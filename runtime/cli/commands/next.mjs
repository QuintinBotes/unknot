// /unknot:next [campaign] — the smallest unblocked, highest-value slice.

import { selectNext } from '../../plan/next.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx } = open(flags);
  const res = selectNext(ctx, { campaign: positional[0] ?? null });
  if (flags.json) return output(res, { json: true });
  if (!res.next) return output(`No unblocked slice.${res.blocked.length ? ` Blocked: ${res.blocked.map((b) => `${b.id} (waiting for ${b.waiting_for.join(', ')})`).join('; ')}` : ''}`);
  output([`Next: ${res.next.id} [${res.next.state}, ${res.next.risk} risk] ${res.next.objective}`, `Why: ${res.next.why.join('; ')}`, ...(res.alternatives.length ? ['Also ready: ' + res.alternatives.map((a) => a.id).join(', ')] : [])].join('\n'));
}
