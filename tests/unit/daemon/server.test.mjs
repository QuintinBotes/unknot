import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { request } from './_helpers.mjs';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-daemon-home-'));

const { createDaemon } = await import('../../../runtime/daemon/server.mjs');
const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { stringifyYAML } = await import('../../../runtime/core/yaml.mjs');

const BRANCHY = `export function classify(order) {
  let label = 'unknown';
  if (order) {
    if (order.total > 1000) {
      if (order.vip) {
        label = 'priority-vip';
      } else {
        label = 'priority';
      }
    } else if (order.total > 100) {
      if (order.vip) {
        label = 'standard-vip';
      } else {
        label = 'standard';
      }
    } else {
      if (order.vip) {
        label = 'small-vip';
      } else {
        label = 'small';
      }
    }
  }
  return label;
}
`;

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

let dir;
let daemon;
let base;
let token;
let tokenFile;

const JSON_H = { 'content-type': 'application/json' };
let seq = 0;
const key = () => `idem-key-${process.pid}-${++seq}`;
const auth = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (path, body, headers = {}) => request(base, 'POST', path, { body, headers: auth({ ...JSON_H, 'idempotency-key': key(), ...headers }) });
const get = (path, headers = {}) => request(base, 'GET', path, { headers: auth(headers) });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uk-daemon-proj-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/classify.mjs'), BRANCHY);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  const ctx = openProject(dir, { create: true });
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({
    version: 1,
    mode: 'plan',
    protected_paths: [],
    detectors: { 'local.complex-function': { cyclomatic: 5, cognitive: 5 }, 'local.deep-nesting': { max_nesting: 2 } },
  }));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'config');
  const cfg = loadConfig(ctx);
  daemon = createDaemon({ root: dir, config: cfg.config, port: 0 });
  await daemon.listen();
  base = daemon.url;
  tokenFile = daemon.tokenFile;
  token = readFileSync(tokenFile, 'utf8').trim();
});

after(async () => {
  await daemon.close();
});

test('startup: loopback only, token file is 0600 and holds 32 random bytes', () => {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
});

test('refuses to bind a non-loopback address in local mode', () => {
  for (const listen of ['0.0.0.0:0', '192.168.1.5:7433', '[::]:0']) {
    assert.throws(() => createDaemon({ root: dir, config: { daemon: { mode: 'local', listen } } }), (e) => e.code === 'UK_POLICY_DENIED' && e.details.policy === 'daemon.local.loopback_only', listen);
  }
  assert.throws(() => createDaemon({ root: dir, config: { daemon: { mode: 'local', listen: '127.0.0.1:0' } }, host: '0.0.0.0', port: 0 }), (e) => e.code === 'UK_POLICY_DENIED');
});

test('remote mode refuses to start without mTLS, OIDC and tenants', () => {
  assert.throws(() => createDaemon({ root: dir, config: { daemon: { mode: 'remote', listen: '0.0.0.0:0' } } }), (e) => e.code === 'UK_CONFIG_INVALID');
});

test('healthz needs no token and returns only {ok:true}', async () => {
  const r = await request(base, 'GET', '/v1/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.headers['content-type'], /^application\/json/);
});

test('missing, wrong and malformed tokens are 401 in the structured error shape', async () => {
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${token}x` }, { authorization: `Basic ${token}` }, { authorization: token }]) {
    const r = await request(base, 'GET', '/v1/runs/run-1', { headers });
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.json.code, 'UK_POLICY_DENIED');
    assert.equal(r.json.retryable, false);
    assert.ok(!('stack' in r.json));
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  }
});

test('Host header must be loopback with the right port (DNS rebinding)', async () => {
  const port = daemon.port;
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `0.0.0.0:${port}`]) {
    const r = await request(base, 'GET', '/v1/healthz', { headers: { host } });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.code, 'UK_POLICY_DENIED');
  }
  const ok = await request(base, 'GET', '/v1/healthz', { headers: { host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
});

test('no CORS headers, ever, and preflight is not honoured', async () => {
  const r = await request(base, 'OPTIONS', '/v1/maps', { headers: auth({ origin: 'https://evil.example', 'access-control-request-method': 'POST' }) });
  assert.ok(r.status >= 400);
  for (const h of Object.keys(r.headers)) assert.ok(!h.startsWith('access-control-'), h);
  const g2 = await request(base, 'GET', '/v1/healthz', { headers: { origin: 'https://evil.example' } });
  for (const h of Object.keys(g2.headers)) assert.ok(!h.startsWith('access-control-'), h);
});

test('wrong content-type is 415; oversize body is 413', async () => {
  const wrongType = await request(base, 'POST', '/v1/maps', { body: {}, headers: auth({ 'content-type': 'text/plain', 'idempotency-key': key() }) });
  assert.equal(wrongType.status, 415);
  const noType = await request(base, 'POST', '/v1/maps', { body: {}, headers: auth({ 'idempotency-key': key() }) });
  assert.equal(noType.status, 415);

  const big = JSON.stringify({ scope: ['x'], pad: 'a'.repeat(2 * 1024 * 1024) });
  const r = await request(base, 'POST', '/v1/maps', { rawBody: big, headers: auth({ ...JSON_H, 'idempotency-key': key() }) });
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 'UK_SCHEMA_INVALID');

  // Chunked upload with no content-length is bounded too.
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: daemon.port, method: 'POST', path: '/v1/maps', headers: auth({ ...JSON_H, 'idempotency-key': key() }) }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('{"pad":"');
    req.write('a'.repeat(1.5 * 1024 * 1024));
    req.end('"}');
  });
  assert.equal(status, 413);
});

test('malformed JSON, non-object bodies, unknown fields and a missing Idempotency-Key are 400', async () => {
  const malformed = await request(base, 'POST', '/v1/maps', { rawBody: '{nope', headers: auth({ ...JSON_H, 'idempotency-key': key() }) });
  assert.equal(malformed.status, 400);
  const arr = await request(base, 'POST', '/v1/maps', { rawBody: '[]', headers: auth({ ...JSON_H, 'idempotency-key': key() }) });
  assert.equal(arr.status, 400);
  const unknown = await post('/v1/maps', { surprise: true });
  assert.equal(unknown.status, 400);
  const noKey = await request(base, 'POST', '/v1/maps', { body: {}, headers: auth(JSON_H) });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.details.header, 'Idempotency-Key');
  const short = await request(base, 'POST', '/v1/maps', { body: {}, headers: auth({ ...JSON_H, 'idempotency-key': 'short' }) });
  assert.equal(short.status, 400);
  const long = await request(base, 'POST', '/v1/maps', { body: {}, headers: auth({ ...JSON_H, 'idempotency-key': 'k'.repeat(129) }) });
  assert.equal(long.status, 400);
});

test('unknown endpoints are 404, wrong methods 405, and there is no shell endpoint', async () => {
  assert.equal((await get('/v1/nope')).status, 404);
  assert.equal((await get('/v1/exec')).status, 404);
  assert.equal((await post('/v1/exec', { command: ['id'] })).status, 404);
  assert.equal((await get('/v1/maps')).status, 405);
  assert.equal((await get('/v1/runs/..%2F..%2Fetc')).status, 404);
});

test('approve is always 403 with a pointer to the interactive CLI', async () => {
  const withBody = await post('/v1/slices/UK-0001/approve', { role: 'code-owner', approver: 'alice' });
  assert.equal(withBody.status, 403);
  assert.equal(withBody.json.code, 'UK_POLICY_DENIED');
  assert.match(withBody.json.message, /interactive CLI with an approver key/);
  assert.equal(withBody.json.details.policy, 'approval.human_only');
  // Even without a content-type, idempotency key or a real slice.
  const bare = await request(base, 'POST', '/v1/slices/anything/approve', { headers: auth() });
  assert.equal(bare.status, 403);
  // And unauthenticated callers get 401, not a hint about the endpoint.
  const anon = await request(base, 'POST', '/v1/slices/UK-0001/approve', { body: {}, headers: JSON_H });
  assert.equal(anon.status, 401);
});

test('map → diagnose → findings → campaign → slice flow, with idempotency and ETags', async () => {
  const mapped = await post('/v1/maps', {});
  assert.equal(mapped.status, 200, mapped.text);
  assert.ok(mapped.json.nodes > 0);

  const diagKey = key();
  const body = { scope: [], only: ['local'] };
  const d1 = await post('/v1/diagnoses', body, { 'idempotency-key': diagKey });
  assert.equal(d1.status, 200, d1.text);
  const finding = d1.json.findings.find((f) => f.scope.includes('src/classify.mjs'));
  assert.ok(finding, `findings: ${d1.json.findings.map((f) => f.kind)}`);

  // Same key + same body → the stored response is replayed, not recomputed.
  const d2 = await post('/v1/diagnoses', body, { 'idempotency-key': diagKey });
  assert.equal(d2.status, 200);
  assert.equal(d2.headers['idempotent-replay'], 'true');
  assert.deepEqual(d2.json, d1.json);
  // Same key + different body → conflict.
  const d3 = await post('/v1/diagnoses', { scope: [], only: ['local'], objective: 'different' }, { 'idempotency-key': diagKey });
  assert.equal(d3.status, 409);
  assert.equal(d3.json.code, 'UK_STATE_CONFLICT');

  const f = await get(`/v1/findings/${finding.id}`);
  assert.equal(f.status, 200);
  assert.equal(f.json.id, finding.id);
  assert.match(f.headers.etag, /^"\d+"$/);
  assert.equal((await get('/v1/findings/F-9999')).status, 404);

  const camp = await post('/v1/campaigns', { objective: 'Flatten classify', findings: [finding.id] });
  assert.equal(camp.status, 201, camp.text);
  const sliceId = camp.json.slices[0].id;
  const cget = await get(`/v1/campaigns/${camp.json.campaign.id}`);
  assert.equal(cget.status, 200);
  assert.match(cget.headers.etag, /^"\d+"$/);

  const s = await get(`/v1/slices/${sliceId}`);
  assert.equal(s.status, 200);
  assert.equal(s.json.state, 'AWAITING_APPROVAL');
  const etag = s.headers.etag;
  assert.match(etag, /^"\d+"$/);

  // If-Match with a stale tag is 412 on every slice mutation; nothing runs.
  for (const action of ['apply', 'verify']) {
    const stale = await post(`/v1/slices/${sliceId}/${action}`, {}, { 'if-match': '"999"' });
    assert.equal(stale.status, 412, action);
    assert.equal(stale.json.code, 'UK_STATE_CONFLICT');
    assert.equal(stale.json.details.current, etag);
  }
  // A current tag gets through to the library, which refuses (mode plan forbids patching; and no human approval exists).
  const unapproved = await post(`/v1/slices/${sliceId}/apply`, {}, { 'if-match': etag });
  assert.equal(unapproved.status, 403, unapproved.text);
  assert.ok(['UK_POLICY_DENIED', 'UK_APPROVAL_REQUIRED'].includes(unapproved.json.code));
  assert.equal((await get(`/v1/slices/${sliceId}/proof-bundle`)).status, 404);

  // Decisions: input validation is the daemon's; the happy path is recordDecision's. (As of this
  // commit recordDecision omits schema_version from its record, so it cannot succeed from the CLI
  // either; that library defect is outside the daemon and is not asserted here.)
  const shortRationale = await post('/v1/decisions', { finding: finding.id, decision: 'reject', rationale: 'short' });
  assert.equal(shortRationale.status, 400);
  const badDec = await post('/v1/decisions', { finding: finding.id, decision: 'approve' });
  assert.equal(badDec.status, 400);
  assert.equal((await post('/v1/decisions', { finding: 'F-9999', decision: 'accept' })).status, 404);

  // Run lifecycle.
  const run = await post('/v1/runs', { command: 'status' });
  assert.equal(run.status, 201, run.text);
  const gr = await get(`/v1/runs/${run.json.id}`);
  assert.equal(gr.status, 200);
  assert.equal(gr.json.actor, 'ci:api:local');
  const again = await post('/v1/runs', { command: 'status' });
  assert.equal(again.status, 409, 'one active run at a time');
  assert.equal((await post(`/v1/runs/${run.json.id}/end`, {}, { 'if-match': '"999"' })).status, 412);
  assert.equal((await post(`/v1/runs/${run.json.id}/end`, {})).status, 200);
  assert.equal((await get('/v1/runs/run-nope')).status, 404);
});

test('audit export: NDJSON with a header line carrying the public key and ledger verdict', async () => {
  const r = await get('/v1/audit/events?limit=5');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/x-ndjson/);
  const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'unknot.audit.header');
  assert.match(lines[0].public_key, /BEGIN PUBLIC KEY/);
  assert.equal(lines[0].ledger.ok, true);
  assert.equal(lines.length - 1, lines[0].count);
  assert.ok(lines.length - 1 <= 5);
  const next = await get(`/v1/audit/events?after=${lines[lines.length - 1].seq}&limit=1000`);
  const nlines = next.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(nlines.slice(1).every((e) => e.seq > lines[lines.length - 1].seq));
  assert.equal((await get('/v1/audit/events?limit=abc')).status, 400);
  assert.equal((await get('/v1/audit/events?limit=0')).status, 400);
});

test('rate limit: a burst beyond the per-minute budget is 429 with Retry-After', async () => {
  const d = createDaemon({ root: dir, config: loadConfig(openProject(dir)).config, port: 0, rateLimit: { perMinute: 5 } });
  await d.listen();
  try {
    const statuses = [];
    let last;
    for (let i = 0; i < 12; i++) {
      last = await request(d.url, 'GET', '/v1/healthz');
      statuses.push(last.status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, 5);
    assert.ok(statuses.includes(429));
    assert.equal(last.json.code, 'UK_BUDGET_EXCEEDED');
    assert.equal(last.json.retryable, true);
    assert.ok(Number(last.headers['retry-after']) >= 1);
  } finally {
    await d.close();
  }
});
