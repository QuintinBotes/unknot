// Model-usage budgets (spec §7.2: max_turns, max_tokens, max_cost_usd). Claude Code does
// not hand usage to hooks; every hook event names the session transcript, whose assistant
// entries carry the API usage of each request. The runtime reads what was appended since
// its last look (bounded per call), counts requests made after the run started, and
// charges the run. Turns are API requests; tokens are everything the requests processed
// (input, cache writes, cache reads, output); cost needs `limits.pricing`.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sha256 } from '../core/canonical.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { charge } from './budget.mjs';

const MAX_READ = 8 * 1024 * 1024;

/**
 * Usage in `path` from byte `offset`, for requests at or after `since`.
 * @returns {{offset: number, lastId: string|null, turns: number, tokens: number, usage: object}}
 */
export function readUsage(path, { offset = 0, since = null, lastId = null } = {}) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < offset) offset = 0; // the transcript was replaced: start over
    const len = Math.min(size - offset, MAX_READ);
    const buf = Buffer.alloc(len);
    const got = len ? readSync(fd, buf, 0, len, offset) : 0;
    const end = buf.subarray(0, got).lastIndexOf(0x0a) + 1; // complete lines only
    const out = { offset: offset + end, lastId, turns: 0, tokens: 0, usage: { input: 0, output: 0, cache_write: 0, cache_read: 0 } };
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const m = e?.message;
      const u = m?.usage;
      if (e?.type !== 'assistant' || !u || typeof u !== 'object') continue;
      // One request is written as several entries (one per content block) with the same id.
      const id = m.id ?? e.requestId ?? null;
      if (id && id === out.lastId) continue;
      out.lastId = id;
      if (since && typeof e.timestamp === 'string' && e.timestamp < since) continue;
      const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
      out.turns++;
      out.usage.input += n(u.input_tokens);
      out.usage.output += n(u.output_tokens);
      out.usage.cache_write += n(u.cache_creation_input_tokens);
      out.usage.cache_read += n(u.cache_read_input_tokens);
    }
    out.tokens = out.usage.input + out.usage.output + out.usage.cache_write + out.usage.cache_read;
    return out;
  } finally {
    closeSync(fd);
  }
}

/** USD for a usage record at the configured per-million-token prices, or null without them. */
export function costOf(usage, pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const p = (k) => (Number.isFinite(pricing[k]) ? pricing[k] : 0);
  return (usage.input * p('input_per_mtok') + usage.output * p('output_per_mtok') + usage.cache_write * p('cache_write_per_mtok') + usage.cache_read * p('cache_read_per_mtok')) / 1e6;
}

/**
 * Charge the run for model usage recorded in the transcript since the last call. Throws
 * UK_BUDGET_EXCEEDED (via charge) when a limit is crossed. A transcript that cannot be read
 * leaves the usage budgets unmeasured; that is recorded once per run, never silently.
 */
export function chargeModelUsage(ctx, run, transcriptPath, { agentId = null, pricing = null } = {}) {
  const limited = ['max_turns', 'max_tokens', 'max_cost_usd'].some((k) => run.budget?.[k] != null);
  if (!limited) return null;
  const key = `usage:${run.id}:${sha256(String(transcriptPath ?? '')).slice(0, 16)}`;
  let state;
  try {
    state = JSON.parse(ctx.store.meta(key) ?? 'null') ?? { offset: 0, lastId: null };
  } catch {
    state = { offset: 0, lastId: null };
  }
  let r;
  try {
    if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) throw new Error('no transcript path in the hook event');
    r = readUsage(transcriptPath, { offset: state.offset, since: run.started_at, lastId: state.lastId });
  } catch (err) {
    const flag = `usage-unmeasured:${run.id}`;
    if (!ctx.store.meta(flag)) {
      ctx.store.meta(flag, '1');
      appendEvent(ctx, { type: 'budget.unmeasured', run_id: run.id, slice_id: run.slice_id, actor: 'runtime:unknot', payload: { reason: String(err.message).slice(0, 200) } });
    }
    return null;
  }
  ctx.store.meta(key, JSON.stringify({ offset: r.offset, lastId: r.lastId }));
  if (r.turns) charge(ctx, run, 'turns', r.turns, { agentId });
  if (r.tokens) charge(ctx, run, 'tokens', r.tokens, { agentId });
  const cost = costOf(r.usage, pricing);
  if (cost) charge(ctx, run, 'cost_usd', cost, { agentId });
  if (run.budget?.max_cost_usd != null && !pricing) {
    const flag = `usage-unpriced:${run.id}`;
    if (!ctx.store.meta(flag)) {
      ctx.store.meta(flag, '1');
      appendEvent(ctx, { type: 'budget.unmeasured', run_id: run.id, slice_id: run.slice_id, actor: 'runtime:unknot', payload: { reason: 'max_cost_usd is set but limits.pricing is not configured' } });
    }
  }
  return r;
}
