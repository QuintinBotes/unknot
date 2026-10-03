// Organization policy bundles (spec §8, §16.3): a YAML policy plus a detached Ed25519
// signature. Creation and signing are human-only operations; verification is the same
// `loadPolicyBundle` the runtime uses at startup, so what `unknot policy verify` says is
// exactly what enforcement will do.

import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { keyFingerprint, publicKeyOf, signText } from '../core/keys.mjs';
import { unknotHome } from '../core/project.mjs';
import { validateArtifact } from '../core/schema.mjs';
import { parseYAML } from '../core/yaml.mjs';
import { loadConfig, loadPolicyBundle } from '../policy/config.mjs';
import { MODES } from '../policy/defaults.mjs';

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MIN_PASSPHRASE = 12;
const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'config.schema.json');

/** Keys only organization policy has; the repository config schema rejects them. */
export const ORG_ONLY_KEYS = Object.freeze(['max_mode', 'approvers_locked', 'forbid_executables']);

function secureDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    chmodSync(p, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return p;
}

export const policyKeyDir = () => secureDir(join(unknotHome(), 'policy-keys'));

function checkName(name) {
  if (!NAME.test(name ?? '')) throw new UnknotError('UK_CONFIG_INVALID', `bad policy key name ${name}`);
}

/** Generate a signing key; the private half is encrypted with `passphrase`. Returns the public PEM. */
export function generatePolicyKey(name, passphrase) {
  checkName(name);
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new UnknotError('UK_CONFIG_INVALID', `policy key passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  const dir = policyKeyDir();
  const priv = join(dir, `${name}.pem`);
  if (existsSync(priv)) throw new UnknotError('UK_STATE_CONFLICT', `policy key ${name} already exists`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }), { mode: 0o600, flag: 'wx' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(dir, `${name}.pub.pem`), pub, { mode: 0o644 });
  return pub;
}

export function loadPolicyKey(name, passphrase) {
  checkName(name);
  const p = join(policyKeyDir(), `${name}.pem`);
  if (!existsSync(p)) throw new UnknotError('UK_NOT_FOUND', `no policy key named ${name}; run unknot policy keygen ${name}`);
  try {
    return createPrivateKey({ key: readFileSync(p), passphrase });
  } catch {
    throw new UnknotError('UK_POLICY_DENIED', 'policy key could not be unlocked with that passphrase');
  }
}

let configProps = null;
function configProperties() {
  configProps ??= new Set(Object.keys(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')).properties));
  return configProps;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate an organization policy: the config schema for every field it shares with
 * repository config, hand-checked rules for the organization-only fields, and an explicit
 * rejection of unknown top-level keys (a typo like `max_mod` must not silently weaken
 * enforcement).
 * @returns {{valid: boolean, errors: {path: string, message: string}[]}}
 */
export function validateOrgPolicy(policy) {
  const errors = [];
  if (!isObj(policy)) return { valid: false, errors: [{ path: '/', message: 'policy must be a mapping' }] };
  const known = configProperties();
  const rest = {};
  for (const [k, v] of Object.entries(policy)) {
    if (ORG_ONLY_KEYS.includes(k)) continue;
    if (!known.has(k)) errors.push({ path: `/${k}`, message: 'unknown top-level key' });
    else rest[k] = v;
  }
  if (policy.max_mode !== undefined && !MODES.includes(policy.max_mode)) {
    errors.push({ path: '/max_mode', message: `must be one of ${MODES.join(', ')}` });
  }
  if (policy.approvers_locked !== undefined && typeof policy.approvers_locked !== 'boolean') {
    errors.push({ path: '/approvers_locked', message: 'must be a boolean' });
  }
  const fe = policy.forbid_executables;
  if (fe !== undefined && !(Array.isArray(fe) && fe.every((x) => typeof x === 'string' && x.length > 0 && !/[\\/\0]/.test(x)))) {
    errors.push({ path: '/forbid_executables', message: 'must be an array of bare executable names' });
  }
  const res = validateArtifact('config', { version: 1, ...rest });
  if (!res.valid) errors.push(...res.errors.map((e) => ({ path: e.path || '/', message: e.message })));
  return { valid: errors.length === 0, errors };
}

export function assertOrgPolicy(policy) {
  const r = validateOrgPolicy(policy);
  if (!r.valid) {
    throw new UnknotError('UK_CONFIG_INVALID', `invalid organization policy: ${r.errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join('; ')}`, {
      details: { errors: r.errors },
    });
  }
  return policy;
}

/** Validate and sign `file`, writing the detached signature next to it as `<file>.sig`. */
export function signPolicyFile(file, privateKey) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new UnknotError('UK_NOT_FOUND', `no policy file ${abs}`);
  const text = readFileSync(abs, 'utf8');
  assertOrgPolicy(parseYAML(text, { filename: abs }) ?? {});
  const signature = signText(privateKey, text);
  const sigFile = `${abs}.sig`;
  writeFileSync(sigFile, `${signature}\n`, { mode: 0o644 });
  return { file: abs, sig_file: sigFile, digest: digest(text), key_fingerprint: keyFingerprint(publicKeyOf(privateKey)) };
}

/** Add a public key to a bundle directory's trusted keys. */
export function trustKey(dir, name) {
  checkName(name);
  const pub = join(policyKeyDir(), `${name}.pub.pem`);
  if (!existsSync(pub)) throw new UnknotError('UK_NOT_FOUND', `no public key for ${name}`);
  const dest = join(resolve(dir), 'trusted-keys');
  mkdirSync(dest, { recursive: true });
  const target = join(dest, `${name}.pem`);
  copyFileSync(pub, target);
  return target;
}

/** Verify a bundle directory exactly as startup would, then validate the policy content. */
export function verifyPolicyDir(dir) {
  const abs = resolve(dir);
  const bundle = loadPolicyBundle(abs); // throws UK_INTEGRITY on a bad or missing signature
  if (!bundle) throw new UnknotError('UK_NOT_FOUND', `no org-policy.yaml in ${abs}`);
  const keysDir = join(abs, 'trusted-keys');
  const trusted = existsSync(keysDir) ? readdirSync(keysDir).filter((f) => f.endsWith('.pem')).length : 0;
  const validation = validateOrgPolicy(bundle.policy);
  return {
    file: bundle.file,
    digest: bundle.digest,
    signed: bundle.signed,
    trusted_keys: trusted,
    valid: validation.valid,
    errors: validation.errors,
    warnings: trusted ? [] : ['no trusted-keys directory: this policy is accepted unsigned; add a trusted key so tampering is detected'],
  };
}

/** The effective configuration for a project and every adjustment organization policy made. */
export function effectivePolicy(ctx) {
  const cfg = loadConfig(ctx);
  return { config: cfg.config, adjustments: cfg.adjustments, org: cfg.org, sources: cfg.sources, digest: cfg.digest };
}
