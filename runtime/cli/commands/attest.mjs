// `unknot attest <PO-id> --result pass|fail --note "..." --as <approver>` (human only).

import { UnknotError } from '../../core/errors.mjs';
import { keyFingerprint, loadApproverKey, publicKeyOf, signText } from '../../core/keys.mjs';
import { attest } from '../../verify/verify.mjs';
import { output, prompt, requireHumanTTY, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  requireHumanTTY('attesting an obligation');
  const [id] = positional;
  if (!id || !['pass', 'fail'].includes(flags.result) || !flags.note || !flags.as) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot attest <PO-id> --result pass|fail --note "..." --as <approver>');
  const { ctx, cfg, actor } = open(flags);
  const key = loadApproverKey(flags.as, prompt(`Passphrase for ${flags.as}: `, { secret: true }));
  const rec = await withRun(ctx, cfg, 'verify', { actor }, (r) => attest(ctx, { cfg, run: r, obligationId: id, result: flags.result, note: flags.note, approver: flags.as, privateKey: key, signText, keyFingerprint, publicKeyOf }));
  output(`Attested ${id}: ${rec.verdict} (${rec.id}). Run unknot verify <slice> to re-evaluate the slice.`);
}
