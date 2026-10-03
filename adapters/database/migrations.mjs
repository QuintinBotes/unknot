// Migration framework detection, ordering and statement recovery (spec §14.3, §14.7).
//
// Frameworks with raw SQL files are parsed directly. Frameworks that express changes in a
// DSL (Rails, Django, Alembic, Liquibase, Knex, Sequelize, TypeORM) are read with small
// regex readers and each recognised operation is rewritten as equivalent SQL, so one
// parser and one forecast model cover every framework. These readers are heuristic: they
// say what the file visibly does, and anything dynamic (loops, helper methods) is
// invisible. Callers mark such facts `confidence: medium`.

import { parseSql } from './sql/parser.mjs';
import { forecast } from './forecast.mjs';

const posix = (p) => String(p).replace(/\\/g, '/');
const baseName = (p) => posix(p).split('/').pop();
const dirName = (p) => posix(p).split('/').slice(0, -1).join('/');

// ---------------------------------------------------------------- detection

/** Zero-pad each numeric segment so string comparison matches version comparison. */
export function padVersion(v) {
  return String(v).split(/[._-]/).map((s) => (/^\d+$/.test(s) ? s.padStart(12, '0') : s)).join('.');
}

/**
 * Identify a migration file from its path (and, where the path is ambiguous, its text).
 * @returns {{framework: string, version: string|null, order_key: string, description: string, direction?: string, kind?: string}|null}
 */
export function detectFramework(path, text = '') {
  const p = posix(path);
  const name = baseName(p);
  let m;

  if ((m = /(?:^|\/)migrations\/([^/]+)\/migration\.sql$/.exec(p)) && (/(?:^|\/)prisma\//.test(p) || /^\d{14}_/.test(m[1]))) {
    return { framework: 'prisma', version: m[1].split('_')[0], order_key: m[1], description: m[1].replace(/^\d+_/, '') };
  }
  if ((m = /^(\d+)_(.+)\.(up|down)\.sql$/i.exec(name))) {
    return { framework: 'golang-migrate', version: m[1], order_key: padVersion(m[1]), description: m[2], direction: m[3].toLowerCase() };
  }
  if ((m = /^([VUR])(\d+(?:[._]\d+)*)?__(.+)\.sql$/i.exec(name)) && (m[1].toUpperCase() === 'R' ? m[2] === undefined : m[2] !== undefined)) {
    const kind = m[1].toUpperCase();
    const version = m[2] ? m[2].replace(/_/g, '.') : null;
    return {
      framework: 'flyway', version, kind,
      order_key: kind === 'R' ? `~repeatable.${m[3]}` : padVersion(version),
      description: m[3].replace(/_/g, ' '),
      direction: kind === 'U' ? 'down' : 'up',
    };
  }
  if ((m = /(?:^|\/)db\/migrate\/(\d+)_(.+)\.rb$/.exec(p))) {
    return { framework: 'rails', version: m[1], order_key: m[1], description: m[2] };
  }
  if (/(?:^|\/)versions\/[^/]+\.py$/.test(p) && !name.startsWith('__')) {
    return { framework: 'alembic', version: null, order_key: name, description: name.replace(/\.py$/, '') };
  }
  if ((m = /(?:^|\/)migrations\/(\d{4})_(.+)\.py$/.exec(p))) {
    return { framework: 'django', version: m[1], order_key: m[1], description: m[2] };
  }
  if (/(?:^|\/)(?:db\.)?changelog[^/]*\.(xml|ya?ml|json)$/i.test(p) || (/\.(xml|ya?ml|json)$/.test(name) && /databaseChangeLog/.test(text.slice(0, 4000)))) {
    return { framework: 'liquibase', version: null, order_key: name, description: name };
  }
  if (/\.sql$/i.test(name) && /^--\s*liquibase formatted sql/i.test(text.slice(0, 200))) {
    return { framework: 'liquibase', version: null, order_key: name, description: name, kind: 'formatted-sql' };
  }
  if (/(?:^|\/)migrations?\/[^/]+\.(?:[cm]?js|ts)$/.test(p)) {
    const key = (/^(\d+)/.exec(name) ?? [])[1] ?? name;
    const desc = name.replace(/^\d+[-_]?/, '').replace(/\.\w+$/, '');
    if (/MigrationInterface/.test(text)) return { framework: 'typeorm', version: key, order_key: padVersion(key), description: desc };
    if (/queryInterface|QueryInterface/.test(text)) return { framework: 'sequelize', version: key, order_key: padVersion(key), description: desc };
    if (/exports\.up|export\s+(?:async\s+)?function\s+up\b|knex\.schema|\(knex\b/.test(text)) return { framework: 'knex', version: key, order_key: padVersion(key), description: desc };
    return null;
  }
  if (/\.sql$/i.test(name) && /(?:^|\/)(?:migrations?|migrate|db\/changes)\//.test(p)) {
    return { framework: 'sql', version: null, order_key: name, description: name.replace(/\.sql$/, '') };
  }
  return null;
}

/** Sort migrations into apply order. Alembic needs `alembicOrder` first. */
export function orderMigrations(list) {
  // Plain code-unit comparison: localeCompare would ignore the punctuation that sorts repeatables last.
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...list].sort((a, b) => (cmp(dirName(a.path), dirName(b.path)) || cmp(a.framework, b.framework) || cmp(String(a.order_key), String(b.order_key)) || cmp(a.path, b.path)));
}

/** Topologically order an Alembic revision chain: revision -> position (0 = first). */
export function alembicOrder(entries) {
  const byRev = new Map(entries.map((e) => [e.revision, e]));
  const depth = new Map();
  const walk = (rev, seen = new Set()) => {
    if (depth.has(rev)) return depth.get(rev);
    const e = byRev.get(rev);
    if (!e || seen.has(rev)) return 0;
    seen.add(rev);
    const downs = [].concat(e.down_revision ?? []).filter((d) => byRev.has(d));
    const d = downs.length ? 1 + Math.max(...downs.map((x) => walk(x, seen))) : 0;
    depth.set(rev, d);
    return d;
  };
  for (const e of entries) walk(e.revision);
  return depth;
}

// ---------------------------------------------------------------- small readers

/** Content between the parens opening at text[open] (which must be '('). Quote aware. */
function balanced(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 }; }
  }
  return { body: text.slice(open + 1), end: text.length };
}

/** Split call arguments at top-level commas. */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Positional and keyword args of a Python/Ruby/JS-ish call. */
function parseArgs(s) {
  const positional = [];
  const named = {};
  for (const a of splitArgs(s)) {
    const m = /^(?::?([A-Za-z_]\w*)\s*(?:=(?!=)|:(?!:))\s*|([A-Za-z_]\w*)\s*=>\s*)([\s\S]+)$/.exec(a);
    const m2 = /^:?([A-Za-z_]\w*)\s*=>\s*([\s\S]+)$/.exec(a); // ruby hash rocket
    if (m2) named[m2[1]] = m2[2].trim();
    else if (m && !/^['"]/.test(a)) named[m[1] ?? m[2]] = m[3].trim();
    else positional.push(a);
  }
  return { positional, named };
}

const unq = (s) => String(s ?? '').trim().replace(/^[:'"`]|['"`]$/g, '').replace(/^:/, '');
const listOf = (s) => splitArgs(String(s ?? '').trim().replace(/^%[wi]?[[({]|^[[({]/, '').replace(/[\])}]$/, '')).flatMap((x) => (/\s/.test(x) && !/['"]/.test(x) ? x.split(/\s+/) : [x])).map(unq).filter(Boolean);
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

const SQL_TYPES = {
  string: 'varchar(255)', text: 'text', integer: 'integer', int: 'integer', bigint: 'bigint', float: 'double precision', decimal: 'numeric',
  boolean: 'boolean', bool: 'boolean', date: 'date', datetime: 'timestamp', timestamp: 'timestamp', time: 'time', json: 'json', jsonb: 'jsonb',
  uuid: 'uuid', binary: 'bytea', references: 'bigint', belongs_to: 'bigint', smallint: 'smallint', primary_key: 'bigserial',
};

function rubyDefault(v) {
  if (v === undefined) return '';
  const lam = /^->\s*\{\s*([\s\S]*?)\s*\}$/.exec(v.trim()) ?? /^lambda\s*\{\s*([\s\S]*?)\s*\}$/.exec(v.trim());
  if (lam) return ` DEFAULT ${unq(lam[1])}`;
  if (/^(true|false|nil)$/.test(v)) return v === 'nil' ? '' : ` DEFAULT ${v}`;
  if (/^-?\d+(\.\d+)?$/.test(v)) return ` DEFAULT ${v}`;
  return ` DEFAULT '${unq(v).replace(/'/g, "''")}'`;
}

/** Parse SQL snippets and stamp every resulting statement with the DSL line. */
function synth(sql, line, dialect, src, out) {
  for (const st of parseSql(sql, { dialect })) {
    st.line = line;
    st.origin = src;
    out.push(st);
  }
}

// ---------------------------------------------------------------- Rails

function readRails(text, dialect) {
  const out = [];
  const notes = {};
  notes.no_transaction = /disable_ddl_transaction!/.test(text);
  const hasDown = /def\s+(self\.)?down\b/.test(text) && !/def\s+(self\.)?down\b[\s\S]{0,200}raise\s+ActiveRecord::IrreversibleMigration/.test(text);
  const hasChange = /def\s+(self\.)?change\b/.test(text);
  const execOutsideReversible = /\bexecute\b/.test(text.replace(/reversible\s+do[\s\S]*?\n\s*end\s*\n\s*end/g, '')) && !/reversible\s+do/.test(text);
  const irreversibleChange = hasChange && (execOutsideReversible || /\b(remove_column\s*:\w+\s*,\s*:\w+\s*\)|drop_table\s*:\w+\s*\)|change_column\b)/.test(text));
  notes.has_down = hasDown || (hasChange && !irreversibleChange);

  const call = /^[ \t]*(add_column|remove_column|remove_columns|change_column|change_column_null|change_column_default|rename_column|rename_table|add_index|remove_index|add_foreign_key|remove_foreign_key|drop_table|create_table|add_check_constraint|add_reference|execute)\b[ (]*/gm;
  let m;
  while ((m = call.exec(text))) {
    const line = lineOf(text, m.index);
    const verb = m[1];
    const startArgs = m.index + m[0].length;
    // Args run to end of statement: the line, or for create_table up to its `do`.
    const lineEnd = text.indexOf('\n', startArgs);
    let argText = text.slice(startArgs, lineEnd < 0 ? text.length : lineEnd).replace(/\)\s*$/, '');
    if (verb === 'execute') {
      const hd = /^<<[~-]?['"]?(\w+)['"]?/.exec(argText.trim());
      let sql;
      if (hd) {
        const endRe = new RegExp(`\\n[ \\t]*${hd[1]}\\b`);
        const rest = text.slice(lineEnd + 1);
        const e = endRe.exec(`\n${rest}`);
        sql = e ? rest.slice(0, Math.max(0, e.index - 1)) : rest;
      } else sql = unq(argText.trim().replace(/^%q?\{|\}$/g, ''));
      synth(sql, line, dialect, 'execute', out);
      continue;
    }
    const { positional: pa, named } = parseArgs(argText.replace(/\s+do\s*(\|.*\|)?\s*$/, ''));
    const t = unq(pa[0]);
    switch (verb) {
      case 'add_column': {
        const type = SQL_TYPES[unq(pa[2])] ?? unq(pa[2]);
        const typ = named.limit && type === 'varchar(255)' ? `varchar(${named.limit})` : type;
        synth(`ALTER TABLE ${t} ADD COLUMN ${unq(pa[1])} ${typ}${rubyDefault(named.default)}${named.null === 'false' ? ' NOT NULL' : ''};`, line, dialect, verb, out);
        break;
      }
      case 'add_reference': synth(`ALTER TABLE ${t} ADD COLUMN ${unq(pa[1])}_id bigint;`, line, dialect, verb, out); break;
      case 'remove_column': case 'remove_columns':
        for (const c of pa.slice(1).filter((x) => /^:/.test(x))) synth(`ALTER TABLE ${t} DROP COLUMN ${unq(c)};`, line, dialect, verb, out);
        break;
      case 'change_column': synth(`ALTER TABLE ${t} ALTER COLUMN ${unq(pa[1])} TYPE ${SQL_TYPES[unq(pa[2])] ?? unq(pa[2])};`, line, dialect, verb, out); break;
      case 'change_column_null': synth(`ALTER TABLE ${t} ALTER COLUMN ${unq(pa[1])} ${pa[2] === 'false' ? 'SET' : 'DROP'} NOT NULL;`, line, dialect, verb, out); break;
      case 'change_column_default': synth(`ALTER TABLE ${t} ALTER COLUMN ${unq(pa[1])} SET DEFAULT ${unq(pa[2]) || 'NULL'};`, line, dialect, verb, out); break;
      case 'rename_column': synth(`ALTER TABLE ${t} RENAME COLUMN ${unq(pa[1])} TO ${unq(pa[2])};`, line, dialect, verb, out); break;
      case 'rename_table': synth(`ALTER TABLE ${t} RENAME TO ${unq(pa[1])};`, line, dialect, verb, out); break;
      case 'drop_table': synth(`DROP TABLE ${t};`, line, dialect, verb, out); break;
      case 'add_index': {
        const cols = /^\[/.test(pa[1] ?? '') ? listOf(pa[1]) : [unq(pa[1])];
        const conc = /concurrently/.test(named.algorithm ?? '');
        const name = unq(named.name) || `index_${t}_on_${cols.join('_and_')}`;
        synth(`CREATE ${named.unique === 'true' ? 'UNIQUE ' : ''}INDEX ${conc ? 'CONCURRENTLY ' : ''}${name} ON ${t} (${cols.join(', ')});`, line, dialect, verb, out);
        break;
      }
      case 'remove_index': synth(`DROP INDEX ${/concurrently/.test(named.algorithm ?? '') ? 'CONCURRENTLY ' : ''}${unq(named.name) || `index_${t}_on_${unq(named.column ?? pa[1])}`};`, line, dialect, verb, out); break;
      case 'add_foreign_key': {
        const to = unq(pa[1]);
        const col = unq(named.column) || `${to.replace(/s$/, '')}_id`;
        synth(`ALTER TABLE ${t} ADD FOREIGN KEY (${col}) REFERENCES ${to} (${unq(named.primary_key) || 'id'})${named.on_delete ? ` ON DELETE ${unq(named.on_delete).replace('_', ' ').toUpperCase()}` : ''}${named.validate === 'false' ? ' NOT VALID' : ''};`, line, dialect, verb, out);
        break;
      }
      case 'remove_foreign_key': synth(`ALTER TABLE ${t} DROP CONSTRAINT fk_rails_${unq(pa[1])};`, line, dialect, verb, out); break;
      case 'add_check_constraint': synth(`ALTER TABLE ${t} ADD CONSTRAINT ${unq(named.name) || 'chk'} CHECK (${unq(pa[1])})${named.validate === 'false' ? ' NOT VALID' : ''};`, line, dialect, verb, out); break;
      case 'create_table': {
        const bodyStart = text.indexOf('\n', m.index);
        const endIdx = text.indexOf('\n  end', bodyStart);
        const body = text.slice(bodyStart, endIdx < 0 ? text.length : endIdx);
        const cols = [];
        let cm;
        const colRe = /^\s*t\.(\w+)\s+:?["']?(\w+)["']?([^\n]*)/gm;
        while ((cm = colRe.exec(body))) {
          if (cm[1] === 'index') continue;
          if (cm[1] === 'references' || cm[1] === 'belongs_to') { cols.push(`${cm[2]}_id bigint`); continue; }
          const o = parseArgs(cm[3].replace(/^\s*,/, ''));
          cols.push(`${cm[2]} ${SQL_TYPES[cm[1]] ?? cm[1]}${rubyDefault(o.named.default)}${o.named.null === 'false' ? ' NOT NULL' : ''}`);
        }
        if (/t\.timestamps/.test(body)) cols.push('created_at timestamp NOT NULL', 'updated_at timestamp NOT NULL');
        if (named.id !== 'false') cols.unshift('id bigserial PRIMARY KEY');
        synth(`CREATE TABLE ${t} (${cols.join(', ')});`, line, dialect, verb, out);
        for (const ix of body.matchAll(/^\s*t\.index\s+(\[[^\]]*\]|"[^"]+"|:\w+)([^\n]*)/gm)) {
          const o = parseArgs(ix[2].replace(/^\s*,/, ''));
          const icols = /^\[/.test(ix[1]) ? listOf(ix[1]) : [unq(ix[1])];
          synth(`CREATE ${o.named.unique === 'true' ? 'UNIQUE ' : ''}INDEX ${unq(o.named.name) || `index_${t}_on_${icols.join('_and_')}`} ON ${t} (${icols.join(', ')});`, line, dialect, 'index', out);
        }
        break;
      }
      default: break;
    }
  }
  return { statements: out, ...notes };
}

// ---------------------------------------------------------------- Django

const DJ_TYPES = {
  CharField: (a) => `varchar(${a.named.max_length ?? a.positional[0] ?? 255})`, TextField: () => 'text', IntegerField: () => 'integer',
  BigIntegerField: () => 'bigint', SmallIntegerField: () => 'smallint', PositiveIntegerField: () => 'integer', BooleanField: () => 'boolean',
  DateTimeField: () => 'timestamp with time zone', DateField: () => 'date', TimeField: () => 'time', UUIDField: () => 'uuid', JSONField: () => 'jsonb',
  FloatField: () => 'double precision', DecimalField: (a) => `numeric(${a.named.max_digits ?? 10},${a.named.decimal_places ?? 2})`,
  EmailField: () => 'varchar(254)', SlugField: () => 'varchar(50)', URLField: () => 'varchar(200)', BinaryField: () => 'bytea',
  AutoField: () => 'serial', BigAutoField: () => 'bigserial', ForeignKey: () => 'bigint', OneToOneField: () => 'bigint', FileField: () => 'varchar(100)',
};

function djangoField(src) {
  const m = /(?:\w+\.)*(\w+)\s*\(/.exec(src);
  if (!m) return { type: 'text', nullable: true, name_suffix: '', default: '', raw: src };
  const open = src.indexOf('(', m.index);
  const args = parseArgs(balanced(src, open).body);
  const fn = DJ_TYPES[m[1]] ?? (() => 'text');
  const dflt = args.named.default;
  let def = '';
  if (dflt !== undefined && !/^None$/.test(dflt)) {
    if (/^(True|False)$/.test(dflt)) def = ` DEFAULT ${dflt.toLowerCase()}`;
    else if (/^-?\d+(\.\d+)?$/.test(dflt)) def = ` DEFAULT ${dflt}`;
    else if (/^['"]/.test(dflt)) def = ` DEFAULT ${dflt.replace(/^"|"$/g, "'")}`;
    else def = " DEFAULT 'callable'"; // callables are evaluated once by Django's schema editor
  }
  const fk = m[1] === 'ForeignKey' || m[1] === 'OneToOneField';
  return { type: fn(args), nullable: args.named.null === 'True', name_suffix: fk ? '_id' : '', default: def, unique: args.named.unique === 'True' || m[1] === 'OneToOneField', fk: fk ? unq(args.positional[0] ?? args.named.to) : null, kind: m[1] };
}

function readDjango(path, text, dialect) {
  const out = [];
  const app = (/(?:^|\/)([^/]+)\/migrations\//.exec(posix(path)) ?? [])[1] ?? 'app';
  const tbl = (model) => `${app}_${String(unq(model)).toLowerCase()}`;
  let reversible = true;
  const re = /\b(?:migrations|operations|postgres_ops|pg_ops)\.(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const op = m[1];
    const open = m.index + m[0].length - 1;
    const { body, end } = balanced(text, open);
    const line = lineOf(text, m.index);
    const a = parseArgs(body);
    const get = (k, i) => a.named[k] ?? a.positional[i];
    switch (op) {
      case 'CreateModel': {
        const fieldsSrc = a.named.fields ?? a.positional[1] ?? '';
        const cols = [];
        for (const item of splitArgs(fieldsSrc.replace(/^\[|\]$/g, ''))) {
          const inner = item.replace(/^\(|\)$/g, '');
          const parts = splitArgs(inner);
          if (parts.length < 2) continue;
          const f = djangoField(parts.slice(1).join(','));
          cols.push(`${unq(parts[0])}${f.name_suffix} ${f.type}${f.nullable ? '' : ' NOT NULL'}${f.kind === 'AutoField' || f.kind === 'BigAutoField' ? ' PRIMARY KEY' : ''}`);
        }
        synth(`CREATE TABLE ${tbl(get('name', 0))} (${cols.join(', ')});`, line, dialect, op, out);
        break;
      }
      case 'DeleteModel': synth(`DROP TABLE ${tbl(get('name', 0))};`, line, dialect, op, out); break;
      case 'RenameModel': synth(`ALTER TABLE ${tbl(get('old_name', 0))} RENAME TO ${tbl(get('new_name', 1))};`, line, dialect, op, out); break;
      case 'AddField': {
        const f = djangoField(get('field', 2));
        const col = `${unq(get('name', 1))}${f.name_suffix}`;
        synth(`ALTER TABLE ${tbl(get('model_name', 0))} ADD COLUMN ${col} ${f.type}${f.default}${f.nullable ? '' : ' NOT NULL'};`, line, dialect, op, out);
        break;
      }
      case 'RemoveField': synth(`ALTER TABLE ${tbl(get('model_name', 0))} DROP COLUMN ${unq(get('name', 1))};`, line, dialect, op, out); break;
      case 'RenameField': synth(`ALTER TABLE ${tbl(get('model_name', 0))} RENAME COLUMN ${unq(get('old_name', 1))} TO ${unq(get('new_name', 2))};`, line, dialect, op, out); break;
      case 'AlterField': {
        const f = djangoField(get('field', 2));
        const col = `${unq(get('name', 1))}${f.name_suffix}`;
        const t = tbl(get('model_name', 0));
        synth(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${f.type}, ALTER COLUMN ${col} ${f.nullable ? 'DROP' : 'SET'} NOT NULL;`, line, dialect, op, out);
        break;
      }
      case 'AddIndex': case 'AddIndexConcurrently': {
        const idx = get('index', 1) ?? '';
        const fields = /fields\s*=\s*(\[[^\]]*\])/.exec(idx);
        const name = /name\s*=\s*['"]([^'"]+)['"]/.exec(idx);
        synth(`CREATE INDEX ${op === 'AddIndexConcurrently' ? 'CONCURRENTLY ' : ''}${name ? name[1] : 'idx'} ON ${tbl(get('model_name', 0))} (${fields ? listOf(fields[1]).join(', ') : 'id'});`, line, dialect, op, out);
        break;
      }
      case 'RemoveIndex': case 'RemoveIndexConcurrently': synth(`DROP INDEX ${op.endsWith('Concurrently') ? 'CONCURRENTLY ' : ''}${unq(get('name', 1))};`, line, dialect, op, out); break;
      case 'AddConstraint': {
        const c = get('constraint', 1) ?? '';
        const chk = /check\s*=\s*([\s\S]*?),\s*name\s*=\s*['"]([^'"]+)['"]/.exec(c);
        if (chk) synth(`ALTER TABLE ${tbl(get('model_name', 0))} ADD CONSTRAINT ${chk[2]} CHECK (${chk[1].replace(/\s+/g, ' ')});`, line, dialect, op, out);
        break;
      }
      case 'RunSQL': {
        const sql = get('sql', 0) ?? '';
        const rev = get('reverse_sql', 1);
        if (!rev || rev === 'None') reversible = false;
        const lit = /^[rR]?(?:'''([\s\S]*?)'''|"""([\s\S]*?)"""|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(sql.trim());
        if (lit) synth(lit[1] ?? lit[2] ?? lit[3] ?? lit[4], line, dialect, op, out);
        break;
      }
      case 'RunPython': {
        const rev = get('reverse_code', 1);
        if (!rev || rev === 'None') reversible = false;
        out.push({ kind: 'run_python', line, text: `RunPython(${String(get('code', 0)).slice(0, 80)})`, origin: op });
        break;
      }
      default: break;
    }
    re.lastIndex = op === 'SeparateDatabaseAndState' ? re.lastIndex : Math.max(re.lastIndex, end);
  }
  const deps = [...text.matchAll(/\(\s*['"]([\w.]+)['"]\s*,\s*['"](\d{4}_[\w]+)['"]\s*\)/g)].map((d) => `${d[1]}:${d[2]}`);
  return { statements: out, has_down: reversible, dependencies: deps };
}

// ---------------------------------------------------------------- Alembic

const SA_TYPES = {
  String: (a) => `varchar(${a[0] ?? 255})`, Text: () => 'text', Integer: () => 'integer', BigInteger: () => 'bigint', SmallInteger: () => 'smallint',
  Boolean: () => 'boolean', DateTime: () => 'timestamp', Date: () => 'date', Time: () => 'time', Float: () => 'double precision',
  Numeric: (a) => (a.length ? `numeric(${a.join(',')})` : 'numeric'), UUID: () => 'uuid', JSON: () => 'json', JSONB: () => 'jsonb', LargeBinary: () => 'bytea',
  Enum: () => 'text', TIMESTAMP: () => 'timestamp',
};

function saType(src) {
  const m = /(?:\w+\.)*(\w+)\s*(?:\(([^)]*)\))?/.exec(String(src ?? ''));
  if (!m) return 'text';
  const args = m[2] ? splitArgs(m[2]).filter((x) => /^\d+$/.test(x)) : [];
  return (SA_TYPES[m[1]] ?? (() => m[1].toLowerCase()))(args);
}

function saColumn(src, line) {
  const open = src.indexOf('(');
  const { positional: p, named } = parseArgs(balanced(src, open).body);
  const name = unq(p[0]);
  let def = '';
  const sd = named.server_default;
  if (sd !== undefined) {
    const t = /text\(\s*(['"])([\s\S]*?)\1\s*\)/.exec(sd);
    def = t ? ` DEFAULT ${t[2]}` : /^['"]/.test(sd) ? ` DEFAULT '${unq(sd)}'` : '';
  }
  void line;
  const pk = named.primary_key === 'True' ? ' PRIMARY KEY' : '';
  return `${name} ${saType(p[1])}${def}${named.nullable === 'False' ? ' NOT NULL' : ''}${pk}`;
}

function readAlembic(text, dialect) {
  const out = [];
  const rev = /^revision\s*(?::[^=]+)?=\s*['"]([^'"]+)['"]/m.exec(text)?.[1] ?? null;
  const downRaw = /^down_revision\s*(?::[^=]+)?=\s*(.+)$/m.exec(text)?.[1]?.trim();
  const down_revision = !downRaw || downRaw === 'None' ? null : (downRaw.startsWith('(') ? [...downRaw.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : unq(downRaw.replace(/#.*$/, '').trim()));
  // Only the upgrade body describes forward changes.
  const upIdx = text.search(/def\s+upgrade\s*\(/);
  const dgIdx = text.search(/def\s+downgrade\s*\(/);
  const upStart = upIdx < 0 ? 0 : text.indexOf(':', text.indexOf(')', upIdx)) + 1;
  const upEnd = dgIdx > upIdx && upIdx >= 0 ? dgIdx : text.length;
  const upBody = text.slice(upStart, upEnd);
  const upOffset = upStart;
  const dg = /def\s+downgrade\s*\([^)]*\)\s*(?:->\s*\w+)?\s*:([\s\S]*)$/.exec(text);
  const dgStatements = dg ? dg[1].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean) : [];
  const has_down = dgStatements.length > 0 && !dgStatements.every((l) => /^(pass|raise NotImplementedError.*|\.\.\.)$/.test(l));
  const re = /\b(?:op|batch_op)\.(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(upBody))) {
    const verb = m[1];
    const open = m.index + m[0].length - 1;
    const { body, end } = balanced(upBody, open);
    const line = lineOf(text, upOffset + m.index);
    const a = parseArgs(body);
    const t = unq(a.positional[0]);
    switch (verb) {
      case 'add_column': synth(`ALTER TABLE ${t} ADD COLUMN ${saColumn(a.positional[1], line)};`, line, dialect, verb, out); break;
      case 'drop_column': synth(`ALTER TABLE ${t} DROP COLUMN ${unq(a.positional[1])};`, line, dialect, verb, out); break;
      case 'alter_column': {
        const col = unq(a.positional[1]);
        const parts = [];
        if (a.named.type_) parts.push(`ALTER COLUMN ${col} TYPE ${saType(a.named.type_)}${a.named.postgresql_using ? ` USING ${unq(a.named.postgresql_using)}` : ''}`);
        if (a.named.nullable !== undefined) parts.push(`ALTER COLUMN ${col} ${a.named.nullable === 'False' ? 'SET' : 'DROP'} NOT NULL`);
        if (a.named.new_column_name) parts.push(`RENAME COLUMN ${col} TO ${unq(a.named.new_column_name)}`);
        if (a.named.server_default !== undefined) parts.push(`ALTER COLUMN ${col} ${a.named.server_default === 'None' ? 'DROP DEFAULT' : 'SET DEFAULT 0'}`);
        for (const p of parts) synth(`ALTER TABLE ${t} ${p};`, line, dialect, verb, out);
        break;
      }
      case 'create_index': {
        const [name, table, cols] = a.positional;
        synth(`CREATE ${a.named.unique === 'True' ? 'UNIQUE ' : ''}INDEX ${a.named.postgresql_concurrently === 'True' ? 'CONCURRENTLY ' : ''}${unq(name)} ON ${unq(table)} (${listOf(cols).join(', ')});`, line, dialect, verb, out);
        break;
      }
      case 'drop_index': synth(`DROP INDEX ${a.named.postgresql_concurrently === 'True' ? 'CONCURRENTLY ' : ''}${unq(a.positional[0])};`, line, dialect, verb, out); break;
      case 'create_table': {
        const cols = a.positional.slice(1).filter((x) => /Column\(/.test(x)).map((x) => saColumn(x.slice(x.indexOf('Column(') + 6), line));
        synth(`CREATE TABLE ${t} (${cols.join(', ')});`, line, dialect, verb, out);
        break;
      }
      case 'drop_table': synth(`DROP TABLE ${t};`, line, dialect, verb, out); break;
      case 'rename_table': synth(`ALTER TABLE ${t} RENAME TO ${unq(a.positional[1])};`, line, dialect, verb, out); break;
      case 'create_foreign_key': {
        const [name, src, ref, lc, rc] = a.positional;
        synth(`ALTER TABLE ${unq(src)} ADD CONSTRAINT ${unq(name)} FOREIGN KEY (${listOf(lc).join(', ')}) REFERENCES ${unq(ref)} (${listOf(rc).join(', ')})${a.named.ondelete ? ` ON DELETE ${unq(a.named.ondelete)}` : ''};`, line, dialect, verb, out);
        break;
      }
      case 'create_unique_constraint': synth(`ALTER TABLE ${unq(a.positional[1])} ADD CONSTRAINT ${unq(a.positional[0])} UNIQUE (${listOf(a.positional[2]).join(', ')});`, line, dialect, verb, out); break;
      case 'create_check_constraint': synth(`ALTER TABLE ${unq(a.positional[1])} ADD CONSTRAINT ${unq(a.positional[0])} CHECK (${unq(a.positional[2])});`, line, dialect, verb, out); break;
      case 'drop_constraint': synth(`ALTER TABLE ${unq(a.positional[1])} DROP CONSTRAINT ${unq(a.positional[0])};`, line, dialect, verb, out); break;
      case 'execute': {
        const lit = /^[rRfF]?(?:'''([\s\S]*?)'''|"""([\s\S]*?)"""|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(a.positional[0].replace(/^(?:sa\.)?text\(\s*/, '').trim());
        if (lit) synth(lit[1] ?? lit[2] ?? lit[3] ?? lit[4], line, dialect, verb, out);
        break;
      }
      default: break;
    }
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return { statements: out, has_down, revision: rev, down_revision };
}

// ---------------------------------------------------------------- JS frameworks

/** Raw SQL strings passed to .raw( / .query( / .execute( calls. */
function rawSqlCalls(text) {
  const out = [];
  const re = /\.(?:raw|query|execute|sql)\s*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(text))) out.push({ sql: m[1].slice(1, -1).replace(/\\n/g, '\n').replace(/\$\{[^}]*\}/g, 'x'), line: lineOf(text, m.index) });
  return out;
}

const JS_TYPES = { STRING: 'varchar(255)', TEXT: 'text', INTEGER: 'integer', BIGINT: 'bigint', BOOLEAN: 'boolean', DATE: 'timestamp', DECIMAL: 'numeric', FLOAT: 'double precision', JSON: 'json', JSONB: 'jsonb', UUID: 'uuid' };

function readJs(framework, fullText, dialect) {
  const out = [];
  // Only the forward (up) body describes the change; blank out the down body, keeping line numbers.
  const upIdx = fullText.search(/\bup\b\s*[:=(]|exports\.up|function\s+up\b/);
  const downIdx = fullText.search(/exports\.down|\bdown\b\s*[:=(]|function\s+down\b/);
  const text = downIdx > upIdx && upIdx >= 0 ? fullText.slice(0, downIdx) + fullText.slice(downIdx).replace(/[^\n]/g, ' ') : fullText;
  for (const { sql, line } of rawSqlCalls(text)) synth(sql, line, dialect, 'raw', out);
  // Sequelize queryInterface DSL.
  const qi = /\bqueryInterface\.(addColumn|removeColumn|renameColumn|changeColumn|addIndex|removeIndex|createTable|dropTable|renameTable)\s*\(/g;
  let m;
  while ((m = qi.exec(text))) {
    const { body } = balanced(text, m.index + m[0].length - 1);
    const a = parseArgs(body);
    const line = lineOf(text, m.index);
    const t = unq(a.positional[0]);
    const typeOf = (s) => { const mm = /(?:Sequelize|DataTypes)\.(\w+)(?:\((\d+)\))?/.exec(s ?? ''); return mm ? (mm[1] === 'STRING' && mm[2] ? `varchar(${mm[2]})` : JS_TYPES[mm[1]] ?? 'text') : 'text'; };
    switch (m[1]) {
      case 'addColumn': synth(`ALTER TABLE ${t} ADD COLUMN ${unq(a.positional[1])} ${typeOf(a.positional[2])}${/allowNull:\s*false/.test(a.positional[2] ?? '') ? ' NOT NULL' : ''}${/defaultValue:\s*[^,}]+/.test(a.positional[2] ?? '') ? ' DEFAULT 0' : ''};`, line, dialect, m[1], out); break;
      case 'removeColumn': synth(`ALTER TABLE ${t} DROP COLUMN ${unq(a.positional[1])};`, line, dialect, m[1], out); break;
      case 'renameColumn': synth(`ALTER TABLE ${t} RENAME COLUMN ${unq(a.positional[1])} TO ${unq(a.positional[2])};`, line, dialect, m[1], out); break;
      case 'changeColumn': synth(`ALTER TABLE ${t} ALTER COLUMN ${unq(a.positional[1])} TYPE ${typeOf(a.positional[2])};`, line, dialect, m[1], out); break;
      case 'addIndex': synth(`CREATE ${/unique:\s*true/.test(a.positional[2] ?? '') ? 'UNIQUE ' : ''}INDEX ${/concurrently:\s*true/.test(a.positional[2] ?? '') ? 'CONCURRENTLY ' : ''}idx_${t} ON ${t} (${listOf(a.positional[1]).join(', ')});`, line, dialect, m[1], out); break;
      case 'removeIndex': synth(`DROP INDEX ${unq(a.positional[1])};`, line, dialect, m[1], out); break;
      case 'createTable': synth(`CREATE TABLE ${t} (id integer);`, line, dialect, m[1], out); break;
      case 'dropTable': synth(`DROP TABLE ${t};`, line, dialect, m[1], out); break;
      case 'renameTable': synth(`ALTER TABLE ${t} RENAME TO ${unq(a.positional[1])};`, line, dialect, m[1], out); break;
      default: break;
    }
  }
  // Knex schema builder and TypeORM QueryRunner DSL (table-name calls only).
  const kx = /\.(createTable|createTableIfNotExists|dropTable|dropTableIfExists|alterTable|table)\s*\(\s*['"`]([\w.]+)['"`]/g;
  let current = null;
  while ((m = kx.exec(text))) {
    const line = lineOf(text, m.index);
    if (m[1].startsWith('dropTable')) synth(`DROP TABLE ${m[2]};`, line, dialect, m[1], out);
    else if (m[1].startsWith('createTable')) synth(`CREATE TABLE ${m[2]} (id integer);`, line, dialect, m[1], out);
    else current = { table: m[2], at: m.index, line };
    if (current && (m[1] === 'alterTable' || m[1] === 'table')) {
      const { body } = balanced(text, text.indexOf('(', m.index));
      for (const d of body.matchAll(/\.\s*(dropColumn|renameColumn)\s*\(\s*['"`](\w+)['"`](?:\s*,\s*['"`](\w+)['"`])?/g)) {
        synth(d[1] === 'dropColumn' ? `ALTER TABLE ${m[2]} DROP COLUMN ${d[2]};` : `ALTER TABLE ${m[2]} RENAME COLUMN ${d[2]} TO ${d[3]};`, line, dialect, d[1], out);
      }
      for (const d of body.matchAll(/\b\w+\.(string|text|integer|bigInteger|boolean|timestamp|decimal|float|json|jsonb|uuid)\s*\(\s*['"`](\w+)['"`][^)]*\)([^\n;]*)/g)) {
        const alter = /\.alter\(\)/.test(d[3]);
        const sql = `ALTER TABLE ${m[2]} ${alter ? 'ALTER COLUMN' : 'ADD COLUMN'} ${d[2]} ${alter ? 'TYPE ' : ''}${d[1] === 'string' ? 'varchar(255)' : d[1] === 'bigInteger' ? 'bigint' : d[1]}${!alter && /\.notNullable\(\)/.test(d[3]) && !/\.defaultTo/.test(d[3]) ? ' NOT NULL' : ''}${!alter && /\.defaultTo\(/.test(d[3]) ? ' DEFAULT 0' : ''};`;
        synth(sql, line, dialect, d[1], out);
      }
    }
  }
  const qr = /\bqueryRunner\.(dropColumn|dropTable|renameColumn)\s*\(\s*['"`]([\w.]+)['"`](?:\s*,\s*['"`](\w+)['"`])?(?:\s*,\s*['"`](\w+)['"`])?/g;
  while ((m = qr.exec(text))) {
    const line = lineOf(text, m.index);
    if (m[1] === 'dropTable') synth(`DROP TABLE ${m[2]};`, line, dialect, m[1], out);
    else if (m[1] === 'dropColumn') synth(`ALTER TABLE ${m[2]} DROP COLUMN ${m[3]};`, line, dialect, m[1], out);
    else synth(`ALTER TABLE ${m[2]} RENAME COLUMN ${m[3]} TO ${m[4]};`, line, dialect, m[1], out);
  }
  out.sort((x, y) => (x.line ?? 0) - (y.line ?? 0));
  let has_down;
  if (framework === 'typeorm') has_down = /async\s+down\s*\([^)]*\)[^{]*\{\s*[^}\s]/.test(fullText);
  else if (framework === 'sequelize') has_down = /\bdown\s*[:(]|async\s+down\b/.test(fullText) && !/down\s*[:(][^{]*\{\s*\}/.test(fullText);
  else has_down = /exports\.down\s*=|function\s+down\b|export\s+(?:async\s+)?function\s+down/.test(fullText);
  return { statements: out, has_down };
}

// ---------------------------------------------------------------- Liquibase

/** Tiny YAML reader: maps, lists, scalars, flow lists and block scalars; enough for changelogs. */
export function parseMiniYaml(text) {
  const lines = text.split('\n').map((l, i) => ({ raw: l.replace(/\s+#.*$/, '').replace(/\r$/, ''), i })).filter((l) => l.raw.trim() && !l.raw.trim().startsWith('#') && l.raw.trim() !== '---');
  const scalar = (s) => {
    s = s.trim();
    if (s === '' ) return null;
    if (/^\[.*\]$/.test(s)) return splitArgs(s.slice(1, -1)).map(scalar);
    if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };
  let pos = 0;
  const indentOf = (l) => /^ */.exec(l.raw)[0].length;
  function block(indent) {
    if (pos >= lines.length) return null;
    if (lines[pos].raw.trim().startsWith('- ')) return list(indent);
    return map(indent);
  }
  function list(indent) {
    const arr = [];
    while (pos < lines.length && indentOf(lines[pos]) === indent && lines[pos].raw.trim().startsWith('-')) {
      const rest = lines[pos].raw.trim().slice(1).trim();
      if (rest === '') { pos++; arr.push(pos < lines.length && indentOf(lines[pos]) > indent ? block(indentOf(lines[pos])) : null); continue; }
      if (/^[\w.-]+\s*:(\s|$)/.test(rest)) {
        // "- key: value" starts a map whose keys align at indent + 2
        lines[pos] = { ...lines[pos], raw: `${' '.repeat(indent + 2)}${rest}` };
        arr.push(map(indent + 2));
      } else { pos++; arr.push(scalar(rest)); }
    }
    return arr;
  }
  function map(indent) {
    const obj = {};
    while (pos < lines.length && indentOf(lines[pos]) === indent && !lines[pos].raw.trim().startsWith('- ')) {
      const m = /^\s*([\w.\-"']+)\s*:\s*(.*)$/.exec(lines[pos].raw);
      if (!m) { pos++; continue; }
      const key = m[1].replace(/["']/g, '');
      const val = m[2];
      pos++;
      if (val === '|' || val === '>' || val === '|-') {
        const parts = [];
        while (pos < lines.length && indentOf(lines[pos]) > indent) parts.push(lines[pos++].raw.trim());
        obj[key] = parts.join('\n');
      } else if (val === '' ) {
        obj[key] = pos < lines.length && (indentOf(lines[pos]) > indent || (indentOf(lines[pos]) === indent && lines[pos].raw.trim().startsWith('- '))) ? block(indentOf(lines[pos])) : null;
      } else obj[key] = scalar(val);
    }
    return obj;
  }
  return lines.length ? block(indentOf(lines[0])) : null;
}

const LB_REVERSIBLE = new Set(['createTable', 'addColumn', 'createIndex', 'addForeignKeyConstraint', 'renameColumn', 'renameTable', 'addNotNullConstraint', 'addPrimaryKey', 'addUniqueConstraint', 'createView', 'createSequence', 'addDefaultValue', 'addAutoIncrement']);

function lbAttr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

/** Normalised Liquibase changeSets from XML, YAML or JSON text. */
export function readLiquibase(path, text) {
  const ext = baseName(path).split('.').pop().toLowerCase();
  const sets = [];
  if (ext === 'xml') {
    const re = /<changeSet\b([^>]*)>([\s\S]*?)<\/changeSet>/g;
    let m;
    while ((m = re.exec(text))) {
      const body = m[2];
      const changes = [];
      const rollback = /<rollback\b/.test(body);
      const cre = /<(createTable|dropTable|addColumn|dropColumn|renameColumn|renameTable|modifyDataType|addNotNullConstraint|dropNotNullConstraint|createIndex|dropIndex|addForeignKeyConstraint|dropForeignKeyConstraint|addPrimaryKey|addUniqueConstraint|addDefaultValue|dropDefaultValue|createView|dropView|createSequence|dropSequence|sql|sqlFile|insert|update|delete|loadData|addAutoIncrement)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
      const bodyNoRb = body.replace(/<rollback\b[\s\S]*?<\/rollback>/g, '');
      let c;
      while ((c = cre.exec(bodyNoRb))) {
        const inner = c[4] ?? '';
        const columns = [...inner.matchAll(/<column\b([^>]*?)(\/>|>([\s\S]*?)<\/column>)/g)].map((cm) => ({
          name: lbAttr(cm[1], 'name'), type: lbAttr(cm[1], 'type'), defaultValue: lbAttr(cm[1], 'defaultValue'), defaultValueComputed: lbAttr(cm[1], 'defaultValueComputed'),
          nullable: /nullable="false"/.test(cm[3] ?? '') ? false : true, primaryKey: /primaryKey="true"/.test(cm[3] ?? ''),
        }));
        const attrs = {};
        for (const a of c[2].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        const sql = c[1] === 'sql' ? inner.replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
        changes.push({ type: c[1], attrs, columns, sql });
      }
      sets.push({ id: lbAttr(m[1], 'id'), author: lbAttr(m[1], 'author'), changes, rollback, line: lineOf(text, m.index) });
    }
    return sets;
  }
  if (ext === 'sql') {
    // Liquibase "formatted SQL": --changeset author:id  followed by statements, optional --rollback.
    const parts = text.split(/^--\s*changeset\s+/im);
    for (let i = 1; i < parts.length; i++) {
      const head = /^([^:\s]+):(\S+)/.exec(parts[i]);
      const body = parts[i].replace(/^.*\n?/, '');
      sets.push({ id: head?.[2], author: head?.[1], changes: [{ type: 'sql', attrs: {}, columns: [], sql: body.split('\n').filter((l) => !/^--\s*rollback/i.test(l)).join('\n') }], rollback: /^--\s*rollback/im.test(body), line: 1 });
    }
    return sets;
  }
  let doc = null;
  try { doc = ext === 'json' ? JSON.parse(text) : parseMiniYaml(text); } catch { return sets; }
  const log = doc?.databaseChangeLog ?? [];
  for (const item of Array.isArray(log) ? log : []) {
    const cs = item?.changeSet;
    if (!cs) continue;
    const changes = [];
    for (const ch of cs.changes ?? []) {
      const [type, body] = Object.entries(ch ?? {})[0] ?? [];
      if (!type) continue;
      const cols = (body?.columns ?? []).map((c) => c.column ?? c);
      changes.push({
        type, attrs: Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => typeof v !== 'object' || v === null)),
        columns: cols.map((c) => ({ name: c.name, type: c.type, defaultValue: c.defaultValue, nullable: c.constraints?.nullable !== false, primaryKey: c.constraints?.primaryKey === true })),
        sql: type === 'sql' ? (body?.sql ?? (typeof body === 'string' ? body : null)) : null,
      });
    }
    sets.push({ id: String(cs.id), author: cs.author, changes, rollback: Boolean(cs.rollback), line: 1 });
  }
  return sets;
}

function liquibaseToSql(set, dialect, out) {
  for (const ch of set.changes) {
    const a = ch.attrs;
    const t = a.tableName;
    const line = set.line;
    const col = ch.columns[0];
    const colSql = (c) => `${c.name} ${c.type ?? 'text'}${c.nullable === false || c.primaryKey ? ' NOT NULL' : ''}${c.primaryKey ? ' PRIMARY KEY' : ''}${c.defaultValue !== undefined ? ` DEFAULT '${c.defaultValue}'` : ''}${c.defaultValueComputed ? ` DEFAULT ${c.defaultValueComputed}` : ''}`;
    switch (ch.type) {
      case 'createTable': synth(`CREATE TABLE ${t} (${ch.columns.map(colSql).join(', ')});`, line, dialect, ch.type, out); break;
      case 'dropTable': synth(`DROP TABLE ${t};`, line, dialect, ch.type, out); break;
      case 'addColumn': for (const c of ch.columns) synth(`ALTER TABLE ${t} ADD COLUMN ${colSql(c)};`, line, dialect, ch.type, out); break;
      case 'dropColumn': synth(`ALTER TABLE ${t} DROP COLUMN ${a.columnName ?? col?.name};`, line, dialect, ch.type, out); break;
      case 'renameColumn': synth(`ALTER TABLE ${t} RENAME COLUMN ${a.oldColumnName} TO ${a.newColumnName};`, line, dialect, ch.type, out); break;
      case 'renameTable': synth(`ALTER TABLE ${a.oldTableName} RENAME TO ${a.newTableName};`, line, dialect, ch.type, out); break;
      case 'modifyDataType': synth(`ALTER TABLE ${t} ALTER COLUMN ${a.columnName} TYPE ${a.newDataType};`, line, dialect, ch.type, out); break;
      case 'addNotNullConstraint': synth(`ALTER TABLE ${t} ALTER COLUMN ${a.columnName} SET NOT NULL;`, line, dialect, ch.type, out); break;
      case 'dropNotNullConstraint': synth(`ALTER TABLE ${t} ALTER COLUMN ${a.columnName} DROP NOT NULL;`, line, dialect, ch.type, out); break;
      case 'createIndex': synth(`CREATE ${a.unique === 'true' || a.unique === true ? 'UNIQUE ' : ''}INDEX ${a.indexName ?? 'idx'} ON ${t} (${ch.columns.map((c) => c.name).join(', ')});`, line, dialect, ch.type, out); break;
      case 'dropIndex': synth(`DROP INDEX ${a.indexName};`, line, dialect, ch.type, out); break;
      case 'addForeignKeyConstraint': synth(`ALTER TABLE ${a.baseTableName} ADD CONSTRAINT ${a.constraintName ?? 'fk'} FOREIGN KEY (${a.baseColumnNames}) REFERENCES ${a.referencedTableName} (${a.referencedColumnNames})${a.onDelete ? ` ON DELETE ${a.onDelete}` : ''};`, line, dialect, ch.type, out); break;
      case 'dropForeignKeyConstraint': synth(`ALTER TABLE ${a.baseTableName} DROP CONSTRAINT ${a.constraintName};`, line, dialect, ch.type, out); break;
      case 'addPrimaryKey': synth(`ALTER TABLE ${t} ADD PRIMARY KEY (${a.columnNames});`, line, dialect, ch.type, out); break;
      case 'addUniqueConstraint': synth(`ALTER TABLE ${t} ADD CONSTRAINT ${a.constraintName ?? 'uq'} UNIQUE (${a.columnNames});`, line, dialect, ch.type, out); break;
      case 'sql': if (ch.sql) synth(ch.sql, line, dialect, 'sql', out); break;
      case 'insert': out.push({ kind: 'insert', table: { schema: null, name: t }, has_where: false, reads: [], joins: [], ctes: [], line, text: 'liquibase insert', origin: 'insert' }); break;
      case 'update': out.push({ kind: 'update', table: { schema: null, name: t }, has_where: false, reads: [], joins: [], ctes: [], line, text: 'liquibase update', origin: 'update' }); break;
      case 'delete': out.push({ kind: 'delete', table: { schema: null, name: t }, has_where: false, reads: [], joins: [], ctes: [], line, text: 'liquibase delete', origin: 'delete' }); break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------- analysis entry point

/** Guess the SQL dialect from syntax hints when the caller does not say. */
export function inferEngine(text) {
  if (/`[A-Za-z_]+`|\bENGINE\s*=|\bAUTO_INCREMENT\b|\bALGORITHM\s*=|\bDELIMITER\b/i.test(text)) return 'mysql';
  if (/\bAUTOINCREMENT\b|\bPRAGMA\b/i.test(text)) return 'sqlite';
  if (/\bCONCURRENTLY\b|[)'\w]\s*::\s*(?:text|int|integer|bigint|smallint|varchar|uuid|jsonb?|timestamptz?|date|numeric|boolean|regclass)\b|\$\$|\bUSING\s+(gin|gist|btree|brin|hash)\b|\bNOT VALID\b|\bplpgsql\b|\bserial\b|\bSET\s+LOGGED\b/i.test(text)) return 'postgresql';
  return null;
}

const tableKeyOf = (t, engine) => (t ? `${t.schema ?? (engine === 'mysql' || engine === 'mariadb' || engine === 'sqlite' ? '' : 'public')}${t.schema || !(engine === 'mysql' || engine === 'mariadb' || engine === 'sqlite') ? '.' : ''}${t.name}` : null);

function describe(st) {
  if (st.kind === 'alter_table') return `alter_table.${[...new Set(st.actions.map((a) => a.action))].join('+') || 'options'}`;
  return st.kind;
}

/**
 * Analyse one migration file.
 * @param {string} path
 * @param {string} text
 * @param {{engine?: string, version?: string, table?: object}} [opts]
 * @returns {null | {framework: string, version: string|null, order_key: string, description: string, has_down: boolean, statements: object[], destructive: boolean, irreversible: boolean, parsed: object[], engine: string|null, no_transaction: boolean, extra: object}}
 */
export function analyzeMigration(path, text, opts = {}) {
  const info = detectFramework(path, text);
  if (!info) return null;
  // Syntax sniffing is only meaningful for files that are themselves SQL.
  const sqlText = ['flyway', 'golang-migrate', 'prisma', 'sql'].includes(info.framework) || info.kind === 'formatted-sql';
  const engineHint = opts.engine ?? (sqlText ? inferEngine(text) : null);
  const dialect = engineHint ?? 'postgresql';
  let parsed = [];
  let has_down = false;
  let extra = {};
  let no_transaction = false;

  switch (info.framework) {
    case 'flyway': case 'golang-migrate': case 'prisma': case 'sql': {
      if (info.direction === 'down') return { ...info, has_down: false, statements: [], destructive: false, irreversible: false, parsed: [], engine: engineHint, no_transaction: false, extra: { direction: 'down' } };
      parsed = parseSql(text, { dialect });
      // Flyway runs each migration in a transaction unless it contains non-transactional statements.
      no_transaction = /^\s*--\s*flyway:executeInTransaction=false/im.test(text);
      break;
    }
    case 'rails': {
      const r = readRails(text, dialect);
      parsed = r.statements; has_down = r.has_down; no_transaction = r.no_transaction;
      break;
    }
    case 'django': { const r = readDjango(path, text, dialect); parsed = r.statements; has_down = r.has_down; extra = { dependencies: r.dependencies }; break; }
    case 'alembic': {
      const r = readAlembic(text, dialect);
      parsed = r.statements; has_down = r.has_down;
      extra = { revision: r.revision, down_revision: r.down_revision };
      info.version = r.revision;
      break;
    }
    case 'liquibase': {
      const sets = readLiquibase(path, text);
      for (const s of sets) liquibaseToSql(s, dialect, parsed);
      has_down = sets.length > 0 && sets.every((s) => s.rollback || s.changes.every((c) => LB_REVERSIBLE.has(c.type)));
      extra = { change_sets: sets.map((s) => ({ id: s.id, author: s.author, types: s.changes.map((c) => c.type), rollback: s.rollback })) };
      break;
    }
    case 'knex': case 'typeorm': case 'sequelize': {
      const r = readJs(info.framework, text, dialect);
      parsed = r.statements; has_down = r.has_down;
      break;
    }
    default: break;
  }

  const engine = engineHint;
  const statements = [];
  let destructive = false;
  for (const st of parsed) {
    if (['transaction', 'set', 'comment', 'unknown'].includes(st.kind) && st.kind !== 'unknown') continue;
    const table = st.table ? tableKeyOf(st.table, engine)
      : st.tables?.[0] ? tableKeyOf(st.tables[0], engine) : st.kind === 'create_index' || st.kind === 'create_trigger' ? tableKeyOf(st.table, engine) : null;
    let fc = null;
    if (st.kind !== 'run_python') fc = forecast(st, { engine: engine ?? opts.engine, version: opts.version, table: opts.table });
    const isDestructive = Boolean(fc?.destructive) || (st.kind === 'delete' && !st.has_where);
    if (isDestructive) destructive = true;
    statements.push({
      kind: st.kind === 'run_python' ? 'run_python' : describe(st),
      table,
      line: st.line ?? null,
      forecast: fc ? { lock_mode: fc.lock_mode, rewrite: fc.rewrite, scan: fc.scan, transactional: fc.transactional, safer_alternative: fc.safer_alternative, rule_id: fc.rule_id, confidence: fc.confidence } : null,
    });
  }
  if (info.framework === 'django' && parsed.some((p) => p.kind === 'run_python')) has_down = has_down && true;
  return {
    ...info,
    has_down,
    statements,
    destructive,
    irreversible: destructive || !has_down,
    parsed,
    engine,
    no_transaction,
    extra,
  };
}

/** Statements recovered from db/schema.rb (same DSL reader as migrations). */
export function readSchemaRb(text, dialect = 'postgresql') {
  return readRails(text, dialect).statements;
}
