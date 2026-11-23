// Issue #80: changelog migrations read by content, T-SQL, keyword guard, honest ownership and forecast.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../../../helpers/kernel.mjs';
import adapter, { defaultSchema } from '../../../../adapters/database/index.mjs';
import { analyzeMigration } from '../../../../adapters/database/migrations.mjs';
import { forecast, normalizeEngine } from '../../../../adapters/database/forecast.mjs';
import { parseSql } from '../../../../adapters/database/sql/parser.mjs';
import { mapRepository } from '../../../../runtime/graph/builder.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { databaseInventory } from '../../../../runtime/artifacts/reports.mjs';
import { edgeFact, nodeFact, prov } from '../../../../runtime/graph/facts.mjs';
import { entry, ids } from './helpers.mjs';

after(() => K.cleanup());

const map = (p) => mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', scope: [], history: false });
const tablesOf = (p) => Graph.fromStore(p.ctx.store).nodes('table').map((n) => n.id).sort();

const yamlTable = (name) => `databaseChangeLog:\n  - changeSet:\n      id: ${name}\n      author: a\n      changes:\n        - createTable:\n            tableName: ${name}\n            columns:\n              - column:\n                  name: id\n                  type: int\n`;
const xmlTable = (name) => `<?xml version="1.0"?>\n<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">\n  <changeSet id="${name}" author="a">\n    <createTable tableName="${name}"><column name="id" type="int"/></createTable>\n  </changeSet>\n</databaseChangeLog>\n`;

// Scenario 1
test('scenario 1: a changelog is read by content, under any file name', async () => {
  const p = K.makeProject({ files: {
    'db/schema-v1.yaml': yamlTable('orders'),
    'db/Update_2.xml': xmlTable('invoices'),
    'config/app.yaml': 'name: demo\nretries: 3\n',
  } });
  await map(p);
  const tables = tablesOf(p);
  assert.ok(tables.some((t) => t.endsWith('.orders')), tables.join());
  assert.ok(tables.some((t) => t.endsWith('.invoices')), tables.join());
  assert.equal(Graph.fromStore(p.ctx.store).nodes('migration').length, 2, 'only the two changelogs are migrations');
});

// Scenario 2
const master = `databaseChangeLog:
  - include:
      file: parts/a.yaml
      relativeToChangelogFile: true
  - include:
      file: db/changelog/parts/b.xml
  - includeAll:
      path: db/changelog/auto/
  - changeSet:
      id: seed
      author: a
      changes:
        - sqlFile:
            path: ../sql/seed.sql
            relativeToChangelogFile: true
  - include:
      file: parts/missing.yaml
      relativeToChangelogFile: true
`;
const tree = {
  'db/changelog/master.yaml': master,
  'db/changelog/parts/a.yaml': yamlTable('alpha'),
  'db/changelog/parts/b.xml': xmlTable('beta'),
  'db/changelog/auto/one.yaml': yamlTable('gamma'),
  'db/changelog/auto/two.xml': xmlTable('delta'),
  'db/sql/seed.sql': 'CREATE TABLE epsilon (id int);\n',
};

test('scenario 2: include, includeAll and sqlFile are followed and resolved as Liquibase resolves them', async () => {
  const p = K.makeProject({ files: tree });
  const r = await map(p);
  const tables = tablesOf(p);
  for (const t of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) assert.ok(tables.some((x) => x.endsWith(`.${t}`)), `${t} in ${tables.join()}`);
  const mnode = Graph.fromStore(p.ctx.store).node('migration:db/changelog/master.yaml');
  const resolved = mnode.attrs.includes.map((i) => [i.kind, i.resolved]);
  assert.deepEqual(resolved, [
    ['include', ['db/changelog/parts/a.yaml']],
    ['include', ['db/changelog/parts/b.xml']],
    ['includeAll', ['db/changelog/auto/one.yaml', 'db/changelog/auto/two.xml']],
    ['sqlFile', ['db/sql/seed.sql']],
    ['include', []],
  ]);
  assert.ok(r.notices.some((n) => n.includes('db/changelog/parts/missing.yaml')), JSON.stringify(r.notices));
});

test('scenario 2 edge: an include cycle terminates and each file is read once', () => {
  const a = 'databaseChangeLog:\n  - include:\n      file: b.yaml\n      relativeToChangelogFile: true\n';
  const b = 'databaseChangeLog:\n  - include:\n      file: a.yaml\n      relativeToChangelogFile: true\n';
  const factsByFile = new Map([['x/a.yaml', adapter.extract(entry('x/a.yaml'), a, { options: {} })], ['x/b.yaml', adapter.extract(entry('x/b.yaml'), b, { options: {} })]]);
  const files = new Map([['x/a.yaml', entry('x/a.yaml')], ['x/b.yaml', entry('x/b.yaml')]]);
  const notes = [];
  const out = adapter.link({ files, factsByFile, options: {}, notes });
  assert.equal(out.filter((f) => f.kind === 'node' && f.type === 'migration').length, 2);
  assert.deepEqual(notes, []);
});

// Scenario 3 and 4
const TSQL = 'CREATE TABLE [dbo].[Orders] (\n  [Id] int NOT NULL\n)\nGO\nCREATE TABLE [dbo].[Lines] (\n  [Id] int\n)\nGO\n';

test('scenario 3: a T-SQL script with GO and bracket identifiers maps dbo.Orders', () => {
  for (const options of [{ engine: 'sqlserver' }, {}]) {
    const facts = adapter.extract(entry('db/scripts/orders.sql'), TSQL, { options });
    assert.deepEqual(ids(facts, 'table'), ['table:dbo.lines', 'table:dbo.orders'], JSON.stringify(options));
  }
});

test('scenario 4: on SQL Server an unqualified table is in dbo, not public', () => {
  assert.equal(defaultSchema('sqlserver'), 'dbo');
  assert.equal(defaultSchema('mssql'), 'dbo');
  const facts = adapter.extract(entry('db/scripts/o.sql'), 'CREATE TABLE Orders (Id int);\n', { options: { engine: 'sqlserver' } });
  assert.deepEqual(ids(facts, 'table'), ['table:dbo.orders']);
  const canon = adapter.canonicalId.table('table:orders', { engine: 'sqlserver' });
  assert.equal(canon, 'table:dbo.orders');
});

// Scenario 5
test('scenario 5: a reserved word is never a table name', () => {
  for (const word of ['from', 'where', 'select', 'join']) {
    const sql = [`DROP TABLE ${word};`, `CREATE TABLE ${word} (a int);`, `ALTER TABLE ${word} ADD x int;`, `SELECT * FROM ${word};`, `DELETE FROM ${word};`, `INSERT INTO ${word} VALUES (1);`].join('\n');
    const facts = adapter.extract(entry('db/x.sql'), sql, { options: { engine: 'postgresql' } });
    assert.deepEqual(ids(facts, 'table'), [], word);
    for (const st of parseSql(sql)) {
      for (const t of [st.table, ...(st.tables ?? []), ...(st.reads ?? [])]) assert.ok(!t || t.name !== word, `${word} in ${st.kind}`);
    }
  }
});

test('scenario 5 edge: a quoted keyword is a real table', () => {
  const pg = adapter.extract(entry('db/x.sql'), 'CREATE TABLE "from" (a int);\n', { options: { engine: 'postgresql' } });
  assert.deepEqual(ids(pg, 'table'), ['table:public.from']);
  const ms = adapter.extract(entry('db/x.sql'), 'CREATE TABLE [dbo].[from] (a int)\nGO\n', { options: { engine: 'sqlserver' } });
  assert.deepEqual(ids(ms, 'table'), ['table:dbo.from']);
});

// Scenario 6
const T = (id) => nodeFact('table', id, { name: id }, prov({ source_type: 'ast', source_ref: 'a.sql:1', extractor: 'database@test', confidence: 'high' }));

test('scenario 6: ownership with no measuring source is unmeasured', () => {
  const inv = databaseInventory(Graph.fromFacts([T('public.t')]));
  assert.deepEqual(inv.ownership, { status: 'unmeasured', sources: [] });
});

test('scenario 6: an ownership edge, an ORM mapping or imported statistics measure it', () => {
  const owns = edgeFact('OWNS_DATA', 'service:billing', 'table:public.t', {}, prov({ source_type: 'config', source_ref: 'CODEOWNERS:1', extractor: 'test', confidence: 'high' }));
  const svc = nodeFact('service', 'billing', { name: 'billing' }, prov({ source_type: 'config', source_ref: 'CODEOWNERS:1', extractor: 'test', confidence: 'high' }));
  assert.deepEqual(databaseInventory(Graph.fromFacts([T('public.t'), svc, owns])).ownership, { status: 'measured', sources: ['ownership'] });
  const orm = nodeFact('table', 'public.u', { name: 'u', attrs: { orm: 'efcore', model: 'U' } }, prov({ source_type: 'ast', source_ref: 'a.cs:1', extractor: 'test', confidence: 'high' }));
  assert.deepEqual(databaseInventory(Graph.fromFacts([orm])).ownership, { status: 'measured', sources: ['orm'] });
  assert.deepEqual(databaseInventory(Graph.fromFacts([T('public.t')]), { catalog: { facts: 3, newest: null, oldest: null, age_days: null } }).ownership, { status: 'measured', sources: ['statistics'] });
});

// Scenario 7
test('scenario 7: SQL Server is not forecast with the PostgreSQL model', () => {
  assert.equal(normalizeEngine('sqlserver'), 'mssql');
  const f = forecast('ALTER TABLE orders ADD note nvarchar(50)', { engine: 'sqlserver' });
  assert.equal(f.engine, 'mssql');
  assert.ok(!/^(pg|postgresql)\./.test(f.rule_id), f.rule_id);
  assert.equal(f.lock_mode, 'unknown');
  assert.equal(f.confidence, 'low');
  assert.ok(f.notes.some((n) => /no forecast model exists for mssql/.test(n)), f.notes.join());
});

test('scenario 7: a T-SQL migration is analysed as SQL Server even when no engine is configured', () => {
  const m = analyzeMigration('db/migration/V2__add.sql', 'ALTER TABLE [dbo].[Orders] ADD [Note] nvarchar(50) NULL\nGO\n');
  assert.equal(m.engine, 'mssql');
  assert.ok(m.statements.length > 0);
  for (const s of m.statements) assert.ok(s.forecast.rule_id.startsWith('mssql.'), s.forecast.rule_id);
  assert.equal(m.statements[0].table, 'dbo.orders');
});

test('T-SQL names compare case-insensitively with dbo applied to bare and bracketed names', () => {
  const sql = 'CREATE TABLE [dbo].[Orders] (Id int)\nGO\nALTER TABLE Orders ADD Note nvarchar(10)\nGO\nALTER TABLE dbo.ORDERS ADD Qty int\nGO\n';
  const m = analyzeMigration('db/migration/V1__x.sql', sql, { engine: 'sqlserver' });
  assert.deepEqual([...new Set(m.statements.map((s) => s.table))], ['dbo.orders']);
  const facts = adapter.extract(entry('db/scripts/o.sql'), sql, { options: { engine: 'sqlserver' } });
  assert.deepEqual(ids(facts, 'table'), ['table:dbo.orders']);
  const pg = analyzeMigration('db/migration/V1__x.sql', 'CREATE TABLE "Orders" (id int);\nALTER TABLE orders ADD x int;\n', { engine: 'postgresql' });
  assert.deepEqual(pg.statements.map((s) => s.table), ['public.Orders', 'public.orders']);
});

test('a Prisma sqlserver provider maps to the mssql engine with schema dbo', () => {
  const facts = adapter.extract(entry('prisma/schema.prisma'), 'datasource db {\n  provider = "sqlserver"\n  url = env("U")\n}\nmodel Order {\n  id Int @id\n}\n', { options: {} });
  assert.ok(ids(facts, 'table').every((t) => t.startsWith('table:dbo.')), ids(facts, 'table').join());
  assert.ok(ids(facts, 'table').length > 0);
});
