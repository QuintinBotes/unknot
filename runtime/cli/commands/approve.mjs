// `unknot approve <slice> --role <role> --as <approver> [--stage plan|change|rollback]`
// `unknot approve --lane <LN-id> --as <approver>`: the changes of a lane's reviewed slices.
// Human only: an interactive terminal, the slice id typed back, and the approver key's
// passphrase. The signature binds the exact plan or diff (spec §20).

import { approvalStatus, currentBinding, loadSlice } from '../../apply/apply.mjs';
import { head } from '../../apply/git.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { loadApproverKey } from '../../core/keys.mjs';
import { modeRank } from '../../policy/defaults.mjs';
import { recordApproval } from '../../policy/approvals.mjs';
import { transitionSlice } from '../../state/machine.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

/** Move a slice whose change approvals are complete to ACCEPTED (and commit in governed mode). */
async function accept(ctx, cfg, slice, status, approver) {
  // What is accepted must be what was reviewed: re-stage the worktree and compare the hash.
  const { stagePatch } = await import('../../apply/worktree.mjs');
  const now = stagePatch(slice.worktree, slice.baseline_commit).diff_hash;
  if (now !== slice.diff_hash) throw new UnknotError('UK_STATE_CONFLICT', `${slice.id}: the worktree changed since it was verified (${now} is not the approved ${slice.diff_hash}); nothing accepted. Run /unknot:apply ${slice.id} to re-verify`, { slice_id: slice.id });
  transitionSlice(ctx, { slice, to: 'ACCEPTED', actor: `human:${approver}`, reason: 'change approved', guards: [() => ({ ok: status.satisfied, id: 'approval.change' })] });
  if (modeRank(cfg.config.mode) >= modeRank('governed')) {
    const { git } = await import('../../apply/git.mjs');
    git(slice.worktree, ['-c', `user.name=unknot`, '-c', 'user.email=unknot@localhost', 'commit', '-q', '-m', `${slice.id}: ${slice.body.objective}\n\nApproved: ${status.valid.map((v) => `${v.approver} (${v.role})`).join(', ')}\nDiff: ${slice.diff_hash}`]);
    return `${slice.id} ACCEPTED and committed on ${slice.branch}. Unknot does not merge or push; open a pull request from that branch.`;
  }
  return `${slice.id} ACCEPTED. The change is staged in ${slice.worktree} on ${slice.branch}; commit and merge it through your normal review flow.`;
}

/** `unknot approve --lane <LN>`: the change approval of every lane slice that is ready for review. */
async function approveLane(flags) {
  const { getLane, laneSlices, laneValidity } = await import('../../policy/lanes.mjs');
  const { ctx, cfg } = open(flags);
  const lane = getLane(ctx, flags.lane);
  const invalid = laneValidity(lane, cfg);
  const role = flags.role ?? lane.body.role;
  const approver = flags.as;
  if (!approver) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot approve --lane <LN-id> --as <approver> [--role <role>]');
  const ready = laneSlices(ctx, lane.id).filter((s) => s.state === 'REVIEW_READY');
  if (!ready.length) throw new UnknotError('UK_NOT_FOUND', `no slice of lane ${lane.id} is REVIEW_READY`);
  output([
    `Approving the changes of ${ready.length} slice(s) in lane ${lane.id} (${lane.campaign_id}) as ${approver} / ${role}:`,
    ...ready.map((s) => `  ${s.id}  ${s.body.objective}  diff ${s.diff_hash}`),
    `Review them first: unknot lane review ${lane.id}`,
    ...(invalid.length ? [`Note: the lane no longer covers new slices (${invalid.join('; ')}); approving these reviewed changes is still your call.`] : []),
  ].join('\n'));
  if (prompt(`Type ${lane.id} to approve these changes: `).trim() !== lane.id) throw new UnknotError('UK_POLICY_DENIED', 'confirmation did not match; nothing recorded');
  const key = loadApproverKey(approver, prompt(`Passphrase for ${approver}: `, { secret: true }));
  const lines = [];
  for (const row of ready) {
    const slice = loadSlice(ctx, row.id);
    const binding = currentBinding(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash });
    recordApproval(ctx, { config: cfg.config, slice, binding, role, approver, privateKey: key, actor: `human:${approver}` });
    const status = approvalStatus(ctx, slice, 'change', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash });
    lines.push(status.satisfied ? await accept(ctx, cfg, slice, status, approver) : `${slice.id}: still needed: roles ${status.missing_roles.join(', ') || '—'}; approvers ${status.approvers}/${status.needed.min_approvers}.`);
  }
  output(lines.join('\n'));
}

export async function run({ positional, flags }) {
  requireHumanTTY('approving a slice');
  if (flags.lane) return approveLane(flags);
  const sliceId = positional[0];
  const role = flags.role;
  const approver = flags.as;
  if (!sliceId || !role || !approver) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot approve <slice> --role <role> --as <approver> [--stage plan|change|rollback]');
  const { ctx, cfg, actor } = open(flags);
  const slice = loadSlice(ctx, sliceId);
  const stage = flags.stage ?? (slice.state === 'REVIEW_READY' ? 'change' : slice.state === 'ACCEPTED' ? 'rollback' : 'plan');
  const commit = stage === 'plan' ? head(ctx.root) : slice.baseline_commit;
  const binding = currentBinding(ctx, slice, stage, { cfg, commit, diffHash: stage === 'plan' ? null : slice.diff_hash });
  output([
    `Approving ${sliceId} (${stage} stage) as ${approver} / ${role}`,
    `Objective: ${slice.body.objective}`,
    `Risk: ${slice.risk}; required roles: ${slice.body.approvals.join(', ')}`,
    `Scope: ${slice.body.scope.include.join(', ')}`,
    stage === 'plan' ? `Baseline commit: ${commit}` : `Diff: ${slice.diff_hash} (review .unknot/runs/*/diff.patch and the proof bundle first)`,
    `Policy digest: ${cfg.digest}`,
    `Expires: ${binding.expires_at}`,
  ].join('\n'));
  if (prompt(`Type ${sliceId} to approve: `).trim() !== sliceId) throw new UnknotError('UK_POLICY_DENIED', 'confirmation did not match; nothing recorded');
  const key = loadApproverKey(approver, prompt(`Passphrase for ${approver}: `, { secret: true }));
  const row = recordApproval(ctx, { config: cfg.config, slice, binding, role, approver, privateKey: key, actor: `human:${approver}` });
  const status = approvalStatus(ctx, slice, stage, { cfg, commit, diffHash: binding.diff_hash });
  const lines = [`Recorded ${row.id}. ${status.satisfied ? 'All required approvals are present.' : `Still needed: roles ${status.missing_roles.join(', ') || '—'}; approvers ${status.approvers}/${status.needed.min_approvers}.`}`];
  if (stage === 'change' && status.satisfied) lines.push(await accept(ctx, cfg, slice, status, approver));
  output(lines.join('\n'));
}
