// Effective configuration = defaults ← repository config ← organization policy (tighten
// only). The digest of the result is what approvals and evidence bind to, so a config
// change after approval invalidates the approval.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { verifyText } from '../core/keys.mjs';
import { unknotHome } from '../core/project.mjs';
import { validateArtifact } from '../core/schema.mjs';
import { parseYAML } from '../core/yaml.mjs';
import { DEFAULT_CONFIG } from './defaults.mjs';
import { applyOrgPolicy, overlay } from './merge.mjs';

/** Managed (administrator-installed) policy locations. Not overridable from the environment. */
export function managedPolicyDirs() {
  if (process.platform === 'darwin') return ['/Library/Application Support/Unknot'];
  if (process.platform === 'win32') return [join(process.env.ProgramData ?? 'C:\\ProgramData', 'Unknot')];
  return ['/etc/unknot'];
}

function trustedKeys(dir) {
  const d = join(dir, 'trusted-keys');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.pem'))
    .sort()
    .map((f) => readFileSync(join(d, f), 'utf8'));
}

/**
 * Load one organization policy bundle. A directory with trusted keys requires a valid
 * detached signature (`org-policy.yaml.sig`, base64 Ed25519 over the file bytes); a
 * policy that fails verification is an integrity error, never silently ignored.
 */
export function loadPolicyBundle(dir) {
  const file = join(dir, 'org-policy.yaml');
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  const keys = trustedKeys(dir);
  let signed = false;
  if (keys.length) {
    const sigFile = `${file}.sig`;
    const sig = existsSync(sigFile) ? readFileSync(sigFile, 'utf8').trim() : '';
    signed = keys.some((k) => verifyText(k, bytes.toString('utf8'), sig));
    if (!signed) {
      throw new UnknotError('UK_INTEGRITY', `organization policy at ${file} is not signed by a trusted key`, {
        details: { file, trusted_keys: keys.length },
      });
    }
  }
  const policy = parseYAML(bytes.toString('utf8'), { filename: file }) ?? {};
  return { file, policy, signed, digest: digest(bytes.toString('utf8')) };
}

export function loadOrgPolicy() {
  // Managed policy first: it is the outer bound, and a user-level file can only add to it.
  const bundles = [...managedPolicyDirs(), unknotHome()].map(loadPolicyBundle).filter(Boolean);
  return bundles;
}

export function readRepoConfig(paths) {
  if (!existsSync(paths.config)) return { raw: null, source: null };
  const text = readFileSync(paths.config, 'utf8');
  let raw;
  try {
    raw = parseYAML(text, { filename: paths.config }) ?? {};
  } catch (err) {
    throw new UnknotError('UK_CONFIG_INVALID', `${paths.config}: ${err.message}`);
  }
  return { raw, source: paths.config };
}

/**
 * @param {{paths: object}} ctx
 * @returns {{config: object, digest: string, adjustments: object[], sources: string[], org: object[]}}
 */
export function loadConfig(ctx, { overrideRaw } = {}) {
  const { raw, source } = overrideRaw ? { raw: overrideRaw, source: '<inline>' } : readRepoConfig(ctx.paths);
  if (raw) {
    const res = validateArtifact('config', raw);
    if (!res.valid) {
      throw new UnknotError('UK_CONFIG_INVALID', `invalid Unknot config: ${res.errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ')}`, {
        details: { errors: res.errors },
      });
    }
  }
  let config = overlay(structuredClone(DEFAULT_CONFIG), raw ?? {});
  const adjustments = [];
  const org = loadOrgPolicy();
  for (const bundle of org) {
    const r = applyOrgPolicy(config, bundle.policy);
    config = r.config;
    adjustments.push(...r.adjustments.map((a) => ({ ...a, by: bundle.file })));
  }
  return {
    config: Object.freeze(config),
    digest: digest({ config, org: org.map((b) => b.digest) }),
    adjustments,
    sources: [source, ...org.map((b) => b.file)].filter(Boolean),
    org: org.map(({ file, signed, digest: d }) => ({ file, signed, digest: d })),
  };
}
