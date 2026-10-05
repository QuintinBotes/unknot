import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/runtime/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { parseTraces } from '../../../../adapters/runtime/traces.mjs';
import { redactStatement, stripQuery } from '../../../../adapters/runtime/util.mjs';
import { edge, find, normalised, NOW, run, runFixtures } from './helpers.mjs';

const OTLP = ['traces.otlp.json'];

test('adapter descriptor', () => {
  assert.equal(adapter.id, 'runtime');
  assert.equal(adapter.version, '0.1.0');
  assert.equal(adapter.kind, 'runtime');
  assert.deepEqual(adapter.capabilities, { files: [], executes: [], network: false });
});

test('OTLP: services, calls, endpoints, tables, topics', async () => {
  const facts = await runFixtures({ traces: OTLP });
  facts.forEach(assertFact);
  const checkout = find(facts, 'service:checkout');
  assert.equal(checkout.attrs.span_count, 9);
  assert.equal(checkout.attrs.trace_count, 3);
  assert.equal(checkout.attrs.p95_ms, 200);
  assert.ok(checkout.attrs.error_rate > 0);
  assert.equal(find(facts, 'service:inventory').attrs.fan_out_p95, 0);
  assert.equal(find(facts, 'service:pricing').attrs.fan_out_p95, 1);
  assert.equal(checkout.attrs.depth_p95, 2);

  const cp = edge(facts, 'RUNTIME_CALLS', 'service:checkout', 'service:pricing');
  assert.equal(cp.attrs.calls, 3); // parent/child link and peer.service must not double count
  assert.equal(cp.attrs.per_request_p95, 1);
  assert.equal(cp.provenance.confidence, 'high');
  assert.ok(edge(facts, 'RUNTIME_CALLS', 'service:pricing', 'service:inventory'));
  const ext = edge(facts, 'RUNTIME_CALLS', 'service:checkout', 'service:payments-gateway');
  assert.equal(ext.provenance.confidence, 'medium'); // declared by peer.service, callee unobserved
  assert.equal(edge(facts, 'RUNTIME_CALLS', 'service:checkout', 'service:inventory'), undefined);

  assert.ok(edge(facts, 'EXPOSES', 'service:checkout', 'endpoint:GET /orders/{id}'));
  assert.ok(edge(facts, 'EXPOSES', 'service:inventory', 'endpoint:GET /stock/{sku}'));
  assert.ok(edge(facts, 'QUERIES', 'service:inventory', 'table:public.stock'));
  assert.ok(edge(facts, 'MUTATES', 'service:inventory', 'table:public.stock')); // via db.sql.table
  assert.ok(edge(facts, 'MUTATES', 'service:inventory', 'table:public.audit_log')); // via statement parse
  assert.ok(edge(facts, 'PUBLISHES', 'service:checkout', 'topic:orders.created'));
  assert.ok(edge(facts, 'SUBSCRIBES', 'service:inventory', 'topic:orders.created'));
  // Messaging is asynchronous: not a RUNTIME_CALLS edge.
  assert.equal(edge(facts, 'RUNTIME_CALLS', 'service:checkout', 'service:inventory'), undefined);
});

test('OTLP: A->B->A cycle recorded on both services', async () => {
  const facts = await runFixtures({ traces: OTLP });
  for (const n of ['service:checkout', 'service:pricing']) {
    assert.deepEqual(find(facts, n).attrs.call_cycles, [{ path: 'checkout>pricing>checkout', traces: 1 }]);
  }
  assert.equal(find(facts, 'service:inventory').attrs.call_cycles, undefined);
});

test('every fact carries provenance, observed_window and expires_at (default ttl 14d)', async () => {
  const facts = await runFixtures({ traces: OTLP });
  for (const f of facts) {
    assert.equal(f.provenance.source_type, 'trace');
    assert.equal(f.provenance.extractor, 'runtime@0.1.0');
    assert.match(f.provenance.source_ref, /^traces\.otlp\.json#.+/);
    assert.ok(f.attrs.observed_window.start <= f.attrs.observed_window.end);
    assert.equal(Date.parse(f.attrs.expires_at) - Date.parse(f.attrs.observed_window.end), 14 * 86_400_000);
  }
  const custom = await runFixtures({ traces: OTLP }, { ttl_days: 3 });
  assert.equal(Date.parse(custom[0].attrs.expires_at) - Date.parse(custom[0].attrs.observed_window.end), 3 * 86_400_000);
});

test('Jaeger, Zipkin and JSONL derive facts identical to OTLP', async () => {
  const base = normalised(await runFixtures({ traces: OTLP }));
  for (const f of ['traces.jaeger.json', 'traces.zipkin.json', 'traces.otlp.jsonl']) {
    const other = normalised(await runFixtures({ traces: [f] }));
    assert.deepEqual(other, base, f);
  }
});

test('format detection', () => {
  const fmt = (t) => parseTraces(t).meta.format;
  assert.equal(fmt('{"resourceSpans":[]}'), 'otlp-json');
  assert.equal(fmt('{"data":[]}'), 'jaeger-json');
  assert.equal(fmt('[]'), 'zipkin-v2-json');
  assert.equal(fmt('{"resourceSpans":[]}\n{"resourceSpans":[]}\n'), 'otlp-jsonl');
  assert.throws(() => [...parseTraces('{"x":1}').spans]);
});

test('privacy: no literal, secret, query string or dropped attribute in any fact', async () => {
  for (const f of ['traces.otlp.json', 'traces.jaeger.json', 'traces.zipkin.json']) {
    const json = JSON.stringify(await runFixtures({ traces: [f] }));
    for (const secret of ['ABC-SECRET-123', 'ZZ-TOP-SECRET', 'hunter2', '12345', 'SECRETTOKEN', 'LEAKYKEY', 'apikey', 'alice@example.com', 'TOPSECRETBEARER', 'token=']) {
      assert.ok(!json.includes(secret), `${f} leaked ${secret}`);
    }
  }
  const facts = await runFixtures({ traces: OTLP });
  assert.equal(edge(facts, 'QUERIES', 'service:inventory', 'table:public.stock').attrs.statement_shape, 'SELECT sku, qty FROM stock WHERE sku = ? AND qty > ?');
});

test('redactStatement: literals, comments, truncation, unterminated quotes', () => {
  assert.equal(redactStatement("SELECT * FROM t WHERE a = 'x''y' AND b = 42 AND c = 3.5e2 AND d = 0xFF"), 'SELECT * FROM t WHERE a = ? AND b = ? AND c = ? AND d = ?');
  assert.equal(redactStatement("SELECT 1 /* pw=secret */ -- tail secret\nFROM t1"), 'SELECT ? FROM t1');
  assert.equal(redactStatement("UPDATE t SET a = 'oops no close"), 'UPDATE t SET a = ?');
  assert.equal(redactStatement('SELECT "col" FROM "my table x" WHERE "bob smith" = 1'), 'SELECT "col" FROM ? WHERE ? = ?');
  assert.equal(redactStatement('SELECT * FROM t WHERE x = $1'), 'SELECT * FROM t WHERE x = $1');
  assert.equal(redactStatement(`SELECT ${'a, '.repeat(200)} FROM t`).length, 200);
  // A literal straddling the 200-char cut is redacted before truncation.
  const long = `SELECT ${'c, '.repeat(80)} '${'S'.repeat(50)}'`;
  assert.ok(!redactStatement(long).includes('SSS'));
});

test('stripQuery drops scheme, host, query and fragment', () => {
  assert.equal(stripQuery('https://u:p@h.example/a/b?token=1#frag'), '/a/b');
  assert.equal(stripQuery('?only=query'), '/');
});

test('target-derived paths are templated, queries never kept', async () => {
  const doc = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] }, scopeSpans: [{ spans: [{
    traceId: 'a1', spanId: 'b1', name: 'x', kind: 2, startTimeUnixNano: '1788220800000000000', endTimeUnixNano: '1788220800005000000',
    attributes: [{ key: 'http.method', value: { stringValue: 'get' } }, { key: 'http.target', value: { stringValue: '/users/12345/orders/3f2b8c1e-1111-2222-3333-444455556666?session=SESS' } }],
  }] }] }] };
  const facts = await run({ traces: ['t.json'] }, { 't.json': JSON.stringify(doc) });
  assert.ok(find(facts, 'endpoint:GET /users/:id/orders/:id'));
  assert.ok(!JSON.stringify(facts).includes('SESS'));
});

test('edge cases: missing parents, negative durations, duplicates, truncation flag', async () => {
  const mk = (id, parent, svc, kind, start, end) => ({
    traceId: 'c0', spanId: id, ...(parent ? { parentSpanId: parent } : {}), name: id, kind, startTimeUnixNano: String(start), endTimeUnixNano: String(end),
    _svc: svc,
  });
  const base = 1788220800000000000n;
  const spans = [
    mk('01', null, 'a', 2, base, base + 10_000_000n),
    mk('02', 'ff', 'b', 2, base, base + 5_000_000n), // parent never exported
    mk('03', '01', 'c', 2, base + 9_000_000n, base + 1_000_000n), // end before start (clock skew)
    mk('01', null, 'a', 2, base, base + 10_000_000n), // exact duplicate
  ];
  const doc = { resourceSpans: spans.map((s) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: s._svc } }] }, scopeSpans: [{ spans: [{ ...s, _svc: undefined }] }] })) };
  const facts = await run({ traces: ['t.json'] }, { 't.json': JSON.stringify(doc) });
  assert.equal(find(facts, 'service:a').attrs.span_count, 1);
  assert.equal(find(facts, 'service:a').attrs.duplicate_spans, 1);
  assert.equal(find(facts, 'service:c').attrs.p95_ms, 0); // clamped, never negative
  assert.equal(edge(facts, 'RUNTIME_CALLS', 'service:ff', 'service:b'), undefined); // orphan is a root, not a call
  assert.ok(edge(facts, 'RUNTIME_CALLS', 'service:a', 'service:c'));
  assert.equal(find(facts, 'service:b').attrs.fan_out_p95, 0); // orphan is a root: no phantom hop

  const capped = await run({ traces: ['t.json'] }, { 't.json': JSON.stringify(doc) }, { max_spans_per_file: 2 });
  assert.equal(find(capped, 'service:a').attrs.truncated, true);
});

test('service_map sets code_root only for safe repo-relative prefixes', async () => {
  const facts = await runFixtures({ traces: OTLP }, { service_map: { checkout: './services/checkout/', pricing: '../outside', inventory: '/abs' } });
  assert.equal(find(facts, 'service:checkout').attrs.code_root, 'services/checkout');
  assert.equal(find(facts, 'service:pricing').attrs.code_root, undefined);
  assert.equal(find(facts, 'service:inventory').attrs.code_root, undefined);
  assert.ok(!facts.some((f) => f.type === 'module'));
});

test('unreadable or corrupt files are reported, others still processed', async () => {
  const warned = [];
  const facts = await adapter.discover({
    evidence: { traces: ['bad.json', 'missing.json', 'ok.json'], metrics: [], profiles: [], catalogs: ['backstage.yaml'] },
    readText: (p) => { if (p === 'bad.json') return '{nope'; if (p === 'ok.json') return '{"data":[]}'; throw new Error('ENOENT'); },
    options: {}, now: NOW, warn: (m) => warned.push(m),
  });
  assert.deepEqual(facts.failures.map((f) => f.file).sort(), ['bad.json', 'missing.json']);
  assert.equal(warned.length, 2);
});

// A guard against super-linear regressions (quadratic work on 200k spans takes minutes), with
// headroom for loaded machines: under the parallel suite it once took 3.8 s against a 3 s bound.
test('performance: 200k spans in well under 10 seconds', async () => {
  const base = 1788220800000000000n;
  const reqSpans = [];
  const svcs = ['gw', 'api', 'db'];
  let n = 0;
  const perSvc = new Map(svcs.map((s) => [s, []]));
  for (let t = 0; t < 40_000; t += 1) {
    const traceId = t.toString(16).padStart(32, '0');
    for (let i = 0; i < 5; i += 1) {
      const svc = svcs[Math.min(2, i)];
      n += 1;
      const start = base + BigInt(t) * 1_000_000n + BigInt(i) * 1000n;
      perSvc.get(svc).push({
        traceId, spanId: n.toString(16).padStart(16, '0'), ...(i ? { parentSpanId: (n - 1).toString(16).padStart(16, '0') } : {}),
        name: 'op', kind: i === 0 ? 2 : i % 2 ? 3 : 2, startTimeUnixNano: String(start), endTimeUnixNano: String(start + 900_000n),
        attributes: [{ key: 'http.method', value: { stringValue: 'GET' } }, { key: 'http.route', value: { stringValue: '/r' } }, { key: 'user.id', value: { stringValue: `u${t}` } }],
      });
    }
  }
  reqSpans.push(...[...perSvc].map(([s, spans]) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: s } }] }, scopeSpans: [{ spans }] })));
  const text = JSON.stringify({ resourceSpans: reqSpans });
  assert.equal(n, 200_000);
  const t0 = performance.now();
  const facts = await run({ traces: ['big.json'] }, { 'big.json': text });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
  assert.equal(facts.filter((f) => f.type === 'service').reduce((a, f) => a + f.attrs.span_count, 0), 200_000);
});
