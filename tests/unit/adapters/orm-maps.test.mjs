// One rule for ORM mappings in every language (adapters/language/orm-maps.mjs): each row of
// ORM_SYNTAX is exercised through the adapter that reads its language, with a small fixture for
// an explicit table name and one for the ORM's naming convention, and every row must state the
// same facts. Then a table written through two entity types in different modules is seen by the
// multiple-writers detector.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'unknot-orm-home-'));

import databaseAdapter from '../../../adapters/database/index.mjs';
import genericAdapter from '../../../adapters/language/generic/index.mjs';
import javascriptAdapter from '../../../adapters/language/javascript/index.mjs';
import pythonAdapter from '../../../adapters/language/python/index.mjs';
import { ORM_SYNTAX } from '../../../adapters/language/orm-maps.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { assertFact } from '../../../runtime/graph/facts.mjs';
import { LANGUAGE_IDS } from '../../../runtime/graph/languages.mjs';
import DB from '../../../runtime/diagnose/detectors/database.mjs';
import { hasPython, realExec, unsupportedExec } from './python/helpers.mjs';

const entryOf = (path, text) => ({ path, size: text.length, language: null, kind: 'source', blob: path });

/** Every fact the adapter that reads `lang` produces for a set of files, after linking. */
async function factsFor(lang, sources) {
  const files = new Map();
  const factsByFile = new Map();
  if (lang === LANGUAGE_IDS.PYTHON) {
    const items = Object.entries(sources).map(([path, text]) => ({ file: entryOf(path, text), text }));
    for (const it of items) files.set(it.file.path, it.file);
    const records = await pythonAdapter.extractBatch(items, { exec: hasPython ? realExec : unsupportedExec, options: {} });
    for (const [path, facts] of records) factsByFile.set(path, facts);
    return [...factsByFile.values()].flat().concat(pythonAdapter.link({ files, factsByFile, options: {} }));
  }
  const adapter = lang === LANGUAGE_IDS.PRISMA ? databaseAdapter : [LANGUAGE_IDS.TYPESCRIPT, LANGUAGE_IDS.JAVASCRIPT].includes(lang) ? javascriptAdapter : genericAdapter;
  for (const [path, text] of Object.entries(sources)) {
    const entry = entryOf(path, text);
    files.set(path, entry);
    factsByFile.set(path, adapter.extract(entry, text, { commit: 'test', options: {} }));
  }
  const linked = lang === LANGUAGE_IDS.PRISMA ? [] : adapter.link({ files, factsByFile, options: {}, resolve: null });
  return [...factsByFile.values()].flat().concat(linked);
}

const L = LANGUAGE_IDS;

// One entry per spelling: a file, what it declares, and the table it maps to. `basis` is
// 'convention' wherever the code does not name the table.
const CASES = [
  { orm: 'jpa', lang: L.JAVA, path: 'src/LedgerEntry.java', src: '@Entity\n@Table(name = "ledger_entries")\npublic class LedgerEntry {\n}\n', table: 'ledger_entries' },
  { orm: 'jpa', lang: L.JAVA, path: 'src/InvoiceLine.java', src: '@Entity\npublic class InvoiceLine {\n}\n', table: 'invoice_line', basis: 'convention' },
  { orm: 'jpa', lang: L.KOTLIN, path: 'src/Order.kt', src: '@Entity\n@Table(name = "orders")\nclass Order {\n}\n', table: 'orders' },
  { orm: 'efcore', lang: L.CSHARP, path: 'Data/LedgerEntry.cs', src: '[Table("ledger_entries")]\npublic class LedgerEntry\n{\n}\n', table: 'ledger_entries' },
  { orm: 'efcore', lang: L.CSHARP, path: 'Data/ToTable.cs', src: 'public class Ctx : DbContext\n{\n    protected override void OnModelCreating(ModelBuilder b)\n    {\n        b.Entity<LedgerEntry>().ToTable("ledger_entries");\n    }\n}\n', table: 'ledger_entries' },
  {
    orm: 'efcore', lang: L.CSHARP, path: 'Data/EntryConfig.cs',
    src: 'public class EntryConfig : IEntityTypeConfiguration<LedgerEntry>\n{\n    public void Configure(EntityTypeBuilder<LedgerEntry> builder)\n    {\n        builder.ToTable("ledger_entries");\n    }\n}\n',
    table: 'ledger_entries',
  },
  { orm: 'efcore', lang: L.CSHARP, path: 'Data/Ctx.cs', src: 'public class Ctx : DbContext\n{\n    public DbSet<InvoiceLine> InvoiceLines { get; set; }\n}\n', table: 'invoice_lines', basis: 'convention' },
  { orm: 'sqlalchemy', lang: L.PYTHON, path: 'ledger/models.py', src: 'class Entry(Base):\n    __tablename__ = "ledger_entries"\n    id = Column(Integer, primary_key=True)\n', table: 'ledger_entries' },
  { orm: 'sqlalchemy', lang: L.PYTHON, path: 'ledger/lines.py', src: 'class InvoiceLine(db.Model):\n    id = db.Column(db.Integer, primary_key=True)\n', table: 'invoice_line', basis: 'convention' },
  { orm: 'sqlalchemy', lang: L.PYTHON, path: 'ledger/core.py', src: 'entries = Table("ledger_entries", metadata, Column("id", Integer))\n', table: 'ledger_entries' },
  { orm: 'django', lang: L.PYTHON, path: 'ledger/models.py', src: 'from django.db import models\n\nclass Entry(models.Model):\n    class Meta:\n        db_table = "ledger_entries"\n', table: 'ledger_entries' },
  { orm: 'django', lang: L.PYTHON, path: 'billing/models.py', src: 'from django.db import models\n\nclass InvoiceLine(models.Model):\n    amount = models.IntegerField()\n', table: 'billing_invoiceline', basis: 'convention' },
  { orm: 'typeorm', lang: L.TYPESCRIPT, path: 'src/entry.ts', src: "@Entity('ledger_entries')\nexport class LedgerEntry {}\n", table: 'ledger_entries' },
  { orm: 'typeorm', lang: L.TYPESCRIPT, path: 'src/named.ts', src: "@Entity({ name: 'ledger_entries' })\nexport class LedgerEntry {}\n", table: 'ledger_entries' },
  { orm: 'typeorm', lang: L.TYPESCRIPT, path: 'src/line.ts', src: '@Entity()\nexport class InvoiceLine {}\n', table: 'invoice_line', basis: 'convention' },
  { orm: 'sequelize', lang: L.JAVASCRIPT, path: 'src/entry.js', src: "const Entry = sequelize.define('Entry', {}, { tableName: 'ledger_entries' });\n", table: 'ledger_entries' },
  { orm: 'sequelize', lang: L.JAVASCRIPT, path: 'src/init.js', src: "class Entry extends Model {}\nEntry.init({}, { sequelize, tableName: 'ledger_entries' });\n", table: 'ledger_entries' },
  { orm: 'sequelize', lang: L.JAVASCRIPT, path: 'src/line.js', src: "const InvoiceLine = sequelize.define('InvoiceLine', {});\n", table: 'InvoiceLines', basis: 'convention' },
  { orm: 'prisma', lang: L.PRISMA, path: 'prisma/schema.prisma', src: 'model Entry {\n  id Int @id\n  @@map("ledger_entries")\n}\n', table: 'ledger_entries', owned: false },
  { orm: 'prisma', lang: L.PRISMA, path: 'billing/schema.prisma', src: 'model InvoiceLine {\n  id Int @id\n}\n', table: 'InvoiceLine', basis: 'convention', owned: false },
  { orm: 'activerecord', lang: L.RUBY, path: 'app/models/entry.rb', src: "class Entry < ApplicationRecord\n  self.table_name = 'ledger_entries'\nend\n", table: 'ledger_entries' },
  { orm: 'activerecord', lang: L.RUBY, path: 'app/models/invoice_line.rb', src: 'class InvoiceLine < ApplicationRecord\nend\n', table: 'invoice_lines', basis: 'convention' },
  { orm: 'gorm', lang: L.GO, path: 'ledger/entry.go', src: 'package ledger\n\ntype Entry struct {\n\tgorm.Model\n}\n\nfunc (Entry) TableName() string { return "ledger_entries" }\n', table: 'ledger_entries' },
  { orm: 'gorm', lang: L.GO, path: 'ledger/line.go', src: 'package ledger\n\ntype InvoiceLine struct {\n\tgorm.Model\n\tAmount int\n}\n', table: 'invoice_lines', basis: 'convention' },
  { orm: 'doctrine', lang: L.PHP, path: 'src/Entry.php', src: "<?php\n#[ORM\\Entity]\n#[ORM\\Table(name: 'ledger_entries')]\nclass Entry\n{\n}\n", table: 'ledger_entries' },
  { orm: 'doctrine', lang: L.PHP, path: 'src/InvoiceLine.php', src: '<?php\n#[ORM\\Entity]\nclass InvoiceLine\n{\n}\n', table: 'invoice_line', basis: 'convention' },
  { orm: 'eloquent', lang: L.PHP, path: 'app/Models/Entry.php', src: "<?php\nclass Entry extends Model\n{\n    protected $table = 'ledger_entries';\n}\n", table: 'ledger_entries' },
  { orm: 'eloquent', lang: L.PHP, path: 'app/Models/InvoiceLine.php', src: '<?php\nclass InvoiceLine extends Model\n{\n}\n', table: 'invoice_lines', basis: 'convention' },
];

test('the table has a case for every ORM row, declared and by convention', () => {
  for (const row of ORM_SYNTAX) {
    const mine = CASES.filter((c) => c.orm === row.orm);
    assert.ok(mine.some((c) => !c.basis), `${row.orm}: an explicit table name`);
    assert.ok(mine.some((c) => c.basis === 'convention'), `${row.orm}: a table named by convention`);
  }
});

for (const c of CASES) {
  test(`${c.orm} (${c.lang}): ${c.basis === 'convention' ? 'convention' : 'declared'} table ${c.table} in ${c.path}`, async () => {
    const facts = await factsFor(c.lang, { [c.path]: c.src });
    facts.forEach(assertFact);
    const tables = facts.filter((f) => f.kind === 'node' && f.type === 'table' && f.attrs.orm === c.orm);
    assert.deepEqual(tables.map((t) => t.name), [c.table]);
    const [table] = tables;
    // The basis is stated only where the ORM's naming convention was used.
    assert.equal(table.attrs.table_name_basis, c.basis);
    if (c.owned === false) return; // a schema file declares the table; no module owns it
    const owns = facts.filter((f) => f.kind === 'edge' && f.type === 'OWNS_DATA' && f.to === table.id);
    assert.deepEqual(owns.map((e) => e.from), [`module:${c.path}`]);
    assert.equal(owns[0].attrs.orm, c.orm);
  });
}

// ---- an entity inherits from an abstract base declared in another file

// Each case: the files, the tables that must exist (by entity) and the types that must not map.
const INHERITED = [
  {
    orm: 'django', lang: L.PYTHON,
    sources: {
      'core/models.py': 'from django.db import models\n\nclass TimestampedModel(models.Model):\n    created = models.DateTimeField()\n\n    class Meta:\n        abstract = True\n',
      'billing/models.py': 'from core.models import TimestampedModel\n\nclass Article(TimestampedModel):\n    title = models.CharField()\n\nclass Review(Article):\n    pass\n',
    },
    tables: ['billing_article', 'billing_review'], absent: ['core_timestampedmodel'],
  },
  {
    orm: 'sqlalchemy', lang: L.PYTHON,
    sources: {
      'ledger/base.py': 'class Audited(Base):\n    __abstract__ = True\n    created = Column(DateTime)\n',
      'ledger/models.py': 'from ledger.base import Audited\n\nclass InvoiceLine(Audited):\n    id = Column(Integer, primary_key=True)\n',
    },
    tables: ['invoice_line'], absent: ['audited'],
  },
  {
    orm: 'jpa', lang: L.JAVA,
    sources: {
      'src/BaseEntity.java': '@MappedSuperclass\npublic abstract class BaseEntity {\n    Long id;\n}\n',
      'src/LedgerEntry.java': '@Entity\n@Table(name = "ledger_entries")\npublic class LedgerEntry extends BaseEntity {\n}\n',
    },
    tables: ['ledger_entries'], absent: ['base_entity'],
  },
  {
    orm: 'activerecord', lang: L.RUBY,
    sources: {
      'app/models/application_record.rb': 'class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n',
      'app/models/party_record.rb': 'class PartyRecord < ApplicationRecord\n  self.abstract_class = true\nend\n',
      'app/models/customer.rb': 'class Customer < PartyRecord\nend\n',
      'app/models/invoice.rb': 'class Invoice < ApplicationRecord\nend\n',
    },
    tables: ['customers', 'invoices'], absent: ['application_records', 'party_records'],
  },
  {
    orm: 'doctrine', lang: L.PHP,
    sources: {
      'src/Base.php': "<?php\n#[ORM\\MappedSuperclass]\nclass Base\n{\n}\n",
      'src/Entry.php': "<?php\n#[ORM\\Entity]\nclass Entry extends Base\n{\n}\n",
    },
    tables: ['entry'], absent: ['base'],
  },
];

for (const c of INHERITED) {
  test(`${c.orm}: concrete entities of an abstract base are mapped, the base is not`, async () => {
    const facts = await factsFor(c.lang, c.sources);
    facts.forEach(assertFact);
    const tables = facts.filter((f) => f.kind === 'node' && f.type === 'table').map((f) => f.name).sort();
    assert.deepEqual(tables, [...c.tables].sort());
    for (const a of c.absent) assert.ok(!tables.includes(a), `${a} is not an entity`);
    for (const t of facts.filter((f) => f.kind === 'node' && f.type === 'table')) {
      assert.equal(t.attrs.orm, c.orm);
      assert.ok(facts.some((f) => f.kind === 'edge' && f.type === 'OWNS_DATA' && f.to === t.id), `${t.name} has an owner`);
    }
  });
}

test('a class whose bases never reach an ORM entity is not mapped', async () => {
  const facts = await factsFor(L.PYTHON, {
    'a/models.py': 'class Mixin:\n    pass\n\nclass Plain(Mixin):\n    pass\n',
  });
  assert.deepEqual(facts.filter((f) => f.kind === 'node' && f.type === 'table'), []);
});

// ---- an entity name in an ORM query string is the entity's table, never a new one

const QUERIES = [
  {
    name: 'JPQL select of the alias',
    sources: {
      'src/PetType.java': '@Entity\n@Table(name = "types")\npublic class PetType {\n}\n',
      'src/Repo.java': 'public interface Repo {\n  @Query("SELECT ptype FROM PetType ptype ORDER BY ptype.name")\n  List<PetType> findPetTypes();\n}\n',
    },
    tables: ['types'], reads: ['types'],
  },
  {
    name: 'a known entity joined in a query that is not recognisable as an entity query',
    sources: {
      'src/Invoice.java': '@Entity\n@Table(name = "invoices")\npublic class Invoice {\n}\n',
      'src/Repo.java': 'public class Repo {\n  void f(EntityManager em) { em.createQuery("SELECT i.id, i.total FROM Invoice i WHERE i.total > 0"); }\n}\n',
    },
    tables: ['invoices'], reads: ['invoices'],
  },
  {
    name: 'an unknown entity in a query shaped like JPQL makes no table',
    sources: {
      'src/Repo.java': 'public interface Repo {\n  @Query("SELECT i FROM Invoice i JOIN FETCH i.lines l WHERE i.id = :id")\n  Object find();\n}\n',
    },
    tables: [], reads: [],
  },
  {
    name: 'plain SQL with the same shape of name still infers its table',
    sources: {
      'src/Repo.java': 'public class Repo {\n  void f(Statement st) { st.executeQuery("SELECT * FROM ledger_entries e WHERE e.id = 1"); }\n}\n',
    },
    tables: ['ledger_entries'], reads: ['ledger_entries'],
  },
];

for (const q of QUERIES) {
  test(`entity query strings: ${q.name}`, async () => {
    const files = new Map();
    const factsByFile = new Map();
    for (const [path, text] of Object.entries(q.sources)) {
      const entry = entryOf(path, text);
      files.set(path, entry);
      factsByFile.set(path, genericAdapter.extract(entry, text, { commit: 'test', options: {} }));
    }
    const linked = genericAdapter.link({ files, factsByFile, options: {}, resolve: null });
    const dbLinked = databaseAdapter.link({ files, factsByFile, options: {} });
    const all = [...factsByFile.values()].flat().concat(linked, [...(dbLinked.values?.() ?? dbLinked)]);
    const tables = [...new Set(all.filter((f) => f.kind === 'node' && f.type === 'table').map((f) => f.name))].sort();
    assert.deepEqual(tables, [...q.tables].sort());
    const read = [...new Set(all.filter((f) => f.kind === 'edge' && f.type === 'QUERIES' && f.attrs?.via === 'raw_sql').map((f) => f.to.split('.').pop()))].sort();
    assert.deepEqual(q.name.startsWith('plain') ? read : read.filter((r) => q.tables.includes(r)), q.reads.sort());
  });
}

// ---- a table written through two entity types in different modules

const DB_DETECTOR = DB.find((d) => d.id === 'database.multiple-writers');

const WRITERS = [
  {
    name: 'python (session.add of the mapped type)',
    lang: L.PYTHON,
    sources: {
      'services/billing/models.py': 'class Entry(Base):\n    __tablename__ = "ledger"\n\ndef post(session):\n    session.add(Entry())\n',
      'services/shipping/models.py': 'class Posting(Base):\n    __tablename__ = "ledger"\n\ndef post(session):\n    session.add(Posting())\n',
    },
  },
  {
    name: 'php (static call on a type declared in another file)',
    lang: L.PHP,
    sources: {
      'services/billing/Entry.php': "<?php\nclass Entry extends Model\n{\n    protected $table = 'ledger';\n}\n",
      'services/billing/Post.php': '<?php\nfunction post() {\n    Entry::create([]);\n}\n',
      'services/shipping/Posting.php': "<?php\nclass Posting extends Model\n{\n    protected $table = 'ledger';\n}\n",
      'services/shipping/Post.php': '<?php\nfunction post() {\n    Posting::create([]);\n}\n',
    },
  },
  {
    name: 'java (entity manager given the mapped type)',
    lang: L.JAVA,
    sources: {
      'services/billing/Entry.java': '@Entity\n@Table(name = "ledger")\npublic class Entry {\n    void post(EntityManager em) { em.persist(new Entry()); }\n}\n',
      'services/shipping/Posting.java': '@Entity\n@Table(name = "ledger")\npublic class Posting {\n    void post(EntityManager em) { em.persist(new Posting()); }\n}\n',
    },
  },
];

for (const w of WRITERS) {
  test(`multiple-writers sees both packages through their mapped types: ${w.name}`, async () => {
    const facts = await factsFor(w.lang, w.sources);
    const graph = Graph.fromFacts(facts);
    const drafts = DB_DETECTOR.detect({ graph, options: {}, config: {}, scope: [] });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].measurements['table.writers'], 2);
    assert.match(drafts[0].title, /services\/billing/);
    assert.match(drafts[0].title, /services\/shipping/);
    // A module that only maps a type it never writes through does not count as a writer.
    const reads = await factsFor(w.lang, Object.fromEntries(Object.entries(w.sources).slice(0, 1)));
    assert.equal(DB_DETECTOR.detect({ graph: Graph.fromFacts(reads), options: {}, config: {}, scope: [] }).length, 0);
  });
}
