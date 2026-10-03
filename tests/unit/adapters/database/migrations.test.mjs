import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMigration, detectFramework, orderMigrations, alembicOrder, parseMiniYaml, readLiquibase, inferEngine } from '../../../../adapters/database/migrations.mjs';
import { fixture } from './helpers.mjs';

const PG = { engine: 'postgresql', version: '16' };
const analyze = (path, fx, opts = PG) => analyzeMigration(path, fixture(fx), opts);

// ------------------------------------------------------------------ detection

test('detectFramework: path conventions', () => {
  const d = (p, text) => detectFramework(p, text)?.framework;
  assert.equal(d('db/migration/V1__init.sql'), 'flyway');
  assert.equal(d('db/migration/V2.1__add.sql'), 'flyway');
  assert.equal(d('db/migration/R__views.sql'), 'flyway');
  assert.equal(d('db/migration/U2__undo.sql'), 'flyway');
  assert.equal(d('migrations/000001_a.up.sql'), 'golang-migrate');
  assert.equal(d('migrations/000001_a.down.sql'), 'golang-migrate');
  assert.equal(d('db/migrate/20240101000000_add_x.rb'), 'rails');
  assert.equal(d('shop/migrations/0001_initial.py'), 'django');
  assert.equal(d('alembic/versions/abc_init.py'), 'alembic');
  assert.equal(d('prisma/migrations/20240101000000_init/migration.sql'), 'prisma');
  assert.equal(d('src/db.changelog-master.xml'), 'liquibase');
  assert.equal(d('db/changes/a.sql', '--liquibase formatted sql\n--changeset a:1'), 'liquibase');
  assert.equal(d('migrations/20240101-add.js', 'exports.up = (knex) => knex.schema.createTable("a", () => {})'), 'knex');
  assert.equal(d('migrations/1700000000000-Add.ts', 'class X implements MigrationInterface {}'), 'typeorm');
  assert.equal(d('migrations/20240101-add.js', "module.exports = { up: (queryInterface) => {} }"), 'sequelize');
  assert.equal(d('src/main.py'), undefined);
  assert.equal(d('docs/readme.sql'), undefined);
});

test('ordering: Flyway versions compare numerically and repeatables come last', () => {
  const files = ['V10__x.sql', 'V2__x.sql', 'V1.5__x.sql', 'R__views.sql', 'V1__x.sql'].map((n) => {
    const i = detectFramework(`db/migration/${n}`);
    return { path: `db/migration/${n}`, framework: i.framework, order_key: i.order_key };
  });
  assert.deepEqual(orderMigrations(files).map((f) => f.path.split('/').pop()), ['V1__x.sql', 'V1.5__x.sql', 'V2__x.sql', 'V10__x.sql', 'R__views.sql']);
});

test('ordering: Alembic follows the down_revision chain, not file names', () => {
  const depth = alembicOrder([
    { revision: 'zzz', down_revision: null },
    { revision: 'aaa', down_revision: 'zzz' },
    { revision: 'mmm', down_revision: 'aaa' },
  ]);
  assert.deepEqual([depth.get('zzz'), depth.get('aaa'), depth.get('mmm')], [0, 1, 2]);
});

// ------------------------------------------------------------------ Flyway (hazards)

test('flyway: hazardous V3 ALTER COLUMN TYPE is a table rewrite', () => {
  const m = analyze('db/migration/V3__change_type.sql', 'flyway-pg/db/migration/V3__change_type.sql', { ...PG, table: { columns: { total: 'integer' }, estimated_rows: 5e7, size_bytes: 4e10 } });
  assert.equal(m.framework, 'flyway');
  assert.equal(m.order_key, '000000000003');
  const s = m.statements[0];
  assert.equal(s.table, 'public.orders');
  assert.equal(s.forecast.lock_mode, 'ACCESS EXCLUSIVE');
  assert.equal(s.forecast.rewrite, 'table');
  assert.match(s.forecast.safer_alternative, /expand\/contract/);
});

test('flyway: CREATE INDEX without CONCURRENTLY blocks writes; NOT VALID FK then VALIDATE are gentle', () => {
  const idx = analyze('db/migration/V2__orders_index.sql', 'flyway-pg/db/migration/V2__orders_index.sql');
  assert.equal(idx.statements[0].forecast.lock_mode, 'SHARE');
  assert.match(idx.statements[0].forecast.safer_alternative, /CONCURRENTLY/);
  const fk = analyze('db/migration/V4__fk_not_valid.sql', 'flyway-pg/db/migration/V4__fk_not_valid.sql');
  assert.equal(fk.statements[0].forecast.scan, 'none');
  const val = analyze('db/migration/V5__validate_fk.sql', 'flyway-pg/db/migration/V5__validate_fk.sql');
  assert.equal(val.statements[0].forecast.lock_mode, 'SHARE UPDATE EXCLUSIVE');
});

test('flyway: destructive migration is flagged irreversible', () => {
  const m = analyze('db/migration/V10__drop_legacy.sql', 'flyway-pg/db/migration/V10__drop_legacy.sql');
  assert.equal(m.destructive, true);
  assert.equal(m.irreversible, true);
  assert.deepEqual(m.statements.map((s) => s.kind), ['alter_table.drop_column', 'drop_table']);
});

test('flyway: undo files produce no migration of their own', () => {
  const m = analyze('db/migration/U3__undo_change_type.sql', 'flyway-pg/db/migration/U3__undo_change_type.sql');
  assert.equal(m.extra.direction, 'down');
  assert.deepEqual(m.statements, []);
});

// ------------------------------------------------------------------ Rails

test('rails: add_column default, volatile lambda default, concurrent index, irreversible down', () => {
  const a = analyze('db/migrate/20240101000001_add_status_to_orders.rb', 'rails/db/migrate/20240101000001_add_status_to_orders.rb');
  assert.equal(a.has_down, true);
  assert.equal(a.statements[0].forecast.rewrite, 'none');
  assert.equal(a.statements[1].forecast.rewrite, 'table');
  assert.equal(a.statements[1].forecast.rule_id, 'pg.add_column.volatile_default');
  const b = analyze('db/migrate/20240102000001_add_index_concurrently.rb', 'rails/db/migrate/20240102000001_add_index_concurrently.rb');
  assert.equal(b.no_transaction, true);
  assert.equal(b.statements[0].forecast.lock_mode, 'SHARE UPDATE EXCLUSIVE');
  assert.equal(b.statements[0].forecast.transactional, false);
  const c = analyze('db/migrate/20240103000001_rename_and_remove.rb', 'rails/db/migrate/20240103000001_rename_and_remove.rb');
  assert.equal(c.has_down, false);
  assert.equal(c.irreversible, true);
  assert.deepEqual(c.statements.map((s) => s.kind), ['alter_table.rename_column', 'alter_table.drop_column', 'update']);
  assert.equal(c.statements[2].table, 'public.orders');
});

// ------------------------------------------------------------------ Django

test('django: operations map to DDL on <app>_<model> tables', () => {
  const m1 = analyze('shop/migrations/0001_initial.py', 'django/shop/migrations/0001_initial.py');
  assert.equal(m1.statements[0].kind, 'create_table');
  assert.equal(m1.statements[0].table, 'public.shop_order');
  const m2 = analyze('shop/migrations/0002_order_status.py', 'django/shop/migrations/0002_order_status.py');
  assert.deepEqual(m2.statements.map((s) => s.kind), ['alter_table.add_column', 'alter_table.alter_column_type+set_not_null', 'alter_table.drop_column', 'alter_table.rename_column']);
  assert.equal(m2.statements[1].forecast.rewrite, 'table');
  assert.equal(m2.extra.dependencies[0], 'shop:0001_initial');
  assert.equal(m2.destructive, true);
});

test('django: RunSQL without reverse and RunPython without reverse_code are irreversible', () => {
  const m = analyze('shop/migrations/0003_backfill.py', 'django/shop/migrations/0003_backfill.py');
  assert.equal(m.has_down, false);
  assert.equal(m.irreversible, true);
  assert.ok(m.statements.some((s) => s.kind === 'run_python'));
  assert.ok(m.statements.some((s) => s.kind === 'update'));
});

// ------------------------------------------------------------------ Alembic

test('alembic: ops, concurrent index, revision chain and downgrade presence', () => {
  const a = analyze('alembic/versions/a1b2_init.py', 'alembic/versions/a1b2_init.py');
  assert.deepEqual([a.extra.revision, a.extra.down_revision, a.has_down], ['a1b2', null, true]);
  const b = analyze('alembic/versions/c3d4_add_col.py', 'alembic/versions/c3d4_add_col.py');
  assert.equal(b.extra.down_revision, 'a1b2');
  assert.equal(b.has_down, false, 'downgrade() is just pass');
  assert.deepEqual(b.statements.map((s) => s.kind), ['alter_table.add_column', 'alter_table.alter_column_type', 'update']);
  const c = analyze('alembic/versions/e5f6_index.py', 'alembic/versions/e5f6_index.py');
  assert.equal(c.statements[0].forecast.lock_mode, 'SHARE UPDATE EXCLUSIVE');
  assert.equal(c.statements[0].forecast.transactional, false);
});

// ------------------------------------------------------------------ Prisma / golang-migrate / MySQL

test('prisma: migration.sql is parsed as PostgreSQL DDL', () => {
  const m = analyze('prisma/migrations/20240101000000_init/migration.sql', 'prisma/migrations/20240101000000_init/migration.sql');
  assert.equal(m.framework, 'prisma');
  assert.equal(m.version, '20240101000000');
  assert.equal(m.has_down, false);
  assert.deepEqual(m.statements.map((s) => s.kind), ['create_table', 'create_table', 'create_index', 'create_index', 'alter_table.add_constraint']);
});

test('golang-migrate: up files are migrations, down files are not', () => {
  const up = analyze('migrations/000002_add_orders.up.sql', 'golang-migrate/migrations/000002_add_orders.up.sql');
  assert.equal(up.framework, 'golang-migrate');
  assert.equal(up.version, '000002');
  assert.equal(up.has_down, false);
  const down = analyze('migrations/000001_create_users.down.sql', 'golang-migrate/migrations/000001_create_users.down.sql');
  assert.equal(down.extra.direction, 'down');
});

test('mysql: ALGORITHM=INSTANT honoured, MODIFY is COPY, DELIMITER trigger parsed', () => {
  const m = analyze('db/migrate/001_instant.sql', 'mysql/001_instant.sql', { engine: 'mysql', version: '8.0.32' });
  assert.equal(m.engine, 'mysql');
  assert.equal(m.statements[0].forecast.lock_mode, 'NONE');
  assert.equal(m.statements[0].forecast.rule_id, 'my.add_column.instant');
  assert.equal(m.statements[1].forecast.rewrite, 'table');
  assert.equal(m.statements[2].kind, 'create_index');
  assert.equal(m.statements[3].kind, 'create_trigger');
  assert.equal(m.statements[0].table, 'orders', 'MySQL tables are not schema-qualified');
});

// ------------------------------------------------------------------ Liquibase

test('liquibase xml: change sets, change types, rollback', () => {
  const sets = readLiquibase('db.changelog-master.xml', fixture('liquibase/db.changelog-master.xml'));
  assert.deepEqual(sets.map((s) => [s.id, s.author]), [['1', 'ann'], ['2', 'ann'], ['3', 'bob']]);
  assert.deepEqual(sets[1].changes.map((c) => c.type), ['addColumn', 'createIndex']);
  assert.equal(sets[2].rollback, true);
  const m = analyze('db/db.changelog-master.xml', 'liquibase/db.changelog-master.xml');
  assert.equal(m.has_down, true);
  assert.deepEqual(m.statements.map((s) => s.kind), ['create_table', 'alter_table.add_column', 'create_index', 'update']);
});

test('liquibase yaml and json', () => {
  const m = analyze('db/db.changelog-master.yaml', 'liquibase/db.changelog-master.yaml');
  assert.deepEqual(m.extra.change_sets[0].types, ['createTable', 'dropColumn']);
  assert.equal(m.destructive, true);
  const json = JSON.stringify({ databaseChangeLog: [{ changeSet: { id: 'j1', author: 'a', changes: [{ createTable: { tableName: 't', columns: [{ column: { name: 'id', type: 'int' } }] } }] } }] });
  const j = analyzeMigration('db/changelog.json', json, PG);
  assert.equal(j.statements[0].kind, 'create_table');
  assert.equal(j.has_down, true);
});

test('mini yaml reader handles maps, lists and block scalars', () => {
  const y = parseMiniYaml('a: 1\nb:\n  - x: hello\n    y: [1, 2]\n  - z: |\n      line1\n      line2\n');
  assert.equal(y.a, 1);
  assert.deepEqual(y.b[0].y, [1, 2]);
  assert.equal(y.b[1].z, 'line1\nline2');
});

// ------------------------------------------------------------------ JS frameworks

test('knex, sequelize and typeorm: raw SQL and DSL calls', () => {
  const knex = analyzeMigration('migrations/20240101_add.js', `exports.up = (knex) => knex.raw('CREATE INDEX i ON t (a)').then(() => knex.schema.alterTable('t', (t) => { t.dropColumn('old'); }));
exports.down = () => Promise.resolve();`, PG);
  assert.equal(knex.framework, 'knex');
  assert.equal(knex.has_down, true);
  assert.deepEqual(knex.statements.map((s) => s.kind).sort(), ['alter_table.drop_column', 'create_index']);
  const seq = analyzeMigration('migrations/20240101000000-add.js', `module.exports = { up: async (queryInterface, Sequelize) => { await queryInterface.addColumn('users', 'age', { type: Sequelize.INTEGER, allowNull: false }); await queryInterface.sequelize.query('UPDATE users SET age = 0'); }, down: async (queryInterface) => { await queryInterface.removeColumn('users', 'age'); } };`, PG);
  assert.equal(seq.framework, 'sequelize');
  assert.equal(seq.has_down, true);
  assert.deepEqual(seq.statements.map((s) => s.kind).sort(), ['alter_table.add_column', 'update']);
  const typeorm = analyzeMigration('migrations/1700000000000-Add.ts', 'export class Add1 implements MigrationInterface { public async up(queryRunner: QueryRunner) { await queryRunner.query(`ALTER TABLE "users" ADD "x" integer`); } public async down(queryRunner: QueryRunner) { await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "x"`); } }', PG);
  assert.equal(typeorm.framework, 'typeorm');
  assert.equal(typeorm.has_down, true);
  assert.equal(typeorm.statements[0].kind, 'alter_table.add_column');
});

test('engine inference from syntax hints', () => {
  assert.equal(inferEngine('ALTER TABLE `t` ADD x int'), 'mysql');
  assert.equal(inferEngine('CREATE INDEX CONCURRENTLY i ON t (a)'), 'postgresql');
  assert.equal(inferEngine('CREATE TABLE t (id integer PRIMARY KEY AUTOINCREMENT)'), 'sqlite');
  assert.equal(inferEngine('ALTER TABLE t ADD x int'), null);
});

test('unknown engine yields low-confidence forecasts', () => {
  const m = analyzeMigration('db/migrate/20240101000000_x.rb', 'class X < ActiveRecord::Migration[7.1]\n  def change\n    add_column :t, :c, :integer\n  end\nend\n', {});
  assert.equal(m.statements[0].forecast.confidence, 'low');
});
