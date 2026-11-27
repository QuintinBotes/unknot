// `unknot approvals <slice> [--stage plan|change|rollback]` (#152): where a slice's approvals stand,
// local signatures and, with `approvals.via: forge | both`, pull request reviews. When forge reviews
// complete the change stage of a REVIEW_READY slice, the slice is accepted as `approve` would, and
// the reviews that counted are recorded. Human only, like approve: an agent session that could
// fake what gh returns must not turn it into an acceptance, and the person confirms (default no).

import { approvalStatus, loadSlice } from '../../apply/apply.mjs';
import { head } from '../../apply/git.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';
import { accept } from './approve.mjs';

export const USAGE = 'usage: unknot approvals <slice> [--stage plan|change|rollback]';

/** `ask` reads the confirmation from the terminal; tests pass their own. */
export async function run({ positional, flags }, { ask = prompt } = {}) {
  requireHumanTTY('accepting a slice on pull request reviews');
  const sliceId = positional[0];
  if (!sliceId) throw new UnknotError('UK_CONFIG_INVALID', USAGE);
  const { ctx, cfg } = open(flags);
  const slice = loadSlice(ctx, sliceId);
  const stage = flags.stage ?? (slice.state === 'REVIEW_READY' ? 'change' : slice.state === 'ACCEPTED' ? 'rollback' : 'plan');
  const commit = stage === 'plan' ? head(ctx.root) : slice.baseline_commit;
  const status = approvalStatus(ctx, slice, stage, { cfg, commit, diffHash: stage === 'plan' ? null : slice.diff_hash });
  const f = status.forge;
  const acceptable = stage === 'change' && status.satisfied && Boolean(f?.valid.length) && slice.state === 'REVIEW_READY';
  if (flags.json) {
    // JSON reports only; accepting needs the confirmation below.
    output({ slice_id: slice.id, stage, ...status, acceptable }, { json: true });
    return 0;
  }
  output([
    `${slice.id} ${stage} approval: ${status.satisfied ? 'satisfied' : 'pending'}`,
    `  needed: roles ${status.needed.roles.join(', ') || '—'}; approvers ${status.approvers}/${status.needed.min_approvers}${status.missing_roles.length ? `; missing ${status.missing_roles.join(', ')}` : ''}`,
    ...status.valid.map((v) => `  counts: ${v.id} ${v.login ?? v.approver} (${v.role})`),
    ...status.stale.map((s) => `  stale: ${s.id} ${s.approver} (${s.reasons.join(', ')})`),
    ...(f ? [
      `  pull request: ${f.url ?? 'none'}${f.base ? `, base ${f.base}` : ''}${f.head ? `, head ${f.head.slice(0, 12)}` : ''}`,
      ...(f.error ? [`  forge: ${f.error}`] : []),
      ...f.reviews.map((r) => `  review ${r.id ?? '?'} by ${r.login ?? '?'}: ${r.counted ? `counts (${r.roles.join(', ')})` : `not counted (${r.reasons.join('; ')})`}`),
    ] : []),
  ].join('\n'));
  if (!acceptable) return 0;
  // The person confirms what they accept on: the pull request, its base and who counted as what.
  const counted = f.reviews.filter((r) => r.counted).map((r) => `${r.login} (${r.roles.filter((x) => x !== 'any-approver').join(', ') || 'any-approver'})`);
  const answer = ask(`Accept ${slice.id} on ${f.url} (base ${f.base}) as approved by ${counted.join(', ')}? [y/N] `).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    output('Not accepted; nothing recorded.');
    return 0;
  }
  output(await accept(ctx, cfg, slice, status, [...new Set(f.valid.map((v) => v.approver))].join('/')));
  return 0;
}
