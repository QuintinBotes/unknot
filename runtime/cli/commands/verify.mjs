// /unknot:verify <slice> — execute proof obligations and decide the next state.

import { UnknotError } from '../../core/errors.mjs';
import { verifySlice } from '../../verify/verify.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const sliceId = positional[0];
  if (!sliceId) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot verify <slice>');
  const { ctx, cfg, actor } = open(flags);
  const res = await withRun(ctx, cfg, 'verify', { actor, slice_id: sliceId }, (r) => verifySlice(ctx, { cfg, run: r, sliceId, actor }));
  if (flags.json) return output(res, { json: true });
  const lines = [`${sliceId} → ${res.state}`, '', table(res.results.map((x) => ({ id: x.id, kind: x.kind, verdict: x.verdict, detail: x.detail })), ['id', 'kind', 'verdict', 'detail'])];
  for (const r of res.results.filter((x) => x.stderr)) lines.push('', `--- ${r.id} stderr (tail) ---`, r.stderr);
  if (res.waiting_for_human.length) lines.push('', `Waiting for human attestation: ${res.waiting_for_human.map((o) => `${o.id} (${o.kind})`).join(', ')} — a person runs: unknot attest <PO-id> --result pass|fail --note "..." --as <approver>`);
  if (res.notes.length) lines.push('', `Notes: ${res.notes.join('; ')}`);
  if (res.bundle) lines.push('', `Proof bundle: ${res.bundle}. Review it, then a human approves the change: unknot approve ${sliceId} --role <role> --as <approver>`);
  output(lines.join('\n'));
  return res.state === 'REVIEW_READY' ? 0 : 1;
}
