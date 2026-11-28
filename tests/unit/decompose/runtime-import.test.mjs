// `unknot import runtime`: row validation, matching onto graph nodes, storage and
// re-import, and decompose reading the imported volumes as a measured signal that lifts
// the static-only confidence cap.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { run } = await import('../../../runtime/cli/commands/import.mjs');
const { parseArgs } = await import('../../../runtime/cli/util.mjs');
const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { edgeFact, nodeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { buildAffinity } = await import('../../../runtime/decompose/affinity.mjs');
const { matchRows, parseImport, parseWindow } = await import('../../../adapters/runtime/imports.mjs');
const { COVERAGE_THRESHOLD, ageGaps, capConfidence, freshnessOf } = await import('../../../runtime/decompose/runtime-evidence.mjs');

const SAMPLE = readFileSync(new URL('../../fixtures/runtime/import-table.csv', import.meta.url), 'utf8');
const NOW = '2026-10-06T00:00:00.000Z';

const imports = (names, self, extra = '') => names.filter((m) => m !== self).map((m) => `import { f_${m} } from './${m}.js';`).join('\n') + extra;
const group = (dir, names, extras = {}) => Object.fromEntries(names.map((n) => [`shop/${dir}/${n}.js`, `${imports(names, n, extras[n] ?? '')}\nexport function f_${n}() { return 1; }\n`]));
const o = ['o0', 'o1', 'o2', 'o3', 'o4'];
const s = ['s0', 's1', 's2', 's3', 's4'];
const repo = () => analyse('modular-monolith', {
  extra: { ...group('orders', o, { o0: "\nimport { f_s0 } from '../stock/s0.js';", o1: "\nimport { f_s1 } from '../stock/s1.js';" }), ...group('stock', s) },
  skipDiagnose: true,
});
let r = await repo();

async function importCli(...argv) {
  const { positional, flags } = parseArgs([...argv, '--cwd', r.dir]);
  let out = '';
  const w = process.stdout.write;
  process.stdout.write = (c) => { out += c; return true; };
  try {
    await run({ positional, flags });
  } finally {
    process.stdout.write = w;
  }
  return out;
}

const put = (name, text) => {
  mkdirSync(join(r.dir, 'exports'), { recursive: true });
  writeFileSync(join(r.dir, 'exports', name), text);
  return `exports/${name}`;
};
const runtimeEdges = (g) => g.edges('RUNTIME_CALLS').filter((e) => e.attrs.imported);

describe('import table parsing', () => {
  test('CSV and JSON rows validate; a bad row is named by its number', () => {
    const csv = parseImport(SAMPLE, { now: NOW });
    assert.equal(csv.rows.length, 7);
    assert.equal(csv.rows[6].p95_ms, null);
    const json = parseImport(JSON.stringify({ rows: [{ caller: 'a', callee: 'b', count: 3, window: 'PT1H' }] }), { now: NOW });
    assert.equal(json.rows[0].window.end, NOW);
    const bad = parseImport('caller,callee,count,window\na,b,-1,P1D\na,b,2,soon\na,b,2,P1D\n', { now: NOW });
    assert.deepEqual(bad.invalid.map((x) => x.row), [1, 2]);
    assert.match(bad.invalid[0].error, /count/);
    assert.throws(() => parseImport('caller,callee\na,b\n', { now: NOW }), /count, window/);
  });

  test('a window is an ISO interval or a duration ending at the import time', () => {
    assert.deepEqual(parseWindow('2026-09-01T00:00:00Z/2026-09-02T00:00:00Z', NOW), { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' });
    assert.deepEqual(parseWindow('P7D', NOW), { start: '2026-09-29T00:00:00.000Z', end: NOW });
    assert.deepEqual(parseWindow('24h', NOW).start, '2026-10-05T00:00:00.000Z');
    assert.throws(() => parseWindow('2026-09-02T00:00:00Z/2026-09-01T00:00:00Z', NOW), /before/);
    assert.throws(() => parseWindow('P', NOW));
  });
});

describe('matching onto graph nodes', () => {
  const p = prov({ source_type: 'ast', extractor: 'test@1.0.0' });
  const g = Graph.fromFacts([
    nodeFact('module', 'src/a.ts', { path: 'src/a.ts' }, p),
    nodeFact('module', 'src/orders/x.ts', { path: 'src/orders/x.ts' }, p),
    nodeFact('endpoint', 'GET /v1/orders/:id', { name: 'GET /v1/orders/:id' }, p),
    nodeFact('service', 'invoicing', { name: 'invoicing' }, p),
    nodeFact('function', 'src/a.ts#run', { name: 'run', path: 'src/a.ts' }, p),
    nodeFact('function', 'src/a.ts#dup', { name: 'dup', path: 'src/a.ts' }, p),
    nodeFact('function', 'src/orders/x.ts#dup', { name: 'dup', path: 'src/orders/x.ts' }, p),
  ]);
  const row = (caller, callee) => ({ caller, callee, operation: null, count: 1, p95_ms: null, error_rate: null, window: { start: NOW, end: NOW }, line: 1 });

  test('routes match by template whatever the parameter is called; symbols, services and paths match by name', () => {
    const rows = [
      row('GET /v1/orders/{orderId}', 'src/a.ts'),
      row('/v1/orders/:id', 'run'),
      row('invoicing', 'src/a.ts#dup'),
      row('shop-checkout', 'src/orders/x.ts'),
    ];
    const { matched, unmatched } = matchRows(g, rows, { serviceMap: { 'shop-checkout': 'src/orders' } });
    assert.deepEqual(matched.map((m) => [m.from, m.to]), [
      ['endpoint:GET /v1/orders/:id', 'module:src/a.ts'],
      ['endpoint:GET /v1/orders/:id', 'function:src/a.ts#run'],
      ['service:invoicing', 'function:src/a.ts#dup'],
      ['service:shop-checkout', 'module:src/orders/x.ts'],
    ]);
    assert.equal(unmatched.length, 0);
  });

  test('an unmatched side is explained, and an ambiguous symbol is not guessed', () => {
    const { matched, unmatched } = matchRows(g, [row('dup', 'src/a.ts'), row('POST /v1/nothing', 'src/a.ts'), row('payments', 'src/a.ts')]);
    assert.equal(matched.length, 0);
    assert.match(unmatched[0].why, /caller: symbol dup is ambiguous/);
    assert.match(unmatched[1].why, /no endpoint or route constant/);
    assert.match(unmatched[2].why, /service_map/);
  });
});

describe('runtime affinity entry modules (#256)', () => {
  const p = prov({ source_type: 'ast', extractor: 'test@1.0.0' });
  const mod = (path) => nodeFact('module', path, { path }, p);
  const contains = (from, to) => edgeFact('CONTAINS', from, to, {}, p);
  const exposes = (from, route) => edgeFact('EXPOSES', from, `endpoint:${route}`, {}, p);
  const affinity = (facts) => buildAffinity(Graph.fromFacts(facts), {
    modules: facts.filter((f) => f.type === 'module').map((f) => f.id),
    weights: { structural: 0, data: 0, evolutionary: 0, semantic: 0, runtime: 1 },
  });
  const coupled = (a) => a.edges.filter((e) => e.parts.R > 0).map((e) => [e.a, e.b]);
  const services = [
    nodeFact('service', 'orders', { attrs: { code_root: 'orders' } }, p),
    nodeFact('service', 'stock', { attrs: { code_root: 'stock' } }, p),
    edgeFact('RUNTIME_CALLS', 'service:orders', 'service:stock', { calls: 40 }, p),
  ];

  test('a handler method inside a class makes its module the entry module', () => {
    const spring = (svc, name) => {
      const file = `${svc}/${name}Controller.java`;
      return [
        mod(file),
        mod(`${svc}/${name}Util.java`),
        nodeFact('class', `${file}#${name}Controller`, { path: file }, p),
        nodeFact('method', `${file}#${name}Controller.get`, { path: file }, p),
        nodeFact('endpoint', `GET /${svc}`, {}, p),
        contains(`module:${file}`, `class:${file}#${name}Controller`),
        contains(`class:${file}#${name}Controller`, `method:${file}#${name}Controller.get`),
        exposes(`method:${file}#${name}Controller.get`, `GET /${svc}`),
      ];
    };
    assert.deepEqual(coupled(affinity([...services, ...spring('orders', 'Order'), ...spring('stock', 'Stock')])), [
      ['module:orders/OrderController.java', 'module:stock/StockController.java'],
    ]);
  });

  test('a module that exposes a route directly keeps being the entry module', () => {
    const ts = (svc) => [mod(`${svc}/routes.ts`), mod(`${svc}/util.ts`), nodeFact('endpoint', `GET /${svc}`, {}, p), exposes(`module:${svc}/routes.ts`, `GET /${svc}`)];
    assert.deepEqual(coupled(affinity([...services, ...ts('orders'), ...ts('stock')])), [['module:orders/routes.ts', 'module:stock/routes.ts']]);
  });
});

describe('unknot import runtime', () => {
  test('attaches counts to the matching edges, lists the unmatched rows, and is idempotent', async () => {
    const file = put('sample.csv', SAMPLE);
    const first = JSON.parse(await importCli('runtime', file, '--source', 'sample', '--json'));
    assert.equal(first.status, 'imported');
    assert.deepEqual([first.rows, first.matched, first.unmatched, first.edges], [7, 4, 3, 3]);
    assert.deepEqual(first.unmatched_rows.map((u) => u.row), [5, 6, 7]);
    assert.match(first.unmatched_rows[0].why, /callee: no module, symbol or service named billing-service/);
    const g = Graph.fromStore(r.ctx.store);
    const edge = g.edges('RUNTIME_CALLS').find((e) => e.id === 'RUNTIME_CALLS|module:shop/orders/o0.js|module:shop/stock/s0.js');
    assert.equal(edge.attrs.calls, 12000);
    assert.equal(edge.attrs.p95_ms, 45.5);
    assert.deepEqual(edge.attrs.sources, ['sample']);
    assert.ok(edge.attrs.observed_window.start < edge.attrs.observed_window.end);
    assert.ok(edge.attrs.expires_at > edge.attrs.observed_window.end);
    // Two operations between the same pair combine: calls add, p95 is the largest, errors weigh by calls.
    const sym = g.edges('RUNTIME_CALLS').find((e) => e.to === 'function:shop/stock/s1.js#f_s1');
    assert.deepEqual([sym.attrs.calls, sym.attrs.p95_ms, sym.attrs.error_rate, sym.attrs.operations], [10000, 60, 0.016, ['release', 'reserve']]);
    assert.equal(g.edges('RUNTIME_CALLS').find((e) => e.id.includes('o2.js')).label, 'observed');

    const generation = r.ctx.store.meta('generation');
    const again = JSON.parse(await importCli('runtime', file, '--source', 'sample', '--json'));
    assert.equal(again.status, 'unchanged');
    assert.equal(again.imported_at, first.imported_at);
    assert.equal(r.ctx.store.meta('generation'), generation);
    assert.equal(runtimeEdges(Graph.fromStore(r.ctx.store)).length, 3);
    assert.match(await importCli('runtime', file, '--source', 'sample'), /Already imported \(unchanged\)[\s\S]*Unmatched rows/);
  });

  test('a newer import with the same source replaces the older one', async () => {
    const file = put('newer.csv', 'caller,callee,operation,count,p95_ms,error_rate,window\nshop/orders/o0.js,shop/stock/s0.js,reserve,5,1,0,P1D\n');
    const res = JSON.parse(await importCli('runtime', file, '--source', 'sample', '--json'));
    assert.equal(res.status, 'replaced');
    const edges = runtimeEdges(Graph.fromStore(r.ctx.store));
    assert.deepEqual(edges.map((e) => e.attrs.calls), [5]);
    // And a map keeps what was imported.
    const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
    await mapRepository(r.ctx, { config: r.config, configDigest: r.cfg.digest });
    assert.deepEqual(runtimeEdges(Graph.fromStore(r.ctx.store)).map((e) => e.attrs.calls), [5]);
  });

  test('refuses a file inside .unknot/, a credential path, an invalid table and a missing source label', async () => {
    mkdirSync(join(r.dir, '.unknot/cache'), { recursive: true });
    writeFileSync(join(r.dir, '.unknot/cache/rows.csv'), SAMPLE);
    await assert.rejects(importCli('runtime', '.unknot/cache/rows.csv'), { code: 'UK_POLICY_DENIED' });
    await assert.rejects(importCli('runtime', join(r.dir, '.unknot/cache/rows.csv')), { code: 'UK_POLICY_DENIED' });
    writeFileSync(join(r.dir, '.env'), SAMPLE);
    await assert.rejects(importCli('runtime', '.env'), { code: 'UK_POLICY_DENIED' });
    await assert.rejects(importCli('runtime', '../outside.csv'), { code: 'UK_SCOPE_VIOLATION' });
    const bad = put('bad.csv', 'caller,callee,count,window\na,b,x,P1D\n');
    await assert.rejects(importCli('runtime', bad), { code: 'UK_SCHEMA_INVALID' });
    await assert.rejects(importCli('runtime', put('ok.csv', SAMPLE), '--source', 'has space'), { code: 'UK_CONFIG_INVALID' });
  });
});

describe('decompose with imported runtime data', () => {
  beforeEach(async () => { r = await repo(); });
  const orders = (res) => res.details.find((x) => x.candidate.name.includes('orders'));

  test('the cross-boundary volume is a measured signal and the static-only cap lifts at enough coverage', async () => {
    await importCli('runtime', put('full.csv', SAMPLE), '--source', 'full');
    const res = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true });
    const rec = orders(res);
    const m = rec.candidate.metrics;
    assert.equal(m['runtime.cross_boundary_calls'], 22000);
    assert.equal(m['runtime.cross_boundary_p95_ms'], 60);
    assert.equal(m['runtime.cross_boundary_error_rate'], 0.0138);
    assert.equal(m['runtime.boundary_coverage'], 1);
    const ev = rec.runtime_evidence;
    assert.equal(ev.label, 'observed');
    assert.ok(ev.window.start < ev.window.end);
    assert.deepEqual(ev.sources, ['import:full']);
    assert.deepEqual([ev.coverage, ev.coverage_threshold, ev.cap], [1, COVERAGE_THRESHOLD, 'lifted']);
    assert.ok(!rec.evidence_gaps.some((g) => /static-only/.test(g)));
  });

  test('below the coverage threshold the cap applies and the gap says so', async () => {
    await importCli('runtime', put('full.csv', SAMPLE), '--source', 'full');
    const one = put('one.csv', 'caller,callee,operation,count,p95_ms,error_rate,window\nshop/orders/o0.js,shop/stock/s0.js,reserve,10,5,0,P1D\nshop/orders/o2.js,shop/orders/o3.js,total,5,1,0,P1D\n');
    await importCli('runtime', one, '--source', 'full');
    const rec = orders(await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true }));
    assert.equal(rec.candidate.metrics['runtime.boundary_coverage'], 0.5);
    assert.equal(rec.runtime_evidence.cap, 'lifted');
    const none = put('none.csv', 'caller,callee,operation,count,p95_ms,error_rate,window\nshop/orders/o2.js,shop/orders/o3.js,total,5,1,0,P1D\n');
    await importCli('runtime', none, '--source', 'full');
    const low = orders(await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true }));
    assert.equal(low.candidate.metrics['runtime.boundary_coverage'], 0);
    assert.equal(low.runtime_evidence, undefined, 'no crossing rows, so no observed signal to report');
    assert.ok(low.evidence_gaps.some((g) => /static-only confidence cap stays/.test(g)));
  });

  test('each runtime signal carries the age of its evidence; past its expiry it is still reported, stale, and confidence is one step lower (#239)', async () => {
    // The window ends 10 days before NOW and expires 14 days (the default ttl) after its end.
    const aged = SAMPLE.replaceAll(',P7D', ',2026-09-19T00:00:00Z/2026-09-26T00:00:00Z');
    await importCli('runtime', put('aged.csv', aged), '--source', 'aged');
    const at = async (now) => orders(await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true, now }));
    const fresh = await at(NOW);
    const later = await at('2026-10-30T00:00:00.000Z');
    const expires = '2026-10-10T00:00:00.000Z';
    assert.deepEqual(fresh.evidence_age['runtime.cross_boundary_calls'], { age_days: 10, expires_at: expires, stale: false });
    const row = (rec) => rec.readiness.find((x) => x.signal === 'traces.available');
    assert.deepEqual([row(fresh).age_days, row(fresh).expires_at, row(fresh).stale], [10, expires, false]);
    assert.ok(!fresh.evidence_gaps.some((g) => /expired/.test(g)));
    assert.equal(fresh.confidence_lowered, undefined);

    // Same evidence, 20 days past its expiry: the value stays, marked stale, one step lower.
    assert.equal(later.candidate.metrics['runtime.cross_boundary_calls'], fresh.candidate.metrics['runtime.cross_boundary_calls']);
    assert.deepEqual(later.evidence_age['runtime.cross_boundary_calls'], { age_days: 34, expires_at: expires, stale: true });
    assert.deepEqual([row(later).age_days, row(later).stale], [34, true]);
    // This boundary's uncapped confidence is medium (one favouring signal).
    assert.equal(fresh.confidence, 'medium');
    assert.equal(later.confidence, 'low');
    assert.match(later.confidence_lowered, /confidence lowered from medium to low: traces\.available, runtime\.cross_boundary_calls.* rest on evidence that expired 20 day\(s\) ago/);
    assert.ok(later.evidence_gaps.some((g) => /runtime evidence expired 20 day\(s\) ago/.test(g)));
  });

  test('evidence without an observed window has no age, and a gap says so (#239)', () => {
    assert.deepEqual(freshnessOf([{ calls: 1 }], NOW), { age_days: null, expires_at: null, stale: false });
    assert.deepEqual(ageGaps('runtime evidence', freshnessOf([{ calls: 1 }], NOW), NOW), ['runtime evidence has no observed window: its age is unknown']);
    // The earliest window end and the earliest expiry among the facts used.
    const f = freshnessOf([{ observed_window: { end: '2026-09-30T12:00:00Z' }, expires_at: '2026-10-14T12:00:00Z' }, { observed_window: { end: '2026-09-26T00:00:00Z' }, expires_at: '2026-10-05T00:00:00Z' }], NOW);
    assert.deepEqual(f, { age_days: 10, expires_at: '2026-10-05T00:00:00Z', stale: true });
  });

  test('static evidence alone caps an extraction at medium; coverage lifts it; nothing raises a lower confidence', () => {
    const lifted = { cap: 'lifted', coverage: 0.8 };
    const applies = { cap: 'applies', coverage: 0.2 };
    assert.deepEqual(capConfidence('high', 'T3', null).confidence, 'medium');
    assert.match(capConfidence('high', 'T3', null).reason, /no runtime evidence/);
    assert.equal(capConfidence('high', 'T3', applies).confidence, 'medium');
    assert.equal(capConfidence('high', 'T3', lifted).confidence, 'high');
    assert.equal(capConfidence('high', 'T1', null).confidence, 'high');
    assert.equal(capConfidence('low', 'T3', null).confidence, 'low');
  });
});
