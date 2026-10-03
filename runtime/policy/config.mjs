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

function parseConfigText(text, filename) {
  try {
    return parseYAML(text, { filename }) ?? {};
  } catch (err) {
    throw new UnknotError('UK_CONFIG_INVALID', `${filename}: ${err.message}`);
  }
}

export function readRepoConfig(paths) {
  if (!existsSync(paths.config)) return { raw: null, source: null, text: null };
  const text = readFileSync(paths.config, 'utf8');
  return { raw: parseConfigText(text, paths.config), source: paths.config, text };
}

/**
 * Record `text` as the human-accepted configuration (spec §4.2: mode elevation requires
 * explicit configuration and cannot be inferred). Called only by `unknot config accept`
 * at a terminal, and by tests.
 */
export function recordAcceptedConfig(ctx, text, actor) {
  const v = validateArtifact('config', parseConfigText(text, '<accepted>'));
  if (!v.valid) throw new UnknotError('UK_CONFIG_INVALID', `config invalid: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
  const d = digest(text);
  ctx.store.tx(() => {
    ctx.store.meta('accepted_config_digest', d);
    ctx.store.meta('accepted_config_text', text);
  });
  return d;
}

/**
 * Which configuration text to honour. A config file nobody accepted, or one changed
 * after acceptance (by an agent, a merge, or a script), never raises authority: the
 * accepted snapshot stays in force, or, with none, the file applies capped at plan mode
 * with no approvers.
 */
function acceptedView(ctx, file) {
  if (!file.text) return { raw: null, acceptance: 'none', notice: null };
  const accepted = ctx.store?.meta?.('accepted_config_digest') ?? null;
  if (accepted && accepted === digest(file.text)) return { raw: file.raw, acceptance: 'accepted', notice: null };
  const snapshot = ctx.store?.meta?.('accepted_config_text') ?? null;
  if (snapshot) {
    // Changes that only tighten (a lower mode, smaller limits, more protected paths)
    // apply at once; anything that would loosen waits for acceptance. Approvers, commands
    // and evidence sources are never taken from an unaccepted file.
    const { approvers, commands, adapters, detectors, evidence, ...tighten } = file.raw;
    return { raw: parseConfigText(snapshot, '<accepted snapshot>'), tighten, acceptance: 'changed', notice: '.unknot/config.yaml changed since a human accepted it; only changes that tighten policy apply until `unknot config accept` is run in a terminal' };
  }
  const capped = { ...file.raw, approvers: {} };
  if (capped.mode && !['observe', 'plan'].includes(capped.mode)) capped.mode = 'plan';
  return { raw: capped, acceptance: 'unaccepted', notice: '.unknot/config.yaml has never been accepted; running in plan mode with no approvers until a human runs `unknot config accept`' };
}

/**
 * @param {{paths: object}} ctx
 * @returns {{config: object, digest: string, adjustments: object[], sources: string[], org: object[]}}
 */
export function loadConfig(ctx, { overrideRaw } = {}) {
  const file = overrideRaw ? { raw: overrideRaw, source: '<inline>', text: null } : readRepoConfig(ctx.paths);
  const view = overrideRaw ? { raw: overrideRaw, acceptance: 'inline', notice: null } : acceptedView(ctx, file);
  const raw = view.raw;
  const source = file.source;
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
  if (view.tighten) {
    const r = applyOrgPolicy(config, { ...view.tighten, mode: view.tighten.mode });
    config = r.config;
    adjustments.push(...r.adjustments.map((a) => ({ ...a, by: 'unaccepted config.yaml (tighten-only)' })));
  }
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
    acceptance: view.acceptance,
    notice: view.notice,
  };
}
