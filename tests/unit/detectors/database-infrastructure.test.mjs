// Database and infrastructure detectors. Facts come from the real adapters run over small
// fixtures (tests/fixtures/detectors-dbi plus the shared IaC fixtures) and from hand-made
// graphs that mirror the adapters' real attrs for the negative and edge cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate user-level state before any runtime module is imported.
process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'unknot-dbi-home-'));

const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { nodeFact, edgeFact, prov, assertFact } = await import('../../../runtime/graph/facts.mjs');
const { openProject } = await import('../../../runtime/context.mjs');
const { loadConfig } = await import('../../../runtime/policy/config.mjs');
const { diagnose } = await import('../../../runtime/diagnose/engine.mjs');
const { default: dbAdapter } = await import('../../../adapters/database/index.mjs');
const { default: iacAdapter } = await import('../../../adapters/infrastructure/iac/index.mjs');
const { default: k8sAdapter } = await import('../../../adapters/infrastructure/k8s/index.mjs');
const { default: DB } = await import('../../../runtime/diagnose/detectors/database.mjs');
const { default: INFRA } = await import('../../../runtime/diagnose/detectors/infrastructure.mjs');
const { validateArtifact } = await import('../../../runtime/core/schema.mjs');

const FX = fileURLToPath(new URL('../../fixtures/detectors-dbi/', import.meta.url));
const IAC = fileURLToPath(new URL('../../fixtures/iac/', import.meta.url));

// ------------------------------------------------------------------ helpers

const P = prov({ source_type: 'config', source_ref: 'test:1', extractor: 'test@0', confidence: 'high' });
const N = (type, key, attrs = {}, path = null, name) => nodeFact(type, key, { name, path, attrs }, P);
const E = (type, from, to, attrs = {}) => edgeFact(type, from, to, attrs, P);

const walk = (dir, acc = []) => {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
};
const rel = (base, abs) => relative(base, abs).split('\\').join('/');

function byId(list, id) {
  const d = list.find((x) => x.id === id);
  assert.ok(d, `detector ${id} registered`);
  return d;
}

/** Run one detector by short name over facts. */
function run(list, prefix, name, facts) {
  const graph = facts instanceof Graph ? facts : Graph.fromFacts(facts);
  return byId(list, `${prefix}.${name}`).detect({ graph, options: {}, config: {}, scope: [] });
}
const runDb = (name, facts) => run(DB, 'database', name, facts);
const runInfra = (name, facts) => run(INFRA, 'infrastructure', name, facts);
const keys = (drafts) => drafts.map((d) => d.key).sort();
const hasKey = (drafts, part) => drafts.some((d) => d.key.includes(part));

// ---- database graph from the real adapter
const PG = { engine: 'postgresql', version: '16' };

function codeModule(path, sql) {
  return [N('module', path, { sql: sql.map((text, i) => ({ text, line: i + 1 })) }, path)];
}

async function buildDbFacts() {
  const factsByFile = new Map();
  const files = new Map();
  const base = join(FX, 'db', 'migration');
  for (const abs of walk(base)) {
    const path = `db/migration/${rel(base, abs)}`;
    const entry = { path };
    factsByFile.set(path, dbAdapter.extract(entry, readFileSync(abs, 'utf8'), { options: PG }));
    files.set(path, entry);
  }
  // Application code: raw SQL recorded on module nodes by the language adapters.
  const code = {
    'services/billing/src/pay.ts': ['UPDATE orders SET total = total + 1 WHERE id = 1'],
    'services/shipping/src/ship.ts': ['UPDATE orders SET status = \'shipped\' WHERE id = 1'],
    'services/crm/src/customers.ts': ['UPDATE customers SET email = \'x\' WHERE id = 1'],
    'services/reporting/src/join.ts': ['SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 1'],
    'services/billing/src/items.ts': ['INSERT INTO order_items (id, order_id) VALUES (1, 1)', 'SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.id = 1'],
    'services/reporting/src/export.ts': ['SELECT * FROM orders'],
    'services/reporting/src/lookup.ts': ['SELECT * FROM customers WHERE id = 1'],
    'services/reporting/src/regions.ts': ['SELECT * FROM warehouses'],
  };
  for (const [path, sql] of Object.entries(code)) {
    factsByFile.set(path, codeModule(path, sql));
    files.set(path, { path });
  }
  const linked = dbAdapter.link({ files, factsByFile, options: PG });
  const discovered = await dbAdapter.discover({
    root: '/x', census: [], options: PG,
    evidence: { db_metadata: ['catalog.json', 'plan.json', 'stats.json'] },
    readText: async (p) => readFileSync(join(FX, 'db', p), 'utf8'),
    exec: async () => { throw new Error('discover must not execute anything'); },
  });
  const all = [...factsByFile.values()].flat().concat(linked, discovered);
  all.forEach(assertFact);
  return all;
}

// ---- infrastructure graph from the real adapters
function buildIacExtract() {
  const factsByFile = new Map();
  const files = new Map();
  const base = join(IAC, 'terraform');
  for (const abs of walk(base)) {
    const path = rel(base, abs);
    const entry = { path };
    factsByFile.set(path, iacAdapter.extract(entry, readFileSync(abs, 'utf8'), {}));
    files.set(path, entry);
  }
  const extra = { path: 'extra/main.tf' };
  factsByFile.set(extra.path, iacAdapter.extract(extra, readFileSync(join(FX, 'iac', 'extra.tf'), 'utf8'), {}));
  files.set(extra.path, extra);
  const linked = iacAdapter.link({ files, factsByFile, options: {} });
  return { factsByFile, facts: [...factsByFile.values()].flat().concat(linked) };
}

async function iacEvidence(factsByFile, evidence) {
  return iacAdapter.discover({
    root: '/x', census: [], options: {}, factsByFile, evidence,
    readText: async (p) => readFileSync(join(IAC, p), 'utf8'),
    exec: async () => { throw new Error('discover must not execute anything'); },
  });
}

function buildK8sFacts() {
  const path = 'k8s/workloads.yaml';
  const entry = { path, kind: 'config' };
  const factsByFile = new Map([[path, k8sAdapter.extract(entry, readFileSync(join(FX, 'k8s', 'workloads.yaml'), 'utf8'), {})]]);
  const linked = k8sAdapter.link({ files: new Map([[path, entry]]), factsByFile, options: {} });
  return [...factsByFile.values()].flat().concat(linked);
}

const dbFacts = await buildDbFacts();
const iacBase = buildIacExtract();
const iacAll = [
  ...iacBase.facts,
  ...(await iacEvidence(iacBase.factsByFile, {
    infra_plans: [{ path: 'plans/b-rds-replace.json' }, { path: 'plans/c-iam-widened.json' }],
    infra_state: ['state/state-v4.json'],
    infra_inventory: ['state/inventory.json'],
  })),
];
const k8sFacts = buildK8sFacts();
iacAll.forEach(assertFact);
k8sFacts.forEach(assertFact);

const dbGraph = Graph.fromFacts(dbFacts);
const infraFacts = [...iacAll, ...k8sFacts];
const infraGraph = Graph.fromFacts(infraFacts);

// ------------------------------------------------------------------ registry

test('both modules export arrays of correctly shaped detectors', () => {
  assert.equal(DB.length, 11);
  assert.equal(INFRA.length, 17);
  for (const [list, cat] of [[DB, 'database'], [INFRA, 'infrastructure']]) {
    const ids = new Set();
    for (const d of list) {
      assert.equal(d.category, cat);
      assert.match(d.id, new RegExp(`^${cat}\\.[a-z0-9-]+$`));
      assert.deepEqual(d.kinds, [d.id]);
      assert.equal(typeof d.detect, 'function');
      assert.match(d.version, /^\d+\.\d+\.\d+$/);
      assert.ok(!ids.has(d.id), `duplicate id ${d.id}`);
      ids.add(d.id);
    }
  }
});

test('every draft is complete: ten questions answered, retain-safe, no live execution advice', () => {
  for (const [list, g] of [[DB, dbGraph], [INFRA, infraGraph]]) {
    for (const d of list) {
      for (const f of d.detect({ graph: g, options: {}, config: {}, scope: [] })) {
        assert.equal(f.kind, d.id, d.id);
        for (const field of ['title', 'key', 'why_accidental', 'smallest_simplification']) assert.ok(f[field], `${d.id} ${field}`);
        assert.ok(f.evidence.length > 0, `${d.id} evidence`);
        assert.ok(f.invariants.length > 0 && f.risks.length > 0 && f.verification.length > 0, `${d.id} invariants/risks/verification`);
        assert.ok(f.recovery?.type, `${d.id} recovery`);
        assert.ok(f.uncertainties || f.thresholds, d.id);
        assert.ok(f.factors && f.quality_impacts, d.id);
        assert.ok(f.alternatives.some((a) => a.id === 'retain') && f.alternatives.filter((a) => a.id === 'retain').length === 1, d.id);
        assert.ok(!/\b(psql|mysql)\b.*\b(production|prod)\b/i.test(JSON.stringify(f.verification)), `${d.id} must not run against production`);
      }
    }
  }
});

// ------------------------------------------------------------------ database

test('unused-index: catalog idx_scan 0 on a non-unique index, with the observation window', () => {
  const out = runDb('unused-index', dbFacts);
  assert.deepEqual(keys(out), ['index:public.orders_customer_idx']);
  const f = out[0];
  assert.equal(f.measurements['index.scans'], 0);
  assert.equal(f.measurements['table.rows'], 52_000_000);
  assert.equal(f.measurements['backup.restore_tested'], 0);
  assert.match(f.uncertainties.join(' '), /Statistics window.*stats reset/s);
  assert.equal(f.recovery.type, 'roll_forward');
  assert.deepEqual(f.patterns, ['database.remove-unused-index']);
});

test('unused-index: primary, unique, used, unmeasured and invalid indexes are not flagged', () => {
  const t = 'public.t';
  const ix = (name, attrs) => N('index', `public.${name}`, { table: t, columns: ['a'], ...attrs });
  const out = runDb('unused-index', [
    N('table', t),
    ix('pk', { idx_scan: 0, primary: true, unique: true }),
    ix('uq', { idx_scan: 0, unique: true }),
    ix('used', { idx_scan: 5 }),
    ix('ddl_only', { idx_scan: null }),
    ix('invalid', { idx_scan: 0, valid: false }),
    ix('target', { idx_scan: 0, observation_window: 'since 2025-01-01' }),
  ]);
  assert.deepEqual(keys(out), ['index:public.target']);
  assert.match(out[0].uncertainties[0], /since 2025-01-01/);
  assert.equal('table.rows' in out[0].measurements, false); // unknown size is left out, not defaulted
});

test('duplicate-index: identical and leading-prefix indexes, never unique or primary ones', () => {
  const out = runDb('duplicate-index', dbFacts);
  assert.deepEqual(keys(out), [
    'index:public.orders_customer_idx2>index:public.orders_customer_idx',
    'index:public.orders_customer_idx>index:public.orders_customer_status_idx',
  ].sort());
  assert.match(out.find((d) => d.key.startsWith('index:public.orders_customer_idx2')).title, /duplicate of/);
  assert.match(out.find((d) => d.key.startsWith('index:public.orders_customer_idx>')).title, /prefix of/);
  assert.ok(out.every((d) => d.measurements['index.duplicates'] === 1));
  assert.ok(out.every((d) => d.patterns.includes('database.merge-duplicate-indexes')));

  const t = 'public.t';
  const mk = (name, columns, attrs = {}) => N('index', `public.${name}`, { table: t, columns, method: 'btree', ...attrs });
  const neg = runDb('duplicate-index', [
    mk('a', ['x'], { unique: true }), mk('ab', ['x', 'y']), // a unique prefix enforces a rule
    mk('p', ['id'], { primary: true }), mk('pq', ['id', 'q']),
    mk('h', ['z'], { method: 'hash' }), mk('b', ['z']), // different methods
    mk('w1', ['w'], { where: 'a > 1' }), mk('w2', ['w']), // partial vs full
    mk('inv', ['v'], { valid: false }), mk('v', ['v']), // invalid ignored
    mk('u1', ['u'], { unique: true }), mk('u2', ['u']), // unique vs non-unique
  ]);
  assert.deepEqual(neg, []);
});

test('hazardous-migration: ACCESS EXCLUSIVE rewrite on a 52M-row table, with the forecast alternative', () => {
  const out = runDb('hazardous-migration', dbFacts);
  assert.deepEqual(keys(out), ['migration:db/migration/V2__hazard.sql']);
  const f = out[0];
  assert.match(f.smallest_simplification, /expand\/contract/);
  assert.equal(f.measurements['migration.locks_exclusive'], 1);
  assert.equal(f.measurements['table.rows'], 52_000_000);
  assert.ok(f.patterns.includes('migration.expand-migrate-contract'));
  assert.match(f.risks.join(' '), /replication and CDC lag/);
  assert.match(f.risks.join(' '), /ACCESS EXCLUSIVE/);
  assert.equal(f.recovery.type, 'roll_forward');
  assert.ok(f.evidence.some((e) => /alter_table\.alter_column_type/.test(e.summary)));
});

test('hazardous-migration: small known tables are skipped, unknown sizes are flagged with an uncertainty', () => {
  const stmt = (table) => ({ kind: 'alter_table.alter_column_type', table, line: 1, forecast: { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'table', scan: 'full', confidence: 'high', rule_id: 'pg.alter_type.rewrite', safer_alternative: 'expand/contract' } });
  const mig = (name, table) => N('migration', name, { statements: [stmt(table)], destructive: false, irreversible: false, has_down: true }, name);
  const out = runDb('hazardous-migration', [
    N('table', 'public.small', { estimated_rows: 40 }), N('table', 'public.big', { estimated_rows: 5_000_000 }),
    mig('small.sql', 'public.small'), mig('big.sql', 'public.big'), mig('unknown.sql', 'public.mystery'),
    N('migration', 'online.sql', { statements: [{ kind: 'create_index', table: 'public.big', line: 1, forecast: { lock_mode: 'SHARE UPDATE EXCLUSIVE', rewrite: 'none', scan: 'full', confidence: 'high' } }] }, 'online.sql'),
  ]);
  assert.deepEqual(keys(out), ['migration:big.sql', 'migration:unknown.sql']);
  const unknown = out.find((d) => d.key === 'migration:unknown.sql');
  assert.match(unknown.uncertainties.join(' '), /size unknown/);
  assert.ok(unknown.factors.evidence <= 0.6);
  assert.ok(!('table.rows' in unknown.measurements));
});

test('destructive-migration: DROP COLUMN and RENAME are flagged, expand-only migrations are not', () => {
  const out = runDb('destructive-migration', dbFacts);
  assert.deepEqual(keys(out), ['migration:db/migration/V2__hazard.sql']);
  const f = out[0];
  assert.equal(f.recovery.type, 'restore');
  assert.equal(f.measurements['migration.irreversible'], 1);
  assert.ok(f.evidence.some((e) => /drop_column/.test(e.summary)));
  assert.ok(f.evidence.some((e) => /rename_column/.test(e.summary)));
  assert.match(f.smallest_simplification, /expand\/contract/);
  assert.ok(f.patterns.includes('migration.expand-migrate-contract'));
});

test('destructive-migration: a missing down alone is not flagged, but the adapter finding becomes evidence', () => {
  const plain = N('migration', 'add.up.sql', { statements: [{ kind: 'alter_table.add_column', table: 'public.t', line: 1, forecast: {} }], has_down: false, irreversible: true, destructive: false }, 'add.up.sql');
  assert.deepEqual(runDb('destructive-migration', [plain]), []);
  const drop = N('migration', 'drop.up.sql', { statements: [{ kind: 'drop_table', table: 'public.t', line: 1, forecast: {} }], has_down: false, irreversible: true, destructive: true }, 'drop.up.sql');
  const fnd = N('finding', 'database.missing_down:drop.up.sql', { rule_id: 'db.migration.missing_down', migration: 'migration:drop.up.sql' }, 'drop.up.sql');
  const out = runDb('destructive-migration', [drop, fnd]);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /no down\/undo/);
  assert.ok(out[0].evidence.some((e) => e.ref === 'finding:database.missing_down:drop.up.sql'));
});

test('backfill-without-batching: UPDATE without WHERE on a large table; small or bounded work is not flagged', () => {
  const out = runDb('backfill-without-batching', dbFacts);
  assert.deepEqual(keys(out), ['migration:db/migration/V2__hazard.sql:5']);
  assert.match(out[0].smallest_simplification, /batch/i);
  assert.ok(out[0].patterns.includes('migration.backfill'));
  assert.equal(out[0].recovery.type, 'roll_forward');

  const upd = (table, rule, scan = 'none') => ({ kind: 'update', table, line: 1, forecast: { lock_mode: 'ROW EXCLUSIVE', rewrite: 'none', scan, rule_id: rule } });
  const neg = runDb('backfill-without-batching', [
    N('table', 'public.small', { estimated_rows: 10 }), N('table', 'public.big', { estimated_rows: 9_000_000 }),
    N('migration', 'a.sql', { statements: [upd('public.small', 'postgresql.dml.update.no_where')] }, 'a.sql'),
    N('migration', 'b.sql', { statements: [upd('public.big', 'postgresql.dml.update.where', 'index')] }, 'b.sql'),
  ]);
  assert.deepEqual(neg, []);
  const del = runDb('backfill-without-batching', [
    N('table', 'public.big', { estimated_rows: 9_000_000 }),
    N('migration', 'c.sql', { statements: [{ ...upd('public.big', 'postgresql.dml.delete.no_where'), kind: 'delete' }] }, 'c.sql'),
  ]);
  assert.equal(del[0].recovery.type, 'restore');
});

test('multiple-writers: two packages mutating one table; one package is fine', () => {
  const out = runDb('multiple-writers', dbFacts);
  assert.deepEqual(keys(out), ['table:public.orders']);
  const f = out[0];
  assert.equal(f.measurements['table.writers'], 2);
  assert.match(f.title, /services\/billing/);
  assert.match(f.title, /services\/shipping/);
  assert.ok(f.patterns.includes('database.owned-interface-for-cross-service-writes'));
  assert.match(f.uncertainties.join(' '), /No declared owner/);
  assert.equal(f.recovery.type, 'roll_forward');
  // order_items is written only by billing; customers only by crm.
  assert.ok(!hasKey(out, 'order_items') && !hasKey(out, 'customers'));
});

test('multiple-writers: package ancestry beats path guessing; QUERIES-only access is not writing', () => {
  const out = runDb('multiple-writers', [
    N('table', 'public.t'),
    N('package', 'alpha'), N('package', 'beta'), N('module', 'lib/a.ts', {}, 'lib/a.ts'), N('module', 'lib/b.ts', {}, 'lib/b.ts'), N('module', 'lib/c.ts', {}, 'lib/c.ts'),
    E('CONTAINS', 'package:alpha', 'module:lib/a.ts'), E('CONTAINS', 'package:beta', 'module:lib/b.ts'),
    E('MUTATES', 'module:lib/a.ts', 'table:public.t'), E('MUTATES', 'module:lib/b.ts', 'table:public.t'),
    E('QUERIES', 'module:lib/c.ts', 'table:public.t'),
    N('table', 'public.u'), E('MUTATES', 'module:lib/a.ts', 'table:public.u'), E('QUERIES', 'module:lib/b.ts', 'table:public.u'),
  ]);
  assert.deepEqual(keys(out), ['table:public.t']);
});

test('cross-boundary-joins: join between tables with disjoint writer packages; same-owner join is not flagged', () => {
  const out = runDb('cross-boundary-joins', dbFacts);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /orders and customers|customers and orders/);
  assert.equal(out[0].measurements['boundary.cross_joins'], 1);
  // billing writes both order_items and orders -> that join stays inside one boundary
  assert.ok(!out.some((d) => d.key.includes('order_items')));
});

test('unbounded-query: SELECT without WHERE or LIMIT on a large table only', () => {
  const out = runDb('unbounded-query', dbFacts);
  assert.deepEqual(keys(out).map((k) => k.split('>')[1].split(':')[0] + ':' + k.split('>')[1].split(':')[1]), ['table:public.orders']);
  assert.equal(out[0].measurements['table.rows'], 52_000_000);
  // regions.ts (SELECT * FROM warehouses, 40 rows) and lookup.ts (WHERE) are absent.
  assert.ok(!out.some((d) => /warehouses|lookup/.test(d.key)));

  const neg = runDb('unbounded-query', [
    N('table', 'public.big', { estimated_rows: 1_000_000 }), N('table', 'public.unknown'),
    N('module', 'm1', {}, 'm1'), N('module', 'm2', {}, 'm2'), N('module', 'm3', {}, 'm3'),
    E('QUERIES', 'module:m1', 'table:public.big', { has_where: true }),
    E('QUERIES', 'module:m2', 'table:public.big', { has_where: false, has_limit: true }),
    E('QUERIES', 'module:m3', 'table:public.unknown', { has_where: false }), // size unknown: no claim
  ]);
  assert.deepEqual(neg, []);
  const q = runDb('unbounded-query', [
    N('table', 'public.big', { estimated_rows: 1_000_000 }),
    N('query', '7', { text: 'SELECT * FROM big', calls: 12 }, null, 'q7'), N('query', '8', { text: 'SELECT * FROM big LIMIT 10' }), N('query', '9', { text: 'SELECT * FROM big WHERE id = $1' }),
    E('QUERIES', 'query:7', 'table:public.big'), E('QUERIES', 'query:8', 'table:public.big'), E('QUERIES', 'query:9', 'table:public.big'),
  ]);
  assert.deepEqual(keys(q), ['query:7>table:public.big:']);
});

test('full-scan-on-hot-path: seq scan on a large table, corroborated by the statement export', () => {
  const out = runDb('full-scan-on-hot-path', dbFacts);
  assert.equal(out.length, 1);
  assert.equal(out[0].measurements['table.rows'], 52_000_000);
  assert.ok(out[0].evidence.some((e) => e.label === 'corroborated' && /250000/.test(e.summary)));
  assert.equal(out[0].uncertainties.length, 0);
  assert.ok(out[0].factors.evidence >= 0.8);

  const cold = runDb('full-scan-on-hot-path', [
    N('table', 'public.big', { estimated_rows: 2_000_000 }), N('table', 'public.tiny', { estimated_rows: 20 }),
    N('plan', 'p#0', { seq_scans: [{ table: 'public.big', rows: 2_000_000, cost: 5, filter: null }, { table: 'public.tiny', rows: 20, cost: 1, filter: null }] }),
  ]);
  assert.equal(cold.length, 1);
  assert.match(cold[0].uncertainties.join(' '), /Hot-path status is unproven/);
  assert.ok(cold[0].factors.evidence < 0.5);
});

test('missing-constraint-candidates: *_id columns with a sibling table and no FOREIGN KEY, low confidence', () => {
  const out = runDb('missing-constraint-candidates', dbFacts);
  assert.deepEqual(keys(out), ['table:public.order_items', 'table:public.orders']);
  const orders = out.find((d) => d.key === 'table:public.orders');
  assert.match(orders.title, /warehouse_id/);
  assert.ok(!/customer_id/.test(orders.title), 'customer_id has a declared REFERENCES');
  assert.ok(orders.factors.evidence <= 0.4);
  assert.match(orders.uncertainties.join(' '), /Low confidence/);
  assert.equal(orders.recovery.type, 'revert');

  const neg = runDb('missing-constraint-candidates', [
    N('table', 'public.a'), N('table', 'public.bs'),
    N('column', 'public.a.b_id'), E('CONTAINS', 'table:public.a', 'column:public.a.b_id'),
    N('constraint', 'public.a.a_b_id_fkey', { kind: 'foreign_key', columns: ['b_id'] }), E('CONTAINS', 'table:public.a', 'constraint:public.a.a_b_id_fkey'),
    N('column', 'public.a.ghost_id'), E('CONTAINS', 'table:public.a', 'column:public.a.ghost_id'), // no sibling table
    N('column', 'public.a.id'), E('CONTAINS', 'table:public.a', 'column:public.a.id'),
  ]);
  assert.deepEqual(neg, []);
});

test('backups-not-restore-tested: retention 0 and untested retention are both flagged; a restore test clears them', () => {
  const out = runDb('backups-not-restore-tested', iacAll);
  const orders = out.find((d) => /orders/.test(d.key));
  const ledger = out.find((d) => /ledger/.test(d.key));
  assert.ok(orders && ledger);
  assert.match(orders.title, /retention is 0/);
  assert.match(ledger.title, /no restore test is recorded/);
  assert.equal(orders.measurements['backup.restore_tested'], 0);
  assert.equal(orders.recovery.type, 'restore');
  assert.match(orders.risks.join(' '), /recovery-posture change/);

  const tested = runDb('backups-not-restore-tested', [...iacAll, N('restore_test', 'q1-drill', { target: 'x' })]);
  assert.deepEqual(tested, []);
  // data sources are not databases we manage
  assert.deepEqual(runDb('backups-not-restore-tested', [N('database', 'data.aws_db_instance.x', { data: true })]), []);
  // a RESTORED_BY edge clears one database only
  const one = runDb('backups-not-restore-tested', [N('database', 'a', { backup_retention_period: 7 }), N('database', 'b', { backup_retention_period: 7 }), E('RESTORED_BY', 'database:a', 'restore_test:r1'), N('restore_test', 'r1', { target: 'database:a' })]);
  assert.ok(one.length <= 1);
});

// ------------------------------------------------------------------ infrastructure

test('copy-pasted-stacks: near-identical environment stacks are one finding; distinct stacks are not', () => {
  const out = runInfra('copy-pasted-stacks', infraGraph);
  assert.ok(out.length >= 1);
  assert.ok(out.every((d) => d.measurements['duplication.similarity'] >= 0.8));
  assert.ok(out.every((d) => d.patterns.includes('infrastructure.extract-iac-module')));
  assert.match(out[0].smallest_simplification, /one state and one backend per environment/);
  assert.match(out[0].verification.join(' '), /zero deletes and replaces/);
  assert.deepEqual(runInfra('copy-pasted-stacks', [N('iac_module', 'envs/a', { resources: 3 }), N('iac_module', 'envs/b', { resources: 9 })]), []);
  // symmetric duplicate_of pairs collapse to one finding
  const pair = runInfra('copy-pasted-stacks', [
    N('iac_module', 'envs/a', { duplicate_of: ['iac_module:envs/b'], duplicate_similarity: 0.9 }),
    N('iac_module', 'envs/b', { duplicate_of: ['iac_module:envs/a'], duplicate_similarity: 0.9 }),
  ]);
  assert.equal(pair.length, 1);
});

test('one-use-wrapper-module: resource-less single-caller module only, with low-medium confidence', () => {
  const out = runInfra('one-use-wrapper-module', infraGraph);
  assert.deepEqual(keys(out), ['iac_module:modules/wrapper']);
  assert.ok(out[0].factors.evidence <= 0.5);
  assert.match(out[0].uncertainties.join(' '), /locals/);
  assert.match(out[0].essential_considerations.join(' '), /policy defaults/);
  assert.equal(out[0].recovery.type, 'revert');
  const neg = runInfra('one-use-wrapper-module', [
    N('iac_module', 'modules/net', { kind: 'module', one_use: true, wrapper: false, resources: 4 }),
    N('iac_module', 'modules/multi', { kind: 'module', one_use: false, wrapper: true }),
    N('iac_module', 'envs/x', { kind: 'stack', one_use: true, wrapper: true }),
  ]);
  assert.deepEqual(neg, []);
});

test('floating-versions: unpinned providers, :latest images and floating bases are flagged; pinned ones are not', () => {
  const out = runInfra('floating-versions', infraGraph);
  const k = keys(out);
  assert.ok(k.includes('iac_module:envs/dev:iac'), 'dev stack declares no provider version');
  assert.ok(!k.some((x) => x.startsWith('iac_module:envs/prod')), 'prod pins providers and module');
  assert.ok(k.includes('workload:shop/Deployment/api:images'));
  assert.ok(!k.some((x) => x.includes('worker') || x.includes('/web')), 'digest-pinned images are fine');
  assert.match(out.find((d) => d.key.endsWith(':images')).smallest_simplification, /digest/);

  const docker = runInfra('floating-versions', [
    N('image', 'Dockerfile', { kind: 'Dockerfile', latest_bases: ['node:latest'] }, 'Dockerfile'),
    N('image', 'svc/Dockerfile', { kind: 'Dockerfile', latest_bases: [] }, 'svc/Dockerfile'),
  ]);
  assert.deepEqual(keys(docker), ['image:Dockerfile:bases']);
});

test('local-or-unencrypted-state: local and unencrypted backends flagged, recorded state and encrypted remote ignored', () => {
  const out = runInfra('local-or-unencrypted-state', infraGraph);
  const k = keys(out);
  assert.ok(k.includes('state_backend:envs/dev'), 'local backend');
  assert.ok(k.includes('state_backend:extra'), 's3 with encrypt = false');
  assert.ok(!k.some((x) => x.includes('prod')));
  assert.ok(!k.some((x) => x.includes('recorded/')));
  assert.equal(out.find((d) => d.key === 'state_backend:envs/dev').recovery.type, 'restore');
  assert.match(out[0].risks.join(' '), /state surgery/);
  // an implicit local backend is inferred, flagged with an uncertainty
  const implicit = runInfra('local-or-unencrypted-state', [N('state_backend', 'envs/z', { type: 'local', remote: false, encrypt: false, locking: false, implicit: true })]);
  assert.match(implicit[0].uncertainties.join(' '), /inferred/);
});

test('missing-state-locking: remote backend without lock only; locked and local backends are skipped', () => {
  const out = runInfra('missing-state-locking', infraGraph);
  assert.deepEqual(keys(out), ['state_backend:extra']);
  assert.deepEqual(runInfra('missing-state-locking', [
    N('state_backend', 'a', { type: 's3', remote: true, encrypt: true, locking: true }),
    N('state_backend', 'b', { type: 'local', remote: false, locking: false }),
    N('state_backend', 'rec', { recorded: true, serial: 3 }),
  ]), []);
});

test('drift: declared/recorded/actual disagreement is reported without an instruction to overwrite', () => {
  const out = runInfra('drift', infraGraph);
  assert.ok(out.length >= 1);
  const unmanaged = out.find((d) => /unmanaged/.test(d.title));
  assert.ok(unmanaged, 'unmanaged resource from the inventory');
  assert.match(unmanaged.essential_considerations.join(' '), /Drift is a finding, not an instruction to overwrite actual state/);
  assert.match(unmanaged.smallest_simplification, /owner/);
  assert.match(unmanaged.smallest_simplification, /resource\.owner_known = 0/);
  assert.equal(unmanaged.measurements['resource.owner_known'], 0);
  assert.ok(out.every((d) => !/apply (the )?declared|overwrite actual state by/i.test(d.smallest_simplification)));
  assert.ok(out.every((d) => d.recovery.type === 'roll_forward'));
  // ordinary resources carry no drift attr
  assert.deepEqual(runInfra('drift', [N('resource', 'aws_s3_bucket.x', { type: 'aws_s3_bucket' })]), []);
  // with an owner recorded the do-not-retire caveat is dropped
  const owned = runInfra('drift', [
    N('resource', 'drift/unmanaged/b1', { drift: { kind: 'unmanaged', id: 'b1', type: 'aws_s3_bucket', evidence: { note: 'x' } } }),
    N('team', 'platform'), E('OWNED_BY', 'resource:drift/unmanaged/b1', 'team:platform'),
  ]);
  assert.equal(owned[0].measurements['resource.owner_known'], 1);
  assert.ok(!/owner_known = 0/.test(owned[0].smallest_simplification));
});

test('destructive-plan-change: replace of a stateful database is flagged with the §15.9 requirements', () => {
  const out = runInfra('destructive-plan-change', infraGraph);
  const rds = out.find((d) => /aws_db_instance\.main/.test(d.title));
  assert.ok(rds, 'RDS replace plan');
  assert.equal(rds.measurements['plan.replaces'], 1);
  assert.equal(rds.measurements['plan.deletes'], 0);
  assert.equal(rds.recovery.type, 'restore');
  assert.equal(rds.blast_radius, 'high');
  const v = rds.verification.join('\n');
  for (const re of [/Two-person approval including the resource owner/, /state serial and environment/, /Dependency and recovery-role evidence/, /Backup\/restore or recreation proof/, /Staged execution/, /abort thresholds and an observation period/, /signed audit event/]) assert.match(v, re);
  assert.match(rds.smallest_simplification, /Do not apply/);
  assert.ok(rds.scope.length >= 1);
  // updates and non-stateful destruction are not this detector's concern
  assert.ok(!out.some((d) => /aws_iam_role_policy/.test(d.title)));
  const neg = runInfra('destructive-plan-change', [
    N('plan_action', 'h/aws_s3_bucket_policy.x', { address: 'aws_s3_bucket_policy.x', action: 'delete', destructive: true, stateful: false, node_type: 'policy', plan_hash: 'h' }),
    N('plan_action', 'h/aws_db_instance.y', { address: 'aws_db_instance.y', action: 'update', destructive: false, stateful: true, plan_hash: 'h' }),
    N('plan_action', 'h/(plan)', { summary: {} }),
  ]);
  assert.deepEqual(neg, []);
  const cluster = runInfra('destructive-plan-change', [N('plan_action', 'h/c', { address: 'aws_eks_cluster.c', type: 'aws_eks_cluster', action: 'delete', destructive: true, stateful: false, node_type: 'cluster', plan_hash: 'h' })]);
  assert.equal(cluster.length, 1);
  assert.equal(cluster[0].measurements['plan.deletes'], 1);
});

test('destructive-plan-change: a create-only plan produces nothing', async () => {
  const created = await iacEvidence(iacBase.factsByFile, { infra_plans: [{ path: 'plans/a-create-only.json' }] });
  assert.deepEqual(runInfra('destructive-plan-change', created), []);
  assert.deepEqual(runInfra('privilege-widening-plan', created), []);
});

test('privilege-widening-plan: widened policy flagged, narrowed one is not', () => {
  const out = runInfra('privilege-widening-plan', infraGraph);
  assert.ok(out.some((d) => /aws_iam_role_policy\.app/.test(d.title)));
  assert.ok(!out.some((d) => /aws_iam_role_policy\.narrow/.test(d.title)));
  const app = out.find((d) => /aws_iam_role_policy\.app/.test(d.title));
  assert.equal(app.measurements['iam.wildcards'], 1);
  assert.match(app.verification.join(' '), /security owner/);
  assert.equal(app.recovery.type, 'revert');
});

test('public-exposure: open CIDRs, public buckets and databases, LoadBalancer services; private rules and ClusterIP are not', () => {
  const out = runInfra('public-exposure', infraGraph);
  const k = keys(out);
  assert.ok(k.some((x) => x.startsWith('firewall_rule:') && x.includes('aws_security_group.open')), 'open security group');
  assert.ok(k.includes('bucket:extra/main.tf/aws_s3_bucket.public') || k.some((x) => x.startsWith('bucket:') && x.includes('public')), 'public bucket');
  assert.ok(k.some((x) => x.startsWith('database:') && x.includes('aws_db_instance.orders')), 'publicly accessible database');
  assert.ok(k.includes('service:shop/api-public'), 'LoadBalancer service');
  assert.ok(!k.includes('service:shop/worker'));
  assert.ok(!k.some((x) => /envs\/(dev|staging)\/.*aws_security_group\.web/.test(x)), 'dev and staging SGs only allow 10.0.0.0/8');
  const prodWeb = out.find((d) => /envs\/prod\/.*aws_security_group\.web/.test(d.key));
  assert.ok(prodWeb, 'prod web SG is open to the world (SSH)');
  assert.deepEqual(prodWeb.uncertainties, [], 'SSH to the world has no by-design caveat');
  assert.match(prodWeb.evidence[0].summary, /22/);
  assert.ok(out.every((d) => d.measurements['network.public_ingress'] === 1));
  const lb = out.find((d) => d.key === 'service:shop/api-public');
  assert.match(lb.uncertainties.join(' '), /internal by annotation/);
  assert.match(out.find((d) => d.key.includes('aws_security_group.open')).smallest_simplification, /by design/);
  // ports 80/443 are commonly intentional: lower evidence
  const web = runInfra('public-exposure', [N('firewall_rule', 'sg', { public_ingress: true, ports: ['443'], cidrs: ['0.0.0.0/0'] })]);
  const wide = runInfra('public-exposure', [N('firewall_rule', 'sg', { public_ingress: true, ports: ['0-65535'], wildcard_ports: true, cidrs: ['0.0.0.0/0'] })]);
  assert.ok(web[0].factors.evidence < wide[0].factors.evidence);
  assert.deepEqual(runInfra('public-exposure', [N('bucket', 'b', { acl: 'private' }), N('database', 'd', { publicly_accessible: false })]), []);
});

test('iam-wildcards: wildcard actions and admin policies flagged; assume-role-only roles are not', () => {
  const out = runInfra('iam-wildcards', infraGraph);
  const k = keys(out);
  assert.ok(k.some((x) => x.includes('aws_iam_policy.admin')), 'admin policy');
  assert.ok(k.some((x) => x.includes('aws_iam_role_policy.app')), 's3:* inline policy');
  assert.ok(!k.some((x) => /aws_iam_role\.app$/.test(x)), 'trust policy only');
  const admin = out.find((d) => d.key.includes('aws_iam_policy.admin'));
  assert.match(admin.title, /administrator-level/);
  assert.ok(admin.measurements['iam.wildcards'] >= 2);
  assert.match(admin.essential_considerations.join(' '), /break-glass/);
  // Kubernetes RBAC: a wildcard ClusterRole is flagged, builtin stubs are not
  const rbac = runInfra('iam-wildcards', [
    N('role', '_cluster/everything', { kind: 'ClusterRole', wildcard_verbs: true, wildcard_resources: true, cluster_admin: true }),
    N('role', '_cluster/cluster-admin', { kind: 'ClusterRole', builtin: true, cluster_admin: true }),
    N('role', 'shop/reader', { kind: 'Role', wildcard_verbs: false, wildcard_resources: false, escalation_risk: false }),
  ]);
  assert.deepEqual(keys(rbac), ['role:_cluster/everything']);
});

test('long-lived-keys: static access keys flagged; other resources and data sources are not', () => {
  const out = runInfra('long-lived-keys', infraGraph);
  assert.equal(out.length, 1);
  assert.match(out[0].key, /aws_iam_access_key\.deploy/);
  assert.ok(out[0].patterns.includes('infrastructure.workload-identity'));
  assert.ok(!JSON.stringify(out[0]).match(/AKIA/));
  assert.equal(out[0].recovery.type, 'roll_forward');
  assert.deepEqual(runInfra('long-lived-keys', [N('resource', 'data.aws_iam_access_key.x', { type: 'aws_iam_access_key', data: true }), N('resource', 'aws_iam_user.u', { type: 'aws_iam_user' })]), []);
});

test('missing-disruption-budget: replicated workload without PDB only', () => {
  const out = runInfra('missing-disruption-budget', infraGraph);
  assert.deepEqual(keys(out), ['workload:shop/Deployment/api']);
  assert.match(out[0].title, /3 replicas/);
  const neg = runInfra('missing-disruption-budget', [
    N('workload', 'x/Deployment/single', { kind: 'Deployment', replicas: 1 }),
    N('workload', 'x/CronJob/job', { kind: 'CronJob', replicas: 4 }),
    N('workload', 'x/Deployment/protected', { kind: 'Deployment', replicas: 4, pdb: true }),
  ]);
  assert.deepEqual(neg, []);
});

test('missing-probes: containers with no probe at all, not partially probed ones', () => {
  const out = runInfra('missing-probes', infraGraph);
  assert.deepEqual(keys(out), ['workload:shop/Deployment/api']);
  assert.match(out[0].title, /api, istio-proxy/);
  const neg = runInfra('missing-probes', [N('workload', 'x/Deployment/ok', { kind: 'Deployment', containers: [{ name: 'a', probes: { liveness: false, readiness: true, startup: false } }] })]);
  assert.deepEqual(neg, []);
});

test('missing-resources: no requests or no limits, reported separately', () => {
  const out = runInfra('missing-resources', infraGraph);
  assert.deepEqual(keys(out), ['workload:shop/Deployment/api']);
  assert.match(out[0].title, /2 container\(s\) without resource requests, 2 without limits/);
  const partial = runInfra('missing-resources', [N('workload', 'x/Deployment/p', { kind: 'Deployment', containers: [{ name: 'a', resources: { requests: true, limits: false } }] })]);
  assert.equal(partial.length, 1);
  assert.match(partial[0].title, /0 container\(s\) without resource requests, 1 without limits/);
  assert.match(partial[0].uncertainties.join(' '), /LimitRange/);
});

test('privileged-workloads: privileged, host access and explicit root; hardened workloads are not', () => {
  const out = runInfra('privileged-workloads', infraGraph);
  assert.deepEqual(keys(out), ['workload:shop/Deployment/api']);
  const t = out[0].title;
  assert.match(t, /privileged/);
  assert.match(t, /hostNetwork/);
  assert.match(t, /runAsNonRoot: false/);
  assert.equal(out[0].recovery.type, 'revert');
  assert.match(out[0].essential_considerations.join(' '), /Node agents/);
  const df = runInfra('privileged-workloads', [N('image', 'Dockerfile', { kind: 'Dockerfile', final_stage_root: true, final_user: null }, 'Dockerfile'), N('image', 'ok/Dockerfile', { kind: 'Dockerfile', final_stage_root: false }, 'ok/Dockerfile')]);
  assert.deepEqual(keys(df), ['image:Dockerfile']);
  // unspecified runAsNonRoot is not claimed to be root
  assert.deepEqual(runInfra('privileged-workloads', [N('workload', 'x/Deployment/u', { kind: 'Deployment', containers: [{ name: 'a', securityContext: { privileged: false, runAsNonRoot: null } }] })]), []);
});

test('mesh-sidecar-without-policy: low confidence, cleared by policy objects or non-mesh sidecars', () => {
  const out = runInfra('mesh-sidecar-without-policy', infraGraph);
  assert.deepEqual(keys(out), ['workload:shop/Deployment/api']);
  assert.ok(out[0].factors.evidence <= 0.4);
  assert.equal(out[0].evidence[0].label, 'inferred');
  assert.match(out[0].uncertainties.join(' '), /Low confidence/);
  assert.match(out[0].smallest_simplification, /never leave encryption weaker/);
  assert.ok(out[0].patterns.includes('anti-pattern.cargo-cult-service-mesh'));
  const withPolicy = runInfra('mesh-sidecar-without-policy', [
    N('workload', 'x/Deployment/a', { kind: 'Deployment', sidecars: [{ name: 'istio-proxy', image: 'proxyv2' }] }),
    N('resource', 'x/PeerAuthentication/default', { kind: 'PeerAuthentication' }),
  ]);
  assert.deepEqual(withPolicy, []);
  const logger = runInfra('mesh-sidecar-without-policy', [N('workload', 'x/Deployment/a', { kind: 'Deployment', sidecars: [{ name: 'fluent-bit', image: 'fluent-bit' }] })]);
  assert.deepEqual(logger, []);
});

test('backups-without-protection: unguarded stateful databases flagged; protected ones are not', () => {
  const out = runInfra('backups-without-protection', infraGraph);
  const orders = out.find((d) => /aws_db_instance\.orders/.test(d.key));
  assert.ok(orders);
  assert.match(orders.title, /deletion_protection = false/);
  assert.match(orders.title, /no lifecycle prevent_destroy/);
  assert.match(orders.title, /skip_final_snapshot/);
  assert.ok(!out.some((d) => /aws_db_instance\.ledger/.test(d.key)), 'ledger has both guards');
  assert.match(orders.risks.join(' '), /recovery-posture change/);
  const neg = runInfra('backups-without-protection', [
    N('volume', 'v1', { stateful: true, lifecycle: { prevent_destroy: true } }),
    N('database', 'data.d', { stateful: true, data: true }),
    N('compute', 'c1', { stateful: false }),
  ]);
  assert.deepEqual(neg, []);
  assert.equal(runInfra('backups-without-protection', [N('volume', 'v2', { stateful: true })]).length, 1);
});

// ------------------------------------------------------------------ engine integration

async function runDiagnose() {
  const dir = mkdtempSync(join(tmpdir(), 'unknot-dbi-proj-'));
  const ctx = openProject(dir, { create: true });
  const { config } = loadConfig(ctx);
  const graph = Graph.fromFacts([...dbFacts, ...infraFacts]);
  const res = await diagnose(ctx, { config, graph, only: ['database', 'infrastructure'] });
  ctx.store.close?.();
  return res;
}

const diagnosed = await runDiagnose();

test('diagnose(): all detectors run end to end with no errors and valid findings', () => {
  const res = diagnosed;
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.detectors, DB.length + INFRA.length);
  for (const f of res.findings) {
    const v = validateArtifact('finding', f);
    assert.ok(v.valid, `${f.kind}: ${JSON.stringify(v.errors?.slice(0, 2))}`);
    assert.ok(f.alternatives.some((a) => a.id === 'retain'));
    assert.ok(f.priority.score > 0, `${f.kind} has a priority`);
  }
  // every detector has a positive case in the integrated fixtures
  const kinds = new Set(res.findings.map((f) => f.kind));
  for (const d of [...DB, ...INFRA]) assert.ok(kinds.has(d.id), `no ${d.id} finding from the integrated fixtures`);
  // database findings are high or critical by the engine's classification
  for (const f of res.findings.filter((x) => x.category === 'database')) assert.ok(['high', 'critical'].includes(f.risk), `${f.kind} risk ${f.risk}`);
  assert.ok(res.findings.filter((x) => x.category === 'infrastructure').every((f) => ['medium', 'high', 'critical'].includes(f.risk)));
});

// ENGINE ISSUE (reported, not worked around): the engine classifies infrastructure risk
// from scope *paths* only (runtime/diagnose/engine.mjs `finalize` never passes
// `surfaces.destructive_infra`, and classifyRisk's IAM/NET/RECOVERY hints regex over
// paths), so a destructive plan change on a stateful resource, a privilege widening or a
// public exposure comes out `medium`. Spec §15.9 says these are always high risk.
test('diagnose(): destructive and privilege-widening infrastructure findings are high or critical risk', { todo: 'engine does not pass surfaces.destructive_infra; classification is path-only' }, () => {
  for (const kind of ['infrastructure.destructive-plan-change', 'infrastructure.privilege-widening-plan']) {
    const found = diagnosed.findings.filter((f) => f.kind === kind);
    assert.ok(found.length >= 1, kind);
    for (const f of found) assert.ok(['high', 'critical'].includes(f.risk), `${kind} classified ${f.risk}`);
  }
});
