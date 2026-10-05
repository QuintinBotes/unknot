// Golden repository (f): PostgreSQL (Flyway) + MySQL + MongoDB migrations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, assertKinds, assertWellFormed, ofKind, read } from './_harness.mjs';

const { forecast, forecastScript } = await import('../../adapters/database/forecast.mjs');

const r = await analyse('migrations', {
  config: { adapters: { database: { engine: 'postgresql', version: '16' } }, evidence: { db_metadata: ['db/catalog.json'] } },
});

test('migrations: map is complete and detectors run cleanly', () => {
  assert.equal(r.mapped.status, 'complete');
  assert.deepEqual(r.errors, []);
});

test('migrations: expected finding kinds', () => {
  assertKinds(r.findings, ['database.hazardous-migration', 'database.destructive-migration', 'database.backfill-without-batching']);
});

test('migrations: the type change on the large catalog table is a hazard with a safer path', () => {
  const h = ofKind(r.findings, 'database.hazardous-migration').find((f) => f.scope.includes('db/migration/V2__hazard.sql'));
  assert.ok(h, 'V2 is flagged');
  const text = h.evidence.map((e) => e.summary).join('\n');
  assert.match(text, /ACCESS EXCLUSIVE/);
  assert.match(text, /52000000 rows/, 'row count comes from the catalog export');
  assert.match(h.smallest_simplification, /expand|concurrent|batch|backfill|new column/i);
  assert.ok(h.alternatives.length >= 2 && h.alternatives.some((a) => a.id === 'retain'));
  assert.ok(['high', 'critical'].includes(h.risk));
  assert.ok(h.approvers.some((a) => /data|specialist/.test(a)), `approvers: ${h.approvers}`);
});

test('migrations: the safe migration on a tiny table is not flagged', () => {
  for (const f of r.findings.filter((x) => /^database\.(hazardous|destructive)/.test(x.kind))) assert.ok(!f.scope.includes('db/migration/V3__safe.sql'));
});

test('migrations: CREATE INDEX without CONCURRENTLY is forecast as blocking writes, with CONCURRENTLY offered', () => {
  const [stmt] = forecastScript(read(r.dir, 'db/migration/V2__hazard.sql').split('\n')[1], { engine: 'postgresql', version: '16', table: { estimated_rows: 52_000_000, size_bytes: 41e9 } });
  assert.equal(stmt.statement.kind, 'create_index');
  assert.equal(stmt.forecast.blocks.writes, true);
  assert.equal(stmt.forecast.concurrently_available, true);
  assert.ok(stmt.forecast.safer_alternative);
});

test('migrations: MySQL ALGORITHM=INSTANT add column is online and rewrite-free', () => {
  const [add] = forecastScript(read(r.dir, 'mysql/001_instant.sql'), { engine: 'mysql', version: '8.0.30', table: { estimated_rows: 52_000_000 } });
  assert.equal(add.statement.kind, 'alter_table');
  assert.equal(add.forecast.rewrite, 'none');
  assert.equal(add.forecast.online, true);
  assert.equal(add.forecast.blocks.writes, false);
  const direct = forecast('ALTER TABLE orders MODIFY COLUMN total BIGINT NOT NULL', { engine: 'mysql', version: '8.0.30', table: { estimated_rows: 52_000_000 } });
  assert.notEqual(direct.rewrite, 'none', 'a column type change is not instant');
});

test('migrations: a MongoDB migration script is mapped as source and raises no SQL findings', () => {
  assert.ok(!r.findings.some((f) => f.scope.includes('mongo/migrations/20240101-add-status.js') && f.kind.startsWith('database.')));
});

test('migrations: evidence provenance, retain alternative and risk sanity', () => {
  assertWellFormed(r.findings);
  for (const f of ofKind(r.findings, 'database.destructive-migration')) {
    assert.ok(['high', 'critical'].includes(f.risk));
    assert.equal(f.recovery.type, 'restore');
  }
  assert.ok(ofKind(r.findings, 'database.backfill-without-batching').every((f) => ['high', 'critical'].includes(f.risk)));
});
