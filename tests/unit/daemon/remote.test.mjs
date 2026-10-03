// Remote mode: mutual TLS + OIDC JWT + RBAC + tenant isolation. Certificates are generated at
// test time with openssl; the whole file is skipped when openssl is unavailable.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { claimsFor, jwks, makeJwt, makeKey, request } from './_helpers.mjs';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-remote-home-'));

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const opts = { skip: hasOpenssl ? false : 'openssl not available' };

const { createDaemon } = await import('../../../runtime/daemon/server.mjs');
const { openProject } = await import('../../../runtime/context.mjs');

let daemon;
let tls;
let signer;
let tmp;
let seq = 0;

const ssl = (...args) => {
  const r = spawnSync('openssl', args, { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 0, `openssl ${args.join(' ')}\n${r.stderr}`);
};

function issue(name, ext, ca) {
  ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`);
  ssl('req', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`);
  writeFileSync(join(tmp, `${name}.ext`), ext);
  ssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-days', '2', '-extfile', `${name}.ext`, '-out', `${name}.crt`);
}

const token = (over, header) => makeJwt(signer, claimsFor(over), { header });
const hdr = (jwt, tenant = 'acme', extra = {}) => ({ authorization: `Bearer ${jwt}`, 'x-unknot-tenant': tenant, ...extra });
const call = (method, path, headers, body) => request(daemon.url, method, path, { headers: body === undefined ? headers : { 'content-type': 'application/json', 'idempotency-key': `idem-remote-${process.pid}-${++seq}`, ...headers }, body, tls });

before(async () => {
  if (!hasOpenssl) return;
  tmp = mkdtempSync(join(tmpdir(), 'uk-remote-'));
  ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  ssl('req', '-x509', '-new', '-key', 'ca.key', '-subj', '/CN=unknot-test-ca', '-days', '2', '-out', 'ca.crt');
  issue('server', 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', 'ca');
  issue('client', 'extendedKeyUsage=clientAuth\n', 'ca');
  // A second CA the daemon does not trust.
  ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'rogue.key');
  ssl('req', '-x509', '-new', '-key', 'rogue.key', '-subj', '/CN=rogue-ca', '-days', '2', '-out', 'rogue.crt');
  issue('intruder', 'extendedKeyUsage=clientAuth\n', 'rogue');

  signer = makeKey('EdDSA', 'idp-1');
  writeFileSync(join(tmp, 'jwks.json'), JSON.stringify(jwks(signer)));

  const base = join(tmp, 'tenants');
  for (const t of ['acme', 'globex']) {
    mkdirSync(join(base, t), { recursive: true });
    openProject(join(base, t), { create: true });
  }
  const config = {
    daemon: {
      mode: 'remote',
      listen: '127.0.0.1:0',
      tls: { cert: join(tmp, 'server.crt'), key: join(tmp, 'server.key'), client_ca: join(tmp, 'ca.crt') },
      oidc: {
        issuer: 'https://idp.example',
        audience: 'unknot',
        jwks_file: join(tmp, 'jwks.json'),
        role_claim: 'groups',
        role_map: { 'unknot-viewers': ['viewer'], 'unknot-planners': ['planner'], 'unknot-ops': ['operator'], 'unknot-admins': ['admin'] },
      },
      tenants: ['acme', 'globex'],
    },
  };
  daemon = createDaemon({ root: base, config, port: 0 });
  await daemon.listen();
  tls = { ca: readFileSync(join(tmp, 'ca.crt')), cert: readFileSync(join(tmp, 'client.crt')), key: readFileSync(join(tmp, 'client.key')) };
});

after(async () => {
  await daemon?.close();
});

test('remote: HTTPS, and a client without a certificate cannot connect', opts, async () => {
  assert.match(daemon.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  const ok = await request(daemon.url, 'GET', '/v1/healthz', { tls });
  assert.equal(ok.status, 200);
  await assert.rejects(request(daemon.url, 'GET', '/v1/healthz', { tls: { ca: tls.ca } }), 'no client certificate');
});

test('remote: a certificate from an untrusted CA is rejected', opts, async () => {
  await assert.rejects(request(daemon.url, 'GET', '/v1/healthz', { tls: { ca: tls.ca, cert: readFileSync(join(tmp, 'intruder.crt')), key: readFileSync(join(tmp, 'intruder.key')) } }));
});

test('remote: mTLS alone is not enough; a valid JWT is also required', opts, async () => {
  assert.equal((await call('GET', '/v1/runs/run-x', {})).status, 401);
  assert.equal((await call('GET', '/v1/runs/run-x', hdr('garbage'))).status, 401);
  assert.equal((await call('GET', '/v1/runs/run-x', hdr(token({ exp: 1 })))).status, 401);
  assert.equal((await call('GET', '/v1/runs/run-x', hdr(token({ aud: 'other' })))).status, 401);
  assert.equal((await call('GET', '/v1/runs/run-x', hdr(token({}, { alg: 'none' })))).status, 401);
});

test('remote: a token that maps to no Unknot role is denied', opts, async () => {
  const r = await call('GET', '/v1/runs/run-x', hdr(token({ groups: ['unrelated'] })));
  assert.equal(r.status, 403);
  assert.equal(r.json.details.reason, 'no_role');
});

test('remote: RBAC — viewer reads, planner plans, operator applies, only admin exports audit', opts, async () => {
  const viewer = token({ groups: ['unknot-viewers'] });
  const planner = token({ groups: ['unknot-planners'] });
  const operator = token({ groups: ['unknot-ops'] });
  const admin = token({ groups: ['unknot-admins'] });

  assert.equal((await call('GET', '/v1/runs/run-x', hdr(viewer))).status, 404, 'viewer may GET (reaches the handler)');
  assert.equal((await call('POST', '/v1/maps', hdr(viewer), {})).status, 403);
  assert.equal((await call('POST', '/v1/decisions', hdr(viewer), {})).status, 403);
  assert.equal((await call('POST', '/v1/diagnoses', hdr(planner), { bogus: 1 })).status, 400, 'planner reaches the handler');
  assert.equal((await call('POST', '/v1/slices/UK-1/apply', hdr(planner), {})).status, 403);
  assert.equal((await call('POST', '/v1/slices/UK-1/verify', hdr(planner), {})).status, 403);
  assert.equal((await call('POST', '/v1/slices/UK-1/apply', hdr(operator), {})).status, 404, 'operator reaches the handler');
  assert.equal((await call('GET', '/v1/audit/events', hdr(operator))).status, 403);
  assert.equal((await call('GET', '/v1/audit/events', hdr(viewer))).status, 403);

  const audit = await call('GET', '/v1/audit/events', hdr(admin));
  assert.equal(audit.status, 200);
  assert.equal(JSON.parse(audit.text.split('\n')[0]).type, 'unknot.audit.header');

  // Nobody approves through the API, admin included.
  const approve = await call('POST', '/v1/slices/UK-1/approve', hdr(admin), {});
  assert.equal(approve.status, 403);
  assert.match(approve.json.message, /interactive CLI with an approver key/);
});

test('remote: tenant header must be present, well-formed, in the token and in daemon.tenants', opts, async () => {
  const jwt = token({ groups: ['unknot-viewers'], tenants: ['acme', 'initech'] });
  assert.equal((await call('GET', '/v1/runs/run-x', { authorization: `Bearer ${jwt}` })).status, 403, 'missing header');
  assert.equal((await call('GET', '/v1/runs/run-x', hdr(jwt, 'globex'))).status, 403, 'not in token');
  assert.equal((await call('GET', '/v1/runs/run-x', hdr(jwt, 'initech'))).status, 403, 'not in daemon.tenants');
  assert.equal((await call('GET', '/v1/runs/run-x', hdr(jwt, '../acme'))).status, 403, 'traversal');
  assert.equal((await call('GET', '/v1/runs/run-x', hdr(jwt, 'acme'))).status, 404, 'allowed');
});

test('remote: tenants are isolated — each request only touches its own project store', opts, async () => {
  const both = token({ groups: ['unknot-planners'], tenants: ['acme', 'globex'] });
  const acme = await call('POST', '/v1/runs', hdr(both, 'acme'), { command: 'status' });
  assert.equal(acme.status, 201, acme.text);
  assert.equal((await call('GET', `/v1/runs/${acme.json.id}`, hdr(both, 'acme'))).status, 200);
  assert.equal((await call('GET', `/v1/runs/${acme.json.id}`, hdr(both, 'globex'))).status, 404, 'globex cannot see acme runs');
  // The same Idempotency-Key in another tenant is independent state, not a replay or conflict.
  const k = 'shared-key-0001';
  const a = await call('POST', '/v1/runs/' + acme.json.id + '/end', hdr(both, 'acme', { 'idempotency-key': k }), {});
  assert.equal(a.status, 200);
  const b = await call('POST', '/v1/runs', hdr(both, 'globex', { 'idempotency-key': k }), { command: 'status' });
  assert.equal(b.status, 201);
  assert.equal(b.headers['idempotent-replay'], undefined);
});

test('remote: unknown tenant directories are 404, never a walk up to a parent project', opts, async () => {
  // daemon.tenants would normally gate this; prove the directory check independently.
  const base = join(tmp, 'tenants');
  const d2 = createDaemon({
    root: base,
    port: 0,
    config: { daemon: { ...JSON.parse(JSON.stringify({ mode: 'remote', listen: '127.0.0.1:0' })), tls: { cert: join(tmp, 'server.crt'), key: join(tmp, 'server.key'), client_ca: join(tmp, 'ca.crt') }, oidc: { issuer: 'https://idp.example', audience: 'unknot', jwks_file: join(tmp, 'jwks.json'), role_claim: 'groups', role_map: { v: ['viewer'] } }, tenants: ['ghost'] } },
  });
  await d2.listen();
  try {
    const r = await request(d2.url, 'GET', '/v1/runs/run-x', { tls, headers: hdr(token({ groups: ['v'], tenants: ['ghost'] }), 'ghost') });
    assert.equal(r.status, 404);
  } finally {
    await d2.close();
  }
});
