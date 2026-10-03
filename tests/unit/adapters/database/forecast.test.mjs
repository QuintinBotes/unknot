import test from 'node:test';
import assert from 'node:assert/strict';
import { forecast, parseVersion, pgTypeChangeRewrite } from '../../../../adapters/database/forecast.mjs';

const BIG = { estimated_rows: 50_000_000, size_bytes: 40e9 };

// [name, sql, engine, version, table, expected subset]
const CASES = [
  // ---- PostgreSQL: columns
  ['pg add column no default', 'ALTER TABLE t ADD COLUMN c int', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'none', scan: 'none', transactional: true, duration: 'constant' }],
  ['pg add column const default pg16', 'ALTER TABLE t ADD COLUMN c int DEFAULT 0', 'postgresql', '16', {}, { rewrite: 'none', rule_id: 'pg.add_column.const_default' }],
  ['pg add column const default pg10', 'ALTER TABLE t ADD COLUMN c int DEFAULT 0', 'postgresql', '10', {}, { rewrite: 'table', scan: 'full', rule_id: 'pg.add_column.default_pre11' }],
  ['pg add column now() default pg13 is metadata-only', 'ALTER TABLE t ADD COLUMN c timestamptz DEFAULT now()', 'postgresql', '13', {}, { rewrite: 'none' }],
  ['pg add column volatile default', 'ALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid()', 'postgresql', '16', {}, { rewrite: 'table', duration: 'proportional_to_table', temporary_disk: 'table_size' }],
  ['pg add serial column rewrites', 'ALTER TABLE t ADD COLUMN id serial', 'postgresql', '16', {}, { rewrite: 'table' }],
  ['pg add stored generated rewrites', 'ALTER TABLE t ADD COLUMN g int GENERATED ALWAYS AS (a + 1) STORED', 'postgresql', '16', {}, { rewrite: 'table' }],
  ['pg drop column', 'ALTER TABLE t DROP COLUMN c', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'none', destructive: true, breaks_old_readers: true }],
  ['pg rename column', 'ALTER TABLE t RENAME COLUMN a TO b', 'postgresql', '16', {}, { rewrite: 'none', breaks_old_readers: true }],
  ['pg rename table', 'ALTER TABLE t RENAME TO u', 'postgresql', '16', {}, { rewrite: 'none', breaks_old_readers: true }],
  // ---- PostgreSQL: types
  ['pg int->bigint rewrites', 'ALTER TABLE t ALTER COLUMN c TYPE bigint', 'postgresql', '16', { columns: { c: 'integer' } }, { rewrite: 'table', lock_mode: 'ACCESS EXCLUSIVE', safer_alternative: /expand\/contract/ }],
  ['pg varchar widen no rewrite', 'ALTER TABLE t ALTER COLUMN c TYPE varchar(200)', 'postgresql', '16', { columns: { c: 'varchar(100)' } }, { rewrite: 'none', scan: 'none' }],
  ['pg varchar->text no rewrite', 'ALTER TABLE t ALTER COLUMN c TYPE text', 'postgresql', '16', { columns: { c: 'character varying(100)' } }, { rewrite: 'none' }],
  ['pg varchar shrink rewrites', 'ALTER TABLE t ALTER COLUMN c TYPE varchar(10)', 'postgresql', '16', { columns: { c: 'varchar(100)' } }, { rewrite: 'table' }],
  ['pg numeric precision increase no rewrite', 'ALTER TABLE t ALTER COLUMN c TYPE numeric(12,2)', 'postgresql', '16', { columns: { c: 'numeric(10,2)' } }, { rewrite: 'none' }],
  ['pg numeric scale change rewrites', 'ALTER TABLE t ALTER COLUMN c TYPE numeric(12,4)', 'postgresql', '16', { columns: { c: 'numeric(10,2)' } }, { rewrite: 'table' }],
  ['pg type change unknown old type is conservative', 'ALTER TABLE t ALTER COLUMN c TYPE bigint', 'postgresql', '16', {}, { rewrite: 'table', confidence: 'medium' }],
  ['pg type change with USING rewrites', "ALTER TABLE t ALTER COLUMN c TYPE int USING c::int", 'postgresql', '16', { columns: { c: 'text' } }, { rewrite: 'table' }],
  ['pg type change on indexed large table', 'ALTER TABLE t ALTER COLUMN c TYPE bigint', 'postgresql', '16', { ...BIG, columns: { c: 'int' }, indexed_columns: ['c'] }, { rewrite: 'table', replication_lag_risk: 'high', notes: /indexed/ }],
  // ---- PostgreSQL: nullability / defaults
  ['pg set not null scans', 'ALTER TABLE t ALTER COLUMN c SET NOT NULL', 'postgresql', '16', {}, { scan: 'full', lock_mode: 'ACCESS EXCLUSIVE', safer_alternative: /NOT VALID/ }],
  ['pg set not null skips scan with valid check (pg12+)', 'ALTER TABLE t ALTER COLUMN c SET NOT NULL', 'postgresql', '12', { has_valid_not_null_check: true }, { scan: 'none' }],
  ['pg set not null pg11 still scans with check', 'ALTER TABLE t ALTER COLUMN c SET NOT NULL', 'postgresql', '11', { has_valid_not_null_check: true }, { scan: 'full' }],
  ['pg drop not null', 'ALTER TABLE t ALTER COLUMN c DROP NOT NULL', 'postgresql', '16', {}, { scan: 'none', rewrite: 'none' }],
  ['pg set default', 'ALTER TABLE t ALTER COLUMN c SET DEFAULT 5', 'postgresql', '16', {}, { rewrite: 'none', scan: 'none' }],
  // ---- PostgreSQL: constraints
  ['pg add check scans', 'ALTER TABLE t ADD CONSTRAINT c1 CHECK (a > 0)', 'postgresql', '16', {}, { scan: 'full', lock_mode: 'ACCESS EXCLUSIVE', safer_alternative: /NOT VALID/ }],
  ['pg add check not valid', 'ALTER TABLE t ADD CONSTRAINT c1 CHECK (a > 0) NOT VALID', 'postgresql', '16', {}, { scan: 'none', lock_mode: 'ACCESS EXCLUSIVE', safer_alternative: null }],
  ['pg validate constraint', 'ALTER TABLE t VALIDATE CONSTRAINT c1', 'postgresql', '16', {}, { lock_mode: 'SHARE UPDATE EXCLUSIVE', scan: 'full', blocks: { reads: false, writes: false } }],
  ['pg add fk scans', 'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)', 'postgresql', '16', {}, { lock_mode: 'SHARE ROW EXCLUSIVE', scan: 'full', blocks: { reads: false, writes: true }, safer_alternative: /NOT VALID/ }],
  ['pg add fk not valid', 'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id) NOT VALID', 'postgresql', '16', {}, { lock_mode: 'SHARE ROW EXCLUSIVE', scan: 'none' }],
  ['pg add pk builds index', 'ALTER TABLE t ADD PRIMARY KEY (id)', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'index', scan: 'full', safer_alternative: /CONCURRENTLY/ }],
  ['pg add unique using index', 'ALTER TABLE t ADD CONSTRAINT u1 UNIQUE USING INDEX u1_idx', 'postgresql', '16', {}, { scan: 'none', rewrite: 'none', safer_alternative: null }],
  ['pg drop constraint', 'ALTER TABLE t DROP CONSTRAINT c1', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'none' }],
  // ---- PostgreSQL: indexes
  ['pg create index blocks writes', 'CREATE INDEX i ON t (a)', 'postgresql', '16', {}, { lock_mode: 'SHARE', blocks: { reads: false, writes: true }, safer_alternative: /CONCURRENTLY/, transactional: true }],
  ['pg create index concurrently', 'CREATE INDEX CONCURRENTLY i ON t (a)', 'postgresql', '16', {}, { lock_mode: 'SHARE UPDATE EXCLUSIVE', transactional: false, blocks: { reads: false, writes: false }, notes: /INVALID/ }],
  ['pg create unique index concurrently notes invalid unique', 'CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)', 'postgresql', '16', {}, { transactional: false, notes: /enforces uniqueness/ }],
  ['pg create index concurrently on partitioned', 'CREATE INDEX CONCURRENTLY i ON t (a)', 'postgresql', '16', { partitioned: true }, { notes: /partitioned/ }],
  ['pg drop index', 'DROP INDEX i', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', safer_alternative: /CONCURRENTLY/ }],
  ['pg drop index concurrently', 'DROP INDEX CONCURRENTLY i', 'postgresql', '16', {}, { lock_mode: 'SHARE UPDATE EXCLUSIVE', transactional: false }],
  ['pg reindex pg16', 'REINDEX TABLE t', 'postgresql', '16', {}, { lock_mode: 'SHARE', rewrite: 'index', safer_alternative: /CONCURRENTLY/ }],
  ['pg reindex pg11 has no concurrently', 'REINDEX TABLE t', 'postgresql', '11', {}, { lock_mode: 'SHARE', concurrently_available: false }],
  ['pg reindex concurrently pg16', 'REINDEX INDEX CONCURRENTLY i', 'postgresql', '16', {}, { lock_mode: 'SHARE UPDATE EXCLUSIVE', transactional: false }],
  ['pg reindex concurrently pg11 unavailable', 'REINDEX INDEX CONCURRENTLY i', 'postgresql', '11', {}, { rule_id: 'pg.reindex.concurrently_unavailable' }],
  // ---- PostgreSQL: misc DDL
  ['pg drop table', 'DROP TABLE t', 'postgresql', '16', {}, { destructive: true, lock_mode: 'ACCESS EXCLUSIVE' }],
  ['pg truncate', 'TRUNCATE t', 'postgresql', '16', {}, { destructive: true, lock_mode: 'ACCESS EXCLUSIVE' }],
  ['pg vacuum full', 'VACUUM FULL t', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'table', transactional: false, safer_alternative: /pg_repack/ }],
  ['pg vacuum full parenthesised', 'VACUUM (FULL, VERBOSE) t', 'postgresql', '16', {}, { rewrite: 'table', transactional: false }],
  ['pg cluster', 'CLUSTER t USING t_pkey', 'postgresql', '16', {}, { rewrite: 'table', lock_mode: 'ACCESS EXCLUSIVE' }],
  ['pg alter type add value pg11 not transactional', "ALTER TYPE mood ADD VALUE 'ok'", 'postgresql', '11', {}, { transactional: false }],
  ['pg alter type add value pg14 transactional', "ALTER TYPE mood ADD VALUE 'ok'", 'postgresql', '14', {}, { transactional: true }],
  ['pg detach partition plain', 'ALTER TABLE p DETACH PARTITION p1', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', safer_alternative: /CONCURRENTLY/ }],
  ['pg detach partition concurrently pg14', 'ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY', 'postgresql', '14', {}, { lock_mode: 'SHARE UPDATE EXCLUSIVE', transactional: false }],
  ['pg detach partition concurrently pg13 rejected', 'ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY', 'postgresql', '13', {}, { rule_id: 'pg.detach_partition.concurrently_unavailable' }],
  ['pg attach partition pg12', "ALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM (1) TO (2)", 'postgresql', '12', {}, { lock_mode: 'SHARE UPDATE EXCLUSIVE', scan: 'full' }],
  ['pg set logged rewrites', 'ALTER TABLE t SET LOGGED', 'postgresql', '16', {}, { rewrite: 'table', lock_mode: 'ACCESS EXCLUSIVE' }],
  ['pg set unlogged rewrites', 'ALTER TABLE t SET UNLOGGED', 'postgresql', '16', {}, { rewrite: 'table' }],
  ['pg refresh matview', 'REFRESH MATERIALIZED VIEW mv', 'postgresql', '16', {}, { lock_mode: 'ACCESS EXCLUSIVE', rewrite: 'table', safer_alternative: /CONCURRENTLY/ }],
  ['pg refresh matview concurrently', 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv', 'postgresql', '16', {}, { lock_mode: 'EXCLUSIVE', notes: /UNIQUE index/ }],
  ['pg multi-action takes worst case', 'ALTER TABLE t ADD COLUMN a int, ALTER COLUMN b SET NOT NULL', 'postgresql', '16', {}, { scan: 'full', lock_mode: 'ACCESS EXCLUSIVE' }],
  // ---- PostgreSQL: DML
  ['pg update without where', 'UPDATE t SET a = 1', 'postgresql', '16', BIG, { scan: 'full', replication_lag_risk: 'high', duration: 'proportional_to_table', safer_alternative: /batches/ }],
  ['pg delete without where', 'DELETE FROM t', 'postgresql', '16', {}, { scan: 'full', destructive: true }],
  ['pg update with where', 'UPDATE t SET a = 1 WHERE id = 3', 'postgresql', '16', {}, { replication_lag_risk: 'low', lock_mode: 'ROW EXCLUSIVE' }],
  // ---- confidence
  ['pg unknown version lowers confidence on version-sensitive rule', 'ALTER TABLE t ADD COLUMN c int DEFAULT 0', 'postgresql', undefined, {}, { confidence: 'low', rewrite: 'table' }],
  ['unknown engine is low confidence', 'ALTER TABLE t ADD COLUMN c int', 'oracle', '19', {}, { confidence: 'low', lock_mode: 'unknown', rewrite: 'unknown' }],
  ['unknown statement is low confidence', 'FROBNICATE t', 'postgresql', '16', {}, { confidence: 'low' }],
  // ---- MySQL
  ['mysql 8.0.32 add column anywhere is instant', 'ALTER TABLE t ADD COLUMN c INT AFTER a', 'mysql', '8.0.32', {}, { lock_mode: 'NONE', rewrite: 'none', algorithm: 'INSTANT', transactional: false, metadata_lock_risk: 'high' }],
  ['mysql 8.0.20 add column last is instant', 'ALTER TABLE t ADD COLUMN c INT', 'mysql', '8.0.20', {}, { algorithm: 'INSTANT' }],
  ['mysql 8.0.20 add column AFTER is inplace rebuild', 'ALTER TABLE t ADD COLUMN c INT AFTER a', 'mysql', '8.0.20', {}, { algorithm: 'INPLACE', rewrite: 'table' }],
  ['mysql 5.7 add column is inplace rebuild', 'ALTER TABLE t ADD COLUMN c INT', 'mysql', '5.7.40', {}, { algorithm: 'INPLACE', rewrite: 'table', lock_mode: 'NONE' }],
  ['mysql add column explicit INSTANT honoured', 'ALTER TABLE t ADD COLUMN c INT, ALGORITHM=INSTANT', 'mysql', '8.0.32', {}, { algorithm: 'INSTANT', explicit_clause: 'honoured' }],
  ['mysql 8.0.15 explicit INSTANT with AFTER rejected', 'ALTER TABLE t ADD COLUMN c INT AFTER a, ALGORITHM=INSTANT', 'mysql', '8.0.15', {}, { explicit_clause: 'rejected' }],
  ['mysql modify type is COPY', 'ALTER TABLE t MODIFY COLUMN c BIGINT', 'mysql', '8.0.32', { columns: { c: 'int' } }, { algorithm: 'COPY', lock_mode: 'SHARED', rewrite: 'table', blocks: { reads: false, writes: true } }],
  ['mysql modify varchar widen is inplace', 'ALTER TABLE t MODIFY COLUMN c VARCHAR(50)', 'mysql', '8.0.32', { columns: { c: 'varchar(20)' } }, { algorithm: 'INPLACE', rewrite: 'none' }],
  ['mysql explicit LOCK=NONE with COPY is rejected', 'ALTER TABLE t MODIFY COLUMN c BIGINT, ALGORITHM=COPY, LOCK=NONE', 'mysql', '8.0.32', { columns: { c: 'int' } }, { explicit_clause: 'rejected' }],
  ['mysql add index is inplace LOCK=NONE', 'CREATE INDEX i ON t (a)', 'mysql', '8.0.32', {}, { algorithm: 'INPLACE', lock_mode: 'NONE', rewrite: 'index', online: true }],
  ['mysql drop column 8.0.32 is instant', 'ALTER TABLE t DROP COLUMN c', 'mysql', '8.0.32', {}, { algorithm: 'INSTANT', destructive: true }],
  ['mysql drop column 8.0.20 inplace rebuild', 'ALTER TABLE t DROP COLUMN c', 'mysql', '8.0.20', {}, { algorithm: 'INPLACE', rewrite: 'table' }],
  ['mysql add FULLTEXT blocks writes', 'ALTER TABLE t ADD FULLTEXT INDEX ft (a)', 'mysql', '8.0.32', {}, { lock_mode: 'SHARED' }],
  ['mysql add FK with checks is COPY', 'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)', 'mysql', '8.0.32', {}, { algorithm: 'COPY' }],
  ['mysql drop pk is COPY', 'ALTER TABLE t DROP PRIMARY KEY', 'mysql', '8.0.32', {}, { algorithm: 'COPY' }],
  ['mysql update without where', 'UPDATE t SET a = 1', 'mysql', '8.0.32', {}, { scan: 'full', replication_lag_risk: 'high' }],
  ['mysql truncate is non-transactional DDL', 'TRUNCATE TABLE t', 'mysql', '8.0.32', {}, { transactional: false, destructive: true }],
  ['mysql unknown version add column is conservative', 'ALTER TABLE t ADD COLUMN c INT', 'mysql', undefined, {}, { algorithm: 'INPLACE', confidence: 'low' }],
  ['mariadb 10.6 add column last is instant', 'ALTER TABLE t ADD COLUMN c INT', 'mariadb', '10.6.12', {}, { algorithm: 'INSTANT' }],
  // ---- SQLite
  ['sqlite add column', 'ALTER TABLE t ADD COLUMN c INT', 'sqlite', '3.40', {}, { rewrite: 'none', transactional: true, lock_mode: 'EXCLUSIVE' }],
  ['sqlite add unique column notes restriction', 'ALTER TABLE t ADD COLUMN c INT UNIQUE', 'sqlite', '3.40', {}, { notes: /UNIQUE/ }],
  ['sqlite alter column type needs rebuild', 'ALTER TABLE t ALTER COLUMN c TYPE text', 'sqlite', '3.40', {}, { rewrite: 'table', safer_alternative: /12-step/ }],
  ['sqlite drop column rewrites', 'ALTER TABLE t DROP COLUMN c', 'sqlite', '3.40', {}, { rewrite: 'table' }],
  ['sqlite create index blocks writers', 'CREATE INDEX i ON t (a)', 'sqlite', '3.40', {}, { blocks: { reads: false, writes: true } }],
];

for (const [name, sql, engine, version, table, expected] of CASES) {
  test(`forecast: ${name}`, () => {
    const r = forecast(sql, { engine, version, table });
    for (const [k, want] of Object.entries(expected)) {
      const got = r[k];
      if (want instanceof RegExp) {
        const text = Array.isArray(got) ? got.join(' | ') : String(got);
        assert.match(text, want, `${k}: ${text}`);
      } else assert.deepEqual(got, want, `${k}: ${JSON.stringify(got)} (rule ${r.rule_id})`);
    }
  });
}

test('forecast: table-driven suite covers at least 40 cases', () => {
  assert.ok(CASES.length >= 40, `only ${CASES.length}`);
});

test('forecast: result shape has every required field', () => {
  const r = forecast('ALTER TABLE t ADD COLUMN c int', { engine: 'postgresql', version: '16' });
  for (const k of ['lock_mode', 'blocks', 'metadata_lock_risk', 'rewrite', 'scan', 'transactional', 'online', 'concurrently_available', 'duration', 'temporary_disk', 'replication_lag_risk', 'cancellation', 'safer_alternative', 'rule_id', 'confidence', 'notes', 'sources']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.ok(r.sources.length > 0);
  assert.equal(r.metadata_lock_risk, 'high');
});

test('forecast: "online" never implies zero impact', () => {
  const r = forecast('CREATE INDEX i ON t (a)', { engine: 'mysql', version: '8.0.32' });
  assert.equal(r.online, true);
  assert.notEqual(r.metadata_lock_risk, 'low');
  assert.notEqual(r.replication_lag_risk, undefined);
  assert.ok(r.notes.some((n) => /metadata lock/.test(n)));
});

test('forecast: accepts parsed statements and SQL text equally', async () => {
  const { parseSql } = await import('../../../../adapters/database/sql/parser.mjs');
  const [st] = parseSql('DROP TABLE t');
  assert.deepEqual(forecast(st, { engine: 'postgresql', version: '16' }).rule_id, forecast('DROP TABLE t', { engine: 'postgres', version: '16' }).rule_id);
});

test('forecast: version and type helpers', () => {
  assert.deepEqual(parseVersion('8.0.32'), [8, 0, 32]);
  assert.deepEqual(parseVersion('16'), [16, 0, 0]);
  assert.equal(parseVersion(undefined), null);
  assert.equal(pgTypeChangeRewrite('varchar(10)', 'varchar(20)'), 'none');
  assert.equal(pgTypeChangeRewrite('int', 'bigint'), 'table');
  assert.equal(pgTypeChangeRewrite(null, 'bigint'), 'unknown');
});
