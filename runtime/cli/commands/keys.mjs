import { UnknotError } from '../../core/errors.mjs';
import { generateApproverKey, keyFingerprint } from '../../core/keys.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';

export async function run({ positional }) {
  const [sub, name] = positional;
  if (sub !== 'generate' || !name) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot keys generate <approver-name>');
  requireHumanTTY('generating an approver key');
  const p1 = prompt(`Passphrase for ${name}: `, { secret: true });
  const p2 = prompt('Repeat passphrase: ', { secret: true });
  if (p1 !== p2) throw new UnknotError('UK_CONFIG_INVALID', 'passphrases differ');
  const pub = generateApproverKey(name, p1);
  output(`Approver key created (${keyFingerprint(pub)}). Register it in .unknot/config.yaml:\n\napprovers:\n  ${name}:\n    roles: [code-owner]\n    public_key: |\n${pub.trim().split('\n').map((l) => `      ${l}`).join('\n')}\n`);
}
