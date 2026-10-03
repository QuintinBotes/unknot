// CLI plumbing shared by every command: argument parsing, who is acting, run lifecycle,
// output (always redacted), and TTY-only prompts for human decisions.

import { openSync, readSync, closeSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { UnknotError } from '../core/errors.mjs';
import { redact } from '../core/redact.mjs';

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-/g, '_');
      if (eq !== -1) flags[key] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
      if (Array.isArray(flags[`${key}[]`])) flags[`${key}[]`].push(flags[key]);
      else flags[`${key}[]`] = [flags[key]];
    } else positional.push(a);
  }
  return { positional, flags };
}

/**
 * Who is running this command. A human is someone at an interactive terminal; an agent's
 * shell has no TTY, and environment variables are not evidence (a model can unset
 * CLAUDECODE), so only the TTY test can make an actor human.
 */
export function currentActor() {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty || process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return process.env.CI && !tty ? 'ci:pipeline' : 'model:main';
  let name = 'user';
  try {
    name = userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user';
  } catch {
    // no passwd entry
  }
  return `human:${name}`;
}

export const isHuman = (actor) => actor.startsWith('human:');

export function requireHumanTTY(what) {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UnknotError('UK_POLICY_DENIED', `${what} must be done by a human in an interactive terminal, not by an agent`, {
      details: { policy: 'approval.human_only' },
    });
  }
}

/** Read a line from the controlling terminal, optionally without echo. */
export function prompt(question, { secret = false } = {}) {
  writeSync(1, question);
  if (secret && process.stdin.isTTY) process.stdin.setRawMode(true);
  const fd = openSync('/dev/tty', 'r');
  const buf = Buffer.alloc(1);
  let out = '';
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString('utf8');
      if (ch === '\r' || ch === '\n') break;
      if (ch === '\u0003') throw new UnknotError('UK_POLICY_DENIED', 'cancelled');
      if (ch === '\u007f') out = out.slice(0, -1);
      else out += ch;
    }
  } finally {
    closeSync(fd);
    if (secret && process.stdin.isTTY) process.stdin.setRawMode(false);
    if (secret) writeSync(1, '\n');
  }
  return out;
}

export function output(value, { json = false, redactPatterns = [] } = {}) {
  const text = json ? `${JSON.stringify(value, null, 2)}\n` : typeof value === 'string' ? `${value.replace(/\n?$/, '\n')}` : `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(redact(text, { extraPatterns: redactPatterns }).text);
}

export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length))));
  const fmt = (vals) => vals.map((v, i) => String(v ?? '').slice(0, 60).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(columns), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => fmt(columns.map((c) => r[c])))].join('\n');
}

/**
 * Use the active run when there is one for this command family; otherwise start one and
 * end it when `fn` finishes, so a human-terminal invocation never leaves a run open.
 */
export async function withRun(ctx, cfg, command, { actor, scope = [], slice_id = null, campaign_id = null }, fn) {
  const { activeRun, startRun, endRun } = await import('../state/runs.mjs');
  const existing = activeRun(ctx.store);
  if (existing) return fn(existing);
  const run = startRun(ctx, { command, actor, scope, slice_id, campaign_id, config: cfg.config, configDigest: cfg.digest });
  let outcome = 'completed';
  try {
    return await fn(run);
  } catch (err) {
    outcome = err?.code === 'UK_BUDGET_EXCEEDED' ? 'budget_exceeded' : 'failed';
    throw err;
  } finally {
    endRun(ctx, run.id, { outcome, actor });
  }
}
