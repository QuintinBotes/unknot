// A tolerant DDL/DML parser. It extracts exactly what the database subsystem reasons
// about (objects touched, constraint shapes, lock-relevant clauses) and ignores the
// rest. It never throws: anything it cannot classify becomes `{kind: 'unknown', text}`
// so one unfamiliar statement cannot hide the rest of a migration (spec §14.3).

import { splitStatements, identValue } from './lexer.mjs';

const EOF = Object.freeze({ t: 'eof', v: '', u: '', line: 0, s: 0, e: 0 });

// Functions whose value differs per call: adding a column with one of these as DEFAULT
// forces PostgreSQL to rewrite the table (PostgreSQL docs, ALTER TABLE "Notes").
const VOLATILE_FN = /\b(random|gen_random_uuid|gen_random_bytes|uuid_generate_v[0-9a-z]+|uuidv[0-9]+|clock_timestamp|timeofday|nextval|setseed|txid_current|newid|newsequentialid|rand|uuid_short|uuid|sys_guid)\s*\(/i;
// STABLE functions are evaluated once at ALTER time, so they do not force a rewrite.
const STABLE_FN = /\b(now|current_timestamp|current_date|current_time|localtime|localtimestamp|statement_timestamp|transaction_timestamp|current_user|session_user|current_setting)\b/i;

const COLUMN_STOP = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'GENERATED', 'AS',
  'COLLATE', 'CONSTRAINT', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'COMMENT', 'ON', 'FIRST', 'AFTER',
  'IDENTITY',
]);

const OBJECT_WORDS = new Set([
  'TABLE', 'INDEX', 'VIEW', 'TRIGGER', 'FUNCTION', 'PROCEDURE', 'TYPE', 'SEQUENCE', 'POLICY',
  'SCHEMA', 'DATABASE', 'EXTENSION', 'ROLE', 'USER', 'DOMAIN', 'RULE', 'TABLESPACE', 'ALIAS',
]);

// Keywords that end a table reference list or can never be a bare table alias.
const NOT_ALIAS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN',
  'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'ON', 'USING', 'WINDOW', 'FOR', 'RETURNING',
  'SET', 'FETCH', 'SELECT', 'VALUES', 'WHEN', 'THEN', 'FROM', 'LATERAL', 'OUTER', 'STRAIGHT_JOIN',
  'PARTITION', 'TABLESAMPLE', 'WITH', 'INTO', 'FORCE', 'USE', 'IGNORE', 'LOCK', 'OF', 'NOWAIT',
]);

/** Token cursor. Reads past the end yield an EOF token so grammar code stays branch-light. */
class Cur {
  constructor(tokens, src) { this.tokens = tokens; this.src = src; this.i = 0; }
  get done() { return this.i >= this.tokens.length; }
  peek(o = 0) { return this.tokens[this.i + o] ?? EOF; }
  next() { return this.tokens[this.i++] ?? EOF; }
  isWord(...ws) { const t = this.peek(); return t.t === 'word' && ws.includes(t.u); }
  isPunct(v) { const t = this.peek(); return t.t === 'punct' && t.v === v; }
  eat(...ws) { if (this.isWord(...ws)) { this.i++; return true; } return false; }
  eatSeq(...ws) {
    for (let k = 0; k < ws.length; k++) if (!(this.peek(k).t === 'word' && this.peek(k).u === ws[k])) return false;
    this.i += ws.length;
    return true;
  }
  eatPunct(v) { if (this.isPunct(v)) { this.i++; return true; } return false; }
  /** Consume a balanced `( ... )` group starting at the current `(`; returns inner tokens. */
  group() {
    if (!this.isPunct('(')) return [];
    this.i++;
    const inner = [];
    let depth = 1;
    while (!this.done) {
      const t = this.next();
      if (t.t === 'punct' && t.v === '(') depth++;
      else if (t.t === 'punct' && t.v === ')') { depth--; if (depth === 0) break; }
      inner.push(t);
    }
    return inner;
  }
  rest() { const r = this.tokens.slice(this.i); this.i = this.tokens.length; return r; }
  slice(toks) { return toks.length ? this.src.slice(toks[0].s, toks.at(-1).e).replace(/\s+/g, ' ').trim() : ''; }
}

/** Split tokens at top-level commas. */
function splitTop(tokens, sep = ',') {
  const parts = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.t === 'punct') {
      if (t.v === '(' || t.v === '[') depth++;
      else if (t.v === ')' || t.v === ']') depth = Math.max(0, depth - 1);
      else if (t.v === sep && depth === 0) { parts.push(cur); cur = []; continue; }
    }
    cur.push(t);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

const isIdent = (t) => t.t === 'word' || t.t === 'qident';

/** Parse `a.b.c` into {schema, name, db}. Unquoted parts fold to lower case. */
function parseName(c) {
  if (!isIdent(c.peek())) return null;
  const parts = [identValue(c.next())];
  while (c.isPunct('.') && (isIdent(c.peek(1)) || c.peek(1).v === '*')) {
    c.i++;
    parts.push(identValue(c.next()));
  }
  const name = parts.at(-1);
  const schema = parts.length > 1 ? parts.at(-2) : null;
  return { schema, name, db: parts.length > 2 ? parts[0] : null };
}

function parseNameList(c) {
  const names = [];
  for (;;) {
    const n = parseName(c);
    if (!n) break;
    names.push(n);
    if (!c.eatPunct(',')) break;
  }
  return names;
}

function identList(tokens) {
  return splitTop(tokens).map((p) => {
    const t = p.find((x) => isIdent(x));
    return t ? identValue(t) : null;
  }).filter(Boolean);
}

/** Render a type from tokens: `character varying(255)`, `numeric(10,2)`, `int[]`. */
function typeText(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.t === 'punct' && ['(', ')', ',', '[', ']'].includes(t.v)) { out += t.v; continue; }
    const piece = t.t === 'string' ? `'${t.v}'` : t.t === 'qident' ? `"${t.v}"` : t.v.toLowerCase();
    out += (out === '' || /[(,[]$/.test(out)) ? piece : ` ${piece}`;
  }
  return out;
}

function fkActions(c, ref) {
  for (;;) {
    if (c.eatSeq('NOT', 'VALID')) { ref.not_valid = true; continue; }
    if (c.eatSeq('NOT', 'DEFERRABLE')) continue;
    if (c.eat('DEFERRABLE')) { ref.deferrable = true; continue; }
    if (c.eatSeq('INITIALLY') || c.isWord('INITIALLY')) { c.eat('INITIALLY'); c.next(); continue; }
    if (c.eat('MATCH')) { c.next(); continue; }
    if (c.isWord('ON') && (c.peek(1).u === 'DELETE' || c.peek(1).u === 'UPDATE')) {
      c.i++;
      const which = c.next().u === 'DELETE' ? 'on_delete' : 'on_update';
      let act = c.next().u;
      if (act === 'NO') { c.next(); act = 'NO ACTION'; } else if (act === 'SET') { act = `SET ${c.next().u}`; if (c.isPunct('(')) c.group(); }
      ref[which] = act;
      continue;
    }
    return;
  }
}

/** `REFERENCES tbl [(cols)] ...` after the REFERENCES keyword. */
function parseReferences(c, constraint) {
  const t = parseName(c);
  constraint.ref_table = t;
  constraint.ref_columns = c.isPunct('(') ? identList(c.group()) : [];
  fkActions(c, constraint);
}

function newConstraint(kind, name) {
  return { kind, name: name ?? null, columns: [], ref_table: null, ref_columns: [], on_delete: null, on_update: null, expr: null, not_valid: false, deferrable: false, using_index: null };
}

/** Constraint tail flags shared by every constraint kind. */
function constraintTail(c, con) {
  for (;;) {
    if (c.eatSeq('NOT', 'VALID')) { con.not_valid = true; continue; }
    if (c.eatSeq('NOT', 'DEFERRABLE')) continue;
    if (c.eat('DEFERRABLE')) { con.deferrable = true; continue; }
    if (c.eat('INITIALLY')) { c.next(); continue; }
    if (c.eatSeq('NO', 'INHERIT')) continue;
    if (c.eatSeq('USING', 'INDEX')) {
      if (c.isWord('TABLESPACE')) { c.i++; c.next(); continue; }
      con.using_index = parseName(c)?.name ?? null;
      continue;
    }
    if (c.eat('ENFORCED') || c.eatSeq('NOT', 'ENFORCED')) continue;
    if (c.eat('INCLUDE') && c.isPunct('(')) { c.group(); continue; }
    if (c.eat('WITH') && c.isPunct('(')) { c.group(); continue; }
    return;
  }
}

/** Table/ALTER constraint body, after any `CONSTRAINT name`. Returns null if not one. */
function parseConstraintBody(c, name) {
  if (c.eatSeq('PRIMARY', 'KEY')) {
    const k = newConstraint('primary_key', name);
    if (c.isWord('USING')) c.i += 2; // mysql: PRIMARY KEY USING BTREE (cols)
    if (c.isPunct('(')) k.columns = identList(c.group());
    constraintTail(c, k);
    return k;
  }
  if (c.isWord('UNIQUE')) {
    c.i++;
    const k = newConstraint('unique', name);
    if (c.isWord('KEY', 'INDEX')) c.i++;
    c.eatSeq('NULLS', 'NOT', 'DISTINCT');
    if (!c.isPunct('(') && isIdent(c.peek()) && !c.isWord('USING')) k.name = k.name ?? identValue(c.next());
    if (c.isPunct('(')) k.columns = identList(c.group());
    constraintTail(c, k);
    return k;
  }
  if (c.eatSeq('FOREIGN', 'KEY')) {
    const k = newConstraint('foreign_key', name);
    if (!c.isPunct('(') && isIdent(c.peek())) k.name = k.name ?? identValue(c.next());
    if (c.isPunct('(')) k.columns = identList(c.group());
    if (c.eat('REFERENCES')) parseReferences(c, k);
    constraintTail(c, k);
    return k;
  }
  if (c.isWord('CHECK')) {
    c.i++;
    const k = newConstraint('check', name);
    const inner = c.isPunct('(') ? c.group() : [];
    k.expr = c.slice(inner);
    constraintTail(c, k);
    return k;
  }
  if (c.isWord('EXCLUDE')) {
    c.i++;
    const k = newConstraint('exclude', name);
    k.expr = c.slice(c.rest());
    return k;
  }
  return null;
}

/** Default value: a term, then any `::cast`, operators and further terms. */
function parseDefault(c) {
  const startIdx = c.i;
  const term = () => {
    const t = c.peek();
    if (t.t === 'punct' && t.v === '(') { c.group(); return; }
    if (t.t === 'punct' && (t.v === '-' || t.v === '+')) { c.i++; term(); return; }
    c.i++;
    if (t.t === 'word' && ['INTERVAL', 'DATE', 'TIMESTAMP', 'TIME'].includes(t.u) && c.peek().t === 'string') c.i++;
    else if (t.t === 'word' && c.isPunct('(')) c.group();
  };
  term();
  for (;;) {
    if (c.isPunct('::')) {
      c.i++;
      while (c.peek().t === 'word' && !COLUMN_STOP.has(c.peek().u)) {
        c.i++;
        if (c.isPunct('(')) c.group();
      }
      while (c.isPunct('[') && c.peek(1).v === ']') c.i += 2;
      continue;
    }
    const t = c.peek();
    if (t.t === 'punct' && ['+', '-', '*', '/', '||', '%'].includes(t.v)) { c.i++; term(); continue; }
    break;
  }
  const used = c.tokens.slice(startIdx, c.i);
  const expr = used.length ? c.src.slice(used[0].s, used.at(-1).e).replace(/\s+/g, ' ').trim() : '';
  const lower = expr.toLowerCase();
  const single = used.length === 1 || (used.length === 2 && used[0].t === 'punct');
  const literal = (single && ['string', 'number'].includes(used.at(-1).t)) || ['true', 'false', 'null'].includes(lower);
  return {
    expr,
    kind: lower === 'null' ? 'null' : literal ? 'literal' : /\(/.test(expr) || STABLE_FN.test(expr) ? 'function' : 'expression',
    volatile: VOLATILE_FN.test(expr),
    stable_function: !VOLATILE_FN.test(expr) && STABLE_FN.test(expr),
  };
}

/** Parse one column definition from its element cursor (name first). */
function parseColumnDef(e) {
  const nameTok = e.next();
  const col = {
    name: identValue(nameTok), type: '', nullable: true, default: null, identity: null,
    generated: null, collation: null, comment: null, position: null, constraints: [],
  };
  const typeToks = [];
  while (!e.done && !(e.peek().t === 'word' && COLUMN_STOP.has(e.peek().u))) {
    if (e.isPunct('(')) typeToks.push({ t: 'punct', v: '(' }, ...e.group(), { t: 'punct', v: ')' });
    else typeToks.push(e.next());
  }
  col.type = typeText(typeToks);
  if (/^(small|big)?serial\d*$/.test(col.type)) col.identity = 'serial';
  let pending = null;
  while (!e.done) {
    if (e.eat('CONSTRAINT')) { pending = identValue(e.next()); continue; }
    if (e.eatSeq('NOT', 'NULL')) { col.nullable = false; continue; }
    if (e.eat('NULL')) { continue; }
    if (e.eat('DEFAULT')) { col.default = parseDefault(e); continue; }
    if (e.isWord('PRIMARY') && e.peek(1).u === 'KEY') {
      e.i += 2;
      col.nullable = false;
      const k = newConstraint('primary_key', pending); k.columns = [col.name];
      constraintTail(e, k);
      col.constraints.push(k); pending = null;
      continue;
    }
    if (e.isWord('UNIQUE')) {
      e.i++;
      if (e.isWord('KEY', 'INDEX')) e.i++;
      e.eatSeq('NULLS', 'NOT', 'DISTINCT');
      const k = newConstraint('unique', pending); k.columns = [col.name];
      constraintTail(e, k);
      col.constraints.push(k); pending = null;
      continue;
    }
    if (e.eat('REFERENCES')) {
      const k = newConstraint('foreign_key', pending); k.columns = [col.name];
      parseReferences(e, k);
      col.constraints.push(k); pending = null;
      continue;
    }
    if (e.isWord('CHECK')) {
      const k = parseConstraintBody(e, pending);
      k.columns = [col.name];
      col.constraints.push(k); pending = null;
      continue;
    }
    if (e.eat('GENERATED')) {
      const mode = e.eat('ALWAYS') ? 'always' : e.eatSeq('BY', 'DEFAULT') ? 'by default' : 'always';
      if (e.eat('AS')) {
        if (e.eat('IDENTITY')) {
          col.identity = mode;
          if (e.isPunct('(')) e.group();
        } else if (e.isPunct('(')) {
          const expr = e.slice(e.group());
          const stored = e.eat('STORED');
          if (!stored) e.eat('VIRTUAL');
          col.generated = { expr, stored };
        }
      }
      continue;
    }
    if (e.isWord('AS') && e.peek(1).v === '(') {
      e.i++;
      const expr = e.slice(e.group());
      const stored = e.eat('STORED');
      if (!stored) e.eat('VIRTUAL');
      col.generated = { expr, stored };
      continue;
    }
    if (e.eat('IDENTITY')) { col.identity = 'identity'; if (e.isPunct('(')) e.group(); continue; }
    if (e.eat('AUTO_INCREMENT') || e.eat('AUTOINCREMENT')) { col.identity = 'auto_increment'; continue; }
    if (e.eat('COLLATE')) { col.collation = identValue(e.next()); continue; }
    if (e.eat('COMMENT')) { col.comment = e.next().v; continue; }
    if (e.isWord('ON') && e.peek(1).u === 'UPDATE') { e.i += 2; parseDefault(e); continue; }
    if (e.eat('FIRST')) { col.position = 'first'; continue; }
    if (e.eat('AFTER')) { col.position = `after ${identValue(e.next())}`; continue; }
    e.i++; // unknown trailing option: skip, never loop
  }
  return col;
}

/** Index key list: `(a, b DESC, lower(c))` -> [{expr, name}] */
function parseIndexKeys(tokens) {
  return splitTop(tokens).map((p) => {
    const first = p[0];
    const simple = first && isIdent(first) && (p.length === 1 || !(p[1].t === 'punct' && p[1].v === '('));
    return {
      expr: p.length ? p.map((t) => t.v).join(' ') : '',
      name: simple ? identValue(first) : null,
      order: p.some((t) => t.u === 'DESC') ? 'desc' : 'asc',
    };
  });
}

function tailOptions(c, st) {
  // MySQL online-DDL clauses may trail CREATE INDEX / DROP INDEX / ALTER TABLE.
  while (!c.done) {
    if (c.isWord('ALGORITHM') || c.isWord('LOCK')) {
      const key = c.next().u.toLowerCase();
      c.eatPunct('=');
      st[key] = c.next().v.toUpperCase();
      c.eatPunct(',');
      continue;
    }
    c.i++;
  }
}

// ---------------------------------------------------------------- CREATE

function parseCreateTable(c, st) {
  st.kind = 'create_table';
  if (c.eatSeq('IF', 'NOT', 'EXISTS')) st.if_not_exists = true;
  st.table = parseName(c);
  Object.assign(st, { columns: [], constraints: [], indexes: [], like: [], partition_by: null, partition_of: null, as_select: false, source_tables: [] });
  if (c.eatSeq('PARTITION', 'OF')) {
    st.partition_of = parseName(c);
    return;
  }
  if (c.isWord('LIKE')) { c.i++; const n = parseName(c); if (n) st.like.push(n); return; }
  if (c.isPunct('(')) {
    for (const el of splitTop(c.group())) {
      const e = new Cur(el, c.src);
      let cname = null;
      if (e.eat('CONSTRAINT')) cname = identValue(e.next());
      if (e.isWord('LIKE')) { e.i++; const n = parseName(e); if (n) st.like.push(n); continue; }
      if (e.isWord('PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE') && (e.peek(1).v !== undefined)) {
        const k = parseConstraintBody(e, cname);
        if (k) { st.constraints.push(k); continue; }
      }
      if (e.isWord('KEY', 'INDEX', 'FULLTEXT', 'SPATIAL') && !(e.peek(1).t === 'word' && COLUMN_STOP.has(e.peek(1).u))) {
        const kind = e.next().u;
        if (kind === 'FULLTEXT' || kind === 'SPATIAL') e.eat('KEY', 'INDEX');
        const nm = isIdent(e.peek()) && !e.isPunct('(') ? identValue(e.next()) : null;
        const keys = e.isPunct('(') ? parseIndexKeys(e.group()) : [];
        st.indexes.push({ name: nm, columns: keys.map((k) => k.name ?? k.expr), unique: false, fulltext: kind === 'FULLTEXT' });
        continue;
      }
      if (!e.done && isIdent(e.peek())) st.columns.push(parseColumnDef(e));
    }
    for (const col of st.columns) for (const k of col.constraints) st.constraints.push(k);
  }
  // Table options after the column list.
  while (!c.done) {
    if (c.eatSeq('PARTITION', 'BY')) {
      const type = c.next().u;
      st.partition_by = { type, columns: c.isPunct('(') ? parseIndexKeys(c.group()).map((k) => k.name ?? k.expr) : [] };
      continue;
    }
    if (c.eat('AS')) {
      st.as_select = true;
      st.source_tables = extractTables(c.rest(), c.src).tables.map(stripRole);
      break;
    }
    if (c.isWord('SELECT')) {
      st.as_select = true;
      st.source_tables = extractTables(c.rest(), c.src).tables.map(stripRole);
      break;
    }
    c.i++;
  }
}

function parseCreateIndex(c, st) {
  st.kind = 'create_index';
  if (c.eat('CONCURRENTLY')) st.concurrently = true;
  if (c.eatSeq('IF', 'NOT', 'EXISTS')) st.if_not_exists = true;
  st.name = c.isWord('ON') ? null : (parseName(c)?.name ?? null);
  if (c.eat('ON')) { c.eat('ONLY'); st.table = parseName(c); }
  st.method = null; st.columns = []; st.include = []; st.where = null;
  while (!c.done) {
    if (c.eat('USING')) { st.method = c.next().v.toLowerCase(); continue; }
    if (c.isPunct('(')) { st.columns = parseIndexKeys(c.group()); continue; }
    if (c.eat('INCLUDE') && c.isPunct('(')) { st.include = identList(c.group()); continue; }
    if (c.eat('WHERE')) {
      const rest = [];
      while (!c.done && !c.isWord('ALGORITHM', 'LOCK', 'TABLESPACE', 'WITH')) rest.push(c.next());
      st.where = c.slice(rest);
      continue;
    }
    if (c.isWord('ALGORITHM', 'LOCK')) { tailOptions(c, st); break; }
    c.i++;
  }
}

function parseCreateView(c, st, flags) {
  st.kind = 'create_view';
  st.materialized = flags.has('MATERIALIZED');
  if (c.eatSeq('IF', 'NOT', 'EXISTS')) st.if_not_exists = true;
  st.name = parseName(c);
  if (c.isPunct('(')) c.group();
  const body = [];
  let seenAs = false;
  let withNoData = false;
  while (!c.done) {
    const t = c.next();
    if (!seenAs) { if (t.t === 'word' && t.u === 'AS') seenAs = true; continue; }
    body.push(t);
  }
  const tail = body.slice(-3).map((t) => t.u).join(' ');
  if (tail.endsWith('WITH NO DATA')) withNoData = true;
  st.with_no_data = withNoData;
  st.sources = extractTables(body, c.src).tables.map(stripRole);
}

function parseCreateTrigger(c, st) {
  st.kind = 'create_trigger';
  st.name = parseName(c)?.name ?? null;
  st.timing = null; st.events = []; st.table = null; st.function = null;
  while (!c.done) {
    if (!st.timing && c.isWord('BEFORE', 'AFTER')) { st.timing = c.next().u; continue; }
    if (!st.timing && c.eatSeq('INSTEAD', 'OF')) { st.timing = 'INSTEAD OF'; continue; }
    if (c.isWord('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') && !st.table) {
      st.events.push(c.next().u);
      if (c.eat('OF')) while (isIdent(c.peek()) && !c.isWord('ON', 'OR')) { c.i++; c.eatPunct(','); }
      continue;
    }
    if (c.eat('ON')) { st.table = parseName(c); continue; }
    if (c.isWord('EXECUTE')) {
      c.i++;
      c.eat('FUNCTION', 'PROCEDURE');
      st.function = parseName(c);
      break;
    }
    c.i++;
  }
}

function parseCreateType(c, st) {
  st.kind = 'create_type';
  st.name = parseName(c);
  st.variant = null; st.values = [];
  if (c.eat('AS')) {
    if (c.eat('ENUM')) { st.variant = 'enum'; st.values = c.isPunct('(') ? splitTop(c.group()).map((p) => p[0]?.v ?? '') : []; } else if (c.eat('RANGE')) st.variant = 'range';
    else st.variant = 'composite';
  }
}

function parseGrant(c, st, revoke) {
  st.kind = revoke ? 'revoke' : 'grant';
  if (revoke && c.eatSeq('GRANT', 'OPTION', 'FOR')) { /* privilege-level form */ }
  const privs = [];
  while (!c.done && !c.isWord('ON', 'TO', 'FROM')) {
    const t = c.next();
    if (t.t === 'word') privs.push(t.u);
    if (c.isPunct('(')) c.group(); // column list
  }
  st.privileges = privs.filter((p) => p !== 'PRIVILEGES');
  st.object_type = 'table'; st.objects = []; st.all_in_schema = null; st.roles = [];
  if (c.eat('ON')) {
    if (c.eatSeq('ALL')) {
      const what = c.next().u.toLowerCase();
      c.eatSeq('IN', 'SCHEMA');
      st.object_type = what; st.all_in_schema = parseName(c)?.name ?? null;
    } else {
      const kw = c.peek().u;
      if (['TABLE', 'SEQUENCE', 'SCHEMA', 'DATABASE', 'FUNCTION', 'PROCEDURE', 'TYPE', 'DOMAIN'].includes(kw)) { st.object_type = kw.toLowerCase(); c.i++; }
      st.objects = parseNameList(c);
    }
  } else st.role_membership = true; // GRANT role TO role
  if (c.eat('TO', 'FROM')) {
    while (!c.done) {
      if (c.isWord('WITH')) break;
      c.eat('GROUP', 'ROLE', 'USER');
      const t = c.next();
      if (isIdent(t)) st.roles.push(identValue(t));
      if (!c.eatPunct(',')) break;
    }
    if (c.isWord('WITH') && c.peek(1).u === 'GRANT') st.with_grant_option = true;
  }
}

function parseCreate(c, st) {
  c.i++; // CREATE
  const flags = new Set();
  let object = null;
  for (let k = 0; k < 14 && !c.done; k++) {
    const t = c.peek();
    if (t.t === 'word' && OBJECT_WORDS.has(t.u) && !(t.u === 'TYPE' && c.peek(1).v === '=')) { object = t.u; c.i++; break; }
    if (t.t === 'word') flags.add(t.u);
    c.i++;
  }
  st.temporary = flags.has('TEMP') || flags.has('TEMPORARY');
  st.unlogged = flags.has('UNLOGGED');
  st.or_replace = flags.has('REPLACE');
  switch (object) {
    case 'TABLE': parseCreateTable(c, st); break;
    case 'INDEX':
      st.unique = flags.has('UNIQUE'); st.fulltext = flags.has('FULLTEXT');
      parseCreateIndex(c, st);
      break;
    case 'VIEW': parseCreateView(c, st, flags); break;
    case 'TRIGGER': parseCreateTrigger(c, st); break;
    case 'FUNCTION': case 'PROCEDURE': {
      st.kind = 'create_function'; st.routine = object.toLowerCase();
      c.eatSeq('IF', 'NOT', 'EXISTS');
      st.name = parseName(c);
      if (c.isPunct('(')) c.group();
      st.language = null;
      while (!c.done) { if (c.eat('LANGUAGE')) { st.language = c.next().v.toLowerCase(); break; } c.i++; }
      break;
    }
    case 'TYPE': parseCreateType(c, st); break;
    case 'SEQUENCE': st.kind = 'create_sequence'; c.eatSeq('IF', 'NOT', 'EXISTS'); st.name = parseName(c); break;
    case 'POLICY': {
      st.kind = 'create_policy';
      st.name = identValue(c.next());
      if (c.eat('ON')) st.table = parseName(c);
      st.command = 'ALL'; st.roles = [];
      while (!c.done) {
        if (c.eat('FOR')) { st.command = c.next().u; continue; }
        if (c.eat('TO')) { while (isIdent(c.peek())) { st.roles.push(identValue(c.next())); if (!c.eatPunct(',')) break; } continue; }
        c.i++;
      }
      break;
    }
    case 'SCHEMA': st.kind = 'create_schema'; c.eatSeq('IF', 'NOT', 'EXISTS'); st.name = parseName(c)?.name ?? null; break;
    case 'ROLE': case 'USER': st.kind = 'create_role'; c.eatSeq('IF', 'NOT', 'EXISTS'); st.name = parseName(c)?.name ?? null; break;
    case 'EXTENSION': st.kind = 'create_extension'; c.eatSeq('IF', 'NOT', 'EXISTS'); st.name = parseName(c)?.name ?? null; break;
    default: st.kind = 'unknown';
  }
}

// ---------------------------------------------------------------- ALTER

function parseAlterAction(tokens, src) {
  const a = new Cur(tokens, src);
  const text = a.slice(tokens);
  const act = (action, extra = {}) => [{ action, text, ...extra }];
  if (a.done) return [];

  if (a.eat('ADD')) {
    if (a.isWord('CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE')) {
      let nm = null;
      if (a.eat('CONSTRAINT')) nm = identValue(a.next());
      const k = parseConstraintBody(a, nm);
      if (k) return act('add_constraint', { constraint: k });
    }
    if (a.isWord('INDEX', 'KEY', 'FULLTEXT', 'SPATIAL')) {
      const kind = a.next().u;
      if (kind === 'FULLTEXT' || kind === 'SPATIAL') a.eat('INDEX', 'KEY');
      const nm = isIdent(a.peek()) && !a.isPunct('(') ? identValue(a.next()) : null;
      const keys = a.isPunct('(') ? parseIndexKeys(a.group()) : [];
      return act('add_index', { name: nm, columns: keys.map((k) => k.name ?? k.expr), fulltext: kind === 'FULLTEXT' });
    }
    if (a.isWord('PARTITION')) return act('other');
    a.eat('COLUMN');
    const ine = a.eatSeq('IF', 'NOT', 'EXISTS');
    if (a.isPunct('(')) { // MySQL: ADD COLUMN (a int, b int)
      return splitTop(a.group()).map((p) => ({ action: 'add_column', text, column: parseColumnDef(new Cur(p, src)), if_not_exists: ine }));
    }
    if (!isIdent(a.peek())) return act('other');
    return act('add_column', { column: parseColumnDef(a), if_not_exists: ine });
  }

  if (a.eat('DROP')) {
    if (a.eatSeq('PRIMARY', 'KEY')) return act('drop_constraint', { name: 'PRIMARY', constraint_kind: 'primary_key' });
    if (a.eatSeq('FOREIGN', 'KEY')) return act('drop_constraint', { name: identValue(a.next()), constraint_kind: 'foreign_key' });
    if (a.isWord('INDEX', 'KEY')) { a.i++; return act('drop_index', { name: identValue(a.next()) }); }
    if (a.isWord('CHECK')) { a.i++; return act('drop_constraint', { name: identValue(a.next()), constraint_kind: 'check' }); }
    if (a.eat('CONSTRAINT')) {
      const ie = a.eatSeq('IF', 'EXISTS');
      return act('drop_constraint', { name: identValue(a.next()), if_exists: ie });
    }
    a.eat('COLUMN');
    const ie = a.eatSeq('IF', 'EXISTS');
    if (a.isWord('PARTITION')) return act('other');
    return act('drop_column', { name: identValue(a.next()), if_exists: ie, cascade: tokens.some((t) => t.u === 'CASCADE') });
  }

  if (a.eat('ALTER')) {
    if (a.isWord('CONSTRAINT')) return act('alter_constraint');
    if (a.isWord('INDEX')) return act('other');
    a.eat('COLUMN');
    const col = identValue(a.next());
    if (a.isWord('SET') && a.peek(1).u === 'DATA' || a.isWord('TYPE') || (a.isWord('SET') && a.peek(1).u === 'TYPE')) {
      a.eat('SET'); a.eat('DATA'); a.eat('TYPE');
      const tt = [];
      while (!a.done && !a.isWord('USING', 'COLLATE')) {
        if (a.isPunct('(')) tt.push({ t: 'punct', v: '(' }, ...a.group(), { t: 'punct', v: ')' });
        else tt.push(a.next());
      }
      let collation = null; let using = null;
      if (a.eat('COLLATE')) collation = identValue(a.next());
      if (a.eat('USING')) using = a.slice(a.rest());
      return act('alter_column_type', { column: col, type: typeText(tt), using, collation });
    }
    if (a.eatSeq('SET', 'NOT', 'NULL')) return act('set_not_null', { column: col });
    if (a.eatSeq('DROP', 'NOT', 'NULL')) return act('drop_not_null', { column: col });
    if (a.eatSeq('SET', 'DEFAULT')) return act('set_default', { column: col, default: parseDefault(a) });
    if (a.eatSeq('DROP', 'DEFAULT')) return act('drop_default', { column: col });
    return act('alter_column_other', { column: col });
  }

  if (a.eat('RENAME')) {
    if (a.eat('CONSTRAINT')) { const from = identValue(a.next()); a.eat('TO'); return act('rename_constraint', { from, to: identValue(a.next()) }); }
    if (a.isWord('INDEX', 'KEY')) { a.i++; const from = identValue(a.next()); a.eat('TO'); return act('rename_index', { from, to: identValue(a.next()) }); }
    if (a.isWord('TO', 'AS')) { a.i++; return act('rename_table', { to: parseName(a) }); }
    a.eat('COLUMN');
    const from = identValue(a.next());
    if (a.eat('TO')) return act('rename_column', { from, to: identValue(a.next()) });
    return act('rename_table', { to: { schema: null, name: from } });
  }

  if (a.eatSeq('VALIDATE', 'CONSTRAINT')) return act('validate_constraint', { name: identValue(a.next()) });
  if (a.eatSeq('SET', 'TABLESPACE')) return act('set_tablespace', { tablespace: identValue(a.next()) });
  if (a.eatSeq('SET', 'LOGGED')) return act('set_logged');
  if (a.eatSeq('SET', 'UNLOGGED')) return act('set_unlogged');
  if (a.eatSeq('SET', 'SCHEMA')) return act('set_schema', { schema: identValue(a.next()) });
  if (a.eatSeq('OWNER', 'TO')) return act('owner_to', { owner: identValue(a.next()) });
  if (a.eat('ATTACH')) {
    a.eat('PARTITION');
    const part = parseName(a);
    return act('attach_partition', { partition: part, default: a.isWord('DEFAULT'), bounds: a.slice(a.rest()) });
  }
  if (a.eat('DETACH')) {
    a.eat('PARTITION');
    const part = parseName(a);
    const rest = a.rest().map((t) => t.u);
    return act('detach_partition', { partition: part, concurrently: rest.includes('CONCURRENTLY'), finalize: rest.includes('FINALIZE') });
  }
  if (a.isWord('ENABLE', 'DISABLE', 'FORCE') || a.isWord('NO')) {
    const rest = tokens.map((t) => t.u).join(' ');
    if (/ROW LEVEL SECURITY/.test(rest)) {
      const verb = tokens[0].u === 'NO' ? 'NO FORCE' : tokens[0].u;
      return act('row_level_security', { mode: verb.toLowerCase() });
    }
    return act('other');
  }
  if (a.isWord('MODIFY')) {
    a.i++; a.eat('COLUMN');
    return act('modify_column', { column: parseColumnDef(a) });
  }
  if (a.isWord('CHANGE')) {
    a.i++; a.eat('COLUMN');
    const from = identValue(a.next());
    return act('change_column', { from, column: parseColumnDef(a) });
  }
  if (a.isWord('ALGORITHM')) { a.i++; a.eatPunct('='); return act('algorithm', { value: a.next().v.toUpperCase() }); }
  if (a.isWord('LOCK')) { a.i++; a.eatPunct('='); return act('lock', { value: a.next().v.toUpperCase() }); }
  if (a.isWord('ENGINE')) { a.i++; a.eatPunct('='); return act('set_engine', { engine: a.next().v.toLowerCase() }); }
  if (a.isWord('CONVERT')) return act('convert_charset');
  return act('other');
}

function parseAlterTable(c, st) {
  st.kind = 'alter_table';
  if (c.eatSeq('IF', 'EXISTS')) st.if_exists = true;
  c.eat('ONLY');
  st.table = parseName(c);
  c.eatPunct('*');
  st.actions = [];
  for (const part of splitTop(c.rest())) st.actions.push(...parseAlterAction(part, c.src));
  for (const a of st.actions) {
    if (a.action === 'algorithm') st.algorithm = a.value;
    if (a.action === 'lock') st.lock = a.value;
  }
  st.actions = st.actions.filter((a) => a.action !== 'algorithm' && a.action !== 'lock');
}

function parseAlter(c, st) {
  c.i++; // ALTER
  if (c.isWord('TABLE')) { c.i++; parseAlterTable(c, st); return; }
  if (c.isWord('TYPE') || c.isWord('DOMAIN')) {
    c.i++;
    st.kind = 'alter_type';
    st.name = parseName(c);
    st.action = 'other'; st.value = null; st.if_not_exists = false;
    if (c.eatSeq('ADD', 'VALUE')) {
      st.action = 'add_value';
      st.if_not_exists = c.eatSeq('IF', 'NOT', 'EXISTS');
      st.value = c.next().v;
    } else if (c.eatSeq('RENAME', 'VALUE')) st.action = 'rename_value';
    else if (c.eatSeq('RENAME', 'TO')) st.action = 'rename';
    return;
  }
  const obj = c.next().u.toLowerCase();
  st.kind = 'alter_other';
  st.object = obj;
  st.name = parseName(c);
  st.text_tail = c.slice(c.rest());
}

// ---------------------------------------------------------------- DROP

function parseDrop(c, st) {
  c.i++; // DROP
  c.eat('TEMPORARY', 'TEMP');
  const materialized = c.eat('MATERIALIZED');
  const obj = c.next().u;
  const concurrently = c.eat('CONCURRENTLY');
  const ie = c.eatSeq('IF', 'EXISTS');
  Object.assign(st, { if_exists: ie });
  const tailFlags = () => {
    const rest = c.rest().map((t) => t.u);
    st.cascade = rest.includes('CASCADE');
    return rest;
  };
  switch (obj) {
    case 'TABLE': st.kind = 'drop_table'; st.tables = parseNameList(c); tailFlags(); break;
    case 'INDEX': {
      st.kind = 'drop_index'; st.concurrently = concurrently; st.indexes = parseNameList(c);
      if (c.eat('ON')) st.table = parseName(c);
      tailOptions(c, st);
      break;
    }
    case 'VIEW': st.kind = 'drop_view'; st.materialized = materialized; st.views = parseNameList(c); tailFlags(); break;
    case 'TRIGGER': st.kind = 'drop_trigger'; st.name = parseName(c)?.name ?? null; if (c.eat('ON')) st.table = parseName(c); tailFlags(); break;
    case 'FUNCTION': case 'PROCEDURE': st.kind = 'drop_function'; st.name = parseName(c); tailFlags(); break;
    case 'TYPE': case 'DOMAIN': st.kind = 'drop_type'; st.name = parseName(c); tailFlags(); break;
    case 'SEQUENCE': st.kind = 'drop_sequence'; st.names = parseNameList(c); tailFlags(); break;
    case 'POLICY': st.kind = 'drop_policy'; st.name = identValue(c.next()); if (c.eat('ON')) st.table = parseName(c); break;
    case 'SCHEMA': case 'DATABASE': st.kind = 'drop_schema'; st.name = parseName(c)?.name ?? null; tailFlags(); break;
    default: st.kind = 'drop_other'; st.object = obj.toLowerCase();
  }
}

// ---------------------------------------------------------------- DML / SELECT

const stripRole = ({ schema, name, alias }) => ({ schema, name, alias });

/**
 * Find tables referenced by FROM / JOIN / UPDATE / INTO / USING-lists in a token run.
 * CTE names defined by WITH are excluded. Returns tables with a `role`
 * (`read` | `write`) and `joins` as pairs of adjacent table references.
 */
export function extractTables(tokens, src = '') {
  const toks = tokens;
  const n = toks.length;
  const ctes = new Set();
  const matching = new Array(n).fill(-1);
  const stack = [];
  for (let i = 0; i < n; i++) {
    const t = toks[i];
    if (t.t !== 'punct') continue;
    if (t.v === '(') stack.push(i);
    else if (t.v === ')' && stack.length) { const o = stack.pop(); matching[o] = i; matching[i] = o; }
  }
  // CTE names: WITH [RECURSIVE] name [(cols)] AS [[NOT] MATERIALIZED] ( ... ) [, name AS (...)]*
  for (let i = 0; i < n; i++) {
    if (!(toks[i].t === 'word' && toks[i].u === 'WITH')) continue;
    let j = i + 1;
    if (toks[j]?.u === 'RECURSIVE') j++;
    for (;;) {
      if (!toks[j] || !isIdent(toks[j])) break;
      const name = identValue(toks[j]);
      j++;
      if (toks[j]?.v === '(' && matching[j] > 0) j = matching[j] + 1;
      if (toks[j]?.u !== 'AS') break;
      j++;
      if (toks[j]?.u === 'NOT') j++;
      if (toks[j]?.u === 'MATERIALIZED') j++;
      if (toks[j]?.v !== '(' || matching[j] < 0) break;
      ctes.add(name);
      j = matching[j] + 1;
      if (toks[j]?.v === ',') { j++; continue; }
      break;
    }
  }

  const tables = [];
  const joins = [];
  const FUNC_FROM = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION']);
  const noFrom = []; // paren depth flags: inside EXTRACT( .. ) etc.
  let lastRef = null;

  const readRef = (i, role) => {
    // returns [nextIndex, refOrNull]
    let j = i;
    while (toks[j] && toks[j].t === 'word' && ['ONLY', 'LATERAL'].includes(toks[j].u)) j++;
    const t = toks[j];
    if (!t || !isIdent(t) || (t.t === 'word' && NOT_ALIAS.has(t.u) && t.u !== 'LATERAL')) return [j, null];
    const parts = [identValue(t)];
    j++;
    while (toks[j]?.v === '.' && toks[j].t === 'punct' && toks[j + 1] && isIdent(toks[j + 1])) {
      parts.push(identValue(toks[j + 1]));
      j += 2;
    }
    if (role === 'read' && toks[j]?.v === '(' && toks[j].t === 'punct') return [j, null]; // function call, not a table (INSERT INTO t (cols) is a table)
    const ref = { schema: parts.length > 1 ? parts.at(-2) : null, name: parts.at(-1), alias: null, role };
    if (toks[j]?.u === 'AS' && toks[j].t === 'word') j++;
    if (toks[j] && isIdent(toks[j]) && !(toks[j].t === 'word' && NOT_ALIAS.has(toks[j].u))) { ref.alias = identValue(toks[j]); j++; }
    if (ctes.has(ref.name) && !ref.schema) ref.cte = true;
    return [j, ref];
  };

  // fromActive[d]: a FROM list is open at paren depth d, so a top-level comma adds a table.
  const fromActive = [false];
  const TERMINATORS = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'RETURNING', 'FETCH', 'FOR', 'SELECT', 'SET', 'VALUES']);
  for (let i = 0; i < n; i++) {
    const t = toks[i];
    const depth = noFrom.length;
    if (t.t === 'punct') {
      if (t.v === '(') { noFrom.push(toks[i - 1]?.t === 'word' && FUNC_FROM.has(toks[i - 1].u)); fromActive[noFrom.length] = false; } else if (t.v === ')') { fromActive[noFrom.length] = false; noFrom.pop(); } else if (t.v === ',' && fromActive[depth] && !noFrom.at(-1)) {
        const [, ref] = readRef(i + 1, 'read');
        if (ref) { if (!ref.cte) tables.push(ref); lastRef = ref; }
      }
      continue;
    }
    if (t.t !== 'word') continue;
    const prev = toks[i - 1];
    if (t.u === 'FROM') {
      if (noFrom.at(-1) || (prev?.t === 'word' && prev.u === 'DISTINCT')) continue;
      const isDelete = prev?.u === 'DELETE';
      const [, ref] = readRef(i + 1, isDelete ? 'write' : 'read');
      fromActive[depth] = true;
      if (ref) { if (!ref.cte) tables.push(ref); lastRef = ref; }
    } else if (t.u === 'JOIN') {
      const [, ref] = readRef(i + 1, 'read');
      if (ref) {
        if (lastRef && !lastRef.cte && !ref.cte) joins.push({ left: { schema: lastRef.schema, name: lastRef.name }, right: { schema: ref.schema, name: ref.name } });
        if (!ref.cte) tables.push(ref);
        lastRef = ref;
      }
    } else if (t.u === 'UPDATE' && !['ON', 'FOR', 'BEFORE', 'AFTER', 'OF', 'KEY'].includes(prev?.u)) {
      const [, ref] = readRef(i + 1, 'write');
      if (ref) tables.push(ref);
    } else if (t.u === 'INTO' && ['INSERT', 'REPLACE', 'MERGE'].includes(prev?.u)) {
      const [, ref] = readRef(i + 1, 'write');
      if (ref) tables.push(ref);
    } else if (t.u === 'USING' && toks[i + 1]?.v !== '(' && ['DELETE', 'MERGE'].some((w) => toks.slice(0, i).some((x) => x.u === w))) {
      const [, ref] = readRef(i + 1, 'read');
      if (ref) tables.push(ref);
      fromActive[depth] = true;
    } else if (TERMINATORS.has(t.u)) {
      fromActive[depth] = false;
    }
  }
  return { tables, joins, ctes: [...ctes].sort() };
}

function depthZeroHas(tokens, word, from = 0) {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'punct') { if (t.v === '(') depth++; else if (t.v === ')') depth--; } else if (depth === 0 && t.t === 'word' && t.u === word) return true;
  }
  return false;
}

function parseDml(tokens, src, st, verb) {
  const { tables, joins, ctes } = extractTables(tokens, src);
  st.kind = verb.toLowerCase() === 'replace' ? 'insert' : verb.toLowerCase();
  const write = tables.find((t) => t.role === 'write');
  st.table = write ? { schema: write.schema, name: write.name } : null;
  // MySQL multi-table DELETE t1 FROM t1 JOIN t2: the target precedes FROM.
  if (st.kind === 'delete' && !st.table) {
    const i = tokens.findIndex((t) => t.u === 'DELETE');
    const c = new Cur(tokens, src); c.i = i + 1;
    const nm = parseName(c);
    if (nm) st.table = nm;
  }
  st.reads = tables.filter((t) => t !== write && t.role === 'read').map(stripRole);
  st.joins = joins;
  st.ctes = ctes;
  const hasWhere = depthZeroHas(tokens, 'WHERE');
  st.has_where = st.kind === 'insert' ? false : st.kind === 'merge' ? true : hasWhere;
  if (st.kind === 'insert') st.has_select = tokens.some((t) => t.u === 'SELECT');
}

function parseStatement(stmt, src, opts) {
  const tokens = stmt.tokens;
  const st = { kind: 'unknown', line: stmt.line, text: stmt.text };
  if (!tokens.length) return st;
  const c = new Cur(tokens, src);
  const first = c.peek();
  if (first.t !== 'word' && !(first.t === 'punct' && first.v === '(')) return st;
  let verb = first.u;
  // A leading WITH wraps SELECT or DML; the verb is the first top-level keyword after it.
  if (verb === 'WITH') {
    verb = 'SELECT';
    let depth = 0;
    for (const t of tokens) {
      if (t.t === 'punct') { if (t.v === '(') depth++; else if (t.v === ')') depth--; } else if (depth === 0 && t.t === 'word' && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(t.u)) { verb = t.u; break; }
    }
  }
  switch (verb) {
    case 'CREATE': parseCreate(c, st); break;
    case 'ALTER': parseAlter(c, st); break;
    case 'DROP': parseDrop(c, st); break;
    case 'INSERT': case 'REPLACE': case 'UPDATE': case 'DELETE': case 'MERGE': parseDml(tokens, src, st, verb); break;
    case 'SELECT': case 'VALUES': case 'TABLE': case '(': {
      const { tables, joins, ctes } = extractTables(tokens, src);
      st.kind = 'select';
      st.has_where = depthZeroHas(tokens, 'WHERE');
      st.reads = tables.map(stripRole);
      st.joins = joins;
      st.ctes = ctes;
      break;
    }
    case 'TRUNCATE': {
      c.i++; c.eat('TABLE'); c.eat('ONLY');
      st.kind = 'truncate';
      st.tables = parseNameList(c);
      st.cascade = tokens.some((t) => t.u === 'CASCADE');
      break;
    }
    case 'VACUUM': {
      c.i++;
      st.kind = 'vacuum';
      const inner = c.isPunct('(') ? c.group().map((t) => t.u) : [];
      st.full = inner.includes('FULL') || c.eat('FULL');
      while (c.isWord('FREEZE', 'VERBOSE', 'ANALYZE', 'ANALYSE')) c.i++;
      st.tables = parseNameList(c);
      break;
    }
    case 'CLUSTER': {
      c.i++; c.eat('VERBOSE');
      st.kind = 'cluster';
      st.table = parseName(c);
      if (c.eat('USING')) st.index = parseName(c)?.name ?? null;
      break;
    }
    case 'REINDEX': {
      c.i++;
      st.kind = 'reindex';
      if (c.isPunct('(')) c.group();
      st.target_type = c.next().u.toLowerCase();
      st.concurrently = c.eat('CONCURRENTLY');
      st.name = parseName(c);
      break;
    }
    case 'REFRESH': {
      c.i++;
      st.kind = 'refresh_matview';
      c.eat('MATERIALIZED'); c.eat('VIEW');
      st.concurrently = c.eat('CONCURRENTLY');
      st.name = parseName(c);
      st.with_no_data = tokens.slice(-3).map((t) => t.u).join(' ').endsWith('WITH NO DATA');
      break;
    }
    case 'GRANT': c.i++; parseGrant(c, st, false); break;
    case 'REVOKE': c.i++; parseGrant(c, st, true); break;
    case 'COMMENT': {
      c.i++; c.eat('ON');
      st.kind = 'comment';
      st.object = c.next().u.toLowerCase();
      st.name = parseName(c);
      break;
    }
    case 'RENAME': {
      c.i++;
      if (c.eat('TABLE')) {
        st.kind = 'rename_table';
        st.pairs = splitTop(c.rest()).map((p) => { const e = new Cur(p, src); const from = parseName(e); e.eat('TO'); return { from, to: parseName(e) }; });
      }
      break;
    }
    case 'BEGIN': case 'START': case 'COMMIT': case 'ROLLBACK': case 'END': case 'SAVEPOINT': case 'RELEASE':
      st.kind = 'transaction'; st.action = verb.toLowerCase(); break;
    case 'SET': st.kind = 'set'; break;
    default: break;
  }
  if (!opts.keepTokens) delete st.tokens;
  return st;
}

/**
 * Parse SQL text into structured statements. Never throws.
 * @param {string} sql
 * @param {{dialect?: 'postgresql'|'mysql'|'mariadb'|'sqlite'|'tsql'|'generic'}} [opts]
 * @returns {object[]}
 */
export function parseSql(sql, opts = {}) {
  let statements;
  try {
    statements = splitStatements(sql, opts);
  } catch {
    return [{ kind: 'unknown', line: 1, text: String(sql ?? '').slice(0, 2000) }];
  }
  const src = typeof sql === 'string' ? sql : String(sql ?? '');
  return statements.map((s) => {
    try {
      const st = parseStatement(s, src, opts);
      st.line = s.line;
      st.text = s.text;
      return st;
    } catch {
      return { kind: 'unknown', line: s.line, text: s.text };
    }
  });
}

export { splitStatements, tokenize } from './lexer.mjs';
