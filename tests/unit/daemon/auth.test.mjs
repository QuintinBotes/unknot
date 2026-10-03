import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { b64u, claimsFor, jwks, makeJwt, makeKey, nowSec } from './_helpers.mjs';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-auth-home-'));

const { bearerToken, checkTenant, constantTimeEqual, ensureTokenFile, mapRole, parseJwks, roleAtLeast, verifyJwt } = await import('../../../runtime/daemon/auth.mjs');

const opts = (keys, extra = {}) => ({ keys: parseJwks(JSON.stringify(jwks(...keys))), issuer: 'https://idp.example', audience: 'unknot', ...extra });
const denied = (e) => e.code === 'UK_POLICY_DENIED' && e.details.reason === 'unauthenticated';

for (const alg of ['RS256', 'ES256', 'EdDSA']) {
  test(`${alg}: a valid token verifies; tampering and wrong keys do not`, () => {
    const key = makeKey(alg, 'k1');
    const o = opts([key]);
    const tok = makeJwt(key, claimsFor());
    assert.equal(verifyJwt(tok, o).claims.sub, 'user-1');

    // Tampered payload: swap in an admin group but keep the old signature.
    const [h, , s] = tok.split('.');
    const forged = `${h}.${b64u(claimsFor({ groups: ['root'] }))}.${s}`;
    assert.throws(() => verifyJwt(forged, o), denied);

    // Signed by a different key under the same kid.
    const other = makeKey(alg, 'k1');
    assert.throws(() => verifyJwt(makeJwt(other, claimsFor()), o), denied);
  });
}

test('claims: expired, not-yet-valid, future iat, wrong iss and aud are rejected; skew is tolerated', () => {
  const key = makeKey('ES256', 'k1');
  const o = opts([key]);
  assert.throws(() => verifyJwt(makeJwt(key, claimsFor({ exp: nowSec() - 3600 })), o), denied);
  assert.throws(() => verifyJwt(makeJwt(key, claimsFor({ nbf: nowSec() + 3600 })), o), denied);
  assert.throws(() => verifyJwt(makeJwt(key, claimsFor({ iat: nowSec() + 3600 })), o), denied);
  assert.throws(() => verifyJwt(makeJwt(key, claimsFor({ iss: 'https://evil.example' })), o), denied);
  assert.throws(() => verifyJwt(makeJwt(key, claimsFor({ aud: 'other' })), o), denied);
  assert.throws(() => verifyJwt(makeJwt(key, claimsFor({ exp: undefined })), o), denied);
  // 30 s past expiry and 30 s before nbf are within the 60 s skew.
  verifyJwt(makeJwt(key, claimsFor({ exp: nowSec() - 30 })), o);
  verifyJwt(makeJwt(key, claimsFor({ nbf: nowSec() + 30 })), o);
  // aud may be an array.
  verifyJwt(makeJwt(key, claimsFor({ aud: ['x', 'unknot'] })), o);
});

test('alg none and HS* are rejected, including the public-key-as-HMAC-secret attack', async () => {
  const { createHmac } = await import('node:crypto');
  const key = makeKey('RS256', 'k1');
  const o = opts([key]);
  const payload = b64u(claimsFor());

  const none = `${b64u({ alg: 'none', kid: 'k1' })}.${payload}.`;
  assert.throws(() => verifyJwt(none, o), denied);
  assert.throws(() => verifyJwt(`${b64u({ alg: 'None', kid: 'k1' })}.${payload}.x`, o), denied);

  // Key confusion: HS256 signed with the PEM of the public key (what a naive verifier would use as the secret).
  const pem = key.publicKey.export({ type: 'spki', format: 'pem' });
  const h = b64u({ alg: 'HS256', kid: 'k1' });
  const mac = createHmac('sha256', pem).update(`${h}.${payload}`).digest('base64url');
  assert.throws(() => verifyJwt(`${h}.${payload}.${mac}`, o), denied);
  for (const alg of ['HS384', 'HS512', 'PS256', 'RS512']) {
    assert.throws(() => verifyJwt(`${b64u({ alg, kid: 'k1' })}.${payload}.${mac}`, o), denied);
  }
});

test('an RS256 token cannot be verified against an EC or Ed25519 key (alg/key-type pinning)', () => {
  const ec = makeKey('ES256', 'k-ec');
  const rsa = makeKey('RS256', 'k-ec'); // attacker signs RS256 but names the EC key's kid
  assert.throws(() => verifyJwt(makeJwt(rsa, claimsFor()), opts([ec])), denied);
});

test('unknown kid, missing kid and garbage tokens are rejected', () => {
  const key = makeKey('EdDSA', 'k1');
  const o = opts([key]);
  assert.throws(() => verifyJwt(makeJwt({ ...key, kid: 'nope' }, claimsFor()), o), denied);
  assert.throws(() => verifyJwt(makeJwt(key, claimsFor(), { header: { kid: undefined } }), o), denied);
  for (const bad of ['', 'a.b', 'a.b.c', '...', 'not a jwt']) assert.throws(() => verifyJwt(bad, o), denied);
});

test('JWKS: private material is ignored and keys without a kid are skipped', () => {
  const key = makeKey('ES256', 'k1');
  const withPrivate = { ...key.jwk, d: 'AAAA' };
  const keys = parseJwks(JSON.stringify({ keys: [withPrivate, { ...key.jwk, kid: undefined }, { kty: 'oct', k: 'AAAA', kid: 'sym' }] }));
  assert.deepEqual([...keys.keys()], ['k1']);
  assert.equal(keys.get('k1').jwk.d, undefined);
});

test('role mapping: highest mapped role wins; unmapped groups grant nothing', () => {
  const cfg = { role_claim: 'groups', role_map: { eng: ['planner'], ops: ['operator'], sec: ['admin'], viewers: ['viewer'] } };
  assert.equal(mapRole({ groups: ['eng'] }, cfg), 'planner');
  assert.equal(mapRole({ groups: ['eng', 'ops'] }, cfg), 'operator');
  assert.equal(mapRole({ groups: ['sec', 'viewers'] }, cfg), 'admin');
  assert.equal(mapRole({ groups: ['admin'] }, cfg), null, 'a group merely named admin is not a grant');
  assert.equal(mapRole({}, cfg), null);
  assert.equal(mapRole({ groups: 'eng' }, cfg), 'planner', 'a single string claim works');
  assert.equal(mapRole({ realm: { roles: ['ops'] } }, { ...cfg, role_claim: 'realm.roles' }), 'operator', 'dotted claim path');
  assert.equal(mapRole({ groups: ['__proto__', 'constructor'] }, cfg), null);
});

test('roles are ordered viewer < planner < operator < admin', () => {
  assert.ok(roleAtLeast('admin', 'viewer'));
  assert.ok(roleAtLeast('operator', 'planner'));
  assert.ok(!roleAtLeast('planner', 'operator'));
  assert.ok(!roleAtLeast('viewer', 'planner'));
  assert.ok(!roleAtLeast('bogus', 'viewer'));
});

test('tenant check: header must be well-formed, in the token, and in the daemon allowlist', () => {
  const claims = { tenants: ['acme', 'globex'] };
  assert.equal(checkTenant(claims, 'acme', ['acme', 'initech']), 'acme');
  const denyTenant = (e) => e.code === 'UK_POLICY_DENIED';
  assert.throws(() => checkTenant(claims, 'globex', ['acme']), denyTenant, 'in token but not allowed by daemon');
  assert.throws(() => checkTenant(claims, 'initech', ['initech']), denyTenant, 'allowed by daemon but not in token');
  assert.throws(() => checkTenant(claims, undefined, ['acme']), denyTenant);
  for (const bad of ['../acme', 'ACME', 'a', '-acme', 'acme/x', 'a'.repeat(64)]) {
    assert.throws(() => checkTenant({ tenants: [bad] }, bad, [bad]), denyTenant, bad);
  }
  assert.throws(() => checkTenant({}, 'acme', ['acme']), denyTenant, 'no tenants claim');
});

test('token file: created 0600 with 32 random bytes, stable across calls, loose modes refused', async () => {
  const a = ensureTokenFile('p-testproject');
  assert.ok(a.created);
  assert.equal(statSync(a.path).mode & 0o777, 0o600);
  assert.equal(Buffer.from(a.token, 'base64url').length, 32);
  const b = ensureTokenFile('p-testproject');
  assert.equal(b.created, false);
  assert.equal(b.token, a.token);
  const { chmodSync } = await import('node:fs');
  chmodSync(a.path, 0o644);
  assert.throws(() => ensureTokenFile('p-testproject'), (e) => e.code === 'UK_INTEGRITY');
  assert.throws(() => ensureTokenFile('../escape'), (e) => e.code === 'UK_CONFIG_INVALID');
});

test('bearer parsing and constant-time compare', () => {
  assert.equal(bearerToken('Bearer abc.def-ghi'), 'abc.def-ghi');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken('Bearer a b'), null);
  assert.equal(bearerToken(undefined), null);
  assert.ok(constantTimeEqual('same', 'same'));
  assert.ok(!constantTimeEqual('same', 'sam'));
  assert.ok(!constantTimeEqual('', 'x'));
});
