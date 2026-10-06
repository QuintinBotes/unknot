import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { MIGRATIONS, LATEST_SCHEMA_VERSION, runMigrations } from '../../../runtime/state/migrations.mjs';
import { Store } from '../../../runtime/state/store.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const tmp = () => mkdtempSync(join(tmpdir(), 'uk-mig-'));
const meta = (db, k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;

test('a fresh store records the schema version and applied names', () => {
  const dir = tmp();
  const s = new Store(join(dir, 's.db'));
  assert.equal(s.meta('schema_version'), '1', 'no applied migration breaks older releases');
  assert.equal(s.meta('schema_applied'), String(LATEST_SCHEMA_VERSION));
  assert.deepEqual(JSON.parse(s.meta('migrations')), MIGRATIONS.map((m) => m.name));
  s.close();
  rmSync(dir, { recursive: true });
});

test('a store from before names were recorded (version 1, no list) is named, not rebuilt', () => {
  const dir = tmp();
  const file = join(dir, 's.db');
  const s = new Store(file);
  s.run("INSERT INTO sequences(name, value) VALUES ('keep', 7)");
  s.run("DELETE FROM meta WHERE key = 'migrations'");
  s.close();
  const again = new Store(file);
  assert.equal(again.get("SELECT value FROM sequences WHERE name = 'keep'").value, 7);
  assert.deepEqual(JSON.parse(again.meta('migrations')), MIGRATIONS.map((m) => m.name));
  again.close();
  rmSync(dir, { recursive: true });
});

test('migrations run in order, once, in one transaction that rolls back whole on failure', () => {
  const db = new DatabaseSync(':memory:');
  const ddl = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);';
  const calls = [];
  const list = [
    { id: 1, name: 'one', always: true, up: (d, c) => (calls.push('one'), d.exec(c.ddl)) },
    { id: 2, name: 'two', up: (d) => (calls.push('two'), d.exec('CREATE TABLE t2 (x)')) },
  ];
  assert.deepEqual(runMigrations(db, { ddl, migrations: list }), ['one', 'two']);
  assert.deepEqual(runMigrations(db, { ddl, migrations: list }), []);
  assert.deepEqual(calls, ['one', 'two', 'one'], 'only the always-migration repeats');
  assert.equal(meta(db, 'schema_applied'), '2');

  const boom = (d) => {
    d.exec('CREATE TABLE t3 (x)');
    throw new Error('boom');
  };
  assert.throws(() => runMigrations(db, { ddl, migrations: [...list, { id: 3, name: 'three', up: boom }] }), /boom/);
  assert.equal(meta(db, 'schema_applied'), '2');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 't3'").get(), undefined, 'the partial migration is rolled back');
  db.close();
});

test('a store newer than the runtime is refused and left untouched', () => {
  const dir = tmp();
  const file = join(dir, 's.db');
  new Store(file).close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  raw.close();
  assert.throws(() => new Store(file), (e) => e.code === 'UK_STATE_CONFLICT' && /newer than this runtime/.test(e.message));
  const check = new DatabaseSync(file);
  assert.equal(meta(check, 'schema_version'), '999');
  check.close();
  rmSync(dir, { recursive: true });
});

test('every migration states whether releases without it can still use the store', () => {
  for (const m of MIGRATIONS) assert.equal(typeof m.breaks, 'boolean', m.name);
});

test('additive migrations keep schema_version where older releases accept it; a store raised by 0.2.0 is lowered again', () => {
  const dir = tmp();
  const file = join(dir, 's.db');
  new Store(file).close();
  // 0.2.0 recorded the highest applied id, which 0.1.15 (it accepts schema_version <= 1) refused.
  const db = new DatabaseSync(file);
  db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  db.close();
  const s = new Store(file);
  assert.equal(s.meta('schema_version'), '1');
  assert.ok(s.all('PRAGMA table_info(facts)').some((c) => c.name === 'digest'));
  s.close();
  rmSync(dir, { recursive: true });
});

test('a migration older releases cannot live with waits while their hooks ran recently, then raises schema_version', () => {
  const ddl = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);';
  const migrations = [
    { id: 1, name: 'base', breaks: true, up: (db) => db.exec(ddl) },
    { id: 2, name: 'additive', breaks: false, up: () => {} },
    { id: 3, name: 'reshape', breaks: true, up: () => {} },
  ];
  const db = new DatabaseSync(':memory:');
  runMigrations(db, { ddl, migrations: migrations.slice(0, 2) });
  assert.equal(meta(db, 'schema_version'), '1');
  assert.throws(() => runMigrations(db, { ddl, migrations, olderHooks: [{ version: '0.2.1', schema: 2 }] }), (e) => e.code === 'UK_STATE_CONFLICT' && /Unknot 0\.2\.1 hooks of a running session.*reload plugins or start a new session/.test(e.message));
  assert.equal(meta(db, 'schema_version'), '1', 'nothing changed');
  runMigrations(db, { ddl, migrations, olderHooks: [{ version: '0.3.0', schema: 3 }] });
  assert.equal(meta(db, 'schema_version'), '3');
  assert.equal(meta(db, 'schema_applied'), '3');
});
