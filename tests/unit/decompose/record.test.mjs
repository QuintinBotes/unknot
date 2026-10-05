// Decompose records: scope, stable ids, names, metrics and evidence, seams, reverse
// dependencies, driver provenance, readiness, summary, list and show.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { boundaryMetrics, describeName, disambiguate } = await import('../../../runtime/decompose/candidates.mjs');
const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { fingerprintOf, listRecords, showRecord, summaryLine } = await import('../../../runtime/decompose/records.mjs');
const { readinessFor, selectTreatment } = await import('../../../runtime/decompose/select.mjs');

const p = prov({ source_type: 'ast', extractor: 'test@1.0.0' });
const mod = (path, attrs = {}) => nodeFact('module', path, { path, attrs }, p);
const imp = (a, b, attrs = {}) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, attrs, p);

// ---- names ------------------------------------------------------------------------------

describe('names', () => {
  const g = Graph.fromFacts([
    ...['A', 'B', 'C'].map((n) => mod(`src/shop/${n}.cs`, { namespace: 'Shop.Catalog.Products' })),
    mod('src/shop/D.cs', { namespace: 'Shop.Catalog' }),
    mod('src/other/E.cs', { namespace: 'Shop.Billing' }),
    mod('src/other/F.cs'),
  ]);
  const ids = (...n) => n.map((x) => `module:${x}`);

  test('the longest namespace shared by at least half of the members names the candidate', () => {
    const r = describeName(ids('src/shop/A.cs', 'src/shop/B.cs', 'src/shop/C.cs', 'src/shop/D.cs', 'src/other/E.cs'), g);
    assert.deepEqual(r, { name: 'Shop.Catalog.Products', basis: 'namespace' });
    assert.equal(describeName(ids('src/shop/D.cs', 'src/other/E.cs', 'src/other/F.cs'), g).name, 'Shop');
  });

  test('without namespaces the dominant directory below the common prefix names it', () => {
    const none = Graph.fromFacts([mod('src/a/x/1.ts'), mod('src/a/x/2.ts'), mod('src/a/y/3.ts')]);
    assert.deepEqual(describeName(ids('src/a/x/1.ts', 'src/a/x/2.ts', 'src/a/y/3.ts'), none), { name: 'src/a/x', basis: 'directory' });
    assert.equal(describeName(ids('src/a/x/1.ts', 'src/a/x/2.ts'), none).name, 'src/a/x');
  });

  test('two candidates that share a name get their hub file appended', () => {
    const list = disambiguate([
      { name: 'Shop.Catalog', modules: ['module:a/ProductService.cs'], top_files: ['a/ProductService.cs'] },
      { name: 'Shop.Catalog', modules: ['module:b/Pricing.cs'], top_files: ['b/Pricing.cs'] },
      { name: 'Shop.Billing', modules: ['module:c/x.cs'], top_files: ['c/x.cs'] },
    ]);
    assert.deepEqual(list.map((c) => c.name), ['Shop.Catalog (hub ProductService.cs)', 'Shop.Catalog (hub Pricing.cs)', 'Shop.Billing']);
  });
});

// ---- boundary metrics ---------------------------------------------------------------------

describe('boundary metrics', () => {
  const facts = [
    ...['in/a.ts', 'in/b.ts'].map((m) => mod(m)),
    mod('out/real.ts'), mod('out/guess.ts'), mod('out/real.test.ts', { is_test: true }), mod('out/other.ts'),
    imp('in/a.ts', 'in/b.ts'),
    imp('in/a.ts', 'out/real.ts'),
    imp('in/b.ts', 'out/real.ts'),
    imp('in/a.ts', 'out/other.ts'),
    imp('in/a.ts', 'out/guess.ts', { via: 'namespace' }),
    imp('in/b.ts', 'out/real.test.ts'),
    imp('out/other.ts', 'in/b.ts'),
  ];
  const g = Graph.fromFacts(facts);
  const members = new Set(['module:in/a.ts', 'module:in/b.ts']);
  const run = (graph = g) => boundaryMetrics(graph, members, { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0 });

  test('namespace-only imports are not counted, test imports are counted apart, and targets are listed', () => {
    const { metrics, details, gaps } = run();
    assert.equal(metrics['boundary.reverse_deps'], 3);
    assert.equal(metrics['boundary.reverse_deps_test'], 1);
    assert.equal(metrics['boundary.reverse_deps_low_confidence'], 1);
    assert.deepEqual(details.reverse_targets, [{ module: 'module:out/real.ts', edges: 2 }, { module: 'module:out/other.ts', edges: 1 }]);
    assert.ok(gaps.some((x) => /resolved only by namespace/.test(x)));
    assert.equal(details.evidence['boundary.reverse_deps'].length, 3);
  });

  test('a cycle through the boundary records its members and closing edges as evidence', () => {
    const { details } = run();
    assert.ok(details.evidence['cycle.size'] === undefined || Array.isArray(details.evidence['cycle.size']));
    const cyc = boundaryMetrics(g, members, { tableOwners: new Map(), sccs: [['module:in/b.ts', 'module:out/other.ts']], candidateOf: () => null, self: 0 });
    assert.equal(cyc.metrics['cycle.size'], 2);
    assert.ok(cyc.details.evidence['cycle.size'].includes('module:out/other.ts'));
    assert.ok(cyc.details.evidence['cycle.size'].some((e) => e.startsWith('IMPORTS|')));
  });

  test('a cycle wholly inside the candidate is recorded with its cut and named apart from the crossing size', () => {
    const { metrics, details } = boundaryMetrics(Graph.fromFacts([...facts, imp('in/b.ts', 'in/a.ts')]), members, { tableOwners: new Map(), sccs: [['module:in/a.ts', 'module:in/b.ts']], candidateOf: () => null, self: 0 });
    assert.equal(metrics['cycle.size'], 0);
    assert.equal(metrics['cycle.crossing_size'], 0);
    assert.equal(metrics['boundary.internal_cycle_size'], 2);
    assert.deepEqual(details.cycle_detail.members, ['module:in/a.ts', 'module:in/b.ts']);
    assert.equal(details.cycle_detail.cut.length, 1);
  });

  test('no seam in the repository is an evidence gap that names the traces and catalogs to import', () => {
    const { metrics, gaps } = run();
    assert.equal(metrics['requests.interceptable'], 0);
    const gap = gaps.find((x) => /no routable seam \(HTTP route or queue entry\) visible in this repository/.test(x));
    assert.ok(gap);
    assert.match(gap, /another repository or a gateway/);
    assert.match(gap, /evidence\.traces/);
    assert.match(gap, /evidence\.catalogs/);
  });

  test('a traced service whose code root maps into the candidate makes it interceptable', () => {
    const svc = (attrs) => nodeFact('service', 'billing-api', { attrs }, p);
    const traced = Graph.fromFacts([...facts, svc({ code_root: 'in', span_count: 12 })]);
    assert.equal(run(traced).metrics['requests.interceptable'], 1);
    assert.deepEqual(run(traced).details.evidence['requests.interceptable'], ['service:billing-api']);
    const untraced = Graph.fromFacts([...facts, svc({ code_root: 'in' })]);
    assert.equal(run(untraced).metrics['requests.interceptable'], 0);
    const elsewhere = Graph.fromFacts([...facts, svc({ code_root: 'out', span_count: 3 })]);
    assert.equal(run(elsewhere).metrics['requests.interceptable'], 0);
  });
});

// ---- selection, readiness, summary ---------------------------------------------------------

const signals = {
  'tests.present': 3, 'boundary.robust': 1, 'cycle.size': 0, 'boundary.shared_table_writers': 0, 'boundary.cross_joins': 0,
  'boundary.reverse_deps': 0, 'requests.interceptable': 0, 'driver.any': 0, 'boundary.interface_count': 3, 'module.consumers': 4,
};

describe('selection and readiness', () => {
  test('a seam-less strangler rejection says so in the words of the precondition', () => {
    const r = selectTreatment({ target: 'backend', signals: { ...signals, 'driver.any': 1, 'driver.independent_deploy': 1 }, drivers: ['independent_deploy'] });
    const t3 = r.rejected_treatments.find((x) => x.treatment === 'T3');
    assert.match(t3.reason, /no routable seam \(HTTP route or queue entry\) visible in this repository/);
  });

  test('non-retain selections carry a selection_reason; retain carries a retain_reason', () => {
    const r = selectTreatment({ target: 'backend', signals, drivers: [] });
    if (r.treatment !== 'T0') {
      assert.ok(r.selection_reason.length > 0);
      assert.equal(r.retain_reason, null);
    }
    const none = selectTreatment({ target: 'backend', signals: { ...signals, 'boundary.robust': 0 }, drivers: [] });
    assert.equal(none.treatment, 'T0');
    assert.equal(none.selection_reason, null);
    assert.ok(none.retain_reason);
  });

  test('readiness lists T3 and T2 predicates with unmeasured signals as null and the evidence needed', () => {
    const rows = readinessFor({ target: 'backend', signals, treatments: ['T3', 'T2'] });
    assert.ok(rows.some((r) => r.treatment === 'T3') && rows.some((r) => r.treatment === 'T2'));
    const own = rows.find((r) => r.treatment === 'T3' && r.signal === 'ownership.alignment' && r.kind === 'applicability');
    assert.equal(own.value, null);
    assert.equal(own.met, null);
    assert.match(own.missing_evidence, /CODEOWNERS|catalog/);
    const seam = rows.find((r) => r.treatment === 'T3' && r.signal === 'requests.interceptable');
    assert.deepEqual([seam.value, seam.op, seam.threshold, seam.met, seam.missing_evidence], [0, '==', 1, false, null]);
    for (const r of rows) assert.ok(['treatment', 'signal', 'value', 'op', 'threshold', 'met', 'missing_evidence'].every((k) => k in r));
  });

  test('a summary line names the top reason the next more invasive treatment was rejected', () => {
    const line = summaryLine({ id: 'DEC-0001', treatment: 'T1', confidence: 'low', candidate: { name: 'Orders', modules: ['a', 'b'] }, rejected_treatments: [{ treatment: 'T3', reason: 'no driver' }, { treatment: 'T2', reason: 'cycle' }, { treatment: 'T0', reason: 'n/a' }] });
    assert.deepEqual(line, { id: 'DEC-0001', name: 'Orders', size: 2, treatment: 'T1', confidence: 'low', next_rejected: 'T2: cycle' });
  });

  test('the fingerprint depends on target, drivers and members, not on their order', () => {
    const a = fingerprintOf({ target: 'backend', drivers: ['x', 'y'], modules: ['m2', 'm1'] });
    assert.equal(a, fingerprintOf({ target: 'backend', drivers: ['y', 'x'], modules: ['m1', 'm2'] }));
    assert.notEqual(a, fingerprintOf({ target: 'frontend', drivers: ['x', 'y'], modules: ['m1', 'm2'] }));
    assert.notEqual(a, fingerprintOf({ target: 'backend', drivers: ['x'], modules: ['m1', 'm2'] }));
    assert.notEqual(a, fingerprintOf({ target: 'backend', drivers: ['x', 'y'], modules: ['m1'] }));
  });
});

// ---- the command on a mapped repository ----------------------------------------------------

const file = (names, own, other) => Object.fromEntries(names.map((n, i) => [`shop/${own}/${n}.js`, `${names.filter((m) => m !== n).map((m) => `import { f_${m} } from './${m}.js';`).join('\n')}${i === 0 && other ? `\nimport { ${other.fn} } from '${other.from}';` : ''}\nexport function f_${n}() { return ${names.filter((m) => m !== n).map((m) => `f_${m}`).join('() + ')}(); }\n`]));
const catalog = ['c0', 'c1', 'c2', 'c3', 'c4'];
const billing = ['b0', 'b1', 'b2', 'b3', 'b4'];
const extra = { ...file(catalog, 'catalog'), ...file(billing, 'billing', { fn: 'f_c0', from: '../catalog/c0.js' }) };

const r = await analyse('modular-monolith', { extra, skipDiagnose: true });
const recordFiles = () => readdirSync(join(r.ctx.paths.base, 'decompositions')).sort();

describe('decompose command', () => {
  test('a glob scope selects its modules, and the result reports the scope', async () => {
    const res = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true });
    assert.equal(res.warning, null);
    assert.deepEqual(res.scope.entries, ['shop/**']);
    assert.equal(res.scope.matched, 10);
    assert.ok(res.scope.total > 10);
    assert.deepEqual(res.scope.unresolved, []);
    assert.ok(res.recommendations.length >= 1);
    for (const x of res.details) for (const m of x.candidate.modules) assert.match(m, /^module:shop\//);
  });

  test('a scope that matches nothing, or a missing seed, writes no records and warns', async () => {
    const total = (await decompose(r.ctx, { config: r.config, dryRun: true })).scope.total;
    const none = await decompose(r.ctx, { config: r.config, scope: ['nowhere/**'] });
    assert.equal(none.warning, `scope "nowhere/**" matched 0 of ${total} modules`);
    assert.deepEqual(none.scope, { entries: ['nowhere/**'], matched: 0, total, unresolved: [] });
    assert.deepEqual(none.recommendations, []);
    const seed = await decompose(r.ctx, { config: r.config, scope: ['seed:NoSuchThing~1'] });
    assert.deepEqual(seed.scope.unresolved, ['NoSuchThing']);
    assert.match(seed.warning, /seed not found: NoSuchThing/);
    assert.deepEqual(seed.recommendations, []);
    assert.throws(() => recordFiles(), { code: 'ENOENT' });
  });

  test('a seed scope selects the module and its neighbours', async () => {
    const res = await decompose(r.ctx, { config: r.config, scope: ['seed:shop/billing/b0.js~1'], dryRun: true });
    assert.equal(res.warning, null);
    assert.ok(res.scope.matched >= 5);
  });

  test('a dry run writes nothing, allocates no ids and shows new', async () => {
    const res = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true });
    assert.ok(res.recommendations.every((x) => x.id === 'new'));
    assert.throws(() => recordFiles(), { code: 'ENOENT' });
    assert.equal(r.ctx.store.get("SELECT value FROM sequences WHERE name = 'DEC'")?.value ?? 0, 0);
  });

  test('reruns reuse and overwrite the records, adding nothing', async () => {
    const first = await decompose(r.ctx, { config: r.config, scope: ['shop/**'] });
    const ids = first.recommendations.map((x) => x.id);
    assert.ok(ids.every((id) => /^DEC-\d{4}$/.test(id)));
    const files = recordFiles();
    const second = await decompose(r.ctx, { config: r.config, scope: ['shop/**'] });
    assert.deepEqual(second.recommendations.map((x) => x.id), ids);
    assert.ok(second.recommendations.every((x) => x.reused));
    assert.deepEqual(recordFiles(), files);
    const dry = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true });
    assert.deepEqual(dry.recommendations.map((x) => x.id), ids);
    // A different driver set is a different recommendation and takes a new id.
    const driven = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], drivers: ['build_time'] });
    assert.ok(driven.recommendations.every((x) => !ids.includes(x.id)));
  });

  test('the record carries fingerprint, graph generation, scope, names, metrics and evidence', async () => {
    const [x] = (await decompose(r.ctx, { config: r.config, scope: ['shop/**'] })).details;
    const rec = JSON.parse(readFileSync(join(r.ctx.paths.base, 'decompositions', `${x.id}.json`), 'utf8'));
    assert.match(rec.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(rec.graph_generation, Number(r.ctx.store.meta('generation')));
    assert.deepEqual(rec.scope, { entries: ['shop/**'], matched: 10, total: rec.scope.total });
    assert.ok(['directory', 'namespace'].includes(rec.candidate.name_basis));
    assert.match(rec.candidate.name, /shop\/(catalog|billing)/);
    assert.ok(rec.candidate.top_files.length >= 1 && rec.candidate.top_files.length <= 5);
    for (const k of ['boundary.cohesion', 'boundary.coupling', 'boundary.stability', 'boundary.reverse_deps_test']) assert.equal(typeof rec.candidate.metrics[k], 'number', k);
    for (const f of rec.favoring_signals) {
      assert.ok(Array.isArray(f.evidence) && f.evidence.length <= 20);
      assert.match(f.source, new RegExp(`${f.signal.replace('.', '\\.')}.*graph generation ${rec.graph_generation}|recorded driver`));
    }
    if (rec.treatment === 'T0') assert.ok(rec.retain_reason);
    else {
      assert.ok(rec.selection_reason);
      assert.equal('retain_reason' in rec, false);
    }
    assert.equal(rec.first_slice.scope.include.length, rec.candidate.modules.length);
    assert.equal(rec.first_slice.include_total, rec.candidate.modules.length);
    assert.ok(rec.readiness.some((row) => row.treatment === 'T3') && rec.readiness.some((row) => row.treatment === 'T2'));
    assert.ok(rec.evidence_gaps.some((g) => /no routable seam/.test(g)));
  });

  test('driver provenance applies to the drivers given on the command line', async () => {
    const res = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], drivers: ['independent_deploy'], driverProvenance: { source: 'https://example.com/plan', quote: 'We need to ship billing on its own.' } });
    assert.deepEqual(res.details[0].driver_provenance, [{ driver: 'independent_deploy', source: 'https://example.com/plan', quote: 'We need to ship billing on its own.' }]);
    const bare = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], drivers: ['independent_deploy'], driverProvenance: { source: 'https://example.com/plan' } });
    assert.deepEqual(bare.details[0].driver_provenance, [{ driver: 'independent_deploy', source: 'https://example.com/plan', quote: null }]);
    const cfg = { ...r.config, decomposition: { ...r.config.decomposition, drivers: [{ id: 'build_time', source: 'docs/goals.md', quote: 'Builds take too long.' }] } };
    const fromConfig = await decompose(r.ctx, { config: cfg, scope: ['shop/**'], dryRun: true });
    assert.deepEqual(fromConfig.details[0].driver_provenance, [{ driver: 'build_time', source: 'docs/goals.md', quote: 'Builds take too long.' }]);
  });

  test('list reports stale records once the graph is rebuilt; show returns one record', async () => {
    const [x] = (await decompose(r.ctx, { config: r.config, scope: ['shop/**'] })).details;
    const row = listRecords(r.ctx).find((l) => l.id === x.id);
    assert.deepEqual([row.target, row.treatment, row.confidence, row.size, row.stale], [x.target, x.treatment, x.confidence, x.candidate.modules.length, false]);
    assert.equal(showRecord(r.ctx, x.id).candidate.name, x.candidate.name);
    assert.throws(() => showRecord(r.ctx, 'DEC-9999'), { code: 'UK_NOT_FOUND' });
    assert.throws(() => showRecord(r.ctx, '../x'), { code: 'UK_SCHEMA_INVALID' });
    r.ctx.store.meta('generation', Number(r.ctx.store.meta('generation')) + 1);
    assert.equal(listRecords(r.ctx).find((l) => l.id === x.id).stale, true);
    assert.equal(showRecord(r.ctx, x.id).stale, true);
  });
});
