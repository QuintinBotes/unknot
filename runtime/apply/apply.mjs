// Patch execution (spec §18). `start` revalidates the slice, policy and the exact-plan
// approval, creates the worktree from the approved baseline, runs baseline checks, and
// moves the slice to PATCHING; the hooks then confine edits to that worktree and scope.
// `finish` stages the patch, binds its hash and moves to VERIFYING. Nothing here merges,
// pushes or deploys.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { matchAny } from '../core/glob.mjs';
import { brokerExec } from '../broker/broker.mjs';
import { bindingFor, evaluateApprovals, invalidateApprovals } from '../policy/approvals.mjs';
import { checkDiffBudget } from '../policy/budget.mjs';
import { modeRank } from '../policy/defaults.mjs';
import { classifyRisk, requiredApprovals } from '../policy/risk.mjs';
import { casPut } from '../state/cas.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { transitionSlice } from '../state/machine.mjs';
import { head } from './git.mjs';
import { assertCleanBaseline, createWorktree, diffStat, removeWorktree, stagePatch } from './worktree.mjs';

export function loadSlice(ctx, id) {
  const row = ctx.store.get('SELECT * FROM slices WHERE id = ?', id);
  if (!row) throw new UnknotError('UK_NOT_FOUND', `no slice ${id}`);
  return { ...row, body: JSON.parse(row.body) };
}

export function currentBinding(ctx, slice, stage, { cfg, commit, diffHash = null }) {
  return bindingFor({
    slice,
    stage,
    commit,
    policyDigest: cfg.digest,
    diffHash,
    planHash: slice.body.infra?.plan_hash ?? null,
    stateSerial: slice.body.infra?.state_serial ?? null,
    environment: slice.body.infra?.environment ?? 'local',
    expiry: cfg.config.approvals.expiry,
  });
}

export function neededApprovals(slice, config) {
  return requiredApprovals(classifyRisk(slice.body, { config, surfaces: slice.body.surfaces ?? {} }), config);
}

export function approvalStatus(ctx, slice, stage, { cfg, commit, diffHash }) {
  const current = currentBinding(ctx, slice, stage, { cfg, commit, diffHash });
  return evaluateApprovals(ctx, { config: cfg.config, slice, current, needed: neededApprovals(slice, cfg.config) });
}

/**
 * Why a test run that passes outside Unknot can fail inside its sandbox, from the output.
 * Only names the cause and the setting a human may choose; never relaxes anything itself.
 */
export function sandboxHint(output, config) {
  const t = String(output);
  const hints = [];
  if (/(listen|connect) EPERM[^\n]*127\.0\.0\.1|EPERM[^\n]*(listen|connect)[^\n]*127\.0\.0\.1|address: '127\.0\.0\.1'/.test(t) && config?.security?.sandbox_loopback !== true) {
    hints.push('The tests open local servers on 127.0.0.1, which the sandbox blocks; a human can set security.sandbox_loopback: true (on macOS that also reaches other local services)');
  }
  if (/spawn(Sync)? (ps|sudo|su|ping|top|login)\b[^\n]*EPERM|execvp\(\) of '[^']*' failed: Operation not permitted/.test(t)) {
    hints.push('The tests run a setuid program (such as ps), which the macOS sandbox cannot execute; exclude those tests from the configured command or run them outside Unknot');
  }
  return hints.join('. ');
}

/** Start patching an approved slice. */
async function startApplyInner(ctx, { cfg, run, sliceId, actor }) {
  const config = cfg.config;
  if (modeRank(config.mode) < modeRank('assist')) {
    throw new UnknotError('UK_POLICY_DENIED', `mode ${config.mode} does not permit patching; a human sets mode: assist (or higher) in .unknot/config.yaml`, { slice_id: sliceId, details: { policy: 'mode.write', required_mode: 'assist' } });
  }
  let slice = loadSlice(ctx, sliceId);
  if (slice.state === 'REVIEW_READY' && !(run.scope ?? []).includes(sliceId) && !String(actor).startsWith('human:')) {
    // Changes after review are the reviewer's request, so a person names the slice.
    throw new UnknotError('UK_POLICY_DENIED', `slice ${sliceId} is ready for review; going back to patching is requested by a person (/unknot:apply ${sliceId})`, { slice_id: sliceId, details: { policy: 'review.reopen' } });
  }
  if (slice.state === 'VERIFICATION_FAILED' || slice.state === 'REVIEW_READY') {
    // Fixing within scope after a failed verification, or changes requested in review:
    // back to PATCHING in the same worktree. Change approvals no longer describe the diff.
    invalidateApprovals(ctx, slice, `re-entered PATCHING from ${slice.state}`);
    slice = transitionSlice(ctx, { slice, to: 'PATCHING', actor, reason: `resume patching from ${slice.state}`, run_id: run.id });
    return { slice: loadSlice(ctx, sliceId), resumed: true };
  }
  if (slice.state === 'PATCHING') return { slice, resumed: true };
  if (slice.state !== 'AWAITING_APPROVAL') throw new UnknotError('UK_STATE_CONFLICT', `slice ${sliceId} is ${slice.state}; only AWAITING_APPROVAL slices can be applied`, { slice_id: sliceId });
  for (const pre of slice.body.preconditions) {
    const p = ctx.store.get('SELECT state FROM slices WHERE id = ?', pre);
    if (!p || p.state !== 'ACCEPTED') throw new UnknotError('UK_POLICY_DENIED', `precondition ${pre} is ${p?.state ?? 'missing'}, not ACCEPTED`, { slice_id: sliceId });
  }
  assertCleanBaseline(ctx.root);
  const commit = head(ctx.root);
  const approvals = approvalStatus(ctx, slice, 'plan', { cfg, commit });
  const guard = () => ({
    ok: approvals.satisfied,
    id: 'approval.plan',
    detail: approvals.satisfied ? 'plan approved' : `plan approval missing: roles ${approvals.missing_roles.join(', ') || '—'}; approvers ${approvals.approvers}/${approvals.needed.min_approvers}${approvals.stale.length ? `; stale: ${approvals.stale.map((s) => `${s.id} (${s.reasons.join(', ')})`).join('; ')}` : ''}`,
  });
  if (!approvals.satisfied) {
    throw new UnknotError('UK_APPROVAL_REQUIRED', guard().detail, { slice_id: sliceId, details: { missing_roles: approvals.missing_roles, stale: approvals.stale, needed: approvals.needed } });
  }
  const protectedTouched = slice.body.scope.include.filter((g) => matchAny(g.replace(/\*+/g, 'x'), config.protected_paths, { nocase: true }));
  if (protectedTouched.length && !['high', 'critical'].includes(slice.risk)) {
    throw new UnknotError('UK_POLICY_DENIED', `scope includes protected paths (${protectedTouched.join(', ')}) but the slice is ${slice.risk} risk`, { slice_id: sliceId });
  }
  const wt = createWorktree(ctx, sliceId, commit);
  // Baseline focused checks (spec §18 step 4): the tests must pass before the change, or
  // passing after it proves nothing about preservation.
  const unit = config.commands?.test_unit;
  let baseline = null;
  if (unit) {
    const r = await brokerExec(ctx, { argv: unit, cwd: wt.path, origin: 'configured', run, config, writable: [wt.path], timeoutMs: (config.limits.max_runtime_minutes ?? 30) * 60_000, sliceId });
    baseline = r.record;
    ctx.store.insert('evidence', { id: r.record.id, obligation_id: null, slice_id: sliceId, run_id: run.id, record: { ...r.record, kind: 'baseline' }, verdict: r.record.verdict, diff_hash: null, at: nowISO() });
    if (r.record.verdict !== 'pass') {
      removeWorktree(ctx, sliceId, { deleteBranch: !wt.reused });
      const hint = sandboxHint(`${r.stdoutTail}\n${r.stderrTail}`, config);
      throw new UnknotError('UK_BASELINE_INVALID', `baseline ${unit.join(' ')} does not pass before any change (exit ${r.record.exit_code}); fix the baseline first${hint ? `. ${hint}` : ''}`, { slice_id: sliceId, details: { evidence: r.record.id, stderr: r.stderrTail.slice(-1500), ...(hint && { hint }) } });
    }
  }
  transitionSlice(ctx, {
    slice,
    to: 'PATCHING',
    actor,
    reason: 'approved plan; worktree created',
    run_id: run.id,
    guards: [guard],
    extra: { worktree: wt.path, branch: wt.branch, baseline_commit: commit },
  });
  appendEvent(ctx, { type: 'apply.started', run_id: run.id, slice_id: sliceId, actor, payload: { worktree: wt.path, branch: wt.branch, baseline: commit, linked_dependencies: wt.linked, baseline_check: baseline?.verdict ?? 'no test_unit configured' } });
  return { slice: loadSlice(ctx, sliceId), worktree: wt, baseline };
}

/** Stage the patch, bind its hash, move to VERIFYING. */
export function finishApply(ctx, { cfg, run, sliceId, actor }) {
  const slice = loadSlice(ctx, sliceId);
  if (slice.state !== 'PATCHING') throw new UnknotError('UK_STATE_CONFLICT', `slice ${sliceId} is ${slice.state}, not PATCHING`, { slice_id: sliceId });
  const stat = diffStat(slice.worktree);
  if (stat.files === 0) throw new UnknotError('UK_STATE_CONFLICT', `slice ${sliceId} has no changes in its worktree`, { slice_id: sliceId });
  const budget = checkDiffBudget({ ...cfg.config.limits, ...slice.body.budgets }, stat);
  const { patch, diff_hash, files } = stagePatch(slice.worktree, slice.baseline_commit);
  const dir = join(ctx.paths.runs, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'diff.patch'), patch);
  const ref = casPut(ctx, patch, { mediaType: 'text/x-diff', runId: run.id, label: `${sliceId}.diff` });
  transitionSlice(ctx, {
    slice,
    to: 'VERIFYING',
    actor,
    reason: `patch staged (${files.length} files)`,
    run_id: run.id,
    guards: [() => ({ ok: budget.ok, id: 'diff-budget', detail: budget.problems.join('; ') })],
    extra: { diff_hash },
  });
  // Any previous verification described a different diff.
  ctx.store.run("UPDATE proof_obligations SET status = 'open', evidence_id = NULL, version = version + 1 WHERE slice_id = ? AND requires_human = 0", sliceId);
  appendEvent(ctx, { type: 'apply.finished', run_id: run.id, slice_id: sliceId, actor, payload: { diff_hash, files, stat, patch_ref: ref } });
  return { diff_hash, files, stat };
}

export function replan(ctx, { run, sliceId, actor, reason }) {
  if (!reason || reason.length < 10) throw new UnknotError('UK_SCHEMA_INVALID', 'say what assumption turned out false (--reason, at least 10 characters)');
  const slice = loadSlice(ctx, sliceId);
  transitionSlice(ctx, { slice, to: 'NEEDS_REPLAN', actor, reason, run_id: run?.id });
  invalidateApprovals(ctx, slice, 'replanned');
  return loadSlice(ctx, sliceId);
}

export function abandon(ctx, { run, sliceId, actor, reason }) {
  const slice = loadSlice(ctx, sliceId);
  transitionSlice(ctx, { slice, to: 'ABANDONED', actor, reason: reason ?? 'abandoned', run_id: run?.id });
  invalidateApprovals(ctx, slice, 'abandoned');
  if (slice.worktree) removeWorktree(ctx, sliceId, { deleteBranch: true });
  return loadSlice(ctx, sliceId);
}

/** Instrumented entry point (spec §27); a no-op span when telemetry is disabled. */
export async function startApply(ctx, opts) {
  const { withSpan } = await import('../telemetry/otel.mjs');
  return withSpan('apply', {}, () => startApplyInner(ctx, opts));
}
