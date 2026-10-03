import test from 'node:test';
import assert from 'node:assert/strict';
import adapter, { tableKey, normalizeTableId } from '../../../../adapters/database/index.mjs';
import { assertFact, nodeFact, edgeFact, prov } from '../../../../runtime/graph/facts.mjs';
import { fixture, fixtureTree, entry, nodes, edges, ids } from './helpers.mjs';

const PG = { options: { engine: 'postgresql', version: '16' } };

/** Extract every file under a fixture dir and return facts by (repo-style) path. */
function extractTree(dir, options = PG.options) {
  const factsByFile = new Map();
  const files = new Map();
  for (const rel of fixtureTree(dir)) {
    const text = fixture(`${dir}/${rel}`);
    files.set(rel, entry(rel));
    factsByFile.set(rel, adapter.extract(entry(rel), text, { options }));
  }
  return { files, factsByFile };
}

const all = (m) => [...m.values()].flat();

// ------------------------------------------------------------------ contract

test('adapter: contract shape and capabilities', () => {
  assert.equal(adapter.id, 'database');
  assert.equal(adapter.version, '0.1.0');
  assert.equal(adapter.kind, 'database');
  assert.deepEqual(adapter.capabilities.executes, []);
  assert.equal(adapter.capabilities.network, false);
  for (const g of ['**/*.sql', '**/migrations/**', '**/migrate/**', '**/schema.prisma', '**/changelog*.{xml,yaml,yml,json}', '**/db/schema.rb', '**/alembic/versions/*.py']) {
    assert.ok(adapter.capabilities.files.includes(g), g);
  }
  assert.equal(typeof adapter.extract, 'function');
  assert.equal(typeof adapter.link, 'function');
  assert.equal(typeof adapter.discover, 'function');
});

test('adapter: every fact validates and carries provenance', () => {
  const { factsByFile } = extractTree('flyway-pg');
  for (const f of all(factsByFile)) {
    assertFact(f);
    assert.equal(f.provenance.extractor, 'database@0.1.0');
    assert.match(f.provenance.source_ref, /:\d+$/);
  }
});

test('adapter: extraction is deterministic', () => {
  const a = JSON.stringify(extractTree('flyway-pg').factsByFile.get('db/migration/V1__init.sql'));
  const b = JSON.stringify(extractTree('flyway-pg').factsByFile.get('db/migration/V1__init.sql'));
  assert.equal(a, b);
});

test('naming: schema defaults, case folding and alias normalisation', () => {
  assert.equal(tableKey({ schema: null, name: 'orders' }, 'postgresql'), 'public.orders');
  assert.equal(tableKey({ schema: null, name: 'orders' }, 'mysql'), 'orders');
  assert.equal(tableKey({ schema: 'Sales', name: 'Orders' }, 'postgresql'), 'Sales.Orders');
  assert.equal(normalizeTableId('table:orders', 'postgresql'), 'table:public.orders');
  assert.equal(normalizeTableId('table:sales.orders', 'postgresql'), 'table:sales.orders');
  assert.equal(normalizeTableId('table:orders', 'mysql'), 'table:orders');
});

// ------------------------------------------------------------------ extract: DDL graph

test('extract: baseline DDL becomes tables, columns, constraints, FKs, views and grants', () => {
  const facts = adapter.extract(entry('db/migration/V1__init.sql'), fixture('flyway-pg/db/migration/V1__init.sql'), PG);
  assert.ok(ids(facts, 'table').includes('table:public.orders'));
  assert.ok(ids(facts, 'column').includes('column:public.orders.customer_id'));
  assert.ok(edges(facts, 'CONTAINS').some((e) => e.from === 'table:public.orders' && e.to === 'column:public.orders.total'));
  assert.ok(ids(facts, 'constraint').includes('constraint:public.orders.orders_total_check'));
  assert.deepEqual(ids(facts, 'view'), ['view:public.big_orders']);
  const derived = edges(facts, 'DERIVED_FROM').filter((e) => e.from === 'view:public.big_orders').map((e) => e.to).sort();
  assert.deepEqual(derived, ['table:public.customers', 'table:public.orders']);
  const grant = edges(facts, 'AUTHORIZED_FOR')[0];
  assert.deepEqual([grant.from, grant.to, grant.attrs.privileges], ['db_role:app_rw', 'table:public.orders', ['SELECT', 'INSERT', 'UPDATE']]);
  const col = nodes(facts, 'column').find((n) => n.id === 'column:public.customers.created_at');
  assert.equal(col.attrs.nullable, false);
  assert.equal(col.attrs.default, 'now()');
});

test('extract: FK adds REFERENCES with columns and on_delete', () => {
  const facts = adapter.extract(entry('db/migration/V4__fk_not_valid.sql'), fixture('flyway-pg/db/migration/V4__fk_not_valid.sql'), PG);
  const ref = edges(facts, 'REFERENCES')[0];
  assert.deepEqual([ref.from, ref.to, ref.attrs.columns, ref.attrs.on_delete, ref.attrs.not_valid], ['table:public.orders', 'table:public.customers', ['customer_id'], 'CASCADE', true]);
});

test('extract: indexes link back with INDEXED_BY', () => {
  const facts = adapter.extract(entry('db/migration/V2__orders_index.sql'), fixture('flyway-pg/db/migration/V2__orders_index.sql'), PG);
  const e = edges(facts, 'INDEXED_BY')[0];
  assert.deepEqual([e.from, e.to], ['table:public.orders', 'index:public.idx_orders_customer']);
});

test('extract: MySQL scripts are not schema-qualified and handle DELIMITER', () => {
  const facts = adapter.extract(entry('db/migrate/001_instant.sql'), fixture('mysql/001_instant.sql'), { options: { engine: 'mysql', version: '8.0.32' } });
  assert.ok(ids(facts, 'table').includes('table:orders'));
  assert.ok(ids(facts, 'trigger').includes('trigger:orders.orders_bi'));
  const m = nodes(facts, 'migration')[0];
  assert.equal(m.attrs.engine, 'mysql');
  assert.equal(m.attrs.statements[0].forecast.rule_id, 'my.add_column.instant');
});

test('extract: case-insensitive for unquoted identifiers, case-preserving for quoted', () => {
  const facts = adapter.extract(entry('schema.sql'), 'CREATE TABLE Public.ORDERS (ID int); CREATE TABLE "Mixed" (x int);', PG);
  assert.ok(ids(facts, 'table').includes('table:public.orders'));
  assert.ok(ids(facts, 'table').includes('table:public.Mixed'));
});

// ------------------------------------------------------------------ extract: migrations

test('extract: Flyway migration node carries spec attrs and MIGRATES edge', () => {
  const facts = adapter.extract(entry('db/migration/V3__change_type.sql'), fixture('flyway-pg/db/migration/V3__change_type.sql'), PG);
  const m = nodes(facts, 'migration')[0];
  assert.equal(m.id, 'migration:db/migration/V3__change_type.sql');
  assert.equal(m.attrs.framework, 'flyway');
  assert.equal(m.attrs.version, '3');
  assert.equal(m.attrs.order_key, '000000000003');
  assert.equal(typeof m.attrs.has_down, 'boolean');
  assert.equal(m.attrs.destructive, false);
  assert.equal(m.attrs.statements[0].forecast.rewrite, 'table');
  assert.ok(edges(facts, 'MIGRATES').some((e) => e.from === m.id && e.to === 'table:public.orders'));
});

test('extract: Rails/Django/Alembic migration facts are medium-confidence inference', () => {
  const rails = adapter.extract(entry('db/migrate/20240101000001_add_status_to_orders.rb'), fixture('rails/db/migrate/20240101000001_add_status_to_orders.rb'), PG);
  const m = nodes(rails, 'migration')[0];
  assert.equal(m.attrs.framework, 'rails');
  assert.equal(m.provenance.confidence, 'medium');
  assert.equal(m.provenance.source_type, 'inference');
  assert.ok(ids(rails, 'column').includes('column:public.orders.status'));
  const dj = adapter.extract(entry('shop/migrations/0002_order_status.py'), fixture('django/shop/migrations/0002_order_status.py'), PG);
  assert.equal(nodes(dj, 'migration')[0].attrs.framework, 'django');
  assert.ok(edges(dj, 'MIGRATES').some((e) => e.to === 'table:public.shop_order'));
});

test('extract: undo/down files produce no facts', () => {
  assert.deepEqual(adapter.extract(entry('db/migration/U3__undo_change_type.sql'), fixture('flyway-pg/db/migration/U3__undo_change_type.sql'), PG), []);
  assert.deepEqual(adapter.extract(entry('migrations/000001_create_users.down.sql'), fixture('golang-migrate/migrations/000001_create_users.down.sql'), PG), []);
});

test('extract: Prisma schema maps models, @@map/@map, relations and indexes', () => {
  const facts = adapter.extract(entry('prisma/schema.prisma'), fixture('prisma/schema.prisma'), { options: {} });
  assert.deepEqual(ids(facts, 'table'), ['table:public.posts', 'table:public.users']);
  assert.ok(ids(facts, 'column').includes('column:public.users.email_address'), '@map renames the column');
  assert.ok(!ids(facts, 'column').includes('column:public.users.posts'), 'relation list fields are not columns');
  const ref = edges(facts, 'REFERENCES')[0];
  assert.deepEqual([ref.from, ref.to, ref.attrs.columns, ref.attrs.ref_columns, ref.attrs.on_delete], ['table:public.posts', 'table:public.users', ['authorId'], ['id'], 'Cascade']);
  assert.ok(ids(facts, 'index').includes('index:public.posts_authorId_idx'));
});

test('extract: Rails schema.rb and Liquibase produce graph facts', () => {
  const schema = adapter.extract(entry('db/schema.rb'), fixture('rails/db/schema.rb'), PG);
  assert.deepEqual(ids(schema, 'table'), ['table:public.customers', 'table:public.orders']);
  assert.ok(edges(schema, 'REFERENCES').some((e) => e.from === 'table:public.orders' && e.to === 'table:public.customers'));
  assert.ok(ids(schema, 'index').includes('index:public.index_orders_on_customer_id'));
  const lb = adapter.extract(entry('db.changelog-master.xml'), fixture('liquibase/db.changelog-master.xml'), PG);
  assert.equal(nodes(lb, 'migration')[0].attrs.framework, 'liquibase');
  assert.ok(ids(lb, 'table').includes('table:public.widgets'));
});

test('extract: Atlas HCL tables, indexes and foreign keys', () => {
  const hcl = `table "users" {
  schema = schema.public
  column "id" { null = false type = int }
  column "email" { null = false type = varchar(100) }
  index "users_email" { columns = [column.email] unique = true }
}
table "posts" {
  schema = schema.public
  column "user_id" { type = int }
  foreign_key "fk_user" { columns = [column.user_id] ref_columns = [table.users.column.id] on_delete = CASCADE }
}`;
  const facts = adapter.extract(entry('schema.hcl'), hcl, PG);
  assert.deepEqual(ids(facts, 'table'), ['table:public.posts', 'table:public.users']);
  assert.ok(edges(facts, 'REFERENCES').some((e) => e.to === 'table:public.users' && e.attrs.on_delete === 'CASCADE'));
  assert.ok(ids(facts, 'index').includes('index:public.users_email'));
});

test('extract: unrelated files yield nothing; huge outputs are capped and say so', () => {
  assert.deepEqual(adapter.extract(entry('src/app.ts'), 'export const a = 1;', PG), []);
  const big = Array.from({ length: 2500 }, (_, i) => `CREATE TABLE t${i} (a int, b int);`).join('\n');
  const facts = adapter.extract(entry('big.sql'), big, PG);
  const file = nodes(facts, 'file')[0];
  assert.equal(file.attrs.truncated, true);
  assert.ok(facts.length <= 5001);
});

// ------------------------------------------------------------------ link

test('link: raw SQL on module nodes becomes QUERIES / MUTATES / JOINS_WITH', () => {
  const modules = JSON.parse(fixture('code/modules.json'));
  const factsByFile = new Map();
  for (const m of modules) {
    const fact = nodeFact('module', m.path, { path: m.path, attrs: { sql: m.sql } }, prov({ source_type: 'ast', source_ref: `${m.path}:1`, extractor: 'javascript@0.1.0' }));
    factsByFile.set(m.path, [fact]);
  }
  const facts = adapter.link({ files: new Map(), factsByFile, options: {} });
  for (const f of facts) assertFact(f);
  const q = edges(facts, 'QUERIES').filter((e) => e.from === 'module:src/orders.ts');
  assert.deepEqual(q.map((e) => e.to).sort(), ['table:public.customers', 'table:public.orders', 'table:public.orders'].sort());
  assert.ok(q.every((e) => typeof e.attrs.line === 'number' && e.attrs.kind === 'select' && 'has_where' in e.attrs));
  const sel = q.find((e) => e.attrs.line === 12 && e.to === 'table:public.orders');
  assert.equal(sel.attrs.has_where, true);
  const muts = edges(facts, 'MUTATES').filter((e) => e.from === 'module:src/orders.ts');
  assert.deepEqual(muts.map((e) => [e.attrs.kind, e.attrs.line, e.attrs.has_where]).sort(), [['delete', 41, true], ['update', 30, false]]);
  const joins = edges(facts, 'JOINS_WITH');
  assert.equal(joins.length, 1);
  assert.deepEqual([joins[0].from, joins[0].to], ['table:public.customers', 'table:public.orders']);
  assert.ok(!edges(facts, 'QUERIES').some((e) => e.to === 'table:public.recent'), 'CTE names are not tables');
  assert.ok(edges(facts, 'MUTATES').some((e) => e.from === 'module:app/models.py' && e.to === 'table:public.audit_log'));
});

test('link: ORM table ids from language adapters are normalised with aliases', () => {
  const py = 'python@0.1.0';
  const pp = (l) => prov({ source_type: 'ast', source_ref: `app/models.py:${l}`, extractor: py });
  const factsByFile = new Map([['app/models.py', [
    nodeFact('module', 'app/models.py', { path: 'app/models.py' }, pp(1)),
    nodeFact('table', 'orders', { path: 'app/models.py' }, pp(3)),
    edgeFact('OWNS_DATA', 'module:app/models.py', 'table:orders', {}, pp(3)),
  ]]]);
  const facts = adapter.link({ files: new Map(), factsByFile, options: {} });
  const t = nodes(facts, 'table').find((n) => n.id === 'table:public.orders');
  assert.deepEqual(t.attrs.aliases, ['table:orders']);
  const e = edges(facts, 'OWNS_DATA')[0];
  assert.equal(e.to, 'table:public.orders');
  assert.deepEqual(e.attrs.aliases, ['table:orders']);
  // MySQL ids stay unqualified, so nothing is rewritten.
  assert.equal(adapter.link({ files: new Map(), factsByFile, options: { engine: 'mysql' } }).length, 0);
});

test('link: golang-migrate pairs and Flyway undo files resolve has_down; missing down is a finding', () => {
  const { files, factsByFile } = extractTree('golang-migrate');
  const facts = adapter.link({ files, factsByFile, options: PG.options });
  const restated = nodes(facts, 'migration');
  const m1 = restated.find((n) => n.id.endsWith('000001_create_users.up.sql'));
  const m2 = restated.find((n) => n.id.endsWith('000002_add_orders.up.sql'));
  assert.equal(m1.attrs.has_down, true);
  assert.equal(m2.attrs.has_down, false);
  assert.equal(m2.attrs.irreversible, true);
  const findings = nodes(facts, 'finding');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].attrs.rule_id, 'db.migration.missing_down');
  assert.match(findings[0].attrs.migration, /000002/);

  const fw = extractTree('flyway-pg');
  const fwFacts = adapter.link({ files: fw.files, factsByFile: fw.factsByFile, options: PG.options });
  const v3 = nodes(fwFacts, 'migration').find((n) => n.id.endsWith('V3__change_type.sql'));
  assert.equal(v3.attrs.has_down, true, 'U3 undo file exists');
  assert.equal(nodes(fwFacts, 'migration').some((n) => n.id.endsWith('V2__orders_index.sql')), true);
  assert.equal(nodes(fwFacts, 'migration').find((n) => n.id.endsWith('V2__orders_index.sql')).attrs.has_down, false);
});

test('link: Alembic order_key follows the revision chain; Atlas dirs are recognised', () => {
  const { files, factsByFile } = extractTree('alembic');
  const facts = adapter.link({ files, factsByFile, options: PG.options });
  const key = (rev) => nodes(facts, 'migration').find((n) => n.attrs.revision === rev).attrs.order_key;
  assert.ok(key('a1b2') < key('c3d4') && key('c3d4') < key('e5f6'));

  const sqlFacts = adapter.extract(entry('atlas/migrations/20240101_init.sql'), 'CREATE TABLE a (id int);', PG);
  const af = new Map([['atlas/migrations/20240101_init.sql', sqlFacts]]);
  const files2 = new Map([['atlas/migrations/20240101_init.sql', entry('x')], ['atlas/migrations/atlas.sum', entry('x')]]);
  const out = adapter.link({ files: files2, factsByFile: af, options: PG.options });
  assert.equal(nodes(out, 'migration')[0].attrs.framework, 'atlas');
});

// ------------------------------------------------------------------ discover

function discoverCtx(paths, extra = {}) {
  return {
    root: '/x',
    census: [],
    options: PG.options,
    evidence: { db_metadata: paths },
    readText: async (p) => fixture(`catalog/${p}`),
    exec: async () => { throw new Error('discover must not execute anything'); },
    ...extra,
  };
}

test('discover: PostgreSQL catalog export with unused, duplicate and redundant indexes', async () => {
  const facts = await adapter.discover(discoverCtx(['pg_catalog.json']));
  for (const f of facts) { assertFact(f); assert.equal(f.provenance.source_type, 'catalog'); }
  const t = nodes(facts, 'table').find((n) => n.id === 'table:public.orders');
  assert.equal(t.attrs.estimated_rows, 52000000);
  assert.equal(t.attrs.size_bytes, 41000000000);
  const ix = Object.fromEntries(nodes(facts, 'index').map((n) => [n.name, n.attrs]));
  assert.equal(ix.idx_orders_total.unused_candidate, true);
  assert.equal(ix.idx_orders_total.idx_scan, 0);
  assert.equal(ix.orders_pkey.unused_candidate, false);
  assert.equal(ix.idx_orders_customer.unused_candidate, false);
  assert.equal(ix.idx_orders_customer_dup.duplicate_of, 'index:public.idx_orders_customer');
  assert.equal(ix.idx_orders_customer.duplicate_of, null);
  assert.equal(ix.idx_orders_customer.redundant_to, 'index:public.idx_orders_customer_total', 'a prefix of a wider btree is redundant');
  assert.equal(ix.idx_orders_broken.invalid, true);
  const fk = edges(facts, 'REFERENCES')[0];
  assert.deepEqual([fk.from, fk.to, fk.attrs.columns, fk.attrs.ref_columns, fk.attrs.on_delete], ['table:public.orders', 'table:public.customers', ['customer_id'], ['id'], 'CASCADE']);
  assert.ok(edges(facts, 'INDEXED_BY').length >= 6);
  const au = edges(facts, 'AUTHORIZED_FOR').find((e) => e.from === 'db_role:app_rw');
  assert.deepEqual(au.attrs.privileges, ['SELECT', 'UPDATE']);
  assert.ok(ids(facts, 'db_role').includes('db_role:app_ro'));
  assert.ok(nodes(facts, 'engine')[0].attrs.version === '16.2');
});

test('discover: pg_stat_statements CSV becomes query nodes with calls and mean time', async () => {
  const facts = await adapter.discover(discoverCtx(['pg_stat_statements.csv']));
  const q = nodes(facts, 'query');
  assert.equal(q.length, 3);
  const q1 = q.find((n) => n.id === 'query:1001');
  assert.deepEqual([q1.attrs.calls, q1.attrs.mean_exec_time_ms], [120000, 0.4]);
  assert.ok(edges(facts, 'QUERIES').some((e) => e.from === 'query:1001' && e.to === 'table:public.orders'));
  assert.ok(edges(facts, 'MUTATES').some((e) => e.from === 'query:1002' && e.to === 'table:public.orders' && e.attrs.has_where === true));
  const joined = q.find((n) => n.id === 'query:1003');
  assert.match(joined.attrs.text, /JOIN customers/, 'multi-line quoted CSV fields are preserved');
  assert.equal(edges(facts, 'QUERIES').filter((e) => e.from === 'query:1003').length, 2);
});

test('discover: pg_stat_statements JSON works too', async () => {
  const json = JSON.stringify([{ queryid: 9, query: 'SELECT 1 FROM t', calls: 3, mean_time: 1.5 }]);
  const facts = await adapter.discover(discoverCtx(['x.json'], { readText: async () => json }));
  const q = nodes(facts, 'query')[0];
  assert.deepEqual([q.id, q.attrs.calls, q.attrs.mean_exec_time_ms], ['query:9', 3, 1.5]);
});

test('discover: EXPLAIN (FORMAT JSON) plan reports Seq Scans, rows and cost', async () => {
  const facts = await adapter.discover(discoverCtx(['explain_seqscan.json']));
  const plan = nodes(facts, 'plan')[0];
  assert.equal(plan.attrs.has_seq_scan, true);
  assert.equal(plan.attrs.total_cost, 98765.4);
  assert.equal(plan.attrs.estimated_rows, 52000000);
  assert.deepEqual(plan.attrs.seq_scans.map((s) => [s.table, s.rows]), [['public.orders', 52000000]]);
  assert.ok(plan.attrs.node_types.includes('Index Scan'));
  const scans = edges(facts, 'QUERIES').map((e) => [e.to, e.attrs.scan]).sort();
  assert.deepEqual(scans, [['table:public.customers', 'Index Scan'], ['table:public.orders', 'Seq Scan']]);
  for (const f of facts) assert.equal(f.provenance.source_type, 'catalog');
});

test('discover: missing evidence, unreadable and unrecognised files are skipped quietly', async () => {
  assert.deepEqual(await adapter.discover({ ...discoverCtx([]), evidence: {} }), []);
  assert.deepEqual(await adapter.discover({ ...discoverCtx(['nope.json']), readText: async () => { throw new Error('ENOENT'); } }), []);
  assert.deepEqual(await adapter.discover(discoverCtx(['junk.txt'], { readText: async () => 'hello world' })), []);
  assert.deepEqual(await adapter.discover(discoverCtx(['bad.json'], { readText: async () => '{not json' })), []);
});
