// Records that read right: superseded records and prune, drivers not served, rejection
// order, test code kept out of candidates, folded siblings and readiness detail.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { census, isTestFile } = await import('../../../runtime/graph/census.mjs');
const { boundaryMetrics } = await import('../../../runtime/decompose/candidates.mjs');
const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { brokenBy } = await import('../../../runtime/decompose/perturb.mjs');
const { foldSiblings } = await import('../../../runtime/decompose/fold.mjs');
const { listRecords, pruneRecords, showRecord, summaryLine } = await import('../../../runtime/decompose/records.mjs');
const { selectTreatment } = await import('../../../runtime/decompose/select.mjs');

const p = prov({ source_type: 'ast', extractor: 'test@1.0.0' });
const mod = (path, attrs = {}) => nodeFact('module', path, { path, attrs }, p);
const imp = (a, b, attrs = {}) => edgeFact('IMPORTS', `module:${a}`, `module:${b}`, attrs, p);

// ---- test code in test projects -------------------------------------------------------------

describe('census test rules', () => {
  test('directories named like test projects, and projects that reference a test framework, hold test code', () => {
    const root = mkdtempSync(join(tmpdir(), 'unknot-census-'));
    try {
      const put = (path, text = 'class A {}\n') => {
        mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put('src/Shop.Orders/Order.cs');
      put('src/Shop.Orders/Shop.Orders.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
      put('src/Shop.Orders.Tests/OrderChecks.cs');
      put('src/Shop.UnitTests/Fixture.cs');
      put('src/Shop.IntegrationTests/Fixture.cs');
      put('src/Shop.Specs/Steps.cs');
      put('src/ShopTests/Fixture.cs');
      put('tools/Shop.Verification/Helper.cs');
      put('tools/Shop.Verification/Shop.Verification.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>\n');
      put('tools/Shop.Verification/Deep/Nested/More.cs');
      put('tools/Shop.Checks/Helper.cs');
      put('tools/Shop.Checks/Shop.Checks.csproj', '<Project><ItemGroup><PackageReference Include="NUnit" Version="3" /></ItemGroup></Project>\n');
      put('lib/Shop.Cart/Cart.cs');
      put('lib/Shop.Cart/Shop.Cart.csproj', '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13" /></ItemGroup></Project>\n');
      const { files } = census(root, { config: {} });
      const by = Object.fromEntries(files.map((f) => [f.path, f]));
      for (const path of ['src/Shop.Orders.Tests/OrderChecks.cs', 'src/Shop.UnitTests/Fixture.cs', 'src/Shop.IntegrationTests/Fixture.cs', 'src/Shop.Specs/Steps.cs', 'src/ShopTests/Fixture.cs', 'tools/Shop.Verification/Helper.cs', 'tools/Shop.Verification/Deep/Nested/More.cs', 'tools/Shop.Checks/Helper.cs']) {
        assert.equal(by[path].is_test, true, path);
        assert.equal(by[path].kind, 'test', path);
      }
      for (const path of ['src/Shop.Orders/Order.cs', 'lib/Shop.Cart/Cart.cs']) {
        assert.equal(by[path].is_test, false, path);
        assert.equal(by[path].kind, 'source', path);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the path rule alone knows test project folders; ordinary names are not tests', () => {
    for (const path of ['a/Shop.Tests/X.cs', 'Shop.UnitTests/X.cs', 'a/Shop.FunctionalTests/b/X.cs', 'a/Shop.Specs/X.cs']) assert.equal(isTestFile(path), true, path);
    for (const path of ['a/Shop.Orders/X.cs', 'a/Contests/X.cs', 'a/Shop.Testing/X.cs', 'a/Shop/Tests.cs.bak']) assert.equal(isTestFile(path), false, path);
  });
});

// ---- folded siblings --------------------------------------------------------------------------

describe('folded siblings', () => {
  const g = Graph.fromFacts([
    ...['a', 'b'].map((n) => mod(`src/orders/${n}.cs`)),
    mod('src/orders/helper.cs'), mod('src/orders/deep.cs'), mod('src/orders/shared.cs'), mod('src/elsewhere/own.cs'), mod('src/billing/c.cs'), mod('src/billing/d.cs'),
    mod('src/orders/helper.test.cs', { is_test: true }),
    imp('src/orders/a.cs', 'src/orders/b.cs'),
    imp('src/orders/a.cs', 'src/orders/helper.cs'),
    imp('src/orders/helper.cs', 'src/orders/deep.cs'),
    imp('src/orders/helper.test.cs', 'src/orders/helper.cs'),
    imp('src/orders/a.cs', 'src/orders/shared.cs'),
    imp('src/billing/c.cs', 'src/orders/shared.cs'),
    imp('src/orders/b.cs', 'src/elsewhere/own.cs'),
    imp('src/billing/c.cs', 'src/billing/d.cs'),
  ]);
  const ids = (xs) => xs.map((x) => `module:src/${x}.cs`);
  const eligible = g.nodes('module').map((n) => n.id);

  test('a same-directory module only members import joins the candidate, transitively, and says why', () => {
    const f = foldSiblings(g, [ids(['orders/a', 'orders/b']), ids(['billing/c', 'billing/d'])], eligible).get(0);
    assert.deepEqual(f.map((x) => x.module).sort(), ids(['orders/deep', 'orders/helper']));
    assert.deepEqual(f.find((x) => x.module.endsWith('helper.cs')).importers, ['module:src/orders/a.cs']);
  });

  test('not folded: another importer outside, another directory, or no importer at all', () => {
    const f = foldSiblings(g, [ids(['orders/a', 'orders/b']), ids(['billing/c', 'billing/d'])], eligible).get(0).map((x) => x.module);
    assert.ok(!f.includes('module:src/orders/shared.cs'));
    assert.ok(!f.includes('module:src/elsewhere/own.cs'));
  });

  test('a module already in another candidate is not taken', () => {
    const f = foldSiblings(g, [ids(['orders/a', 'orders/b']), ids(['orders/helper', 'billing/d'])], eligible);
    assert.ok(!(f.get(0) ?? []).some((x) => x.module.endsWith('helper.cs')));
  });

  test('a folded module stops counting as a reverse dependency', () => {
    const outside = boundaryMetrics(g, new Set(ids(['orders/a', 'orders/b'])), { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0 });
    const folded = boundaryMetrics(g, new Set(ids(['orders/a', 'orders/b', 'orders/helper', 'orders/deep'])), { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0 });
    assert.equal(outside.metrics['boundary.reverse_deps'], 3);
    assert.equal(folded.metrics['boundary.reverse_deps'], 2);
  });
});

// ---- rejection reasons and drivers served ---------------------------------------------------------

const base = {
  'tests.present': 3, 'boundary.robust': 1, 'cycle.size': 0, 'boundary.shared_table_writers': 0, 'boundary.cross_joins': 0,
  'boundary.cross_transactions': 0, 'ownership.alignment': 0.95, 'module.co_change_leak': 0.05, 'boundary.reverse_deps': 0,
  'boundary.calls_per_request_p95': 1, 'requests.interceptable': 0, 'traces.available': 1, 'layer.violations': 2,
  'boundary.interface_count': 3, 'boundary.size': 8, 'owners.count': 1, 'contracts.present': 1, 'module.consumers': 4,
  'driver.any': 1, 'driver.independent_deploy': 1,
};
const select = (signals) => selectTreatment({ target: 'backend', signals: { ...base, ...signals }, drivers: ['independent_deploy'] });

describe('rejection reasons', () => {
  test('a treatment that fails two predicates leads with both, signal, value and threshold', () => {
    const t3 = select({ 'boundary.reverse_deps': 12, 'ownership.alignment': 0.3 }).rejected_treatments.find((x) => x.treatment === 'T3');
    assert.match(t3.reason, /^failed: ownership\.alignment=0\.3 \(contraindicated when < 0\.8\); boundary\.reverse_deps=12 \(contraindicated when > 3\)/);
    assert.deepEqual(t3.failed_predicates.map((f) => [f.signal, f.value, f.op, f.threshold]).slice(0, 2), [['ownership.alignment', 0.3, '<', 0.8], ['boundary.reverse_deps', 12, '>', 3]]);
  });

  test('missing evidence follows the failed predicates', () => {
    const t3 = select({ 'boundary.cross_transactions': undefined, 'boundary.reverse_deps': 12 }).rejected_treatments.find((x) => x.treatment === 'T3');
    const failed = t3.reason.indexOf('failed:');
    const missing = t3.reason.indexOf('evidence missing:');
    assert.ok(failed === 0 && missing > failed, t3.reason);
    assert.ok(t3.evidence_needed.includes('boundary.cross_transactions'));
  });

  test('--summary and show carry the same line', () => {
    const r = select({ 'boundary.reverse_deps': 12 });
    const rec = { id: 'DEC-0001', candidate: { name: 'Shop.Orders', modules: ['a', 'b'] }, treatment: r.treatment, confidence: 'medium', rejected_treatments: r.rejected_treatments };
    const next = summaryLine(rec).next_rejected;
    const [t, ...reason] = next.split(': ');
    assert.equal(reason.join(': '), r.rejected_treatments.find((x) => x.treatment === t).reason);
  });
});

describe('drivers not served', () => {
  test('a driver only a more invasive treatment gives is named, with the reason that treatment was rejected', () => {
    const r = select({});
    assert.equal(r.treatment, 'T1');
    const [d] = r.drivers_not_served;
    assert.equal(d.driver, 'independent_deploy');
    assert.ok(d.would_be_served_by.includes('T3'));
    assert.match(d.reason, /^modularizing in place does not give independent deployment; /);
    assert.match(d.reason, /T3 was rejected: failed: requests\.interceptable=0/);
  });

  test('a driver the chosen treatment serves is not listed', () => {
    const r = selectTreatment({ target: 'backend', signals: { ...base, 'requests.interceptable': 1, 'driver.team_autonomy': 1 }, drivers: ['team_autonomy'] });
    assert.deepEqual(r.drivers_not_served, []);
  });
});

// ---- readiness detail ------------------------------------------------------------------------------

describe('readiness detail', () => {
  test('owners are named with their shares beside the count', () => {
    const own = (owner) => nodeFact('owner', owner, { name: owner }, p);
    const owned = (m, o) => edgeFact('OWNED_BY', `module:${m}`, `owner:${o}`, {}, p);
    const g = Graph.fromFacts([...['a', 'b', 'c', 'd'].map((n) => mod(`x/${n}.ts`)), own('@orders'), own('@billing'), owned('x/a.ts', '@orders'), owned('x/b.ts', '@orders'), owned('x/c.ts', '@billing')]);
    const { metrics, details } = boundaryMetrics(g, new Set(['a', 'b', 'c', 'd'].map((n) => `module:x/${n}.ts`)), { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0 });
    assert.equal(metrics['owners.count'], 2);
    assert.equal(metrics['ownership.alignment'], 0.5);
    assert.deepEqual(details.owners, [{ owner: '@orders', modules: 2, share: 0.5 }, { owner: '@billing', modules: 1, share: 0.25 }]);
    assert.equal(details.unowned, 1);
  });

  test('a perturbation that moves members is named with its seed and the members', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = [['a', 'b', 5], ['b', 'c', 5], ['a', 'c', 5], ['d', 'e', 5], ['e', 'f', 5], ['d', 'f', 5], ['c', 'd', 4.5]].map(([a, b, w]) => ({ a, b, w }));
    const runs = brokenBy({ nodes, edges }, ['a', 'b', 'c']);
    assert.ok(runs.length <= 3);
    for (const x of runs) {
      assert.ok(x.run && Number.isInteger(x.seed));
      assert.ok(x.moved_total >= 1 && x.moved.every((m) => ['a', 'b', 'c'].includes(m)));
    }
    assert.deepEqual(brokenBy({ nodes, edges }, ['a', 'b', 'c']), runs);
  });
});

// ---- the command on a mapped repository -------------------------------------------------------------

const names = (own, list) => Object.fromEntries(list.map((n) => [`shop/${own}/${n}.js`, `${list.filter((m) => m !== n).map((m) => `import { f_${m} } from './${m}.js';`).join('\n')}\nexport function f_${n}() { return 1; }\n`]));
const r = await analyse('modular-monolith', { extra: { ...names('orders', ['o0', 'o1', 'o2', 'o3', 'o4']), ...names('stock', ['s0', 's1', 's2', 's3', 's4']) }, skipDiagnose: true });
const dir = () => join(r.ctx.paths.base, 'decompositions');
const bump = () => r.ctx.store.meta('generation', Number(r.ctx.store.meta('generation') ?? 0) + 1);

describe('superseded records and prune', () => {
  test('records without a fingerprint, and older-generation records once a run replaced them, are superseded; prune removes them', async () => {
    const first = (await decompose(r.ctx, { config: r.config, scope: ['shop/**'] })).details;
    assert.ok(first.length >= 2);
    const [keep, old, legacy] = first.map((x) => x.id);
    assert.ok(listRecords(r.ctx).every((x) => x.superseded === null));
    // an older version wrote a record with no fingerprint
    const rec = JSON.parse(readFileSync(join(dir(), `${legacy ?? old}.json`), 'utf8'));
    const { fingerprint, ...bare } = rec;
    writeFileSync(join(dir(), `${rec.id}.json`), JSON.stringify(bare));
    assert.match(listRecords(r.ctx).find((x) => x.id === rec.id).superseded, /older version \(no fingerprint\)/);
    assert.match(showRecord(r.ctx, rec.id).superseded, /older version/);
    // the graph is rebuilt: until a run produces records again, nothing has replaced them
    bump();
    assert.ok(listRecords(r.ctx).filter((x) => x.id !== rec.id).every((x) => x.superseded === null && x.stale === true));
    // a rerun overwrites its own records at the new generation; a record only the old graph produced stays behind
    const strays = { ...JSON.parse(readFileSync(join(dir(), `${keep}.json`), 'utf8')), id: 'DEC-0900', fingerprint: 'f'.repeat(64), graph_generation: Number(r.ctx.store.meta('generation')) - 1 };
    writeFileSync(join(dir(), 'DEC-0900.json'), JSON.stringify(strays));
    await decompose(r.ctx, { config: r.config, scope: ['shop/**'] });
    const rows = listRecords(r.ctx);
    assert.match(rows.find((x) => x.id === 'DEC-0900').superseded, /older graph generation \(\d+, now \d+\) and not produced again since/);
    assert.equal(rows.find((x) => x.id === keep).superseded, null);

    const dry = pruneRecords(r.ctx, { dryRun: true });
    assert.ok(dry.removed.some((x) => x.id === 'DEC-0900'));
    assert.ok(existsSync(join(dir(), 'DEC-0900.json')));
    const done = pruneRecords(r.ctx);
    assert.deepEqual(done.removed.map((x) => x.id).includes('DEC-0900'), true);
    assert.ok(!existsSync(join(dir(), 'DEC-0900.json')));
    assert.ok(existsSync(join(dir(), `${keep}.json`)));
  });

  test('a record a campaign or slice references is kept, and prune says where', () => {
    const rec = JSON.parse(readFileSync(join(dir(), readdirNames()[0]), 'utf8'));
    const { fingerprint, ...bare } = rec;
    writeFileSync(join(dir(), `${rec.id}.json`), JSON.stringify(bare));
    r.ctx.store.run("INSERT INTO campaigns (id, schema_version, status, body, created_at, updated_at) VALUES ('CAMP-0001', '1.0', 'PLANNED', ?, 'now', 'now')", JSON.stringify({ sources: [rec.id] }));
    const res = pruneRecords(r.ctx);
    assert.ok(!res.removed.some((x) => x.id === rec.id));
    assert.match(res.kept.find((x) => x.id === rec.id).reason, /referenced by campaign CAMP-0001/);
    assert.ok(existsSync(join(dir(), `${rec.id}.json`)));
  });
});

function readdirNames() {
  return JSON.parse(JSON.stringify(listRecords(r.ctx).map((x) => `${x.id}.json`)));
}
