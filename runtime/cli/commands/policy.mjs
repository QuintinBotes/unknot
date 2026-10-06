// `unknot policy`: organization policy bundles. keygen and sign are human-only because a
// signature is what makes a policy binding on every developer machine.

import { UnknotError } from '../../core/errors.mjs';
import { keyFingerprint } from '../../core/keys.mjs';
import { stringifyYAML } from '../../core/yaml.mjs';
import { effectivePolicy, generatePolicyKey, loadPolicyKey, policyKeyDir, signPolicyFile, trustKey, verifyPolicyDir } from '../../enterprise/policy-bundle.mjs';
import { output, prompt, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

export const USAGE = 'usage: unknot policy keygen <name> | sign <org-policy.yaml> --key <name> | trust <dir> --key <name> | verify <dir> | effective | denials [--limit N] [--run <id>]';

/**
 * Recent refusals grouped by rule, with the latest example of each: the way to find a rule that
 * refuses legitimate work (roadmap item 5). Command text is cut and passed through redaction.
 */
function denials(flags) {
  const { ctx } = open(flags);
  const limit = Math.min(Number(flags.limit ?? 500) || 500, 5000);
  const rows = ctx.store.all(`SELECT run_id, operation, reasons, policy_ids, at FROM policy_results WHERE decision = 'deny'${flags.run ? ' AND run_id = ?' : ''} ORDER BY id DESC LIMIT ?`, ...(flags.run ? [flags.run, limit] : [limit]));
  const byRule = new Map();
  for (const r of rows) {
    const ids = JSON.parse(r.policy_ids);
    const key = ids.join(', ') || '(none)';
    const op = JSON.parse(r.operation);
    const g = byRule.get(key) ?? { rule: key, count: 0, runs: new Set(), latest: null };
    g.count++;
    g.runs.add(r.run_id ?? 'no run');
    g.latest ??= { at: r.at, run_id: r.run_id, what: op.command ?? op.paths?.join(', ') ?? op.tool, reason: JSON.parse(r.reasons).join('; ') };
    byRule.set(key, g);
  }
  const groups = [...byRule.values()].sort((a, b) => b.count - a.count).map((g) => ({ rule: g.rule, count: g.count, runs: g.runs.size, latest: g.latest }));
  if (flags.json) return output({ examined: rows.length, groups }, { json: true });
  if (!groups.length) return output('No refusals recorded.');
  return output([`${rows.length} most recent refusal(s), by rule:`, ...groups.map((g) => `  ${g.rule}: ${g.count} (in ${g.runs} run(s)); latest ${g.latest.at}: ${String(g.latest.what).slice(0, 160)}\n    ${g.latest.reason.slice(0, 240)}`)].join('\n'));
}

export async function run({ positional, flags }) {
  const [sub, arg] = positional;
  if (sub === 'denials') return denials(flags);
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
