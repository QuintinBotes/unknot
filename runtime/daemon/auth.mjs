// Authentication for the API daemon (spec §24, §16.3).
//
// Local mode: one bearer token in a 0600 file under the user's Unknot home. Remote mode:
// an OIDC-issued JWT checked against a LOCAL JWKS file. There is deliberately no network
// fetch: a daemon that dials out to discover keys can be steered by whoever controls that
// endpoint, and an offline key file is auditable and rotatable by the operator.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnknotError } from '../core/errors.mjs';
import { unknotHome } from '../core/project.mjs';

/** Unknot API roles, weakest first. Rank is the index. */
export const ROLES = Object.freeze(['viewer', 'planner', 'operator', 'admin']);

/** True when `role` is at least `needed` (both must be known roles). */
export const roleAtLeast = (role, needed) => ROLES.indexOf(role) >= 0 && ROLES.indexOf(role) >= ROLES.indexOf(needed);

/** Tenant ids double as directory names, so the grammar is strict. */
export const TENANT_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Compare secrets without leaking length or prefix through timing: hash first, then compare. */
export function constantTimeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** The token carried by an `Authorization: Bearer` header, or null. */
export function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Create (first start) or read the per-project bearer token. The file is created with
 * `wx` so two daemons cannot race to different tokens, and a token file that is readable
 * by group/other is refused rather than silently trusted.
 * @returns {{path: string, token: string, created: boolean}}
 */
export function ensureTokenFile(projectId) {
  if (!/^[a-z0-9-]{8,64}$/.test(projectId ?? '')) throw new UnknotError('UK_CONFIG_INVALID', `bad project id ${projectId}`);
  const dir = join(unknotHome(), 'daemon');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort on filesystems without modes
  }
  const path = join(dir, `${projectId}.token`);
  let created = false;
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
      created = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    throw new UnknotError('UK_INTEGRITY', `daemon token file ${path} is accessible to other users; chmod 600 it or delete it to rotate`, { details: { path } });
  }
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < 32) throw new UnknotError('UK_INTEGRITY', `daemon token file ${path} is too short; delete it to regenerate`, { details: { path } });
  return { path, token, created };
}

const B64URL = /^[A-Za-z0-9_-]+$/;
// The only algorithms accepted, each pinned to one key type. `none` and every HS* variant
// are absent on purpose: HS* with a public key as the secret is the classic confusion attack.
const ALGS = Object.freeze({
  RS256: { kty: 'rsa' },
  ES256: { kty: 'ec', curve: 'prime256v1' },
  EdDSA: { kty: 'ed25519' },
});

/** Parse a JWKS document into a kid → {key, jwk} map. Unusable keys are skipped, never trusted. */
export function parseJwks(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UnknotError('UK_CONFIG_INVALID', 'JWKS file is not valid JSON');
  }
  if (!doc || !Array.isArray(doc.keys)) throw new UnknotError('UK_CONFIG_INVALID', 'JWKS file has no "keys" array');
  const keys = new Map();
  for (const jwk of doc.keys) {
    if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    if (jwk.use && jwk.use !== 'sig') continue;
    try {
      // Never hold private or symmetric material, even if the file carries it.
      const { d, p, q, dp, dq, qi, k, ...pub } = jwk;
      keys.set(jwk.kid, { key: createPublicKey({ key: pub, format: 'jwk' }), jwk: pub });
    } catch {
      // unusable key: ignore
    }
  }
  return keys;
}

/** A JWKS reader that re-reads the file when its mtime changes, so rotation needs no restart. */
export function createJwksProvider(file) {
  let mtime = -1;
  let keys = new Map();
  return () => {
    const m = statSync(file).mtimeMs;
    if (m !== mtime) {
      keys = parseJwks(readFileSync(file, 'utf8'));
      mtime = m;
    }
    return keys;
  };
}

const unauth = (hint) => new UnknotError('UK_POLICY_DENIED', 'invalid or missing credentials', { details: { reason: 'unauthenticated', hint } });

function decodeJson(part, what) {
  if (!B64URL.test(part)) throw unauth(`${what} is not base64url`);
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw unauth(`${what} is not a JSON object`);
  }
}

/**
 * Verify a compact JWS and its registered claims.
 * @param {string} token
 * @param {{keys: Map<string, {key: import('node:crypto').KeyObject, jwk: object}>, issuer: string, audience: string, now?: number, skewSeconds?: number}} opts
 *   `now` is epoch seconds (injectable for tests).
 * @returns {{header: object, claims: object}}
 */
export function verifyJwt(token, { keys, issuer, audience, now = Math.floor(Date.now() / 1000), skewSeconds = 60 }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw unauth('not a compact JWS');
  const header = decodeJson(parts[0], 'header');
  const alg = header.alg;
  // Algorithm allowlist BEFORE any key lookup: the token never gets to choose a weaker scheme.
  if (typeof alg !== 'string' || !Object.hasOwn(ALGS, alg)) throw unauth('algorithm not allowed');
  if (header.crit !== undefined) throw unauth('unsupported critical header');
  if (typeof header.kid !== 'string' || !keys.has(header.kid)) throw unauth('unknown key id');
  const { key, jwk } = keys.get(header.kid);
  const want = ALGS[alg];
  if (key.asymmetricKeyType !== want.kty) throw unauth('key type does not match algorithm');
  if (want.curve && key.asymmetricKeyDetails?.namedCurve !== want.curve) throw unauth('curve does not match algorithm');
  if (want.kty === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw unauth('RSA key too small');
  if (jwk.alg && jwk.alg !== alg) throw unauth('key is bound to a different algorithm');
  if (!B64URL.test(parts[2])) throw unauth('signature is not base64url');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  let ok = false;
  try {
    if (alg === 'RS256') ok = cryptoVerify('sha256', data, key, sig);
    else if (alg === 'ES256') ok = sig.length === 64 && cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    else ok = cryptoVerify(null, data, key, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw unauth('bad signature');

  const claims = decodeJson(parts[1], 'payload');
  if (claims.iss !== issuer) throw unauth('issuer mismatch');
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(audience)) throw unauth('audience mismatch');
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw unauth('exp missing');
  if (now > claims.exp + skewSeconds) throw unauth('token expired');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || now + skewSeconds < claims.nbf)) throw unauth('token not yet valid');
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > now + skewSeconds)) throw unauth('issued in the future');
  if (typeof claims.sub !== 'string' || !claims.sub) throw unauth('sub missing');
  return { header, claims };
}

/** Read a possibly dotted claim path (`realm_access.roles`) as an array of strings. */
function claimValues(claims, path) {
  let v = claims;
  for (const seg of String(path).split('.')) {
    if (v === null || typeof v !== 'object') return [];
    v = v[seg];
  }
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x) => typeof x === 'string');
}

/**
 * Highest Unknot role granted by the token's IdP groups, or null (the caller denies).
 * Only values that appear in `role_map` count; an IdP group literally named "admin" grants
 * nothing unless the operator mapped it.
 */
export function mapRole(claims, { role_claim: roleClaim, role_map: roleMap }) {
  if (!roleClaim || !roleMap) return null;
  let best = -1;
  for (const value of claimValues(claims, roleClaim)) {
    if (!Object.hasOwn(roleMap, value)) continue;
    for (const r of roleMap[value]) best = Math.max(best, ROLES.indexOf(r));
  }
  return best >= 0 ? ROLES[best] : null;
}

/**
 * Validate the requested tenant against the token and the daemon's allowlist.
 * @returns {string} the tenant id
 */
export function checkTenant(claims, header, allowed) {
  if (typeof header !== 'string' || !TENANT_RE.test(header)) {
    throw new UnknotError('UK_POLICY_DENIED', 'X-Unknot-Tenant header missing or malformed', { details: { reason: 'tenant' } });
  }
  const granted = Array.isArray(claims.tenants) ? claims.tenants : [];
  if (!granted.includes(header) || !(allowed ?? []).includes(header)) {
    throw new UnknotError('UK_POLICY_DENIED', 'not authorised for this tenant', { details: { reason: 'tenant' } });
  }
  return header;
}
