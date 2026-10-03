import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTelemetry, hostAllowed, sanitizeAttributes } from '../../../runtime/telemetry/otel.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'uk-tel-'));
const quiet = () => {};

test('disabled telemetry is a complete no-op', async () => {
  const root = tmp();
  const tel = createTelemetry({ config: { telemetry: { enabled: false } }, root });
  const span = tel.startSpan('unknot.run', { 'unknot.command': 'map' });
  span.child('map').end('ok');
  span.setAttribute('unknot.files', 3);
  span.end('ok');
  tel.metric('unknot.run.count', 1);
  tel.log('info', 'hello');
  assert.equal(await tel.withSpan('map', {}, async () => 42), 42);
  await tel.flush();
  assert.equal(tel.enabled, false);
  assert.deepEqual(tel.payloads(), {});
  assert.equal(existsSync(join(root, '.unknot')), false);
});

test('allowlist drops unknown keys, paths and non-scalars; redacts and caps strings', () => {
  const out = sanitizeAttributes({
    'unknot.command': 'map',
    'unknot.files': 12,
    'unknot.error_code': `token ghp_${'a1B2c3D4e5'.repeat(4)} leaked`,
    'unknot.detector': 'x'.repeat(500),
    'unknot.tool': 'src/secret/file.ts',
    'file.path': 'src/a.ts',
    'unknot.sql': 'SELECT * FROM users',
    'unknot.mode': ['assist'],
  });
  assert.deepEqual(Object.keys(out).sort(), ['unknot.command', 'unknot.detector', 'unknot.error_code', 'unknot.files']);
  assert.match(out['unknot.error_code'], /\[REDACTED:github-token\]/);
  assert.doesNotMatch(out['unknot.error_code'], /ghp_/);
  assert.equal(out['unknot.detector'].length, 128);
});

test('file exporter writes OTLP/JSON lines with the section 27 hierarchy', async () => {
  const root = tmp();
  const tel = createTelemetry({ config: { mode: 'assist', telemetry: { enabled: true, exporter: 'file' } }, root });
  await tel.withSpan('unknot.run', { 'unknot.command': 'map' }, async () => {
    await tel.withSpan('map', {}, async () => {
      await tel.withSpan('adapter.language', { 'unknot.adapter': 'typescript', 'unknot.path': 'src/a.ts' }, async () => {});
    });
    tel.log('warn', 'partial map', { 'unknot.files': 3 });
  });
  tel.metric('unknot.run.duration', 120, { 'unknot.outcome': 'completed' });
  tel.metric('unknot.proof.obligations', 1, { 'unknot.result': 'pass' });
  tel.metric('not.a.metric', 1);
  await tel.flush();

  const dir = join(root, '.unknot', 'telemetry');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  const [traces, metrics, logs] = [lines.find((l) => l.resourceSpans), lines.find((l) => l.resourceMetrics), lines.find((l) => l.resourceLogs)];

  const spans = traces.resourceSpans[0].scopeSpans[0].spans;
  const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ['adapter.language', 'map', 'unknot.run']);
  assert.match(byName['unknot.run'].traceId, /^[0-9a-f]{32}$/);
  assert.match(byName['unknot.run'].spanId, /^[0-9a-f]{16}$/);
  assert.equal(byName['unknot.run'].parentSpanId, undefined);
  assert.equal(byName.map.parentSpanId, byName['unknot.run'].spanId);
  assert.equal(byName['adapter.language'].parentSpanId, byName.map.spanId);
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  assert.match(byName.map.startTimeUnixNano, /^\d+$/);
  assert.equal(byName['adapter.language'].attributes.some((a) => a.key === 'unknot.path'), false);

  const ms = metrics.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.deepEqual(ms.map((m) => m.name).sort(), ['unknot.proof.obligations', 'unknot.run.duration']);
  const hist = ms.find((m) => m.name === 'unknot.run.duration').histogram.dataPoints[0];
  assert.equal(hist.count, '1');
  assert.equal(hist.sum, 120);
  assert.equal(hist.bucketCounts.length, hist.explicitBounds.length + 1);
  assert.equal(ms.find((m) => m.name === 'unknot.proof.obligations').sum.isMonotonic, true);

  const rec = logs.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(rec.severityText, 'WARN');
  assert.equal(rec.body.stringValue, 'partial map');
  assert.equal(rec.traceId, byName['unknot.run'].traceId);
  assert.equal(traces.resourceSpans[0].resource.attributes[0].key, 'service.name');
});

test('errors set span status and a code, never the message', async () => {
  const tel = createTelemetry({ config: { telemetry: { enabled: true } }, root: tmp() });
  await assert.rejects(tel.withSpan('apply', {}, async () => { throw Object.assign(new Error('secret detail'), { code: 'UK_POLICY_DENIED' }); }));
  const s = tel.payloads().traces.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(s.status.code, 2);
  assert.ok(!JSON.stringify(s).includes('secret detail'));
  assert.ok(s.attributes.some((a) => a.key === 'unknot.error_code' && a.value.stringValue === 'UK_POLICY_DENIED'));
});

test('hostAllowed compares parsed hostnames', () => {
  assert.equal(hostAllowed('http://127.0.0.1:4318', ['127.0.0.1']), true);
  assert.equal(hostAllowed('https://otel.example.com', ['example.com']), true);
  assert.equal(hostAllowed('https://evilexample.com', ['example.com']), false);
  assert.equal(hostAllowed('https://example.com.evil.io', ['example.com']), false);
  assert.equal(hostAllowed('not a url', ['example.com']), false);
});

test('otlp exporter refuses hosts outside network.allowed_domains and warns once', async () => {
  const warnings = [];
  const tel = createTelemetry({
    config: { telemetry: { enabled: true, exporter: 'otlp', endpoint: 'http://127.0.0.1:1' }, network: { allowed_domains: ['example.com'] } },
    root: tmp(),
    stderr: (s) => warnings.push(s),
  });
  tel.startSpan('unknot.run').end('ok');
  tel.log('info', 'x');
  await tel.flush();
  assert.equal(tel.enabled, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /allowed_domains/);
});

test('otlp exporter POSTs OTLP/JSON to an allowlisted endpoint', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, type: req.headers['content-type'], body: JSON.parse(body) });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const tel = createTelemetry({
      config: { telemetry: { enabled: true, exporter: 'otlp', endpoint: `http://127.0.0.1:${port}/` }, network: { allowed_domains: ['127.0.0.1'] } },
      root: tmp(),
    });
    tel.startSpan('unknot.run', { 'unknot.command': 'map' }).end('ok');
    tel.metric('unknot.findings', 4);
    tel.log('info', 'done');
    await tel.flush();
    assert.deepEqual(received.map((r) => r.url).sort(), ['/v1/logs', '/v1/metrics', '/v1/traces']);
    assert.ok(received.every((r) => r.method === 'POST' && r.type === 'application/json'));
    assert.ok(received.find((r) => r.url === '/v1/traces').body.resourceSpans);
  } finally {
    server.close();
  }
});
