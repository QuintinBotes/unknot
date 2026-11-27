// /unknot:next [campaign] — the smallest unblocked, highest-value slice.

import { selectNext } from '../../plan/next.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, config } = open(flags);
  const res = selectNext(ctx, { campaign: positional[0] ?? null, config });
  if (flags.json) return output(res, { json: true });
  // Slices apply would refuse stay visible as plans, never offered as work (#178).
  const held = [...res.plan_only.map((p) => `Plan-only: ${p.id}: ${p.reason}`), ...res.waits_on_evidence.map((w) => `Waits on evidence: ${w.id}: ${w.reason}`)];
  if (!res.next) return output([`No unblocked slice.${res.blocked.length ? ` Blocked: ${res.blocked.map((b) => `${b.id} (waiting for ${b.waiting_for.join(', ')})`).join('; ')}` : ''}`, ...held].join('\n'));
  output([`Next: ${res.next.id} [${res.next.state}, ${res.next.risk} risk] ${res.next.objective}`, `Why: ${res.next.why.join('; ')}`, ...[res.next, ...res.alternatives].filter((x) => x.needs_reapproval).map((x) => `Needs re-approval: ${x.id}: ${x.needs_reapproval}`), ...(res.alternatives.length ? ['Also ready: ' + res.alternatives.map((a) => a.id).join(', ')] : []), ...held].join('\n'));
}
