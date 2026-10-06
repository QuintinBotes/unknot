// The verification engine (spec §19). Every obligation ends with an evidence record:
// executed (a brokered command or a built-in check, bound to the diff hash) or attested
// (a human signature). An agent cannot mark anything passed; verdicts come from exit codes
// and checks, and a slice reaches REVIEW_READY only when every obligation has passing
// evidence for the exact diff under review.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJSON, digest, randomId } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { forbiddenCommand, guidanceForScope, loadGuidance } from '../core/guidance.mjs';
import { brokerExec } from '../broker/broker.mjs';
import { loadSlice, approvalStatus } from '../apply/apply.mjs';
import { stagePatch } from '../apply/worktree.mjs';
import { casPut } from '../state/cas.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { transitionSlice } from '../state/machine.mjs';
import { CHECKS, changedPaths, graphPair } from './checks.mjs';
import { emitProofBundle } from './bundle.mjs';

function obligationsOf(ctx, sliceId) {
  return ctx.store.all('SELECT * FROM proof_obligations WHERE slice_id = ? ORDER BY CAST(substr(id, 4) AS INTEGER)', sliceId).map((o) => ({ ...o, body: JSON.parse(o.body) }));
}

function recordEvidence(ctx, { run, slice, obligation, record, verdict }) {
  ctx.store.tx(() => {
    ctx.store.insert('evidence', { id: record.id, obligation_id: obligation.id, slice_id: slice.id, run_id: run.id, record, verdict, diff_hash: slice.diff_hash, at: nowISO() });
    const status = verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'fail' : 'inconclusive';
    ctx.store.run('UPDATE proof_obligations SET status = ?, evidence_id = ?, version = version + 1 WHERE id = ?', status, record.id, obligation.id);
    // The record's digest goes into the signed, chained ledger; evidence counts only if it
    // still matches, so a row written straight into the database proves nothing.
    appendEvent(ctx, { type: 'evidence.recorded', run_id: run.id, slice_id: slice.id, actor: 'runtime:verifier', payload: { obligation: obligation.id, kind: obligation.kind, verdict, evidence: record.id, record_digest: digest(record), diff_hash: slice.diff_hash } });
  });
}

/** Run every executable obligation of a slice in VERIFYING and decide the next state. */
async function verifySliceInner(ctx, { cfg, run, sliceId, actor }) {
  const config = cfg.config;
  let slice = loadSlice(ctx, sliceId);
  if (slice.state !== 'VERIFYING') throw new UnknotError('UK_STATE_CONFLICT', `slice ${sliceId} is ${slice.state}; run \`unknot apply finish ${sliceId}\` first`, { slice_id: sliceId });
  const staged = stagePatch(slice.worktree, slice.baseline_commit);
  if (staged.diff_hash !== slice.diff_hash) {
    throw new UnknotError('UK_STATE_CONFLICT', `the worktree changed after apply finish (diff ${staged.diff_hash.slice(0, 19)}… ≠ ${slice.diff_hash.slice(0, 19)}…); re-run apply finish`, { slice_id: sliceId });
  }
  const changes = changedPaths(slice.worktree, slice.baseline_commit);
  const obligations = obligationsOf(ctx, sliceId).filter((o) => o.status !== 'pass' && !o.requires_human);
  const needsGraph = obligations.some((o) => ['cycles', 'api', 'complexity', 'parse'].includes(o.body.builtin));
  const pair = needsGraph ? await graphPair(ctx, { config, worktree: slice.worktree, base: slice.baseline_commit, changes }) : null;
  const results = [];
  const checkNotes = [];
  const guide = guidanceForScope(ctx.root, slice.body.scope.include, loadGuidance(ctx.root));
  for (const o of obligations) {
    if (o.body.builtin) {
      const t0 = Date.now();
      let res;
      try {
        res = await CHECKS[o.body.builtin]({ ctx, slice, config, changes, patch: staged.patch, pair });
      } catch (err) {
        res = { verdict: 'inconclusive', detail: `check failed to run: ${err.message}`, data: {} };
      }
      if (res.data?.note) checkNotes.push(`${o.id}: ${res.data.note}`);
      const body = canonicalJSON({ detail: res.detail, data: res.data });
      const record = {
        id: `ex-${randomId(6)}`,
        obligation: o.id,
        command: ['unknot', 'check', o.body.builtin],
        working_directory: slice.worktree,
        environment_digest: digest({ builtin: o.body.builtin, runtime: process.versions.node }),
        started_at: new Date(t0).toISOString(),
        duration_ms: Date.now() - t0,
        exit_code: res.verdict === 'pass' ? 0 : res.verdict === 'fail' ? 1 : null,
        stdout_digest: digest(body),
        stderr_digest: digest(''),
        artifact_refs: [casPut(ctx, body, { mediaType: 'application/json', runId: run.id, label: `${o.id}.${o.body.builtin}` })],
        verdict: res.verdict,
        kind: 'builtin',
        detail: res.detail,
        diff_hash: slice.diff_hash,
      };
      recordEvidence(ctx, { run, slice, obligation: o, record, verdict: res.verdict });
      results.push({ id: o.id, kind: o.kind, verdict: res.verdict, detail: res.detail });
    } else if (o.body.command && forbiddenCommand(guide, o.body.command)) {
      // Guidance can forbid a command, never permit one: the obligation is left for a person.
      const rule = forbiddenCommand(guide, o.body.command);
      const note = `not run: ${rule.file}:${rule.line} says "${rule.sentence}"; a person confirms`;
      const body = { ...o.body, command: null, requires_human: true, description: `${String(o.body.description).replace(/ \(not run: .*$/, '')} (${note})` };
      ctx.store.run('UPDATE proof_obligations SET requires_human = 1, body = ?, version = version + 1 WHERE id = ?', JSON.stringify(body), o.id);
      results.push({ id: o.id, kind: o.kind, verdict: 'needs_human', detail: `${o.body.command.join(' ')} ${note}` });
    } else if (o.body.command) {
      const r = await brokerExec(ctx, { argv: o.body.command, cwd: slice.worktree, origin: 'configured', run, config, writable: [slice.worktree], timeoutMs: (config.limits.max_runtime_minutes ?? 30) * 60_000, obligation: o.id, sliceId, diffHash: slice.diff_hash });
      recordEvidence(ctx, { run, slice, obligation: o, record: { ...r.record, kind: 'command' }, verdict: r.record.verdict });
      results.push({ id: o.id, kind: o.kind, verdict: r.record.verdict, detail: `${o.body.command.join(' ')} → exit ${r.record.exit_code}${r.record.timed_out ? ' (timed out)' : ''}`, stderr: r.record.verdict === 'pass' ? undefined : r.stderrTail.slice(-1200) });
    } else {
      results.push({ id: o.id, kind: o.kind, verdict: 'inconclusive', detail: 'no command configured and not a built-in check' });
    }
  }
  return decide(ctx, { cfg, run, slice: loadSlice(ctx, sliceId), actor, results, notes: [...(pair?.notes ?? []), ...checkNotes], pair });
}

/** Evidence for an obligation is valid only if it is for this exact diff. */
function evidenceValid(ctx, slice, o) {
  if (o.status !== 'pass' || !o.evidence_id) return false;
  const ev = ctx.store.get('SELECT verdict, diff_hash, record FROM evidence WHERE id = ?', o.evidence_id);
  if (!ev || ev.verdict !== 'pass' || ev.diff_hash !== slice.diff_hash) return false;
  const want = digest(JSON.parse(ev.record));
  for (const e of ctx.store.all("SELECT payload FROM events WHERE type = 'evidence.recorded' AND slice_id = ?", slice.id)) {
    const p = JSON.parse(e.payload);
    if (p.evidence === o.evidence_id && p.obligation === o.id && p.record_digest === want && p.verdict === 'pass' && p.diff_hash === slice.diff_hash) return true;
  }
  return false;
}

export async function decide(ctx, { cfg, run, slice, actor, results = [], notes = [], pair = null }) {
  const all = obligationsOf(ctx, slice.id);
  const failed = all.filter((o) => o.status === 'fail');
  const inconclusive = all.filter((o) => o.status === 'inconclusive');
  const waitingHuman = all.filter((o) => o.requires_human && !evidenceValid(ctx, slice, o));
  const unproven = all.filter((o) => !evidenceValid(ctx, slice, o));
  let to = null;
  let reason;
  if (failed.length) {
    to = 'VERIFICATION_FAILED';
    reason = `failed: ${failed.map((o) => `${o.id} ${o.kind}`).join(', ')}`;
  } else if (inconclusive.length) {
    to = 'BLOCKED_UNCERTAINTY';
    reason = `inconclusive: ${inconclusive.map((o) => `${o.id} ${o.kind}`).join(', ')}`;
  } else if (!unproven.length) {
    to = 'REVIEW_READY';
    reason = 'every obligation has passing evidence for this diff';
  }
  const highDb = slice.body.kind === 'database' && ['high', 'critical'].includes(slice.risk);
  const guards = to === 'REVIEW_READY'
    ? [
        () => ({ ok: !unproven.length, id: 'evidence.complete', detail: `unproven: ${unproven.map((o) => o.id).join(', ')}` }),
        () => {
          if (!highDb) return { ok: true, id: 'database.recovery' };
          const plan = approvalStatus(ctx, slice, 'plan', { cfg, commit: slice.baseline_commit });
          const dataOwner = plan.valid.some((v) => v.role === 'data-owner');
          const rehearsed = all.some((o) => o.kind === 'rollback-rehearsal' && evidenceValid(ctx, slice, o));
          return { ok: dataOwner && rehearsed, id: 'database.recovery', detail: 'a high-risk database slice needs data-owner approval and a passed recovery rehearsal (spec §14.11)' };
        },
      ]
    : [];
  let bundle = null;
  if (to) {
    transitionSlice(ctx, { slice, to, actor, reason, run_id: run.id, guards });
    if (to === 'REVIEW_READY') bundle = await emitProofBundle(ctx, { cfg, run, slice: loadSlice(ctx, slice.id), all: obligationsOf(ctx, slice.id), pair, notes });
  }
  const summary = {
    slice: slice.id,
    state: to ?? slice.state,
    diff_hash: slice.diff_hash,
    results,
    waiting_for_human: waitingHuman.map((o) => ({ id: o.id, kind: o.kind, description: o.body.description })),
    notes,
    bundle,
  };
  const dir = join(ctx.paths.runs, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** A human attests a human-review obligation, signed with their approver key. */
export function attest(ctx, { cfg, run, obligationId, result, note, approver, privateKey, signText, keyFingerprint, publicKeyOf }) {
  const o = ctx.store.get('SELECT * FROM proof_obligations WHERE id = ?', obligationId);
  if (!o) throw new UnknotError('UK_NOT_FOUND', `no obligation ${obligationId}`);
  if (!o.requires_human) throw new UnknotError('UK_POLICY_DENIED', `${obligationId} is an executed obligation; only its command can pass it`);
  const reg = cfg.config.approvers?.[approver];
  if (!reg || keyFingerprint(publicKeyOf(privateKey)) !== keyFingerprint(reg.public_key)) throw new UnknotError('UK_POLICY_DENIED', `${approver} is not a registered approver with this key`);
  const slice = loadSlice(ctx, o.slice_id);
  if (!slice.diff_hash) throw new UnknotError('UK_STATE_CONFLICT', `slice ${slice.id} has no staged diff to attest against`);
  const statement = canonicalJSON({ obligation: o.id, slice: slice.id, diff_hash: slice.diff_hash, result, note, approver, purpose: 'unknot-attestation-v1' });
  const record = {
    id: `at-${randomId(6)}`,
    obligation: o.id,
    command: ['human-attestation'],
    working_directory: slice.worktree ?? ctx.root,
    environment_digest: digest('human'),
    started_at: nowISO(),
    duration_ms: 0,
    exit_code: result === 'pass' ? 0 : 1,
    stdout_digest: digest(statement),
    stderr_digest: digest(''),
    artifact_refs: [],
    verdict: result,
    kind: 'human',
    approver,
    note,
    signature: signText(privateKey, statement),
    diff_hash: slice.diff_hash,
  };
  recordEvidence(ctx, { run, slice, obligation: { id: o.id, kind: o.kind }, record, verdict: result });
  return record;
}

/** Instrumented entry point (spec §27); a no-op span when telemetry is disabled. */
export async function verifySlice(ctx, opts) {
  const { withSpan } = await import('../telemetry/otel.mjs');
  return withSpan('verify', {}, () => verifySliceInner(ctx, opts));
}
