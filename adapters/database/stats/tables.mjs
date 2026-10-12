// The one SQL table extractor behind database query-statistics evidence. It is lexical and
// conservative: it reads FROM, JOIN, UPDATE, INSERT INTO, REPLACE INTO, DELETE FROM,
// MERGE INTO, TRUNCATE and SELECT ... INTO, skips CTE names, temporary tables and table
// variables, and reports what it could not read instead of guessing. It never executes
// anything and keeps no literal: comments and string literals are dropped first.

const WRITE_KINDS = new Set(['insert', 'update', 'delete', 'merge', 'truncate', 'replace']);
const READ_KINDS = new Set(['select', 'with', 'values', 'table']);
// Words that can follow a table reference and are therefore never its alias.
const NOT_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer', 'on', 'using', 'set', 'group', 'order', 'having',
  'limit', 'offset', 'union', 'intersect', 'except', 'returning', 'values', 'select', 'when', 'then', 'with', 'for', 'fetch',
  'window', 'lateral', 'straight_join', 'output', 'option', 'partition', 'tablesample', 'force', 'use', 'ignore', 'into', 'from',
  'apply', 'pivot', 'unpivot', 'by', 'and', 'or', 'not', 'is', 'in', 'as',
]);
const FUNCTION_PARENS = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);

/** Lexical tokens: `id` (bare word, lower-cased), `q` (quoted identifier), `var`, `lit` and `sym`. */
function tokenize(sql) {
  const out = [];
  const s = String(sql);
  const n = s.length;
  let i = 0;
  let unbalanced = false;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if ((c === '-' && s[i + 1] === '-') || (c === '#' && !/[\w#]/.test(s[i + 1] ?? ''))) { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) { unbalanced = true; break; }
      i = end + 2;
      continue;
    }
    if (c === '\'') {
      i++;
      let closed = false;
      while (i < n) {
        if (s[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (s[i] === '\'') {
          if (s[i + 1] === '\'') { i += 2; continue; }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) unbalanced = true;
      out.push({ t: 'lit' });
      continue;
    }
    if (c === '$') {
      const tag = /^\$([A-Za-z_]*)\$/.exec(s.slice(i));
      if (tag) {
        const end = s.indexOf(tag[0], i + tag[0].length);
        if (end < 0) { unbalanced = true; break; }
        i = end + tag[0].length;
      } else {
        i++;
        while (i < n && /\d/.test(s[i])) i++;
      }
      out.push({ t: 'lit' });
      continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < n) {
        if (s[j] === close) {
          if (s[j + 1] === close && c !== '[') { v += close; j += 2; continue; }
          closed = true;
          break;
        }
        v += s[j++];
      }
      if (!closed) { unbalanced = true; break; }
      i = j + 1;
      out.push({ t: 'q', v });
      continue;
    }
    if (/[A-Za-z_#@]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (/[\w$#@]/.test(s[j]) || s[j].charCodeAt(0) > 127)) j++;
      const raw = s.slice(i, j);
      out.push({ t: raw[0] === '@' ? 'var' : 'id', v: raw.toLowerCase() });
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(s[j])) j++;
      out.push({ t: 'lit' });
      i = j;
      continue;
    }
    out.push({ t: 'sym', v: c });
    i++;
  }
  return { tokens: out, unbalanced };
}

const isSym = (tok, v) => tok?.t === 'sym' && tok.v === v;
const isKw = (tok, ...words) => tok?.t === 'id' && words.includes(tok.v);
const isName = (tok) => tok?.t === 'id' || tok?.t === 'q';

/** Index just past the parenthesised group opening at `p`. */
function skipGroup(tokens, p) {
  let depth = 0;
  for (let q = p; q < tokens.length; q++) {
    if (isSym(tokens[q], '(')) depth++;
    else if (isSym(tokens[q], ')') && --depth === 0) return q + 1;
  }
  return tokens.length;
}

/**
 * Extract the tables one SQL text reads and writes.
 * @param {string} sql
 * @returns {{reads: string[], writes: string[], kind: string|null, has_where: boolean, parsed: boolean, note: string|null}}
 *   Names are `name` or `schema.name`, as written (unquoted names folded to lower case; a
 *   three- or four-part name is reduced to its last two parts). `parsed` is false when part
 *   of the text was not understood; the names found before that point are still returned.
 */
export function extractTables(sql) {
  const { tokens, unbalanced } = tokenize(sql);
  const reads = new Set();
  const writes = new Set();
  const ctes = new Set();
  let parsed = !unbalanced;
  let note = unbalanced ? 'unterminated quote or comment' : null;
  const fail = (why) => {
    if (parsed) { parsed = false; note = why; }
  };

  let k = 0;
  while (isSym(tokens[k], '(') || isSym(tokens[k], ';')) k++;
  const kind = tokens[k]?.t === 'id' ? tokens[k].v : null;
  if (!kind || !(WRITE_KINDS.has(kind) || READ_KINDS.has(kind))) {
    return { reads: [], writes: [], kind, has_where: false, parsed: false, note: kind ? `${kind} statements are not read` : 'no statement text' };
  }

  // CTE names: WITH [RECURSIVE] name [(cols)] AS [[NOT] MATERIALIZED] ( ... ) [, name ...]
  if (kind === 'with') {
    let p = k + 1;
    if (isKw(tokens[p], 'recursive')) p++;
    while (isName(tokens[p])) {
      ctes.add(tokens[p].v.toLowerCase());
      p++;
      if (isSym(tokens[p], '(')) p = skipGroup(tokens, p);
      if (!isKw(tokens[p], 'as')) break;
      p++;
      if (isKw(tokens[p], 'not')) p++;
      if (isKw(tokens[p], 'materialized')) p++;
      if (!isSym(tokens[p], '(')) break;
      p = skipGroup(tokens, p);
      if (isSym(tokens[p], ',')) p++;
      else break;
    }
  }

  /** A (possibly qualified) name at `p`: `{name, bare, next}` or null. */
  const readName = (p) => {
    const parts = [];
    let q = p;
    while (isName(tokens[q])) {
      parts.push(tokens[q].v);
      q++;
      if (isSym(tokens[q], '.') && isSym(tokens[q + 1], '.')) { q += 2; continue; } // db..table
      if (isSym(tokens[q], '.') && isName(tokens[q + 1])) { q++; continue; }
      break;
    }
    if (!parts.length) return null;
    const name = parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : parts[0];
    return { name, bare: parts[parts.length - 1], next: q };
  };

  /** Skip an optional alias (`[AS] name`). */
  const afterRef = (p) => {
    if (isKw(tokens[p], 'as') && isName(tokens[p + 1])) return p + 2;
    if (tokens[p]?.t === 'q' || (tokens[p]?.t === 'id' && !NOT_ALIAS.has(tokens[p].v))) return p + 1;
    return p;
  };

  const addRef = (target, ref) => {
    if (ctes.has(ref.name.toLowerCase()) || ref.bare.startsWith('#') || ref.bare.startsWith('@')) return;
    target.add(ref.name);
  };

  /** Table references after a keyword; `list` allows comma-separated successors (FROM a, b). */
  const tableRefs = (p, target, { list }) => {
    let q = p;
    for (;;) {
      while (isKw(tokens[q], 'only', 'lateral', 'table')) q++;
      const tok = tokens[q];
      if (isSym(tok, '(')) return; // subquery or parenthesised join: the scan reads inside it
      if (tok?.t === 'var' || tok?.t === 'lit') { fail('table variable or parameter'); return; }
      const ref = readName(q);
      if (!ref) { fail(`no table name after ${tokens[p - 1]?.v ?? 'keyword'}`); return; }
      if (isSym(tokens[ref.next], '(') && target === reads) return; // a table function, not a table
      addRef(target, ref);
      q = afterRef(ref.next);
      if (list && isSym(tokens[q], ',')) { q++; continue; }
      return;
    }
  };

  const stack = [];
  let hasWhere = false;
  for (let p = k; p < tokens.length; p++) {
    const tok = tokens[p];
    if (isSym(tok, '(')) { stack.push(tokens[p - 1]?.v ?? ''); continue; }
    if (isSym(tok, ')')) { stack.pop(); continue; }
    if (tok.t !== 'id') continue;
    const prev = tokens[p - 1];
    const next = tokens[p + 1];
    switch (tok.v) {
      case 'where': hasWhere = true; break;
      case 'from':
        if (FUNCTION_PARENS.has(stack[stack.length - 1]) || isKw(prev, 'distinct')) break;
        if (kind === 'delete' && stack.length === 0 && isKw(prev, 'delete')) { tableRefs(p + 1, writes, { list: false }); break; }
        if (kind === 'delete' && stack.length === 0 && isName(prev) && isKw(tokens[p - 2], 'delete')) fail('multi-table DELETE');
        tableRefs(p + 1, reads, { list: true });
        break;
      case 'join': tableRefs(p + 1, reads, { list: false }); break;
      case 'update':
        if (isKw(prev, 'for', 'on', 'do', 'key', 'of', 'then') || isKw(next, 'set') || isSym(prev, '(')) break;
        if (isName(next)) tableRefs(p + 1, writes, { list: false });
        break;
      case 'into':
        if (isKw(prev, 'insert', 'replace', 'merge', 'ignore')) tableRefs(p + 1, writes, { list: false });
        else if ((kind === 'select' || kind === 'with') && isName(next) && !isKw(next, 'outfile', 'dumpfile')) tableRefs(p + 1, writes, { list: false }); // SELECT ... INTO new_table
        break;
      case 'using':
        if ((kind === 'merge' || kind === 'delete') && stack.length === 0 && isName(next)) tableRefs(p + 1, reads, { list: false });
        break;
      case 'truncate':
        if (kind === 'truncate') tableRefs(p + 1, writes, { list: true });
        break;
      default: break;
    }
  }
  if (parsed && !reads.size && !writes.size && WRITE_KINDS.has(kind)) fail(`no target table found for ${kind}`);
  return { reads: [...reads].sort(), writes: [...writes].sort(), kind, has_where: hasWhere, parsed, note };
}
