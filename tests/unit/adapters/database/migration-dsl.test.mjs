// Migration DSL regressions found on public example apps: foreign keys declared in a DSL,
// rollback sections that must not count as forward-destructive, option keywords that are not
// columns, and per-dialect schema files that are alternatives rather than one merged table.

import test from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/database/index.mjs';
import { analyzeMigration } from '../../../../adapters/database/migrations.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { default as DB } from '../../../../runtime/diagnose/detectors/database.mjs';
import { nodes, edges } from './helpers.mjs';

const PG = { engine: 'postgresql', version: '16' };
const extract = (path, text) => adapter.extract({ path, size: 0, language: null, kind: 'source', blob: 'x' }, text, { options: PG });
const fks = (facts) => edges(facts, 'REFERENCES').map((e) => `${e.from}>${e.to}(${(e.attrs.columns ?? []).join(',')})`).sort();
const columns = (facts) => nodes(facts, 'column').map((c) => c.name).sort();

// ------------------------------------------------------------------ 1. foreign keys in DSLs

const FK_ROWS = [
  ['rails t.references', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    create_table :orders do |t|\n      t.references :user, foreign_key: true\n    end\n  end\nend\n',
    ['table:public.orders>table:public.users(user_id)']],
  ['rails t.references to_table', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    create_table :orders do |t|\n      t.references :author, foreign_key: { to_table: :people }\n    end\n  end\nend\n',
    ['table:public.orders>table:public.people(author_id)']],
  ['rails add_foreign_key', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    add_foreign_key :invoices, :orders\n  end\nend\n',
    ['table:public.invoices>table:public.orders(order_id)']],
  ['rails add_reference', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    add_reference :invoices, :order, foreign_key: true\n  end\nend\n',
    ['table:public.invoices>table:public.orders(order_id)']],
  ['laravel foreignId constrained', 'database/migrations/2024_01_01_000000_create_orders.php',
    "<?php\nreturn new class extends Migration {\n  public function up() {\n    Schema::create('orders', function (Blueprint $table) {\n      $table->id();\n      $table->foreignId('user_id')->constrained()->onDelete('cascade');\n    });\n  }\n};\n",
    ['table:public.orders>table:public.users(user_id)']],
  ['laravel foreign references on', 'database/migrations/2024_01_01_000000_create_orders.php',
    "<?php\nreturn new class extends Migration {\n  public function up() {\n    Schema::table('invoices', function (Blueprint $table) {\n      $table->unsignedBigInteger('order_id');\n      $table->foreign('order_id')->references('id')->on('orders');\n    });\n  }\n};\n",
    ['table:public.invoices>table:public.orders(order_id)']],
  ['django ForeignKey', 'shop/migrations/0001_initial.py',
    "from django.db import migrations, models\nclass Migration(migrations.Migration):\n    operations = [\n        migrations.CreateModel(name='Invoice', fields=[('id', models.AutoField(primary_key=True)), ('order', models.ForeignKey(on_delete=models.CASCADE, to='shop.order'))]),\n    ]\n",
    ['table:public.shop_invoice>table:public.shop_order(order_id)']],
  // A swappable user model names no table in the migration, so no foreign key (and no guessed table).
  ['django settings.AUTH_USER_MODEL', 'shop/migrations/0002_ledger.py',
    "from django.conf import settings\nfrom django.db import migrations, models\nclass Migration(migrations.Migration):\n    operations = [\n        migrations.CreateModel(name='Ledger', fields=[('id', models.AutoField(primary_key=True)), ('owner', models.OneToOneField(on_delete=models.CASCADE, to=settings.AUTH_USER_MODEL))]),\n        migrations.AddField(model_name='ledger', name='editor', field=models.ForeignKey(on_delete=models.CASCADE, to=settings.AUTH_USER_MODEL)),\n    ]\n",
    []],
  ['alembic sa.ForeignKey', 'alembic/versions/a1_init.py',
    "revision = 'a1'\ndown_revision = None\ndef upgrade():\n    op.create_table('invoices', sa.Column('id', sa.Integer, primary_key=True), sa.Column('order_id', sa.Integer, sa.ForeignKey('orders.id')))\ndef downgrade():\n    op.drop_table('invoices')\n",
    ['table:public.invoices>table:public.orders(order_id)']],
  ['alembic ForeignKeyConstraint', 'alembic/versions/a1_init.py',
    "revision = 'a1'\ndown_revision = None\ndef upgrade():\n    op.create_table('invoices', sa.Column('order_id', sa.Integer), sa.ForeignKeyConstraint(['order_id'], ['orders.id']))\ndef downgrade():\n    pass\n",
    ['table:public.invoices>table:public.orders(order_id)']],
  ['alembic create_foreign_key', 'alembic/versions/a2_fk.py',
    "revision = 'a2'\ndown_revision = 'a1'\ndef upgrade():\n    op.create_foreign_key('fk_inv_order', 'invoices', 'orders', ['order_id'], ['id'])\ndef downgrade():\n    pass\n",
    ['table:public.invoices>table:public.orders(order_id)']],
  ['efcore table.ForeignKey', 'Migrations/20240101000000_Init.cs',
    'public partial class Init : Migration {\n protected override void Up(MigrationBuilder migrationBuilder) {\n  migrationBuilder.CreateTable(name: "Invoices", columns: table => new { Id = table.Column<int>(nullable: false), OrderId = table.Column<int>(nullable: false) }, constraints: table => { table.PrimaryKey("PK_Invoices", x => x.Id); table.ForeignKey(name: "FK_Invoices_Orders_OrderId", column: x => x.OrderId, principalTable: "Orders", principalColumn: "Id", onDelete: ReferentialAction.Cascade); });\n }\n protected override void Down(MigrationBuilder migrationBuilder) { }\n}\n',
    ['table:public.invoices>table:public.orders(orderid)']],
  ['efcore AddForeignKey', 'Migrations/20240102000000_Fk.cs',
    'public partial class Fk : Migration {\n protected override void Up(MigrationBuilder migrationBuilder) {\n  migrationBuilder.AddForeignKey(name: "FK_Invoices_Orders", table: "Invoices", column: "OrderId", principalTable: "Orders", principalColumn: "Id");\n }\n}\n',
    ['table:public.invoices>table:public.orders(orderid)']],
  ['knex references inTable', 'migrations/20240101_a.js',
    "exports.up = (knex) => knex.schema.createTable('invoices', (t) => {\n  t.integer('order_id').references('id').inTable('orders');\n});\nexports.down = (knex) => knex.schema.dropTable('invoices');\n",
    ['table:public.invoices>table:public.orders(order_id)']],
  ['knex foreign references', 'migrations/20240101_a.js',
    "exports.up = (knex) => knex.schema.alterTable('invoices', (t) => {\n  t.foreign('order_id').references('orders.id');\n});\nexports.down = () => {};\n",
    ['table:public.invoices>table:public.orders(order_id)']],
  ['typeorm TableForeignKey', 'migrations/1700000000000-Add.ts',
    "export class Add implements MigrationInterface {\n  public async up(queryRunner: QueryRunner) {\n    await queryRunner.createForeignKey('invoices', new TableForeignKey({ columnNames: ['order_id'], referencedColumnNames: ['id'], referencedTableName: 'orders' }));\n  }\n  public async down(queryRunner: QueryRunner) { await queryRunner.dropTable('invoices'); }\n}\n",
    ['table:public.invoices>table:public.orders(order_id)']],
  ['sequelize references', 'migrations/20240101-add.js',
    "module.exports = { up: async (queryInterface, Sequelize) => {\n  await queryInterface.addColumn('invoices', 'order_id', { type: Sequelize.INTEGER, references: { model: 'orders', key: 'id' } });\n}, down: async () => {} };\n",
    ['table:public.invoices>table:public.orders(order_id)']],
];

for (const [name, path, text, expected] of FK_ROWS) {
  test(`foreign key in migration DSL: ${name}`, () => {
    assert.deepEqual(fks(extract(path, text)), expected);
  });
}

test('foreign key facts match the DDL REFERENCES facts', () => {
  const ddl = extract('db/migration/V1__a.sql', 'CREATE TABLE orders (id bigint PRIMARY KEY);\nCREATE TABLE invoices (id bigint PRIMARY KEY, order_id bigint REFERENCES orders (id));\n');
  const dsl = extract('db/migrate/20240101000000_a.rb', 'class A < ActiveRecord::Migration[7.0]\n  def change\n    create_table :invoices do |t|\n      t.references :order, foreign_key: true\n    end\n  end\nend\n');
  assert.deepEqual(fks(dsl), fks(ddl));
});

// ------------------------------------------------------------------ 2. rollback sections

const FORWARD_OK = 'CREATE TABLE keep (id integer);';
void FORWARD_OK;
const ROLLBACK_ROWS = [
  ['rails def down', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def up\n    create_table :orders do |t|\n      t.string :name\n    end\n  end\n\n  def down\n    drop_table :orders\n  end\nend\n',
    'class A < ActiveRecord::Migration[7.0]\n  def up\n    drop_table :orders\n  end\n\n  def down\n    create_table :orders do |t|\n    end\n  end\nend\n'],
  ['rails self.down', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def self.up\n    add_column :orders, :x, :integer\n  end\n  def self.down\n    remove_column :orders, :x\n  end\nend\n',
    'class A < ActiveRecord::Migration[7.0]\n  def self.up\n    remove_column :orders, :x\n  end\n  def self.down\n    add_column :orders, :x, :integer\n  end\nend\n'],
  ['rails reversible dir.down', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    reversible do |dir|\n      dir.up { }\n      dir.down do\n        drop_table :orders\n      end\n    end\n  end\nend\n',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    drop_table :orders\n  end\nend\n'],
  ['laravel down()', 'database/migrations/2024_01_01_000000_a.php',
    "<?php\nreturn new class extends Migration {\n  public function up() {\n    Schema::create('orders', function (Blueprint $table) { $table->id(); });\n  }\n  public function down() {\n    Schema::dropIfExists('orders');\n  }\n};\n",
    "<?php\nreturn new class extends Migration {\n  public function up() {\n    Schema::dropIfExists('orders');\n  }\n  public function down() {\n    Schema::create('orders', function (Blueprint $table) { $table->id(); });\n  }\n};\n"],
  ['alembic downgrade()', 'alembic/versions/a1_x.py',
    "revision = 'a1'\ndown_revision = None\ndef upgrade():\n    op.add_column('orders', sa.Column('x', sa.Integer))\ndef downgrade():\n    op.drop_column('orders', 'x')\n",
    "revision = 'a1'\ndown_revision = None\ndef upgrade():\n    op.drop_column('orders', 'x')\ndef downgrade():\n    op.add_column('orders', sa.Column('x', sa.Integer))\n"],
  ['django reverse_sql', 'shop/migrations/0002_x.py',
    "from django.db import migrations\nclass Migration(migrations.Migration):\n    operations = [migrations.RunSQL(sql='CREATE INDEX i ON orders (id)', reverse_sql='DROP TABLE orders')]\n",
    "from django.db import migrations\nclass Migration(migrations.Migration):\n    operations = [migrations.RunSQL(sql='DROP TABLE orders', reverse_sql='CREATE TABLE orders (id integer)')]\n"],
  ['django RunPython reverse_code', 'shop/migrations/0002_x.py',
    "from django.db import migrations\ndef fwd(apps, se):\n    pass\ndef back(apps, se):\n    schema_editor.execute('DROP TABLE orders')\nclass Migration(migrations.Migration):\n    operations = [migrations.RunPython(fwd, reverse_code=back)]\n",
    "from django.db import migrations\nclass Migration(migrations.Migration):\n    operations = [migrations.DeleteModel(name='Order')]\n"],
  ['flyway U__ undo', 'db/migration/U2__undo.sql',
    'DROP TABLE orders;\n',
    'db/migration/V2__drop.sql'],
  ['liquibase rollback', 'db/changelog.xml',
    '<databaseChangeLog><changeSet id="1" author="a"><createTable tableName="orders"><column name="id" type="int"/></createTable><rollback><dropTable tableName="orders"/></rollback></changeSet></databaseChangeLog>',
    '<databaseChangeLog><changeSet id="1" author="a"><dropTable tableName="orders"/></changeSet></databaseChangeLog>'],
  ['efcore Down()', 'Migrations/20240101000000_Init.cs',
    'public partial class Init : Migration {\n protected override void Up(MigrationBuilder migrationBuilder) {\n  migrationBuilder.CreateTable(name: "Orders", columns: table => new { Id = table.Column<int>(nullable: false) });\n }\n protected override void Down(MigrationBuilder migrationBuilder) {\n  migrationBuilder.DropTable(name: "Orders");\n }\n}\n',
    'public partial class Init : Migration {\n protected override void Up(MigrationBuilder migrationBuilder) {\n  migrationBuilder.DropTable(name: "Orders");\n }\n protected override void Down(MigrationBuilder migrationBuilder) { }\n}\n'],
  ['knex exports.down', 'migrations/20240101_a.js',
    "exports.up = (knex) => knex.schema.createTable('orders', (t) => { t.increments('id'); });\nexports.down = (knex) => knex.schema.dropTable('orders');\n",
    "exports.up = (knex) => knex.schema.dropTable('orders');\nexports.down = (knex) => knex.schema.createTable('orders', (t) => { t.increments('id'); });\n"],
];

for (const [name, path, rollbackText, forwardOrPath] of ROLLBACK_ROWS) {
  test(`rollback section is not forward-destructive: ${name}`, () => {
    const back = analyzeMigration(path, rollbackText, PG);
    assert.ok(back, 'recognised as a migration');
    assert.equal(back.destructive, false, 'a drop in the rollback section is not destructive');
    assert.equal(back.statements.filter((s) => /^drop_table|drop_column|alter_table\.drop/.test(s.kind)).length, 0);
    if (!/\.sql$/.test(forwardOrPath) || name !== 'flyway U__ undo') {
      const fwd = analyzeMigration(path, forwardOrPath, PG);
      assert.equal(fwd.destructive, true, 'the same drop in the forward section still counts');
    } else {
      assert.equal(analyzeMigration(forwardOrPath, 'DROP TABLE orders;\n', PG).destructive, true);
    }
  });
}

// ------------------------------------------------------------------ 3. options are not columns

const OPTION_ROWS = [
  ['rails t.timestamps null: false', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    create_table :orders do |t|\n      t.string :name\n      t.timestamps null: false\n    end\n  end\nend\n',
    ['created_at', 'id', 'name', 'updated_at']],
  ['rails t.timestamps', 'db/migrate/20240101000000_a.rb',
    'class A < ActiveRecord::Migration[7.0]\n  def change\n    create_table :orders do |t|\n      t.timestamps\n    end\n  end\nend\n',
    ['created_at', 'id', 'updated_at']],
  ['laravel timestamps()', 'database/migrations/2024_01_01_000000_a.php',
    "<?php\nreturn new class extends Migration {\n  public function up() {\n    Schema::create('orders', function (Blueprint $table) {\n      $table->id();\n      $table->string('name');\n      $table->timestamps();\n    });\n  }\n};\n",
    ['created_at', 'id', 'name', 'updated_at']],
];

for (const [name, path, text, expected] of OPTION_ROWS) {
  test(`DSL options are not columns: ${name}`, () => {
    const cols = columns(extract(path, text));
    assert.deepEqual(cols.map((c) => c), expected);
    assert.ok(!cols.includes('null'));
  });
}

// ------------------------------------------------------------------ 4. dialect variants

const DIALECT_DDL = 'CREATE TABLE orders (id bigint PRIMARY KEY, customer_id bigint);\n';

function graphOf(files) {
  const factsByFile = new Map();
  const map = new Map();
  for (const [path, text] of Object.entries(files)) {
    map.set(path, { path });
    factsByFile.set(path, extract(path, text));
  }
  const linked = adapter.link({ files: map, factsByFile, options: PG });
  return Graph.fromFacts([...factsByFile.values()].flat().concat(linked));
}
const dupes = (graph) => DB.find((d) => d.id === 'database.duplicate-index').detect({ graph, options: {}, config: {}, scope: [] });

test('dialect variants: indexes of different dialects are never compared', () => {
  const graph = graphOf({
    'db/h2/schema.sql': `${DIALECT_DDL}CREATE INDEX idx_orders_customer ON orders (customer_id);\n`,
    'db/mysql/schema.sql': `${DIALECT_DDL}CREATE INDEX orders_customer_idx ON orders (customer_id);\n`,
    'db/postgres/schema.sql': `${DIALECT_DDL}CREATE INDEX idx_customer_orders ON orders (customer_id);\n`,
  });
  assert.deepEqual(dupes(graph), []);
  const table = graph.node('table:public.orders');
  assert.deepEqual(table.attrs.variants, ['h2', 'mysql', 'postgresql']);
  assert.equal(graph.nodes('table').filter((t) => t.name === 'orders').length, 1);
});

test('dialect variants: a real duplicate inside one variant is still found', () => {
  const graph = graphOf({
    'db/h2/schema.sql': `${DIALECT_DDL}CREATE INDEX idx_a ON orders (customer_id);\nCREATE INDEX idx_b ON orders (customer_id);\n`,
    'db/mysql/schema.sql': `${DIALECT_DDL}CREATE INDEX idx_a ON orders (customer_id);\n`,
  });
  const found = dupes(graph);
  assert.equal(found.length, 1);
  assert.match(found[0].title, /idx_b|idx_a/);
});

test('dialect variants: files that name no dialect are unaffected', () => {
  const graph = graphOf({ 'db/schema.sql': `${DIALECT_DDL}CREATE INDEX idx_a ON orders (customer_id);\nCREATE INDEX idx_b ON orders (customer_id);\n` });
  assert.equal(dupes(graph).length, 1);
  assert.equal(graph.node('table:public.orders').attrs.variants, undefined);
});
