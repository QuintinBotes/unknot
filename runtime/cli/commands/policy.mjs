// `unknot policy`: organization policy bundles. keygen and sign are human-only because a
// signature is what makes a policy binding on every developer machine.

import { UnknotError } from '../../core/errors.mjs';
import { keyFingerprint } from '../../core/keys.mjs';
import { stringifyYAML } from '../../core/yaml.mjs';
import { effectivePolicy, generatePolicyKey, loadPolicyKey, policyKeyDir, signPolicyFile, trustKey, verifyPolicyDir } from '../../enterprise/policy-bundle.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

const USAGE = 'usage: unknot policy keygen <name> | sign <org-policy.yaml> --key <name> | trust <dir> --key <name> | verify <dir> | effective';

export async function run({ positional, flags }) {
  const [sub, arg] = positional;
  if (sub === 'keygen') {
    if (!arg) throw new UnknotError('UK_CONFIG_INVALID', USAGE);
    requireHumanTTY('generating a policy signing key');
    const p1 = prompt(`Passphrase for policy key ${arg}: `, { secret: true });
    const p2 = prompt('Repeat passphrase: ', { secret: true });
    if (p1 !== p2) throw new UnknotError('UK_CONFIG_INVALID', 'passphrases differ');
    const pub = generatePolicyKey(arg, p1);
    return output(`Policy key ${arg} created (${keyFingerprint(pub)}) in ${policyKeyDir()}.\nDistribute ${arg}.pub.pem as <policy-dir>/trusted-keys/${arg}.pem (or run: unknot policy trust <dir> --key ${arg}).`);
  }
  if (sub === 'sign') {
    if (!arg || typeof flags.key !== 'string') throw new UnknotError('UK_CONFIG_INVALID', USAGE);
    requireHumanTTY('signing an organization policy');
    const key = loadPolicyKey(flags.key, prompt(`Passphrase for policy key ${flags.key}: `, { secret: true }));
    const r = signPolicyFile(arg, key);
    return output(flags.json ? r : `Signed ${r.file} (${r.digest}) with ${r.key_fingerprint}; signature in ${r.sig_file}`, { json: flags.json });
  }
  if (sub === 'trust') {
    if (!arg || typeof flags.key !== 'string') throw new UnknotError('UK_CONFIG_INVALID', USAGE);
    return output(`Trusted key installed at ${trustKey(arg, flags.key)}`);
  }
  if (sub === 'verify') {
    if (!arg) throw new UnknotError('UK_CONFIG_INVALID', USAGE);
    const r = verifyPolicyDir(arg);
    const text = [`${r.file}: ${r.signed ? 'signature valid' : 'UNSIGNED'}, ${r.valid ? 'content valid' : 'CONTENT INVALID'}`, ...r.errors.map((e) => `  ${e.path} ${e.message}`), ...r.warnings.map((w) => `  warning: ${w}`)].join('\n');
    output(flags.json ? r : text, { json: flags.json });
    return r.valid ? 0 : 1;
  }
  if (sub === 'effective') {
    const { ctx } = open(flags);
    const r = effectivePolicy(ctx);
    if (flags.json) return output(r, { json: true });
    const adj = r.adjustments.length ? r.adjustments.map((a) => `  ${a.path}: ${JSON.stringify(a.from)} -> ${JSON.stringify(a.to)} (${a.by})`).join('\n') : '  (none)';
    return output(`# Effective configuration (digest ${r.digest})\n${stringifyYAML(r.config)}\n# Adjustments made by organization policy\n${adj}\n# Sources: ${r.sources.join(', ') || '(defaults)'}`);
  }
  output(USAGE);
  return 2;
}
