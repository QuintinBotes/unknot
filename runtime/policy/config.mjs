// Effective configuration = defaults ← repository config ← organization policy (tighten
// only). The digest of the result is what approvals and evidence bind to, so a config
// change after approval invalidates the approval.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxRequired } from '../broker/sandbox.mjs';
import { canonicalJSON, digest } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { signAcceptance, verifyAcceptance, verifyText } from '../core/keys.mjs';
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

export function parseConfigText(text, filename) {
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
 * A proposal waiting for a person: `config accept` consumes the proposal file, so one that
 * exists beside an accepted configuration is newer than it. Null when there is none.
 */
export function waitingProposal(ctx) {
  const acceptedText = acceptedConfigText(ctx);
  if (!existsSync(ctx.paths.proposedConfig) || !acceptedText) return null;
  try {
    const proposed = parseConfigText(readFileSync(ctx.paths.proposedConfig, 'utf8'), 'config.proposed.yaml');
    const accepted = parseConfigText(acceptedText, '<accepted>');
    const differs = Object.keys({ ...proposed, ...accepted }).filter((k) => JSON.stringify(proposed[k] ?? null) !== JSON.stringify(accepted[k] ?? null)).sort();
    return differs.length ? { path: '.unknot/config.proposed.yaml', differs } : null;
  } catch {
    return { path: '.unknot/config.proposed.yaml', differs: ['(unreadable)'] };
  }
}

// What an acceptance signature covers (#215): the text through its digest, the project and its
// root (so another project's signed acceptance does not verify here), and when.
const acceptanceStatement = (ctx, d, at) => canonicalJSON({ type: 'unknot.config-acceptance/v1', project_id: ctx.projectId, root: ctx.root, digest: d, at });

/**
 * Record `text` as the human-accepted configuration (spec §4.2: mode elevation requires
 * explicit configuration and cannot be inferred), signed with the project's audit key from
 * UNKNOT_HOME. Called only by `unknot config accept` at a terminal, and by tests and scripts
 * through the runtime API.
 */
export function recordAcceptedConfig(ctx, text, actor) {
  const v = validateArtifact('config', parseConfigText(text, '<accepted>'));
  if (!v.valid) throw new UnknotError('UK_CONFIG_INVALID', `config invalid: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
  const d = digest(text);
  const at = nowISO();
  const signature = signAcceptance(ctx.projectId, acceptanceStatement(ctx, d, at));
  ctx.store.tx(() => {
    ctx.store.meta('accepted_config_digest', d);
    ctx.store.meta('accepted_config_text', text);
    ctx.store.meta('accepted_config_at', at);
    ctx.store.meta('accepted_config_signature', signature);
  });
  return d;
}

/**
 * The acceptance recorded in the store: `{text, digest}` when its signature verifies against
 * this project's key and is the one in force, `{invalid}` when a record is there but does not
 * (unsigned: written by a release before #215 or straight into the store; forged; replayed;
 * another project's), and null when there is none. Only a verified record unlocks anything.
 */
export function acceptedRecord(ctx) {
  const meta = (k) => ctx.store?.meta?.(k) ?? null;
  const text = meta('accepted_config_text');
  const d = meta('accepted_config_digest');
  if (!text && !d) return null;
  const signature = meta('accepted_config_signature');
  if (!signature) return { invalid: 'unsigned' };
  if (!ctx.projectId || !text || d !== digest(text) || !verifyAcceptance(ctx.projectId, acceptanceStatement(ctx, d, meta('accepted_config_at')), signature)) return { invalid: 'signature' };
  return { text, digest: d };
}

/** The verified accepted configuration text, or null. */
export const acceptedConfigText = (ctx) => acceptedRecord(ctx)?.text ?? null;

const INVALID_NOTICE = {
  unsigned: 'the configuration acceptance in the store carries no signature (it was recorded by an earlier release, or written into the store directly), so it is not honoured',
  signature: "the configuration acceptance in the store does not verify against this project's key in UNKNOT_HOME (forged, replayed, from another project or checkout path, or the key was replaced), so it is not honoured",
};

/**
 * Which configuration text to honour. A config file nobody accepted, or one changed
 * after acceptance (by an agent, a merge, or a script), never raises authority: the
 * accepted snapshot stays in force, or, with none, the file applies capped at plan mode
 * with no approvers.
 */
function acceptedView(ctx, file) {
  if (!file.text) return { raw: null, acceptance: 'none', notice: null };
  const record = acceptedRecord(ctx);
  if (record?.digest && record.digest === digest(file.text)) return { raw: file.raw, acceptance: 'accepted', notice: null };
  const snapshot = record?.text ?? null;
  if (snapshot) {
    // Changes that only tighten (a lower mode, smaller limits, more protected paths)
    // apply at once; anything that would loosen waits for acceptance. Approvers, commands
    // and evidence sources are never taken from an unaccepted file.
    const { approvers, commands, adapters, detectors, evidence, ...tighten } = file.raw;
    return { raw: parseConfigText(snapshot, '<accepted snapshot>'), tighten, acceptance: 'changed', notice: '.unknot/config.yaml changed since a human accepted it; only changes that tighten policy apply until `unknot config accept` is run in a terminal' };
  }
  const capped = { ...file.raw, approvers: {} };
  if (capped.mode && !['observe', 'plan'].includes(capped.mode)) capped.mode = 'plan';
  // Running SCIP indexers can execute the repository's build, so a file nobody accepted cannot
  // turn it on: a hostile repository's first map would otherwise run its own code.
  const scipRunOverridden = Boolean(capped.adapters?.scip?.run);
  if (scipRunOverridden) capped.adapters = { ...capped.adapters, scip: { ...capped.adapters.scip, run: false } };
  const notice = (record?.invalid ? `${INVALID_NOTICE[record.invalid]}; running in plan mode with no approvers until a person runs \`unknot config accept\` in a terminal once` : '.unknot/config.yaml has never been accepted; running in plan mode with no approvers until a human runs `unknot config accept`')
    + (scipRunOverridden ? '; adapters.scip.run: true was ignored because this configuration is unaccepted; run `unknot config accept` in a terminal to enable it' : '');
  return { raw: capped, acceptance: record?.invalid ? 'invalid' : 'unaccepted', notice };
}

/** Whether a write mode has left traces: slice worktrees on disk, or applied slices, approvals or lanes in the store. */
function writeModeTraces(ctx) {
  try {
    if (ctx.paths?.worktrees && existsSync(ctx.paths.worktrees) && readdirSync(ctx.paths.worktrees).length) return true;
  } catch {
    return true;
  }
  try {
    return Boolean(ctx.store?.get?.('SELECT 1 FROM slices WHERE worktree IS NOT NULL UNION ALL SELECT 1 FROM approvals UNION ALL SELECT 1 FROM lanes LIMIT 1'));
  } catch {
    return false;
  }
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
    const r = applyOrgPolicy(config, { ...view.tighten, mode: view.tighten.mode }, { unruledKeys: 'ignore' });
    config = r.config;
    adjustments.push(...r.adjustments.map((a) => ({ ...a, by: 'unaccepted config.yaml (tighten-only)' })));
  }
  // An edit or removal nobody accepted may lower the mode, never the OS sandbox requirement of
  // the accepted configuration (#170): code a slice wrote in assist must not run unsandboxed
  // because an agent set `mode: plan`. With the snapshot gone (the state directory removed)
  // but a write mode's traces left, the requirement is kept too: fail closed.
  let notice = view.notice;
  if (!overrideRaw && view.acceptance !== 'accepted' && !sandboxRequired(config)) {
    const snapshot = acceptedConfigText(ctx);
    const keep = snapshot ? sandboxRequired(overlay(structuredClone(DEFAULT_CONFIG), parseConfigText(snapshot, '<accepted snapshot>'))) : writeModeTraces(ctx);
    if (keep) {
      adjustments.push({ path: 'security.require_os_sandbox', from: config.security?.require_os_sandbox ?? null, to: true, by: snapshot ? 'accepted config.yaml (sandbox requirement kept)' : 'write-mode traces without an accepted config' });
      config = { ...config, security: { ...config.security, require_os_sandbox: true } };
      if (!snapshot) notice = `${notice ? `${notice}; ` : ''}this project has slice worktrees or approvals from a write mode but no accepted configuration (was .unknot/state removed?), so brokered commands run only inside an OS sandbox until a human runs \`unknot config accept\``;
    }
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
    notice,
  };
}
