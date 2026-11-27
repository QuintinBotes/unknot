// `unknot slice <id>` — a slice with its obligations, approvals and evidence.
// `unknot slice <id> diff` — the slice's patch (staged, else working changes) in its worktree:
// the read-only way to look at it, since shell commands into .unknot/ are denied.
// `unknot slice patching [path...]` — the slices in PATCHING, and which paths their scope holds back.

import { relative, resolve } from 'node:path';
import { UnknotError } from '../../core/errors.mjs';
import { git } from '../../apply/git.mjs';
import { diffStat } from '../../apply/worktree.mjs';
import { isInside, realpathLenient, toPosix } from '../../core/paths.mjs';
import { sliceScopeDenial } from '../../policy/pdp.mjs';
import { activeRun } from '../../state/runs.mjs';
import { redact } from '../../core/redact.mjs';
import { staleEvidence } from '../../plan/staleness.mjs';
import { output } from '../util.mjs';
import { open, sliceRow } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, config } = open(flags);
  if (positional[0] === 'patching') return output(patching(ctx, config, positional.slice(1), flags), { json: true });
  const s = sliceRow(ctx, positional[0]);
  if (!s) throw new UnknotError('UK_NOT_FOUND', `no slice ${positional[0]}`);
  if (positional[1] === 'diff') {
    if (!s.worktree) throw new UnknotError('UK_STATE_CONFLICT', `slice ${s.id} has no worktree yet (state ${s.state})`);
    const args = s.diff_hash ? ['diff', '--cached', '--no-ext-diff', '--no-textconv'] : ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'];
    const stat = git(s.worktree, [...args, '--stat'], { check: false }).stdout;
    const patch = git(s.worktree, args, { check: false }).stdout;
    const max = Number(flags.max ?? 400);
    const lines = patch.split('\n');
    const body = lines.length > max ? `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines (--max N)` : patch;
    return output(redact(`${stat}\n${body}`).text);
  }
  const obligations = ctx.store.all('SELECT id, kind, status, requires_human, evidence_id, body FROM proof_obligations WHERE slice_id = ? ORDER BY CAST(substr(id, 4) AS INTEGER)', s.id).map((o) => ({ id: o.id, kind: o.kind, status: o.status, human: Boolean(o.requires_human), evidence: o.evidence_id, description: JSON.parse(o.body).description }));
  const approvals = ctx.store.all('SELECT id, stage, role, approver, expires_at, revoked_at, revoked_reason FROM approvals WHERE slice_id = ?', s.id);
  const { sliceStanding } = await import('../../policy/lanes.mjs');
  const st = sliceStanding(s, config, ctx);
  const stale = staleEvidence(ctx, s.body);
  output({ id: s.id, state: s.state, risk: s.risk, risk_reasons: st.risk_reasons, required_approvals: st.approvals, lane: st.lane, ...(st.proven_deletion && { proven_deletion: st.proven_deletion }), ...(stale.length && { stale_evidence: stale }), worktree: s.worktree, baseline: s.baseline_commit, diff_hash: s.diff_hash, slice: s.body, obligations, approvals }, { json: true });
}

/**
 * `unknot slice patching [path...] [--session <id>]`: the slices in PATCHING with their scope and
 * the change budget left, and which of `paths` their scope holds back, judged by the PDP's own
 * scope rules. Read-only; the guard mod asks it before an Edit or Write runs. `applies` is false
 * when the active run belongs to another session, whose edits the run does not govern.
 */
function patching(ctx, config, paths, flags) {
  const run = activeRun(ctx.store);
  const slices = ctx.store.all("SELECT * FROM slices WHERE state = 'PATCHING' ORDER BY id").map((r) => ({ ...r, body: JSON.parse(r.body) }));
  const out = slices.map((s) => ({ id: s.id, campaign_id: s.campaign_id, worktree: s.worktree, scope: { include: s.body.scope?.include ?? [], exclude: s.body.scope?.exclude ?? [] }, budget: budgetLeft(config, s) }));
  const applies = slices.length > 0 && !(run?.session_id && flags.session && run.session_id !== flags.session);
  const held = [];
  const root = realpathLenient(ctx.root);
  for (const p of applies ? paths : []) {
    const real = realpathLenient(resolve(flags.cwd ?? process.cwd(), p));
    if (!isInside(root, real)) continue;
    const owner = slices.filter((s) => s.worktree && isInside(realpathLenient(s.worktree), real));
    const runSlice = slices.filter((s) => s.id === run?.slice_id);
    const candidates = owner.length ? owner : runSlice.length ? runSlice : slices;
    const verdicts = candidates.map((s) => {
      const base = owner.length ? realpathLenient(s.worktree) : root;
      return { slice: s.id, ...sliceScopeDenial({ config, slice: s, inner: toPosix(relative(base, real)) }) };
    });
    // Held only when no candidate slice's scope takes the path.
    if (verdicts.every((v) => v.rule)) held.push({ path: p, ...verdicts[0] });
  }
  return { patching: out, applies, held };
}

function budgetLeft(config, s) {
  const limits = { ...config.limits, ...(s.body.budgets ?? {}) };
  const budget = { max_changed_files: limits.max_changed_files ?? null, max_diff_lines: limits.max_diff_lines ?? null };
  if (!s.worktree) return budget;
  try {
    const stat = diffStat(s.worktree);
    return { ...budget, changed_files: stat.files, diff_lines: stat.lines, files_left: budget.max_changed_files == null ? null : budget.max_changed_files - stat.files, lines_left: budget.max_diff_lines == null ? null : budget.max_diff_lines - stat.lines };
  } catch {
    return budget; // a worktree git cannot read: the budget is unknown, the scope still holds
  }
}
