// `unknot approvals <slice> [--stage plan|change|rollback]` (#152): where a slice's approvals stand,
// local signatures and, with `approvals.via: forge | both`, pull request reviews. When forge reviews
// complete the change stage of a REVIEW_READY slice, the slice is accepted as `approve` would.
// The authority is the reviews; this command only reads them and records what counted.

import { approvalStatus, loadSlice } from '../../apply/apply.mjs';
import { head } from '../../apply/git.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';
import { accept } from './approve.mjs';

export const USAGE = 'usage: unknot approvals <slice> [--stage plan|change|rollback]';

export async function run({ positional, flags }) {
  const sliceId = positional[0];
  if (!sliceId) throw new UnknotError('UK_CONFIG_INVALID', USAGE);
  const { ctx, cfg } = open(flags);
  const slice = loadSlice(ctx, sliceId);
  const stage = flags.stage ?? (slice.state === 'REVIEW_READY' ? 'change' : slice.state === 'ACCEPTED' ? 'rollback' : 'plan');
  const commit = stage === 'plan' ? head(ctx.root) : slice.baseline_commit;
  const status = approvalStatus(ctx, slice, stage, { cfg, commit, diffHash: stage === 'plan' ? null : slice.diff_hash });
  const reviewers = [...new Set((status.forge?.valid ?? []).map((v) => v.approver))];
  const accepted = stage === 'change' && status.satisfied && reviewers.length && slice.state === 'REVIEW_READY'
    ? await accept(ctx, cfg, slice, status, reviewers.join('/'))
    : null;
  if (flags.json) {
    output({ slice_id: slice.id, stage, ...status, accepted }, { json: true });
    return 0;
  }
  const f = status.forge;
  output([
    `${slice.id} ${stage} approval: ${status.satisfied ? 'satisfied' : 'pending'}`,
    `  needed: roles ${status.needed.roles.join(', ') || '—'}; approvers ${status.approvers}/${status.needed.min_approvers}${status.missing_roles.length ? `; missing ${status.missing_roles.join(', ')}` : ''}`,
    ...status.valid.map((v) => `  counts: ${v.id} ${v.approver} (${v.role})`),
    ...status.stale.map((s) => `  stale: ${s.id} ${s.approver} (${s.reasons.join(', ')})`),
    ...(f ? [
      `  pull request: ${f.url ?? 'none'}${f.head ? `, head ${f.head.slice(0, 12)}` : ''}`,
      ...(f.error ? [`  forge: ${f.error}`] : []),
      ...f.reviews.map((r) => `  review ${r.id ?? '?'} by ${r.login ?? '?'}: ${r.counted ? `counts (${r.roles.join(', ')})` : `not counted (${r.reasons.join('; ')})`}`),
    ] : []),
    ...(accepted ? [accepted] : []),
  ].join('\n'));
  return 0;
}
