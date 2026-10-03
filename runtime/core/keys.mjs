// Key material. All of it lives under the user's Unknot home, never in the repository,
// with 0700 directories and 0600 files.
//
//   projects/<project-id>/audit.pem      Ed25519 key that signs every ledger event
//   projects/<project-id>/cache.key      AES-256-GCM key for the content-addressed cache
//   projects/<project-id>/capability.key HMAC key for capability tokens
//   approvers/<name>.pem                 Ed25519 approver key, encrypted with a passphrase
//
// Deleting a project's directory crypto-shreds its encrypted cache (spec §16.5).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnknotError } from './errors.mjs';
import { unknotHome } from './project.mjs';

function secureDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    chmodSync(p, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return p;
}

function writeSecret(path, data) {
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
}

export function projectKeyDir(projectId) {
  if (!/^[a-z0-9-]{8,64}$/.test(projectId)) throw new UnknotError('UK_CONFIG_INVALID', `bad project id ${projectId}`);
  return secureDir(join(unknotHome(), 'projects', projectId));
}

/** Create any missing per-project keys; return their public parts. */
export function ensureProjectKeys(projectId) {
  const dir = projectKeyDir(projectId);
  const audit = join(dir, 'audit.pem');
  if (!existsSync(audit)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    try {
      writeSecret(audit, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  for (const name of ['cache.key', 'capability.key']) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      try {
        writeSecret(p, randomBytes(32));
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }
  return { auditPublicKey: auditPublicKeyPem(projectId) };
}

const memo = new Map();
function readKey(projectId, name) {
  const k = `${projectId}/${name}`;
  if (!memo.has(k)) {
    const p = join(projectKeyDir(projectId), name);
    if (!existsSync(p)) throw new UnknotError('UK_INTEGRITY', `missing key ${name} for project ${projectId}; run unknot doctor`);
    memo.set(k, readFileSync(p));
  }
  return memo.get(k);
}

export function auditPrivateKey(projectId) {
  return createPrivateKey(readKey(projectId, 'audit.pem'));
}

export function auditPublicKeyPem(projectId) {
  return createPublicKey(auditPrivateKey(projectId)).export({ type: 'spki', format: 'pem' });
}

export const cacheKey = (projectId) => readKey(projectId, 'cache.key');
export const capabilityKey = (projectId) => readKey(projectId, 'capability.key');

export function shredProjectKeys(projectId) {
  rmSync(join(unknotHome(), 'projects', projectId), { recursive: true, force: true });
  for (const k of memo.keys()) if (k.startsWith(`${projectId}/`)) memo.delete(k);
}

export function clearKeyCache() {
  memo.clear();
}

// ---- signatures ----

export function signText(privateKey, text) {
  return sign(null, Buffer.from(text), privateKey).toString('base64');
}

export function verifyText(publicKeyPem, text, signature) {
  try {
    return verify(null, Buffer.from(text), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function keyFingerprint(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex').slice(0, 32)}`;
}

// ---- symmetric encryption for the cache ----

const MAGIC = Buffer.from('UKE1');

export function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(key, blob) {
  if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) {
    throw new UnknotError('UK_INTEGRITY', 'not an Unknot-encrypted blob');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  decipher.setAuthTag(blob.subarray(16, 32));
  try {
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
  } catch {
    throw new UnknotError('UK_INTEGRITY', 'encrypted blob failed authentication');
  }
}

// ---- approver keys ----

export function approverDir() {
  return secureDir(join(unknotHome(), 'approvers'));
}

/** Generate an approver key protected by `passphrase`. Returns the public key PEM. */
export function generateApproverKey(name, passphrase) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new UnknotError('UK_CONFIG_INVALID', `bad approver name ${name}`);
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new UnknotError('UK_CONFIG_INVALID', 'approver passphrase must be at least 8 characters');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dir = approverDir();
  writeSecret(
    join(dir, `${name}.pem`),
    privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }),
  );
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(dir, `${name}.pub.pem`), pub, { mode: 0o644 });
  return pub;
}

export function loadApproverKey(name, passphrase) {
  const p = join(approverDir(), `${name}.pem`);
  if (!existsSync(p)) throw new UnknotError('UK_NOT_FOUND', `no approver key named ${name}; run unknot keys generate ${name}`);
  try {
    return createPrivateKey({ key: readFileSync(p), passphrase });
  } catch {
    throw new UnknotError('UK_POLICY_DENIED', 'approver key could not be unlocked with that passphrase');
  }
}

export function publicKeyOf(privateKey) {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
}
