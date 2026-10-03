// `unknot approve <slice> --role <role> --as <approver> [--stage plan|change|rollback]`
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

export async function run({ positional, flags }) {
  requireHumanTTY('approving a slice');
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
  if (stage === 'change' && status.satisfied) {
    transitionSlice(ctx, { slice, to: 'ACCEPTED', actor: `human:${approver}`, reason: 'change approved', guards: [() => ({ ok: status.satisfied, id: 'approval.change' })] });
    if (modeRank(cfg.config.mode) >= modeRank('governed')) {
      const { git } = await import('../../apply/git.mjs');
      git(slice.worktree, ['-c', `user.name=unknot`, '-c', 'user.email=unknot@localhost', 'commit', '-q', '-m', `${sliceId}: ${slice.body.objective}\n\nApproved: ${status.valid.map((v) => `${v.approver} (${v.role})`).join(', ')}\nDiff: ${slice.diff_hash}`]);
      lines.push(`ACCEPTED and committed on ${slice.branch}. Unknot does not merge or push; open a pull request from that branch.`);
    } else lines.push(`ACCEPTED. The change is staged in ${slice.worktree} on ${slice.branch}; commit and merge it through your normal review flow.`);
  }
  output(lines.join('\n'));
}
