// /unknot:rollback <slice> — execute the recorded source recovery. Unaccepted slices are
// discarded (worktree and branch removed). Accepted slices get a revert commit on a new
// branch, which needs a rollback-stage approval; nothing is pushed or merged.

import { loadSlice, approvalStatus } from '../../apply/apply.mjs';
import { git, head } from '../../apply/git.mjs';
import { removeWorktree } from '../../apply/worktree.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { transitionSlice } from '../../state/machine.mjs';
import { output, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const sliceId = positional[0];
  const { ctx, cfg, actor } = open(flags);
  const slice = loadSlice(ctx, sliceId);
  const res = await withRun(ctx, cfg, 'rollback', { actor, slice_id: sliceId }, async (r) => {
    if (['PATCHING', 'VERIFICATION_FAILED', 'REVIEW_READY'].includes(slice.state)) {
      transitionSlice(ctx, { slice, to: 'ROLLED_BACK', actor, reason: 'discarded before acceptance', run_id: r.id });
      removeWorktree(ctx, sliceId, { deleteBranch: true });
      return `${sliceId} discarded: worktree and branch removed; the main checkout was never touched.`;
    }
    if (slice.state !== 'ACCEPTED') throw new UnknotError('UK_STATE_CONFLICT', `${sliceId} is ${slice.state}; nothing to roll back`);
    const status = approvalStatus(ctx, slice, 'rollback', { cfg, commit: slice.baseline_commit, diffHash: slice.diff_hash });
    if (!status.satisfied) throw new UnknotError('UK_APPROVAL_REQUIRED', `rolling back an accepted slice needs a rollback-stage approval (unknot approve ${sliceId} --stage rollback ...); missing ${status.missing_roles.join(', ')}`);
    if (slice.body.recovery.type !== 'revert') throw new UnknotError('UK_RECOVERY_REQUIRED', `${sliceId} declares recovery ${slice.body.recovery.type}; follow its recovery.md instead of a source revert`);
    const commits = git(ctx.root, ['log', '--format=%H', `--grep=^${sliceId}:`, 'HEAD']).stdout.split('\n').filter(Boolean);
    if (!commits.length) throw new UnknotError('UK_RECOVERY_REQUIRED', `no commit for ${sliceId} is reachable from HEAD; if it was never merged, abandon the branch ${slice.branch}`);
    const branch = `unknot/${sliceId}-rollback`;
    const path = `${ctx.paths.worktrees}/${sliceId}-rollback`;
    git(ctx.root, ['worktree', 'add', '-b', branch, path, head(ctx.root)]);
    git(path, ['-c', 'user.name=unknot', '-c', 'user.email=unknot@localhost', 'revert', '--no-edit', ...commits]);
    transitionSlice(ctx, { slice, to: 'ROLLED_BACK', actor, reason: `revert prepared on ${branch}`, run_id: r.id });
    appendEvent(ctx, { type: 'rollback.executed', run_id: r.id, slice_id: sliceId, actor, payload: { branch, reverted: commits } });
    return `Revert of ${commits.length} commit(s) prepared on ${branch} (${path}). Unknot does not push or merge it.`;
  });
  output(res);
}
