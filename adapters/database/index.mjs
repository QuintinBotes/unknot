// Database adapter (spec §14): turns DDL, migration files, ORM schema files and exported
// catalog metadata into graph facts. It never connects to a database and never executes
// SQL; everything is parsed text. Catalog access is by user-exported files only (§14.3).

import { nodeFact, edgeFact, prov } from '../../runtime/graph/facts.mjs';
import { parseSql } from './sql/parser.mjs';
import { analyzeMigration, detectFramework, alembicOrder, readSchemaRb, padVersion } from './migrations.mjs';
import { normalizeEngine } from './forecast.mjs';

const ID = 'database';
const VERSION = '0.1.0';
const EXTRACTOR = `${ID}@${VERSION}`;
const MAX_FACTS = 5000;
const NO_SCHEMA_ENGINES = new Set(['mysql', 'mariadb', 'sqlite']);

const posix = (p) => String(p).replace(/\\/g, '/');
const baseName = (p) => posix(p).split('/').pop();
const dirName = (p) => posix(p).split('/').slice(0, -1).join('/');

// ---------------------------------------------------------------- naming

/** Schema used when a name is unqualified: `public` for PostgreSQL, none for MySQL/SQLite. */
export function defaultSchema(engine) {
  return NO_SCHEMA_ENGINES.has(normalizeEngine(engine)) ? null : 'public';
}

/**
 * Canonical table key. Unquoted identifiers were already folded to lower case by the
 * parser, so `Orders` and `orders` collapse; quoted identifiers keep their case.
 */
export function tableKey(ref, engine) {
  if (!ref || !ref.name) return null;
  const schema = ref.schema ?? defaultSchema(engine);
  return schema ? `${schema}.${ref.name}` : ref.name;
}

/** Normalise an id like `table:orders` to `table:public.orders`; other ids pass through. */
export function normalizeTableId(id, engine) {
  const m = /^table:(.+)$/.exec(id);
  if (!m || m[1].includes('.')) return id;
  const schema = defaultSchema(engine);
  return schema ? `table:${schema}.${m[1].toLowerCase()}` : id;
}

function constraintName(k, table) {
  if (k.name) return k.name;
  const cols = k.columns.join('_');
  switch (k.kind) {
    case 'primary_key': return `${table}_pkey`;
    case 'unique': return `${table}_${cols}_key`;
    case 'foreign_key': return `${table}_${cols}_fkey`;
    case 'check': return `${table}_${cols || 'expr'}_check`;
    default: return `${table}_${cols}_excl`;
  }
}

// ---------------------------------------------------------------- fact collection

class Facts {
  constructor(path) {
    this.path = path;
    this.map = new Map();
    this.truncated = false;
  }

  add(f) {
    const key = f.kind === 'node' ? f.id : `${f.type}|${f.from}|${f.to}`;
    if (this.map.has(key)) return;
    if (this.map.size >= MAX_FACTS) { this.truncated = true; return; }
    this.map.set(key, f);
  }

  list() {
    const out = [...this.map.values()];
    if (this.truncated) {
      out.push(nodeFact('file', this.path, { path: this.path, attrs: { truncated: true, cap: MAX_FACTS } }, prov({ source_type: 'ast', source_ref: this.path, extractor: EXTRACTOR, confidence: 'high' })));
    }
    return out;
  }
}

/** Emit facts for parsed DDL. `p(line)` builds provenance for a statement line. */
function emitDdl(F, parsed, { engine, p, migrationId, path }) {
  const tk = (ref) => tableKey(ref, engine);
  const touched = new Set();

  const tableNode = (ref, attrs = {}, line) => {
    const key = tk(ref);
    if (!key) return null;
    F.add(nodeFact('table', key, { name: ref.name, path, attrs: { engine: engine ?? null, ...attrs } }, p(line)));
    touched.add(key);
    return key;
  };

  const columnNode = (key, col, line) => {
    F.add(nodeFact('column', `${key}.${col.name}`, {
      name: col.name, path,
      attrs: {
        type: col.type, nullable: col.nullable, default: col.default?.expr ?? null, default_volatile: col.default?.volatile ?? false,
        identity: col.identity, generated: col.generated?.expr ?? null, collation: col.collation,
      },
    }, p(line)));
    F.add(edgeFact('CONTAINS', `table:${key}`, `column:${key}.${col.name}`, {}, p(line)));
  };

  const constraintNode = (key, tableName, k, line) => {
    const name = constraintName(k, tableName);
    F.add(nodeFact('constraint', `${key}.${name}`, {
      name, path,
      attrs: { kind: k.kind, columns: k.columns, expr: k.expr, not_valid: k.not_valid, deferrable: k.deferrable, references: k.ref_table ? tk(k.ref_table) : null, using_index: k.using_index },
    }, p(line)));
    F.add(edgeFact('CONTAINS', `table:${key}`, `constraint:${key}.${name}`, {}, p(line)));
    if (k.kind === 'foreign_key' && k.ref_table) {
      const to = tableNode(k.ref_table, {}, line);
      F.add(edgeFact('REFERENCES', `table:${key}`, `table:${to}`, { columns: k.columns, ref_columns: k.ref_columns, on_delete: k.on_delete ?? 'NO ACTION', on_update: k.on_update ?? 'NO ACTION', constraint: name, not_valid: k.not_valid }, p(line)));
    }
  };

  const indexNode = (tableRef, st, line) => {
    const key = tableNode(tableRef, {}, line);
    if (!key) return;
    const schema = tableRef.schema ?? defaultSchema(engine);
    const cols = (st.columns ?? []).map((c) => (typeof c === 'string' ? c : c.name ?? c.expr));
    const name = st.name ?? `${tableRef.name}_${cols.join('_')}_idx`;
    const id = `${schema ? `${schema}.` : ''}${name}`;
    F.add(nodeFact('index', id, { name, path, attrs: { table: key, unique: Boolean(st.unique), method: st.method ?? null, columns: cols, where: st.where ?? null, concurrently: Boolean(st.concurrently), fulltext: Boolean(st.fulltext) } }, p(line)));
    F.add(edgeFact('INDEXED_BY', `table:${key}`, `index:${id}`, { unique: Boolean(st.unique) }, p(line)));
  };

  for (const st of parsed) {
    const line = st.line;
    switch (st.kind) {
      case 'create_table': {
        const key = tableNode(st.table, { partitioned: Boolean(st.partition_by), partition_by: st.partition_by, temporary: st.temporary, unlogged: st.unlogged }, line);
        if (!key) break;
        for (const c of st.columns) columnNode(key, c, line);
        for (const k of st.constraints) constraintNode(key, st.table.name, k, line);
        for (const ix of st.indexes) indexNode(st.table, { ...ix, columns: ix.columns }, line);
        if (st.partition_of) {
          const parent = tableNode(st.partition_of, {}, line);
          F.add(edgeFact('CONTAINS', `table:${parent}`, `table:${key}`, { partition: true }, p(line)));
        }
        for (const src of st.source_tables) {
          const sk = tableNode(src, {}, line);
          F.add(edgeFact('DERIVED_FROM', `table:${key}`, `table:${sk}`, { via: 'create_table_as' }, p(line)));
        }
        break;
      }
      case 'alter_table': {
        const key = tableNode(st.table, {}, line);
        if (!key) break;
        for (const a of st.actions) {
          if (a.action === 'add_column') {
            columnNode(key, a.column, line);
            for (const k of a.column.constraints) constraintNode(key, st.table.name, k, line);
          } else if (a.action === 'add_constraint') constraintNode(key, st.table.name, a.constraint, line);
          else if (a.action === 'add_index') indexNode(st.table, { name: a.name, columns: a.columns, fulltext: a.fulltext }, line);
          else if (a.action === 'row_level_security') tableNode(st.table, { rls: a.mode }, line);
          else if (a.action === 'attach_partition' && a.partition) {
            const child = tableNode(a.partition, {}, line);
            F.add(edgeFact('CONTAINS', `table:${key}`, `table:${child}`, { partition: true }, p(line)));
          }
        }
        break;
      }
      case 'create_index': if (st.table) indexNode(st.table, st, line); break;
      case 'create_view': {
        if (!st.name) break;
        const schema = st.name.schema ?? defaultSchema(engine);
        const id = `${schema ? `${schema}.` : ''}${st.name.name}`;
        F.add(nodeFact('view', id, { name: st.name.name, path, attrs: { materialized: st.materialized, with_no_data: st.with_no_data } }, p(line)));
        for (const src of st.sources) {
          const sk = tableNode(src, {}, line);
          F.add(edgeFact('DERIVED_FROM', `view:${id}`, `table:${sk}`, {}, p(line)));
        }
        break;
      }
      case 'create_trigger': {
        const key = st.table ? tableNode(st.table, {}, line) : null;
        if (!key || !st.name) break;
        const id = `${key}.${st.name}`;
        F.add(nodeFact('trigger', id, { name: st.name, path, attrs: { timing: st.timing, events: st.events, function: st.function?.name ?? null } }, p(line)));
        F.add(edgeFact('CONTAINS', `table:${key}`, `trigger:${id}`, {}, p(line)));
        if (st.function) {
          const schema = st.function.schema ?? defaultSchema(engine);
          F.add(edgeFact('DEPENDS_ON', `trigger:${id}`, `routine:${schema ? `${schema}.` : ''}${st.function.name}`, {}, p(line)));
        }
        break;
      }
      case 'create_function': {
        if (!st.name) break;
        const schema = st.name.schema ?? defaultSchema(engine);
        F.add(nodeFact('routine', `${schema ? `${schema}.` : ''}${st.name.name}`, { name: st.name.name, path, attrs: { routine: st.routine, language: st.language } }, p(line)));
        break;
      }
      case 'create_sequence': {
        if (!st.name) break;
        const schema = st.name.schema ?? defaultSchema(engine);
        F.add(nodeFact('sequence', `${schema ? `${schema}.` : ''}${st.name.name}`, { name: st.name.name, path }, p(line)));
        break;
      }
      case 'create_type': {
        if (!st.name) break;
        const schema = st.name.schema ?? defaultSchema(engine);
        F.add(nodeFact('type', `${schema ? `${schema}.` : ''}${st.name.name}`, { name: st.name.name, path, attrs: { variant: st.variant, values: st.values } }, p(line)));
        break;
      }
      case 'create_policy': {
        const key = st.table ? tableNode(st.table, {}, line) : null;
        if (!key) break;
        F.add(nodeFact('policy', `${key}.${st.name}`, { name: st.name, path, attrs: { command: st.command, roles: st.roles } }, p(line)));
        F.add(edgeFact('CONTAINS', `table:${key}`, `policy:${key}.${st.name}`, {}, p(line)));
        break;
      }
      case 'create_role': if (st.name) F.add(nodeFact('db_role', st.name, { name: st.name, path }, p(line))); break;
      case 'grant': {
        if (st.role_membership) break;
        for (const role of st.roles) {
          F.add(nodeFact('db_role', role, { name: role, path }, p(line)));
          if (st.all_in_schema) {
            F.add(nodeFact('schema', st.all_in_schema, { name: st.all_in_schema, path }, p(line)));
            F.add(edgeFact('AUTHORIZED_FOR', `db_role:${role}`, `schema:${st.all_in_schema}`, { privileges: st.privileges, scope: `all ${st.object_type}` }, p(line)));
            continue;
          }
          if (st.object_type !== 'table') continue;
          for (const o of st.objects) {
            const key = tableNode(o, {}, line);
            F.add(nodeFact('grant', `${role}:${key}`, { name: `${role} on ${key}`, path, attrs: { privileges: st.privileges, with_grant_option: Boolean(st.with_grant_option) } }, p(line)));
            F.add(edgeFact('AUTHORIZED_FOR', `db_role:${role}`, `table:${key}`, { privileges: st.privileges, with_grant_option: Boolean(st.with_grant_option) }, p(line)));
          }
        }
        break;
      }
      default: break;
    }
  }

  // MIGRATES: every table a migration statement touches, including DML targets.
  if (migrationId) {
    for (const st of parsed) {
      const refs = [];
      if (st.table) refs.push(st.table);
      if (st.tables) refs.push(...st.tables);
      if (st.indexes && st.table) refs.push(st.table);
      for (const r of refs) {
        const key = tk(r);
        if (!key) continue;
        F.add(nodeFact('table', key, { name: r.name, path, attrs: { engine: engine ?? null } }, p(st.line)));
        touched.add(key);
      }
    }
    for (const key of [...touched].sort()) F.add(edgeFact('MIGRATES', migrationId, `table:${key}`, {}, p(null)));
  }
}

// ---------------------------------------------------------------- Prisma

const PRISMA_TYPES = { Int: 'integer', String: 'text', BigInt: 'bigint', Boolean: 'boolean', DateTime: 'timestamp(3)', Json: 'jsonb', Float: 'double precision', Decimal: 'decimal(65,30)', Bytes: 'bytea' };

function extractPrisma(text, path, F, optsEngine) {
  const provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/s.exec(text)?.[1] ?? null;
  const engine = optsEngine ?? (provider === 'sqlserver' || provider === 'cockroachdb' ? 'postgresql' : provider) ?? 'postgresql';
  if (provider === 'mongodb') return;
  const enums = new Set([...text.matchAll(/^\s*enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  const models = [];
  const re = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
  let m;
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split('\n').length + 1;
    const body = m[2];
    const map = /@@map\("([^"]+)"\)/.exec(body)?.[1];
    const schema = /@@schema\("([^"]+)"\)/.exec(body)?.[1];
    models.push({ name: m[1], table: map ?? m[1], schema, body, line });
  }
  const byModel = new Map(models.map((x) => [x.name, x]));
  const p = (line, confidence = 'high') => prov({ source_type: 'config', source_ref: `${path}:${line ?? 1}`, extractor: EXTRACTOR, confidence });
  const keyOf = (mod) => tableKey({ schema: mod.schema ?? null, name: mod.table }, engine);

  for (const mod of models) {
    const key = keyOf(mod);
    F.add(nodeFact('table', key, { name: mod.table, path, attrs: { engine, orm: 'prisma', model: mod.name } }, p(mod.line)));
    const fieldRe = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?([^\n]*)$/gm;
    let f;
    while ((f = fieldRe.exec(mod.body))) {
      const [, fname, ftype, list, opt, rest] = f;
      if (fname.startsWith('@')) continue;
      const rel = /@relation\(([^)]*)\)/.exec(rest);
      const target = byModel.get(ftype);
      if (target) {
        if (!rel) continue;
        const cols = /fields:\s*\[([^\]]*)\]/.exec(rel[1])?.[1];
        if (!cols) continue; // the referenced side of the relation
        const refs = /references:\s*\[([^\]]*)\]/.exec(rel[1])?.[1] ?? '';
        const onDelete = /onDelete:\s*(\w+)/.exec(rel[1])?.[1];
        F.add(edgeFact('REFERENCES', `table:${key}`, `table:${keyOf(target)}`, { columns: cols.split(',').map((x) => x.trim()), ref_columns: refs.split(',').map((x) => x.trim()), on_delete: onDelete ?? 'NO ACTION', constraint: `${mod.table}_${cols.trim()}_fkey` }, p(mod.line)));
        continue;
      }
      if (list) continue;
      const colName = /@map\("([^"]+)"\)/.exec(rest)?.[1] ?? fname;
      const dflt = /@default\(([^)]*(?:\([^)]*\))?[^)]*)\)/.exec(rest)?.[1] ?? null;
      F.add(nodeFact('column', `${key}.${colName}`, { name: colName, path, attrs: { type: PRISMA_TYPES[ftype] ?? (enums.has(ftype) ? ftype.toLowerCase() : ftype), nullable: Boolean(opt), default: dflt, field: fname, primary_key: /@id\b/.test(rest) } }, p(mod.line)));
      F.add(edgeFact('CONTAINS', `table:${key}`, `column:${key}.${colName}`, {}, p(mod.line)));
      if (/@unique\b/.test(rest)) {
        const cn = `${mod.table}_${colName}_key`;
        F.add(nodeFact('constraint', `${key}.${cn}`, { name: cn, path, attrs: { kind: 'unique', columns: [colName] } }, p(mod.line)));
        F.add(edgeFact('CONTAINS', `table:${key}`, `constraint:${key}.${cn}`, {}, p(mod.line)));
      }
    }
    for (const ix of mod.body.matchAll(/@@(index|unique)\(\s*\[([^\]]*)\]/g)) {
      const cols = ix[2].split(',').map((x) => x.trim().replace(/\(.*$/, ''));
      const schema = mod.schema ?? defaultSchema(engine);
      const name = `${mod.table}_${cols.join('_')}_${ix[1] === 'unique' ? 'key' : 'idx'}`;
      F.add(nodeFact('index', `${schema ? `${schema}.` : ''}${name}`, { name, path, attrs: { table: key, unique: ix[1] === 'unique', columns: cols } }, p(mod.line)));
      F.add(edgeFact('INDEXED_BY', `table:${key}`, `index:${schema ? `${schema}.` : ''}${name}`, { unique: ix[1] === 'unique' }, p(mod.line)));
    }
  }
}

// ---------------------------------------------------------------- Atlas HCL

function extractAtlasHcl(text, path, F, optsEngine) {
  const engine = optsEngine ?? 'postgresql';
  const p = (line) => prov({ source_type: 'config', source_ref: `${path}:${line ?? 1}`, extractor: EXTRACTOR, confidence: 'medium' });
  const block = (src, start) => {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start + 1, i); }
    }
    return src.slice(start + 1);
  };
  const re = /^table\s+"([^"]+)"\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    const body = block(text, m.index + m[0].length - 1);
    const line = text.slice(0, m.index).split('\n').length;
    const schema = /schema\s*=\s*schema\.(\w+)/.exec(body)?.[1] ?? null;
    const key = tableKey({ schema, name: m[1] }, engine);
    F.add(nodeFact('table', key, { name: m[1], path, attrs: { engine, orm: 'atlas' } }, p(line)));
    const cre = /column\s+"([^"]+)"\s*\{/g;
    let c;
    while ((c = cre.exec(body))) {
      const cb = block(body, c.index + c[0].length - 1);
      F.add(nodeFact('column', `${key}.${c[1]}`, { name: c[1], path, attrs: { type: /type\s*=\s*([^\n]+)/.exec(cb)?.[1]?.trim() ?? null, nullable: !/null\s*=\s*false/.test(cb) } }, p(line)));
      F.add(edgeFact('CONTAINS', `table:${key}`, `column:${key}.${c[1]}`, {}, p(line)));
    }
    const ire = /index\s+"([^"]+)"\s*\{/g;
    let ix;
    while ((ix = ire.exec(body))) {
      const ib = block(body, ix.index + ix[0].length - 1);
      const cols = [...(/columns\s*=\s*\[([^\]]*)\]/.exec(ib)?.[1] ?? '').matchAll(/column\.(\w+)/g)].map((x) => x[1]);
      const id = `${schema ?? defaultSchema(engine) ?? ''}${(schema ?? defaultSchema(engine)) ? '.' : ''}${ix[1]}`;
      F.add(nodeFact('index', id, { name: ix[1], path, attrs: { table: key, unique: /unique\s*=\s*true/.test(ib), columns: cols } }, p(line)));
      F.add(edgeFact('INDEXED_BY', `table:${key}`, `index:${id}`, {}, p(line)));
    }
    const fre = /foreign_key\s+"([^"]+)"\s*\{/g;
    let fk;
    while ((fk = fre.exec(body))) {
      const fb = block(body, fk.index + fk[0].length - 1);
      const refT = /ref_columns\s*=\s*\[table\.(\w+)\.column\.(\w+)/.exec(fb);
      if (!refT) continue;
      F.add(edgeFact('REFERENCES', `table:${key}`, `table:${tableKey({ schema, name: refT[1] }, engine)}`, { columns: [...(/columns\s*=\s*\[([^\]]*)\]/.exec(fb)?.[1] ?? '').matchAll(/column\.(\w+)/g)].map((x) => x[1]), ref_columns: [refT[2]], on_delete: /on_delete\s*=\s*(\w+)/.exec(fb)?.[1] ?? 'NO_ACTION', constraint: fk[1] }, p(line)));
    }
  }
}

// ---------------------------------------------------------------- extract

function extract(file, text, ctx) {
  const path = posix(file.path);
  const options = ctx?.options ?? {};
  const F = new Facts(path);
  const name = baseName(path);
  const p = (line, confidence = 'high', source_type = 'ast') => prov({ source_type, source_ref: `${path}:${line ?? 1}`, extractor: EXTRACTOR, confidence });

  if (name === 'schema.prisma') { extractPrisma(text, path, F, options.engine); return F.list(); }
  if (/\.hcl$/.test(name)) { extractAtlasHcl(text, path, F, options.engine); return F.list(); }
  if (/(?:^|\/)db\/schema\.rb$/.test(path)) {
    const engine = options.engine ?? 'postgresql';
    emitDdl(F, readSchemaRb(text, engine), { engine, p: (l) => p(l, 'medium', 'inference'), migrationId: null, path });
    return F.list();
  }

  const mig = analyzeMigration(path, text, options);
  if (mig) {
    if (mig.extra?.direction === 'down') return []; // undo/down files are resolved against their up file in link()
    const dsl = !['flyway', 'golang-migrate', 'prisma', 'sql'].includes(mig.framework);
    const migrationId = `migration:${path}`;
    const attrs = {
      framework: mig.framework, version: mig.version, order_key: mig.order_key, has_down: mig.has_down,
      statements: mig.statements, destructive: mig.destructive, irreversible: mig.irreversible,
      engine: mig.engine, description: mig.description, no_transaction: mig.no_transaction,
      kind: mig.kind ?? null, ...(mig.extra ?? {}),
    };
    if (mig.framework === 'flyway' || mig.framework === 'golang-migrate') attrs.down_resolved_in_link = true;
    F.add(nodeFact('migration', path, { name: baseName(path), path, attrs }, p(1, dsl ? 'medium' : 'high', dsl ? 'inference' : 'ast')));
    emitDdl(F, mig.parsed, { engine: mig.engine ?? options.engine ?? null, p: (l) => p(l, dsl ? 'medium' : 'high', dsl ? 'inference' : 'ast'), migrationId, path });
    return F.list();
  }

  if (/\.sql$/i.test(name)) {
    const engine = options.engine ?? null;
    emitDdl(F, parseSql(text, { dialect: engine ?? 'postgresql' }), { engine, p: (l) => p(l), migrationId: null, path });
    return F.list();
  }
  return [];
}

// ---------------------------------------------------------------- link

function link(ctx) {
  const out = new Map();
  const options = ctx?.options ?? {};
  const engine = options.engine ?? 'postgresql';
  const add = (f) => {
    const key = f.kind === 'node' ? f.id : `${f.type}|${f.from}|${f.to}|${f.attrs?.line ?? ''}|${f.attrs?.kind ?? ''}`;
    if (!out.has(key)) out.set(key, f);
  };
  const paths = [...(ctx.files?.keys?.() ?? [])].map(posix).sort();
  const migNodes = [];

  const files = [...(ctx.factsByFile ?? new Map()).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [file, facts] of files) {
    const p = (line, confidence = 'medium') => prov({ source_type: 'inference', source_ref: `${file}:${line ?? 1}`, extractor: EXTRACTOR, confidence });
    for (const f of facts) {
      if (f.kind === 'node' && f.type === 'migration' && f.provenance?.extractor === EXTRACTOR) migNodes.push(f);

      if (f.kind === 'node' && f.type === 'module' && Array.isArray(f.attrs?.sql)) {
        for (const entry of f.attrs.sql) {
          const text = typeof entry === 'string' ? entry : entry?.text;
          const line = typeof entry === 'object' ? entry.line ?? null : null;
          if (!text) continue;
          for (const st of parseSql(text, { dialect: engine })) {
            const ref = (t) => tableKey(t, engine);
            const stub = (key) => add(nodeFact('table', key, { name: key.split('.').pop(), attrs: { inferred_from_code: true } }, p(line, 'low')));
            for (const r of st.reads ?? []) {
              const key = ref(r);
              if (!key) continue;
              stub(key);
              add(edgeFact('QUERIES', f.id, `table:${key}`, { line, kind: 'select', has_where: Boolean(st.has_where), via: 'raw_sql' }, p(line)));
            }
            if (st.kind === 'select') {
              // select reads are already covered above
            } else if (['insert', 'update', 'delete', 'merge'].includes(st.kind) && st.table) {
              const key = ref(st.table);
              stub(key);
              add(edgeFact('MUTATES', f.id, `table:${key}`, { line, kind: st.kind, has_where: Boolean(st.has_where), via: 'raw_sql' }, p(line)));
            }
            for (const j of st.joins ?? []) {
              const a = ref(j.left);
              const b = ref(j.right);
              if (!a || !b || a === b) continue;
              const [x, y] = a < b ? [a, b] : [b, a];
              stub(x); stub(y);
              add(edgeFact('JOINS_WITH', `table:${x}`, `table:${y}`, { line, kind: 'join', symmetric: true, module: f.id }, p(line)));
            }
          }
        }
      }

      // Language-adapter ORM tables use `table:<name>`; ours are schema-qualified.
      if (f.kind === 'node' && f.type === 'table' && f.provenance?.extractor !== EXTRACTOR && !f.id.slice(6).includes('.')) {
        const canon = normalizeTableId(f.id, engine);
        if (canon !== f.id) add(nodeFact('table', canon.slice(6), { name: f.name, path: f.path, attrs: { ...f.attrs, aliases: [f.id] } }, p(f.provenance?.source_ref?.split(':')[1], 'medium')));
      }
      if (f.kind === 'edge' && f.provenance?.extractor !== EXTRACTOR && /^table:[^.]+$/.test(f.to) && ['OWNS_DATA', 'READS', 'WRITES', 'QUERIES', 'MUTATES'].includes(f.type)) {
        const canon = normalizeTableId(f.to, engine);
        if (canon !== f.to) add(edgeFact(f.type, f.from, canon, { ...f.attrs, aliases: [f.to] }, p(null)));
      }
    }
  }

  // Cross-file migration facts: undo files, down pairs, Alembic chain order, Atlas dirs.
  const infos = paths.map((pth) => ({ path: pth, info: detectFramework(pth) })).filter((x) => x.info);
  const hasUndo = new Set();
  const hasDownFile = new Set();
  for (const { path: pth, info } of infos) {
    if (info.framework === 'flyway' && info.kind === 'U') hasUndo.add(`${dirName(pth)}|${padVersion(info.version)}`);
    if (info.framework === 'golang-migrate' && info.direction === 'down') hasDownFile.add(`${dirName(pth)}|${info.version}`);
  }
  const alembicByDir = new Map();
  for (const n of migNodes) {
    if (n.attrs.framework === 'alembic' && n.attrs.revision) {
      const d = dirName(n.path);
      if (!alembicByDir.has(d)) alembicByDir.set(d, []);
      alembicByDir.get(d).push({ revision: n.attrs.revision, down_revision: n.attrs.down_revision });
    }
  }
  const alembicDepth = new Map([...alembicByDir.entries()].map(([d, list]) => [d, alembicOrder(list)]));
  const atlasDirs = new Set(paths.filter((x) => baseName(x) === 'atlas.sum').map(dirName));
  const restate = (n, over, line) => add({ ...n, attrs: { ...n.attrs, ...over }, provenance: prov({ source_type: 'inference', source_ref: `${n.path}:${line ?? 1}`, extractor: EXTRACTOR, confidence: n.provenance.confidence }) });

  for (const n of migNodes) {
    const a = n.attrs;
    if (a.framework === 'flyway' && a.kind !== 'R') {
      const has = hasUndo.has(`${dirName(n.path)}|${padVersion(a.version)}`);
      restate(n, { has_down: has, irreversible: a.destructive || !has, down_resolved_in_link: false });
    } else if (a.framework === 'golang-migrate') {
      const has = hasDownFile.has(`${dirName(n.path)}|${a.version}`);
      restate(n, { has_down: has, irreversible: a.destructive || !has, down_resolved_in_link: false });
      if (!has) {
        add(nodeFact('finding', `database.missing_down:${n.path}`, { name: 'migration has no down file', path: n.path, attrs: { rule_id: 'db.migration.missing_down', severity: 'medium', migration: n.id } },
          prov({ source_type: 'inference', source_ref: `${n.path}:1`, extractor: EXTRACTOR, confidence: 'high' })));
      }
    } else if (a.framework === 'alembic') {
      const depth = alembicDepth.get(dirName(n.path))?.get(a.revision);
      if (depth !== undefined) restate(n, { order_key: String(depth).padStart(6, '0') });
    } else if (a.framework === 'sql' && atlasDirs.has(dirName(n.path))) {
      restate(n, { framework: 'atlas', order_key: baseName(n.path) });
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- discover (catalog exports)

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function evidencePaths(ctx) {
  const ev = ctx?.evidence?.db_metadata;
  if (!ev) return [];
  return [].concat(ev).map((e) => (typeof e === 'string' ? e : e?.path)).filter(Boolean);
}

const CONSTRAINT_KIND = { p: 'primary_key', u: 'unique', f: 'foreign_key', c: 'check', x: 'exclude' };

function catalogFacts(doc, path, F) {
  const engine = normalizeEngine(doc.engine) === 'unknown' ? 'postgresql' : normalizeEngine(doc.engine);
  const p = (confidence = 'high') => prov({ source_type: 'catalog', source_ref: path, extractor: EXTRACTOR, confidence });
  F.add(nodeFact('engine', engine, { name: engine, path, attrs: { version: doc.version ?? null } }, p()));
  for (const t of doc.tables ?? []) {
    const key = tableKey({ schema: t.schema ?? null, name: t.name }, engine);
    const tid = `table:${key}`;
    F.add(nodeFact('table', key, { name: t.name, path, attrs: { engine, version: doc.version ?? null, estimated_rows: num(t.estimated_rows), size_bytes: num(t.size_bytes), partitioned: Boolean(t.partitioned) } }, p()));
    for (const c of t.columns ?? []) {
      F.add(nodeFact('column', `${key}.${c.name}`, { name: c.name, path, attrs: { type: c.type ?? null, nullable: c.nullable !== false, default: c.default ?? null } }, p()));
      F.add(edgeFact('CONTAINS', tid, `column:${key}.${c.name}`, {}, p()));
    }
    // Index analysis: unused, invalid, duplicate and redundant-prefix candidates.
    const idx = (t.indexes ?? []).map((ix) => {
      const st = parseSql(ix.definition ?? '', { dialect: engine })[0];
      const cols = st?.kind === 'create_index' ? st.columns.map((c) => c.expr.replace(/\s+/g, ' ').trim()) : [];
      return { ix, cols, method: st?.method ?? 'btree', where: st?.where ?? null, include: st?.include ?? [], unique: Boolean(ix.unique ?? st?.unique) };
    });
    const sig = (e) => JSON.stringify([e.method, e.cols, e.where, e.include, e.unique]);
    const groups = new Map();
    for (const e of idx.filter((x) => x.ix.valid !== false && x.cols.length)) {
      const k = sig(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const dupOf = new Map();
    for (const g of groups.values()) {
      g.sort((a, b) => (a.ix.primary ? -1 : b.ix.primary ? 1 : 0) || a.ix.name.localeCompare(b.ix.name));
      for (const d of g.slice(1)) dupOf.set(d.ix.name, g[0].ix.name);
    }
    const redundant = new Map();
    for (const a of idx) {
      if (a.unique || a.ix.valid === false || a.method !== 'btree' || a.where || !a.cols.length || dupOf.has(a.ix.name)) continue;
      const b = idx.find((o) => o !== a && o.ix.valid !== false && o.method === 'btree' && !o.where && o.cols.length > a.cols.length && a.cols.every((c, i) => c === o.cols[i]));
      if (b) redundant.set(a.ix.name, b.ix.name);
    }
    for (const e of idx) {
      const ix = e.ix;
      const schema = t.schema ?? defaultSchema(engine);
      const id = `${schema ? `${schema}.` : ''}${ix.name}`;
      const scans = num(ix.idx_scan);
      const attrs = {
        table: key, definition: ix.definition ?? null, columns: e.cols, method: e.method, unique: e.unique, primary: Boolean(ix.primary), valid: ix.valid !== false,
        idx_scan: scans, size_bytes: num(ix.size_bytes),
        unused_candidate: scans === 0 && !e.unique && !ix.primary && ix.valid !== false,
        invalid: ix.valid === false,
        duplicate_of: dupOf.has(ix.name) ? `index:${schema ? `${schema}.` : ''}${dupOf.get(ix.name)}` : null,
        redundant_to: redundant.has(ix.name) ? `index:${schema ? `${schema}.` : ''}${redundant.get(ix.name)}` : null,
        observation_window: 'since last pg_stat reset (unknown)',
      };
      F.add(nodeFact('index', id, { name: ix.name, path, attrs }, p()));
      F.add(edgeFact('INDEXED_BY', tid, `index:${id}`, { unique: e.unique }, p()));
    }
    for (const c of t.constraints ?? []) {
      let k = { kind: c.kind ?? CONSTRAINT_KIND[c.type] ?? 'unknown', columns: c.columns ?? [], ref_table: null, ref_columns: [], on_delete: null, on_update: null, expr: null };
      if (c.definition) {
        const st = parseSql(`ALTER TABLE ${t.name} ADD CONSTRAINT ${c.name} ${c.definition}`, { dialect: engine })[0];
        const parsed = st?.actions?.[0]?.constraint;
        if (parsed) k = parsed;
      }
      if (c.ref_table) k.ref_table = typeof c.ref_table === 'string' ? { schema: null, name: c.ref_table } : c.ref_table;
      if (c.ref_columns) k.ref_columns = c.ref_columns;
      if (c.on_delete) k.on_delete = c.on_delete;
      F.add(nodeFact('constraint', `${key}.${c.name}`, { name: c.name, path, attrs: { kind: k.kind, columns: k.columns, expr: k.expr, definition: c.definition ?? null, references: k.ref_table ? tableKey(k.ref_table, engine) : null } }, p()));
      F.add(edgeFact('CONTAINS', tid, `constraint:${key}.${c.name}`, {}, p()));
      if (k.kind === 'foreign_key' && k.ref_table) {
        const to = tableKey(k.ref_table, engine);
        F.add(nodeFact('table', to, { name: k.ref_table.name, path, attrs: {} }, p('medium')));
        F.add(edgeFact('REFERENCES', tid, `table:${to}`, { columns: k.columns, ref_columns: k.ref_columns, on_delete: k.on_delete ?? 'NO ACTION', constraint: c.name }, p()));
      }
    }
  }
  for (const r of doc.roles ?? []) F.add(nodeFact('db_role', r.name, { name: r.name, path, attrs: { superuser: Boolean(r.superuser), login: r.login !== false } }, p()));
  const grantAgg = new Map();
  for (const g of doc.grants ?? []) {
    const key = tableKey({ schema: g.schema ?? null, name: g.table }, engine);
    const k = `${g.grantee}|${key}`;
    if (!grantAgg.has(k)) grantAgg.set(k, { role: g.grantee, key, privileges: new Set(), grantable: false });
    const e = grantAgg.get(k);
    e.privileges.add(String(g.privilege).toUpperCase());
    e.grantable = e.grantable || g.is_grantable === true || g.is_grantable === 'YES';
  }
  for (const e of [...grantAgg.values()].sort((a, b) => (a.role + a.key < b.role + b.key ? -1 : 1))) {
    const privileges = [...e.privileges].sort();
    F.add(nodeFact('db_role', e.role, { name: e.role, path }, p('medium')));
    F.add(nodeFact('table', e.key, { name: e.key.split('.').pop(), path, attrs: {} }, p('medium')));
    F.add(nodeFact('grant', `${e.role}:${e.key}`, { name: `${e.role} on ${e.key}`, path, attrs: { privileges, with_grant_option: e.grantable } }, p()));
    F.add(edgeFact('AUTHORIZED_FOR', `db_role:${e.role}`, `table:${e.key}`, { privileges, with_grant_option: e.grantable }, p()));
  }
}

function statementsFacts(rows, path, F, engine) {
  const p = () => prov({ source_type: 'catalog', source_ref: path, extractor: EXTRACTOR, confidence: 'high' });
  rows.forEach((r, i) => {
    const text = String(r.query ?? r.Query ?? '');
    if (!text) return;
    const id = String(r.queryid ?? r.query_id ?? `${path}#${i}`);
    const calls = num(r.calls);
    const mean = num(r.mean_exec_time ?? r.mean_time);
    const total = num(r.total_exec_time ?? r.total_time);
    F.add(nodeFact('query', id, { name: text.replace(/\s+/g, ' ').slice(0, 80), path, attrs: { text: text.replace(/\s+/g, ' ').slice(0, 500), calls, mean_exec_time_ms: mean, total_exec_time_ms: total, rows: num(r.rows) } }, p()));
    for (const st of parseSql(text, { dialect: engine })) {
      for (const rd of st.reads ?? []) {
        const key = tableKey(rd, engine);
        if (key) { F.add(nodeFact('table', key, { name: rd.name, path, attrs: {} }, p())); F.add(edgeFact('QUERIES', `query:${id}`, `table:${key}`, { kind: 'select', calls }, p())); }
      }
      if (['insert', 'update', 'delete', 'merge'].includes(st.kind) && st.table) {
        const key = tableKey(st.table, engine);
        F.add(nodeFact('table', key, { name: st.table.name, path, attrs: {} }, p()));
        F.add(edgeFact('MUTATES', `query:${id}`, `table:${key}`, { kind: st.kind, has_where: st.has_where, calls }, p()));
      }
    }
  });
}

function planFacts(plans, path, F, engine) {
  const p = () => prov({ source_type: 'catalog', source_ref: path, extractor: EXTRACTOR, confidence: 'high' });
  plans.forEach((doc, i) => {
    const root = doc.Plan ?? doc;
    if (!root || typeof root !== 'object') return;
    const seq = [];
    const scans = [];
    const nodeTypes = new Set();
    const walk = (n) => {
      nodeTypes.add(n['Node Type']);
      if (n['Relation Name']) {
        const key = tableKey({ schema: n.Schema ?? null, name: n['Relation Name'] }, engine);
        const s = { table: key, scan: n['Node Type'], rows: num(n['Plan Rows']), cost: num(n['Total Cost']), filter: n.Filter ?? null };
        scans.push(s);
        if (n['Node Type'] === 'Seq Scan') seq.push(s);
      }
      for (const c of n.Plans ?? []) walk(c);
    };
    walk(root);
    const id = `${path}#${i}`;
    F.add(nodeFact('plan', id, { name: `plan ${i + 1}`, path, attrs: { total_cost: num(root['Total Cost']), startup_cost: num(root['Startup Cost']), estimated_rows: num(root['Plan Rows']), has_seq_scan: seq.length > 0, seq_scans: seq, node_types: [...nodeTypes].sort(), actual_total_time_ms: num(root['Actual Total Time']), planning_time_ms: num(doc['Planning Time']), execution_time_ms: num(doc['Execution Time']) } }, p()));
    for (const s of scans) {
      F.add(nodeFact('table', s.table, { name: s.table.split('.').pop(), path, attrs: {} }, p()));
      F.add(edgeFact('QUERIES', `plan:${id}`, `table:${s.table}`, { scan: s.scan, rows: s.rows, cost: s.cost }, p()));
    }
  });
}

async function discover(ctx) {
  const F = new Facts('catalog');
  const engine = normalizeEngine(ctx?.options?.engine) === 'unknown' ? 'postgresql' : normalizeEngine(ctx.options.engine);
  for (const path of evidencePaths(ctx)) {
    let text;
    try { text = await ctx.readText(path); } catch { continue; } // an unreadable export is skipped, not fatal
    if (typeof text !== 'string' || !text.trim()) continue;
    const head = text.trimStart()[0];
    let doc = null;
    if (head === '{' || head === '[') {
      try { doc = JSON.parse(text); } catch { doc = null; }
    }
    if (doc) {
      if (!Array.isArray(doc) && Array.isArray(doc.tables)) { catalogFacts(doc, path, F); continue; }
      const arr = Array.isArray(doc) ? doc : (doc.pg_stat_statements ?? doc.rows ?? null);
      if (Array.isArray(arr) && arr.length && arr.every((x) => x && typeof x === 'object' && 'query' in x)) { statementsFacts(arr, path, F, engine); continue; }
      const plans = Array.isArray(doc) ? doc : [doc];
      if (plans.some((x) => x && typeof x === 'object' && 'Plan' in x)) { planFacts(plans.filter((x) => x && 'Plan' in x), path, F, engine); continue; }
      continue;
    }
    const rows = parseCsv(text);
    if (rows.length && 'query' in rows[0] && 'calls' in rows[0]) statementsFacts(rows, path, F, engine);
  }
  return F.list();
}

export default {
  id: ID,
  version: VERSION,
  kind: 'database',
  capabilities: {
    files: ['**/*.sql', '**/migrations/**', '**/migrate/**', '**/schema.prisma', '**/changelog*.{xml,yaml,yml,json}', '**/db/schema.rb', '**/alembic/versions/*.py'],
    executes: [],
    network: false,
  },
  extract,
  link,
  discover,
};
