// One rule for ORM mappings in every language: a code type (class, struct, model) that is
// mapped to a database table is an entity, and the table it maps to is named either by the
// code (an annotation argument, a class attribute, a method, a fluent call) or by that ORM's
// documented naming convention. A module that reaches the table through the mapped type
// (`Order.objects.create(...)`, `ctx.Orders.Add(...)`, `session.add(Order(...))`) reads or
// writes that table.
//
// Only the spelling differs by ORM, and it lives in ORM_SYNTAX below, one row per ORM:
//   entity     what makes a type an entity: `markers` (annotations, attributes, decorators),
//              `bases` (a supertype, optionally only when an import is present), `assigns`
//              (a class-level assignment), `embeds` (an embedded struct), `kinds` (a declared
//              block kind); `skipWhen` lists assignments that say it is abstract
//   name       where an explicit table name is written: `markers` ({ names, args }, an argument
//              being a position or a keyword), `assigns`
//   convention the key into CONVENTIONS that names the table when the code does not
//   texts      mappings that are a shape in the text rather than part of a type: a call that
//              names a table, a method that returns one, a fluent configuration
//   collections  a typed collection member that maps its element type (`DbSet<T> Name`)
//   access     the verbs that read or write through the mapped type, by how it is reached:
//              `static` (`Entity.verb()`, optionally through a named manager), `arg` (the type
//              is the argument of the call) and `member` (a collection member)
//
// The adapters read their own structures into a view (see `mapEntities`) and call the one pass;
// which library a spelling comes from is never consulted. Every mapping carries the same facts:
// the entity, the table, and `basis` ('declared' when the code names the table, 'convention'
// when this module guessed from the ORM's naming convention).

import { edgeFact, nodeFact } from '../../runtime/graph/facts.mjs';
import { LANGUAGE_IDS } from '../../runtime/graph/languages.mjs';

const L = LANGUAGE_IDS;

export function snake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

export function pluralize(s) {
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

const lastName = (name) => String(name).split(/::|\.|\\/).pop();

/** The Django app a model file belongs to: its directory, without a trailing `models` package. */
function djangoApp(path) {
  const parts = String(path ?? '').split('/');
  parts.pop();
  if (parts[parts.length - 1] === 'models') parts.pop();
  return parts[parts.length - 1] ?? '';
}

/** How each ORM names a table its code does not name. */
export const CONVENTIONS = {
  snake: (name) => snake(lastName(name)),
  snake_plural: (name) => pluralize(snake(lastName(name))),
  plural: (name) => pluralize(lastName(name)),
  as_is: (name) => lastName(name),
  django: (name, view) => {
    const app = djangoApp(view?.path);
    return `${app ? `${app}_` : ''}${lastName(name).toLowerCase()}`;
  },
};

const WRITE = 'writes';
const READ = 'reads';

/**
 * @type {Array<{ orm: string, languages: string[], entity: object, name?: object, convention: string,
 *   texts?: object[], collections?: object, access?: object }>}
 */
export const ORM_SYNTAX = [
  {
    orm: 'django', languages: [L.PYTHON],
    entity: { bases: ['models.Model', { name: 'Model', imports: ['django.db.models'] }], skipWhen: ['Meta.abstract'] },
    name: { assigns: ['Meta.db_table'] },
    convention: 'django',
    access: {
      static: {
        through: ['objects'],
        [WRITE]: ['create', 'update', 'delete', 'bulk_create', 'bulk_update', 'get_or_create', 'update_or_create'],
        [READ]: ['get', 'filter', 'all', 'exclude', 'count', 'first', 'last', 'exists', 'values', 'values_list', 'select_related', 'prefetch_related', 'aggregate', 'annotate', 'order_by'],
      },
    },
  },
  {
    orm: 'sqlalchemy', languages: [L.PYTHON],
    entity: { assigns: ['__tablename__'], bases: ['db.Model'] },
    name: { assigns: ['__tablename__'] },
    convention: 'snake',
    texts: [{
      // `orders = Table("orders", metadata, ...)`: a table object bound to a metadata object.
      re: /(?:\b(\w+)\s*=\s*)?(?<![\w.])(?:\w+\.)?Table\(\s*(['"])(\w[\w.]*)\2\s*,\s*[\w.]*[mM]eta\w*/g,
      entity: 1, entityFallback: 3, table: 3,
    }],
    access: {
      static: {
        through: ['query'],
        [WRITE]: ['delete', 'update'],
        [READ]: ['filter', 'filter_by', 'get', 'all', 'first', 'count', 'order_by', 'join'],
      },
      arg: {
        [WRITE]: ['add', 'add_all', 'merge', 'delete', 'bulk_save_objects', 'insert', 'update'],
        [READ]: ['query', 'get', 'select', 'scalars', 'scalar'],
      },
    },
  },
  {
    orm: 'jpa', languages: [L.JAVA, L.KOTLIN],
    entity: { markers: ['Entity'] },
    name: { markers: [{ names: ['Table'], args: ['name'] }] },
    convention: 'snake',
    access: {
      arg: {
        [WRITE]: ['persist', 'merge', 'remove', 'save', 'saveAll', 'saveAndFlush', 'delete', 'deleteAll'],
        [READ]: ['find', 'getReference', 'createQuery', 'createNamedQuery'],
      },
    },
  },
  {
    orm: 'efcore', languages: [L.CSHARP],
    entity: { markers: ['Table'] },
    name: { markers: [{ names: ['Table'], args: [0, 'name'] }] },
    convention: 'snake',
    texts: [
      // `modelBuilder.Entity<T>().ToTable("x")` and `modelBuilder.Entity<T>(e => e.ToTable("x"))`.
      { re: /\.Entity<\s*([\w.]+)\s*>\s*\(\s*(?:\)|\w+\s*=>\s*\w+)\s*\.ToTable\(\s*@?"([^"]*)"/g, entity: 1, table: 2, deferred: true },
      // `Configure(EntityTypeBuilder<T> b) { b.ToTable("x"); }` in an IEntityTypeConfiguration<T>.
      {
        re: /\bConfigure\s*\(\s*EntityTypeBuilder<\s*([\w.]+)\s*>\s+(\w+)\s*\)/g, entity: 1, deferred: true,
        follow: (m) => new RegExp(`\\b${m[2]}\\s*\\.ToTable\\(\\s*@?"([^"]*)"`), followWindow: 4000, followTable: 1,
      },
    ],
    collections: { re: /\bDbSet<\s*([\w.]+)\s*>\s+(\w+)/g, entity: 1, member: 2, convention: 'snake' },
    access: {
      member: {
        [WRITE]: ['Add', 'AddAsync', 'AddRange', 'AddRangeAsync', 'Remove', 'RemoveRange', 'Update', 'UpdateRange', 'Attach'],
        [READ]: ['Find', 'FindAsync', 'Where', 'FirstOrDefault', 'FirstOrDefaultAsync', 'First', 'Single', 'SingleOrDefault', 'ToList', 'ToListAsync', 'Any', 'AnyAsync', 'Count', 'CountAsync', 'Include', 'AsNoTracking', 'Select', 'OrderBy'],
      },
    },
  },
  {
    orm: 'typeorm', languages: [L.TYPESCRIPT, L.JAVASCRIPT],
    entity: { markers: ['Entity'] },
    name: { markers: [{ names: ['Entity'], args: [0] }] },
    convention: 'snake',
    access: {
      static: {
        through: [''],
        [WRITE]: ['create', 'save', 'insert', 'update', 'delete', 'remove'],
        [READ]: ['find', 'findOne', 'findBy', 'findOneBy', 'findAndCount', 'count'],
      },
      arg: {
        [WRITE]: ['save', 'insert', 'update', 'delete', 'remove', 'softDelete', 'upsert'],
        [READ]: ['find', 'findOne', 'findBy', 'findOneBy', 'findAndCount', 'count', 'createQueryBuilder', 'getRepository'],
      },
    },
  },
  {
    orm: 'sequelize', languages: [L.TYPESCRIPT, L.JAVASCRIPT],
    entity: { markers: ['Table'] },
    name: { markers: [{ names: ['Table'], args: [0] }] },
    convention: 'plural',
    texts: [
      // `const Order = sequelize.define('Order', { ... }, { tableName: 'x' })`.
      { re: /(?:\b(\w+)\s*=\s*)?\b\w+\.define\(\s*(['"`])(\w+)\2/g, entity: 1, entityFallback: 3, model: 3, option: 'tableName' },
      // `Order.init({ ... }, { sequelize, tableName: 'x' })`: the options object marks it as a model.
      { re: /\b([A-Z]\w*)\.init\(/g, entity: 1, option: 'tableName', modelOption: 'modelName', requireOption: ['sequelize', 'tableName', 'modelName'] },
    ],
    access: {
      static: {
        through: [''],
        [WRITE]: ['create', 'bulkCreate', 'update', 'destroy', 'upsert', 'findOrCreate', 'increment', 'decrement', 'restore', 'truncate'],
        [READ]: ['findAll', 'findOne', 'findByPk', 'findAndCountAll', 'count', 'max', 'min', 'sum'],
      },
    },
  },
  {
    orm: L.PRISMA, languages: [L.PRISMA], // the ORM and its schema language share a name
    entity: { kinds: ['model'] },
    name: { markers: [{ names: ['map'], args: [0] }] },
    convention: 'as_is',
  },
  {
    orm: 'activerecord', languages: [L.RUBY],
    entity: { bases: ['ApplicationRecord', 'ActiveRecord.Base'] },
    name: { assigns: ['self.table_name'] },
    convention: 'snake_plural',
    access: {
      static: {
        through: [''],
        [WRITE]: ['create', 'create!', 'update', 'update_all', 'update!', 'destroy', 'destroy_all', 'delete', 'delete_all', 'insert', 'insert_all', 'upsert', 'upsert_all', 'find_or_create_by', 'first_or_create'],
        [READ]: ['find', 'find_by', 'where', 'all', 'first', 'last', 'count', 'exists?', 'pluck', 'order', 'joins', 'includes', 'select', 'find_each', 'take'],
      },
    },
  },
  {
    orm: 'gorm', languages: [L.GO],
    entity: {},
    convention: 'snake_plural',
    texts: [
      // `func (Order) TableName() string { return "x" }`
      { re: /\bfunc\s*\(\s*(?:\w+\s+)?\*?\s*(\w+)\s*\)\s*TableName\s*\(\s*\)\s*string\s*\{\s*return\s+"([^"]*)"/g, entity: 1, table: 2 },
      // `type Order struct { gorm.Model ... }`
      { re: /\btype\s+(\w+)\s+struct\s*\{[^}]*?\bgorm\.Model\b/g, entity: 1 },
    ],
    access: {
      arg: {
        [WRITE]: ['Create', 'CreateInBatches', 'Save', 'Delete', 'Update', 'Updates', 'UpdateColumn', 'UpdateColumns'],
        [READ]: ['Find', 'First', 'Take', 'Last', 'Model', 'Where', 'Preload', 'Count'],
      },
    },
  },
  {
    orm: 'doctrine', languages: [L.PHP],
    entity: { markers: ['Entity'] },
    name: { markers: [{ names: ['Table'], args: ['name', 0] }] },
    convention: 'snake',
    access: {
      arg: {
        [WRITE]: ['persist', 'remove', 'merge'],
        [READ]: ['find', 'getRepository', 'getReference'],
      },
    },
  },
  {
    orm: 'eloquent', languages: [L.PHP],
    entity: { bases: ['Model'] },
    name: { assigns: ['$table'] },
    convention: 'snake_plural',
    access: {
      static: {
        through: [''],
        [WRITE]: ['create', 'insert', 'update', 'destroy', 'upsert', 'firstOrCreate', 'updateOrCreate', 'forceCreate', 'insertOrIgnore', 'truncate'],
        [READ]: ['find', 'findOrFail', 'where', 'all', 'first', 'firstOrFail', 'count', 'pluck', 'with', 'get', 'query', 'orderBy', 'paginate', 'exists'],
      },
    },
  },
];

/**
 * How a class-level assignment is written where the structure reader does not give it: the key
 * it is stored under (so a row can name it) and the pattern, with the value in the last group.
 */
export const ASSIGN_SYNTAX = {
  [L.PHP]: { re: /\b(?:public|protected|private)\s+(?:static\s+)?(\$\w+)\s*=\s*(['"])([^'"\n]*)\2/g, key: (m) => m[1] },
  [L.RUBY]: { re: /\bself\.(\w+)\s*=\s*(['"])([^'"\n]+)\2/g, key: (m) => `self.${m[1]}` },
};

/** The marker syntax a language writes ORM mappings in where HTTP routing reads none (PHP 8 `#[...]` attributes). */
export const MARKER_SYNTAX = { [L.PHP]: 'hash' };

/** How a type states its parent where the structure reader truncates it (`< ActiveRecord::Base`). */
export const PARENT_SYNTAX = {
  [L.RUBY]: /^class\s+[\w:]+\s*<\s*([\w:]+)/,
};

export const ormLanguages = (lang) => ORM_SYNTAX.some((r) => r.languages.includes(lang));
export const ormRowsFor = (lang) => ORM_SYNTAX.filter((r) => r.languages.includes(lang));
const rowOf = (orm) => ORM_SYNTAX.find((r) => r.orm === orm);

// --------------------------------------------------------------------------- literals

/** The value of one string literal as written (`"x"`, `'x'`, `@"x"`, `` `x` ``), else null. */
export function unquote(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  const m = /^@?"((?:[^"\\\n]|\\.)*)"$/s.exec(t) ?? /^'((?:[^'\\\n]|\\.)*)'$/s.exec(t) ?? /^`([^`]*)`$/s.exec(t);
  return m ? m[1] : null;
}

function markerArg(marker, keys) {
  for (const k of keys) {
    const raw = typeof k === 'number' ? marker.args?.positional?.[k] : marker.args?.named?.[k];
    const v = unquote(raw);
    if (v) return v;
  }
  return null;
}

/** The text between the parenthesis that opened just before `from` and its match (strings respected). */
export function argsAfter(text, from, limit = 4000) {
  let depth = 1;
  let quote = null;
  const end = Math.min(text.length, from + limit);
  for (let i = from; i < end; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return text.slice(from, i); }
  }
  return text.slice(from, end);
}

// --------------------------------------------------------------------------- the pass

const norm = (b) => String(b).replace(/<.*$/s, '').replace(/::|\\/g, '.').trim();

function baseMatches(spec, base, imports) {
  const b = norm(base);
  const name = typeof spec === 'string' ? spec : spec.name;
  if (b !== name && !b.endsWith(`.${name}`)) return false;
  return typeof spec === 'string' || !spec.imports || spec.imports.some((i) => imports.includes(i));
}

/** The trigger that makes `t` an entity of `row`: a marker, or a plain label, or null. */
function triggerOf(row, t, view) {
  const e = row.entity ?? {};
  if (e.skipWhen?.some((k) => t.assigns?.[k]?.value === true)) return null;
  const marker = e.markers ? t.markers?.find((m) => e.markers.includes(m.name)) : null;
  if (marker) return { marker };
  if (e.bases?.some((spec) => (t.bases ?? []).some((b) => baseMatches(spec, b, view.imports ?? [])))) return {};
  if (e.assigns?.some((k) => t.assigns?.[k] !== undefined)) return {};
  if (e.embeds?.some((n) => (t.embeds ?? []).includes(n))) return {};
  if (e.kinds?.includes(t.kind)) return {};
  return null;
}

function explicitName(row, t) {
  for (const spec of row.name?.markers ?? []) {
    const m = t.markers?.find((x) => spec.names.includes(x.name));
    const v = m ? markerArg(m, spec.args) : null;
    if (v) return { value: v, from: 'marker' };
  }
  for (const k of row.name?.assigns ?? []) {
    const a = t.assigns?.[k];
    if (a && typeof a.value === 'string' && a.value) return { value: a.value, from: 'assign', line: a.line };
  }
  return null;
}

/**
 * The one pass. `view` is what an adapter read from a file:
 *   lang, path, imports (module names, `module.name` for a name imported from it), lineOf(offset),
 *   matches(re) (matches of a global pattern over the file's code, so strings and comments cannot
 *   fool it), text (the same code, for argument lists),
 *   types: [{ name, ref, line, kind, bases, markers: [{ name, args: { positional, named }, line }],
 *             assigns: { key: { value, line } }, embeds }]
 * @returns {{ mappings: object[], members: object[] }} each mapping is { orm, entity, ref, table,
 *   basis, line, deferred? } and each member { orm, entity, member } (a collection that exposes an entity)
 */
export function mapEntities(view) {
  const mappings = [];
  const members = [];
  const claimed = new Set();
  for (const row of ORM_SYNTAX) {
    if (!row.languages.includes(view.lang)) continue;
    const seen = new Set(mappings.filter((m) => m.orm === row.orm).map((m) => lastName(m.entity)));
    const conv = (name) => CONVENTIONS[row.convention](name, view);
    const push = (m) => {
      const key = lastName(m.entity);
      if (seen.has(key)) return;
      seen.add(key);
      mappings.push({ orm: row.orm, ...m });
    };
    const claim = (t, m) => { claimed.add(t); push({ ...m, ref: t.ref }); };
    for (const t of view.types ?? []) {
      if (claimed.has(t)) continue;
      const trig = triggerOf(row, t, view);
      if (!trig) continue;
      const named = explicitName(row, t);
      if (named) {
        const line = named.from === 'assign' ? named.line ?? t.line : trig.marker?.line ?? t.line;
        claim(t, { entity: t.name, table: named.value, basis: 'declared', line });
      } else {
        claim(t, { entity: t.name, table: conv(t.name), basis: 'convention', line: trig.marker?.line ?? t.line });
      }
    }
    for (const tx of row.texts ?? []) {
      for (const m of view.matches?.(tx.re) ?? []) {
        const found = m[tx.entity] ?? m[tx.entityFallback];
        if (!found) continue;
        const entity = lastName(found);
        let table = tx.table ? m[tx.table] : null;
        let line = view.lineOf(m.index);
        const after = m.index + m[0].length;
        if (tx.follow) {
          const win = view.text.slice(after, after + tx.followWindow);
          const f = tx.follow(m).exec(win);
          if (f) { table = f[tx.followTable]; line = view.lineOf(after + f.index); }
        }
        if (tx.option || tx.requireOption) {
          const args = argsAfter(view.text, after);
          const opt = (key) => new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`\\n]+)\\1`).exec(args)?.[2];
          if (tx.requireOption && !tx.requireOption.some((k) => new RegExp(`\\b${k}\\b`).test(args))) continue;
          if (!table && tx.option) table = opt(tx.option) ?? null;
          if (!table && tx.modelOption) {
            const model = opt(tx.modelOption);
            if (model) { push({ entity, table: conv(model), basis: 'convention', line, deferred: tx.deferred }); continue; }
          }
        }
        if (table) push({ entity, table, basis: 'declared', line, deferred: tx.deferred });
        else if (!tx.follow) push({ entity, table: conv(tx.model ? m[tx.model] : entity), basis: 'convention', line, deferred: tx.deferred });
      }
    }
    if (row.collections) {
      const c = row.collections;
      for (const m of view.matches?.(c.re) ?? []) {
        const entity = lastName(m[c.entity]);
        members.push({ orm: row.orm, entity, member: m[c.member] });
        if (seen.has(entity)) continue;
        push({ entity, table: CONVENTIONS[c.convention](m[c.member], view), basis: 'convention', line: view.lineOf(m.index) });
      }
    }
  }
  return { mappings, members };
}

/**
 * The facts every mapping states, the same for every ORM: the table node, marked with how its
 * name was found, and the owning edge from the module that maps it.
 * @param {object} m a mapping from mapEntities
 * @param {{ key: string, spec: { name: string, path?: string, attrs: object }, from?: string,
 *   edgeAttrs?: object, pv: object }} o `from` is omitted when the owner is found at link time
 */
export function tableFacts(m, o) {
  const attrs = m.basis === 'convention' ? { ...o.spec.attrs, table_name_basis: 'convention' } : o.spec.attrs;
  const out = [nodeFact('table', o.key, { ...o.spec, attrs }, o.pv)];
  if (o.from) out.push(edgeFact('OWNS_DATA', o.from, `table:${o.key}`, o.edgeAttrs ?? { orm: m.orm }, o.pv));
  return out;
}

// --------------------------------------------------------------------------- access

const ALL_VERBS = new Set();
for (const row of ORM_SYNTAX) {
  for (const shape of Object.values(row.access ?? {})) for (const k of [WRITE, READ]) for (const v of shape[k] ?? []) ALL_VERBS.add(v);
}

const SEP = /\s*(?:\?\.|\.|::|->)\s*/;
const CHAIN = /([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.|::|->)\s*[A-Za-z_$][\w$]*[!?]?)+)(\s*\()?/g;
const ARG = /^\s*(?:&|new\s+)?(?:\(\s*)?([A-Z]\w*)(?=\s*[({),]|\.class\b|::class\b|\s*$)/;
const MAX_ACCESS = 400;

/**
 * Calls in `text` that could reach a mapped type, without knowing which types are mapped (they
 * may be declared in another file): `{ n, v, via, l }` is a call of verb `v` on name `n`, `via`
 * being the path between them, '@arg' when `n` is the call's argument and '@member' when `n` is
 * the member the call is made on. link resolves them with `ormAccess`.
 */
export function accessCandidates(text, lang, lineOf) {
  if (!ormLanguages(lang)) return [];
  const parenless = lang === L.RUBY;
  const out = [];
  const seen = new Set();
  const add = (n, v, via, off) => {
    const k = `${n}|${v}|${via}`;
    if (seen.has(k) || out.length >= MAX_ACCESS) return;
    seen.add(k);
    out.push({ n, v, via, l: lineOf(off) });
  };
  CHAIN.lastIndex = 0;
  for (const m of text.matchAll(CHAIN)) {
    if (!m[2] && !parenless) continue;
    const segs = m[1].split(SEP);
    const v = segs[segs.length - 1];
    if (!ALL_VERBS.has(v)) continue;
    if (/^[A-Z]/.test(segs[0])) add(segs[0], v, segs.slice(1, -1).join('.'), m.index);
    if (segs.length >= 2 && /^[A-Z]/.test(segs[segs.length - 2])) add(segs[segs.length - 2], v, '@member', m.index);
    if (m[2]) {
      const arg = ARG.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 120));
      if (arg) add(arg[1], v, '@arg', m.index);
    }
  }
  return out;
}

/** The link-only module attributes this rule uses; link removes them so they are never persisted. */
export function ormAttrs(entities, members, access) {
  const out = {};
  if (entities.length) out.orm_entities = entities;
  if (members.length) out.orm_members = members;
  if (access.length) out.orm_access = access;
  return out;
}

/**
 * Edges for modules that reach a table through a mapped type. `factsByFile` is the adapters'
 * per-file facts (module attrs `orm_entities`, `orm_members`, `orm_access` are read and removed).
 * A name that maps to several tables resolves only inside the file that declares it.
 * @returns {object[]} MUTATES and QUERIES edges from the module to the table
 */
export function ormAccess(factsByFile, extractorPrefix, pv) {
  const own = (f) => String(f.provenance?.extractor ?? '').startsWith(extractorPrefix);
  const entities = new Map(); // entity name -> [{ path, id, orm }]
  const members = new Map(); // member name -> [entity name]
  const users = [];
  for (const [path, facts] of factsByFile) {
    for (const f of facts) {
      if (f.kind !== 'node' || f.type !== 'module' || !own(f)) continue;
      const a = f.attrs;
      for (const e of a.orm_entities ?? []) {
        if (!entities.has(e.n)) entities.set(e.n, []);
        entities.get(e.n).push({ path, id: e.t, orm: e.o });
      }
      for (const m of a.orm_members ?? []) {
        if (!members.has(m.n)) members.set(m.n, []);
        members.get(m.n).push(m.e);
      }
      if (a.orm_access?.length) users.push({ path, access: a.orm_access });
      delete a.orm_entities;
      delete a.orm_members;
      delete a.orm_access;
    }
  }
  const pick = (name, path) => {
    const all = entities.get(name) ?? [];
    const here = all.filter((e) => e.path === path);
    const ids = new Set((here.length ? here : all).map((e) => e.id));
    return ids.size === 1 ? (here.length ? here : all)[0] : null;
  };
  const out = [];
  const done = new Set();
  for (const { path, access } of users) {
    for (const c of access) {
      let hit = null;
      let shape = null;
      if (c.via === '@member') {
        const names = [...new Set(members.get(c.n) ?? [])];
        const entity = names.length === 1 ? pick(names[0], path) : null;
        if (entity) { hit = entity; shape = 'member'; }
      } else {
        hit = pick(c.n, path);
        shape = c.via === '@arg' ? 'arg' : 'static';
      }
      const row = hit ? rowOf(hit.orm) : null;
      const spec = row?.access?.[shape];
      if (!spec || (shape === 'static' && !spec.through.includes(c.via))) continue;
      const type = spec[WRITE]?.includes(c.v) ? 'MUTATES' : spec[READ]?.includes(c.v) ? 'QUERIES' : null;
      if (!type) continue;
      const key = `${type}|${path}|${hit.id}`;
      if (done.has(key)) continue;
      done.add(key);
      out.push(edgeFact(type, `module:${path}`, `table:${hit.id}`, { via: 'orm', orm: hit.orm, entity: c.n, kind: c.v, line: c.l }, pv(path, c.l)));
    }
  }
  return out;
}
