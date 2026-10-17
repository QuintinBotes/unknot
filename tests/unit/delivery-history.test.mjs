// Delivery history as evidence: the normalised deployment rows, the per-unit metrics
// and RELEASED_WITH facts they become, `unknot import deliveries`, and decompose
// reading them as measured evidence (expired ones ignored and named).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { analyse } from '../golden/_harness.mjs';

const { run } = await import('../../runtime/cli/commands/import.mjs');
const { parseArgs } = await import('../../runtime/cli/util.mjs');
const { decompose } = await import('../../runtime/decompose/index.mjs');
const { Graph } = await import('../../runtime/graph/graph.mjs');
const { nodeFact, prov } = await import('../../runtime/graph/facts.mjs');
const { readDeliveries } = await import('../../adapters/delivery/history/format.mjs');
const { deliveryImportFacts } = await import('../../adapters/delivery/history/imports.mjs');
const { boundaryMetrics } = await import('../../runtime/decompose/candidates.mjs');

const day = (n, hour = 0) => new Date(Date.now() - n * 86_400_000 + hour * 3_600_000).toISOString();
const bare = (rows) => rows.map(({ line, ...r }) => r);

describe('delivery row parsing', () => {
  const rows = [
    { unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'succeeded', environment: 'production', commit: 'aaa', committed_at: '2026-08-31T00:00:00Z', release: 'r1', code_root: 'shop/orders' },
    { unit: 'orders', deployed_at: '2026-09-08T00:00:00Z', status: 'FAILED', committed_at: '2026-09-07T12:00:00Z', release: 'r2', code_root: 'shop/orders' },
    { unit: 'invoices', deployed_at: '2026-09-01T00:00:00Z', status: 'ok', environment: 'production', release: 'r1', code_root: 'shop/invoices' },
  ];
  const csv = [
    'unit,deployed_at,status,environment,commit,committed_at,release,code_root',
    'orders,2026-09-01T00:00:00Z,succeeded,production,aaa,2026-08-31T00:00:00Z,r1,shop/orders',
    'orders,2026-09-08T00:00:00Z,FAILED,,,2026-09-07T12:00:00Z,r2,shop/orders',
    'invoices,2026-09-01T00:00:00Z,ok,production,,,r1,shop/invoices',
    '',
  ].join('\n');

  test('JSON array, JSON Lines and CSV give the same rows, with aliases normalised', () => {
    const fromJson = readDeliveries(JSON.stringify(rows));
    const fromJsonl = readDeliveries(rows.map((r) => JSON.stringify(r)).join('\n'));
    const fromCsv = readDeliveries(csv);
    assert.deepEqual(bare(fromJsonl.rows), bare(fromJson.rows));
    assert.deepEqual(bare(fromCsv.rows), bare(fromJson.rows));
    assert.deepEqual(fromJson.rows.map((r) => r.status), ['success', 'failure', 'success']);
    assert.equal(fromJson.rows[1].environment, 'production');
    assert.deepEqual(fromJson.window, { start: '2026-09-01T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z' });
  });

  test('rollback spellings normalise to rolled_back', () => {
    for (const status of ['rolled_back', 'rolled-back', 'rollback', 'Reverted', 'error']) {
      const res = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status }]));
      assert.equal(res.rows[0].status, status === 'error' ? 'failure' : 'rolled_back', status);
    }
  });

  test('statuses that are not deployments and other environments are skipped and counted', () => {
    const res = readDeliveries(JSON.stringify([
      { unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'canceled' },
      { unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'running' },
      { unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success', environment: 'staging' },
      { unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success' },
    ]));
    assert.deepEqual([res.rows.length, res.skipped_status, res.skipped_environment, res.invalid.length], [1, 2, 1, 0]);
    const staging = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success', environment: 'staging' }]), { environment: 'staging' });
    assert.equal(staging.rows.length, 1);
  });

  test('a missing required field or bad timestamp is invalid with its row number', () => {
    const missing = readDeliveries('unit,deployed_at,status\norders,2026-09-01T00:00:00Z,success\n,2026-09-02T00:00:00Z,success\n');
    assert.deepEqual(missing.invalid, [{ row: 2, error: 'unit is empty' }]);
    const badTime = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: 'not-a-time', status: 'success' }]));
    assert.equal(badTime.invalid[0].row, 1);
    assert.match(badTime.invalid[0].error, /deployed_at/);
    const noTime = readDeliveries(JSON.stringify([{ unit: 'orders', status: 'success' }]));
    assert.match(noTime.invalid[0].error, /deployed_at is empty/);
    const badCommit = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success', committed_at: 'soon' }]));
    assert.match(badCommit.invalid[0].error, /committed_at/);
    const noStatus = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-01T00:00:00Z' }]));
    assert.match(noStatus.invalid[0].error, /status is empty/);
  });

  test('an absolute or parent-escaping code_root is invalid', () => {
    for (const code_root of ['/srv/orders', 'C:/orders', 'shop/../orders', '../orders']) {
      const res = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success', code_root }]));
      assert.equal(res.rows.length, 0, code_root);
      assert.match(res.invalid[0].error, /code_root/, code_root);
    }
    const ok = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success', code_root: './shop/orders/' }]));
    assert.equal(ok.rows[0].code_root, 'shop/orders');
  });
});

describe('delivery metrics and facts', () => {
  // Hand-computed: window 2026-09-01 to 2026-09-22 is 21 days. orders has 4 counted
  // deployments (1 failure, 1 rolled back), so change_failure_rate is 2/4 = 0.5 and
  // deploys_per_week is 4/21*7 = 1.33. Its lead times are 24, 12, 24 and 48 hours:
  // median 24, nearest-rank p90 48. invoices has 2, both 48 hours: 2/21*7 = 0.67.
  const csv = [
    'unit,deployed_at,status,committed_at,release,code_root',
    'orders,2026-09-01T00:00:00Z,success,2026-08-31T00:00:00Z,r1,shop/orders',
    'orders,2026-09-08T00:00:00Z,failure,2026-09-07T12:00:00Z,r2,shop/orders',
    'orders,2026-09-15T00:00:00Z,rolled_back,2026-09-14T00:00:00Z,r3,shop/orders',
    'orders,2026-09-22T00:00:00Z,success,2026-09-20T00:00:00Z,,shop/orders',
    'invoices,2026-09-01T00:00:00Z,success,2026-08-30T00:00:00Z,r1,shop/invoices',
    'invoices,2026-09-08T00:00:00Z,success,2026-09-06T00:00:00Z,r2,shop/invoices',
    'ledger,2026-09-10T00:00:00Z,success,,,',
    '',
  ].join('\n');
  const parsed = readDeliveries(csv);
  const imp = { source: 'ci', imported_at: '2026-09-23T00:00:00.000Z', rows: parsed.rows, window: parsed.window };
  const facts = deliveryImportFacts([imp], new Graph(), {});
  const deliveryOf = (unit) => facts.find((f) => f.id === `deployable:${unit}`).attrs.delivery;

  test('per-unit delivery metrics match the hand-computed values', () => {
    const orders = deliveryOf('orders');
    assert.deepEqual(
      [orders.deployments, orders.failures, orders.rolled_back, orders.change_failure_rate, orders.deploys_per_week, orders.lead_time_median_hours, orders.lead_time_p90_hours, orders.code_root],
      [4, 1, 1, 0.5, 1.33, 24, 48, 'shop/orders'],
    );
    const invoices = deliveryOf('invoices');
    assert.deepEqual(
      [invoices.deployments, invoices.change_failure_rate, invoices.deploys_per_week, invoices.lead_time_median_hours, invoices.lead_time_p90_hours],
      [2, 0, 0.67, 48, 48],
    );
    assert.deepEqual(orders.sources, ['ci']);
    assert.equal(orders.imported, true);
    assert.deepEqual(orders.observed_window, { start: '2026-09-01T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' });
    assert.equal(orders.expires_at, '2026-10-06T00:00:00.000Z'); // window end + 14 days
    const fact = facts.find((f) => f.id === 'deployable:orders');
    assert.deepEqual([fact.provenance.source_type, fact.provenance.confidence, fact.provenance.extractor], ['catalog', 'medium', 'delivery@0.1.3']);
  });

  test('a unit with no usable lead time reports nulls, and a negative lead time is ignored', () => {
    assert.deepEqual([deliveryOf('ledger').lead_time_median_hours, deliveryOf('ledger').lead_time_p90_hours], [null, null]);
    const p = readDeliveries(JSON.stringify([
      { unit: 'ledger', deployed_at: '2026-09-01T00:00:00Z', status: 'success', committed_at: '2026-09-02T00:00:00Z' },
      { unit: 'ledger', deployed_at: '2026-09-03T00:00:00Z', status: 'success', committed_at: '2026-09-01T00:00:00Z' },
    ]));
    const [f] = deliveryImportFacts([{ source: 'ci', imported_at: '2026-09-04T00:00:00.000Z', rows: p.rows, window: p.window }], new Graph(), {});
    assert.equal(f.attrs.delivery.lead_time_median_hours, 48);
  });

  test('code_root falls back to a same-named service node', () => {
    const graph = Graph.fromFacts([
      nodeFact('service', 'ledger', { name: 'ledger', attrs: { code_root: 'shop/ledger' } }, prov({ source_type: 'catalog', source_ref: 'catalog:1', extractor: 'test@0' })),
    ]);
    const withService = deliveryImportFacts([imp], graph, {});
    assert.equal(withService.find((f) => f.id === 'deployable:ledger').attrs.delivery.code_root, 'shop/ledger');
  });

  test('the delivery attributes survive merging with a CI-derived deployable node', () => {
    const ci = nodeFact('deployable', 'orders', { name: 'orders', attrs: { co_deployed_with: ['invoices'], inferred: true } }, prov({ source_type: 'inference', source_ref: 'ci.yml:1', extractor: 'delivery@0.1.3', confidence: 'medium' }));
    const node = Graph.fromFacts([ci, ...facts]).node('deployable:orders');
    assert.deepEqual(node.attrs.co_deployed_with, ['invoices']);
    assert.equal(node.attrs.delivery.deployments, 4);
  });

  test('RELEASED_WITH counts shared releases and shares them by the smaller side', () => {
    // orders has r1, r2, r3 and invoices has r1, r2: 2 shared, smaller side 2, share 1.
    const edges = facts.filter((f) => f.kind === 'edge');
    assert.equal(edges.length, 1);
    assert.deepEqual([edges[0].type, edges[0].from, edges[0].to, edges[0].attrs.releases, edges[0].attrs.share], ['RELEASED_WITH', 'deployable:invoices', 'deployable:orders', 2, 1]);
    assert.ok(!edges.some((e) => e.from.includes('ledger') || e.to.includes('ledger')));

    // Both sides in three releases, two of them shared: share is 2/3.
    const p = readDeliveries(JSON.stringify([
      { unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success', release: 'r1' },
      { unit: 'orders', deployed_at: '2026-09-02T00:00:00Z', status: 'success', release: 'r2' },
      { unit: 'orders', deployed_at: '2026-09-03T00:00:00Z', status: 'success', release: 'r3' },
      { unit: 'invoices', deployed_at: '2026-09-01T00:00:00Z', status: 'success', release: 'r1' },
      { unit: 'invoices', deployed_at: '2026-09-02T00:00:00Z', status: 'success', release: 'r2' },
      { unit: 'invoices', deployed_at: '2026-09-03T00:00:00Z', status: 'success', release: 'r4' },
    ]));
    const [edge] = deliveryImportFacts([{ source: 'ci', imported_at: '2026-09-04T00:00:00.000Z', rows: p.rows, window: p.window }], new Graph(), {}).filter((f) => f.kind === 'edge');
    assert.deepEqual([edge.attrs.releases, edge.attrs.share], [2, 0.667]);
  });

  test('several sources for one unit combine counts and keep the window union; ttl_days sets the expiry', () => {
    const a = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-01T00:00:00Z', status: 'success', code_root: 'shop/orders' }]));
    const b = readDeliveries(JSON.stringify([{ unit: 'orders', deployed_at: '2026-09-15T00:00:00Z', status: 'failure', code_root: 'shop/orders' }]));
    const imps = [
      { source: 'a', imported_at: '2026-09-16T00:00:00.000Z', rows: a.rows, window: a.window },
      { source: 'b', imported_at: '2026-09-17T00:00:00.000Z', rows: b.rows, window: b.window },
    ];
    const [f] = deliveryImportFacts(imps, new Graph(), { options: { ttl_days: 7 } });
    assert.deepEqual([f.attrs.delivery.deployments, f.attrs.delivery.failures, f.attrs.delivery.sources], [2, 1, ['a', 'b']]);
    assert.deepEqual(f.attrs.delivery.observed_window, { start: '2026-09-01T00:00:00.000Z', end: '2026-09-15T00:00:00.000Z' });
    assert.equal(f.attrs.delivery.expires_at, '2026-09-22T00:00:00.000Z'); // window end + 7 days
  });

  test('a candidate places a whole-repository unit, and names units it cannot place', () => {
    const P = prov({ source_type: 'catalog', source_ref: 'x:1', extractor: 'delivery@0.1.3', confidence: 'medium' });
    const members = new Set(['module:shop/orders/a.js', 'module:shop/orders/b.js']);
    const run = (root) => boundaryMetrics(Graph.fromFacts([
      nodeFact('module', 'shop/orders/a.js', { name: 'a', path: 'shop/orders/a.js' }, P),
      nodeFact('module', 'shop/orders/b.js', { name: 'b', path: 'shop/orders/b.js' }, P),
      nodeFact('deployable', 'orders', { name: 'orders', attrs: { delivery: { deployments: 3, deploys_per_week: 1, change_failure_rate: 0, lead_time_median_hours: 2, code_root: root, sources: ['ci'], observed_window: { start: '2999-01-01T00:00:00.000Z', end: '2999-01-08T00:00:00.000Z' }, expires_at: '2999-01-22T00:00:00.000Z' } } }, P),
    ]), members, { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: null });
    assert.equal(run('.').details.delivery.units[0].members_under, 2);
    const unplaced = run(null);
    assert.equal(unplaced.details.delivery, undefined);
    assert.ok(unplaced.gaps.some((g) => /could not be placed/.test(g) && /code_root/.test(g)), unplaced.gaps.join('|'));
  });
});

// ---- import and decompose ------------------------------------------------------------

const group = (dir, names, extras = {}) => Object.fromEntries(names.map((n) => [`shop/${dir}/${n}.js`, `${names.filter((m) => m !== n).map((m) => `import { f_${m} } from './${m}.js';`).join('\n')}${extras[n] ?? ''}\nexport function f_${n}() { return 1; }\n`]));
const o = ['o0', 'o1', 'o2', 'o3', 'o4'];
const i = ['i0', 'i1', 'i2', 'i3', 'i4'];
const repo = () => analyse('modular-monolith', {
  extra: {
    ...group('orders', o, { o0: "\nimport { f_i0 } from '../invoices/i0.js';" }),
    ...group('invoices', i),
  },
  skipDiagnose: true,
});
const r = await repo();

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

// A fresh window (21 days ago to today): orders deploys in r1, r2, r3 and once with no
// release; invoices in r1, r2, r4. Shared releases 2 of 3 on each side, share 0.667.
const deliver = (at) => [
  'unit,deployed_at,status,environment,committed_at,release,code_root',
  `orders,${at(21)},success,production,${at(22)},r1,shop/orders`,
  `orders,${at(14)},failure,production,${at(15)},r2,shop/orders`,
  `orders,${at(7)},success,production,${at(9)},r3,shop/orders`,
  `orders,${at(0)},success,production,${at(1)},,shop/orders`,
  `invoices,${at(21)},success,production,${at(23)},r1,shop/invoices`,
  `invoices,${at(14)},success,production,${at(16)},r2,shop/invoices`,
  `invoices,${at(7)},rolled_back,production,${at(8)},r4,shop/invoices`,
  `invoices,${at(1)},success,staging,${at(2)},r9,shop/invoices`,
  `orders,${at(1)},canceled,production,,,shop/orders`,
  '',
].join('\n');
const EXPORT = deliver(day);
const OLD = deliver((n) => `2020-01-${String(22 - Math.min(n, 21)).padStart(2, '0')}T00:00:00Z`);

describe('decompose without delivery history', () => {
  test('the no-delivery-history gap is present and no delivery metric is set', async () => {
    const rec = (await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true })).details.find((x) => x.candidate.name.includes('orders'));
    assert.ok(rec);
    assert.equal(rec.delivery_evidence, undefined);
    assert.equal(rec.candidate.metrics['service.deploy_coupling'], undefined);
    assert.ok(rec.evidence_gaps.includes('no delivery history: deploy frequency, change failure rate and lead time unknown; import with unknot import deliveries'), rec.evidence_gaps.join('|'));
  });
});

describe('unknot import deliveries', () => {
  test('stores per-unit facts and release coupling, and is idempotent', async () => {
    const file = put('deliveries.csv', EXPORT);
    const first = JSON.parse(await importCli('deliveries', file, '--source', 'ci', '--json'));
    assert.equal(first.status, 'imported');
    assert.deepEqual([first.deployments, first.units, first.skipped_status, first.skipped_environment], [7, 2, 1, 1]);
    assert.deepEqual(first.units_matched, ['invoices', 'orders']);
    assert.equal(first.units_unmatched_count, 0);
    const g = Graph.fromStore(r.ctx.store);
    const orders = g.node('deployable:orders').attrs.delivery;
    assert.deepEqual([orders.deployments, orders.failures, orders.change_failure_rate, orders.deploys_per_week, orders.lead_time_median_hours], [4, 1, 0.25, 1.33, 24]);
    assert.ok(orders.expires_at > orders.observed_window.end);
    const edges = g.edges('RELEASED_WITH');
    assert.equal(edges.length, 1);
    assert.deepEqual([edges[0].from, edges[0].to, edges[0].attrs.releases, edges[0].attrs.share, edges[0].attrs.sources], ['deployable:invoices', 'deployable:orders', 2, 0.667, ['ci']]);

    const generation = r.ctx.store.meta('generation');
    const human = await importCli('deliveries', file, '--source', 'ci');
    assert.match(human, /Already imported \(unchanged\)/);
    const again = JSON.parse(await importCli('deliveries', file, '--source', 'ci', '--json'));
    assert.equal(again.status, 'unchanged');
    assert.equal(r.ctx.store.meta('generation'), generation);
  });

  test('a different file with the same source replaces the earlier import', async () => {
    const one = put('one.csv', `unit,deployed_at,status,code_root\nledger,${day(0)},success,shop/orders\n`);
    const replaced = JSON.parse(await importCli('deliveries', one, '--source', 'ci', '--json'));
    assert.deepEqual([replaced.status, replaced.deployments, replaced.units], ['replaced', 1, 1]);
    // Restore the two-unit export for the decompose tests below.
    const restored = JSON.parse(await importCli('deliveries', put('deliveries2.csv', EXPORT), '--source', 'ci', '--json'));
    assert.equal(restored.status, 'replaced');
  });

  test('refuses .unknot/ and credential paths, and a file with a bad row', async () => {
    mkdirSync(join(r.dir, '.unknot/cache'), { recursive: true });
    writeFileSync(join(r.dir, '.unknot/cache/d.csv'), EXPORT);
    await assert.rejects(importCli('deliveries', '.unknot/cache/d.csv'), { code: 'UK_POLICY_DENIED' });
    writeFileSync(join(r.dir, '.env'), EXPORT);
    await assert.rejects(importCli('deliveries', '.env'), { code: 'UK_POLICY_DENIED' });
    const bad = put('bad.csv', 'unit,deployed_at,status\norders,not-a-time,success\n');
    await assert.rejects(importCli('deliveries', bad, '--source', 'bad'), { code: 'UK_SCHEMA_INVALID' });
  });
});

describe('decompose with imported delivery history', () => {
  const orders = (res) => res.details.find((x) => x.candidate.name.includes('orders'));

  test('the candidate shows its unit as observed evidence and its deploy coupling', async () => {
    const rec = orders(await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true }));
    assert.ok(rec);
    assert.equal(rec.candidate.metrics['service.deploy_coupling'], 0.667);
    assert.equal(rec.delivery_evidence.label, 'observed');
    assert.ok(rec.delivery_evidence.window.start < rec.delivery_evidence.window.end);
    assert.deepEqual(rec.delivery_evidence.sources, ['import:ci']);
    assert.deepEqual(rec.delivery_evidence.units, [{
      unit: 'orders', deployments: 4, deploys_per_week: 1.33, change_failure_rate: 0.25,
      lead_time_median_hours: 24, members_under: 5, released_with: [{ unit: 'invoices', share: 0.667 }],
    }]);
    assert.ok(!rec.evidence_gaps.some((g) => /delivery/.test(g)), rec.evidence_gaps.join('|'));
  });

  test('expired delivery evidence is ignored and named in the gaps', async () => {
    await importCli('deliveries', put('old.csv', OLD), '--source', 'ci');
    const rec = orders(await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true }));
    assert.equal(rec.candidate.metrics['service.deploy_coupling'], undefined);
    assert.equal(rec.delivery_evidence, undefined);
    assert.ok(rec.evidence_gaps.some((g) => /delivery fact\(s\) are past their expiry/.test(g)), rec.evidence_gaps.join('|'));
    assert.ok(!rec.evidence_gaps.some((g) => g.startsWith('no delivery history')), rec.evidence_gaps.join('|'));
  });
});
