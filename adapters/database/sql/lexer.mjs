// A tolerant SQL lexer and statement splitter. It never throws: migration files in the
// wild contain vendor syntax, template placeholders and truncated text, and a lexer that
// gives up on the first oddity would hide the rest of the file from every detector.
//
// Dialect differences that change *where a statement ends* are handled here (dollar
// quotes, nested comments, MySQL DELIMITER, T-SQL GO, trigger BEGIN..END bodies); the
// DDL grammar lives in parser.mjs.

/** @typedef {{t: 'word'|'qident'|'string'|'number'|'punct'|'param'|'term', v: string, u: string, line: number, s: number, e: number}} Token */

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;
const MYSQLISH = new Set(['mysql', 'mariadb']);
// String-literal prefixes that attach directly to a quote: E'..', N'..', B'..', X'..', U&'..'.
const STRING_PREFIX = new Set(['E', 'N', 'B', 'X']);
const MULTI_PUNCT = ['<=>', '->>', '#>>', '::', '<=', '>=', '<>', '!=', '||', '->', '#>', '@>', '<@', '&&', '<<', '>>', ':=', '!~', '~*'];

/**
 * Tokenize SQL. Comments are dropped. Statement terminators become `term` tokens (so
 * `;` inside a MySQL custom-DELIMITER body stays an ordinary `punct`).
 * @param {string} sql
 * @param {{dialect?: string}} [opts]
 * @returns {Token[]}
 */
export function tokenize(sql, { dialect = 'postgresql' } = {}) {
  const src = typeof sql === 'string' ? sql : String(sql ?? '');
  const n = src.length;
  const out = [];
  const nestedComments = dialect === 'postgresql' || dialect === 'generic';
  const mysqlish = MYSQLISH.has(dialect);
  const bracketIdent = dialect === 'sqlite' || dialect === 'tsql';
  let delimiter = ';';
  let i = 0;
  let line = 1;
  let lineStart = true; // only whitespace seen since the last newline

  const push = (t, v, s, e, ln, u) => out.push({ t, v, u: u ?? v, line: ln, s, e });

  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; lineStart = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') { i++; continue; }

    // Line-oriented client commands: MySQL `DELIMITER //` and T-SQL `GO`.
    if (lineStart) {
      const m = /^[ \t]*(DELIMITER[ \t]+(\S+)|GO(?:[ \t]+\d+)?)[ \t]*(?:--.*)?(?:\r?\n|$)/i.exec(src.slice(i, i + 200));
      if (m) {
        if (m[2]) delimiter = m[2];
        else push('term', 'GO', i, i + m[0].length, line);
        i += m[0].length - (m[0].endsWith('\n') ? 1 : 0);
        continue;
      }
    }
    lineStart = false;

    const start = i;
    const startLine = line;

    // Comments.
    if (ch === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '#' && mysqlish) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '\n') line++;
        if (nestedComments && src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }

    // Custom statement delimiter (anything other than the default `;`).
    if (delimiter !== ';' && src.startsWith(delimiter, i)) {
      i += delimiter.length;
      push('term', delimiter, start, i, startLine);
      continue;
    }

    // Single-quoted strings; E'' (and MySQL) honour backslash escapes.
    if (ch === "'") {
      const prev = out.at(-1);
      const prefixed = prev && prev.t === 'word' && prev.e === start && STRING_PREFIX.has(prev.u);
      const backslash = mysqlish || (prefixed && prev.u === 'E');
      const [val, end, ln] = readQuoted(src, i, "'", backslash, line);
      if (prefixed) {
        out.pop();
        push('string', val, prev.s, end, startLine);
      } else push('string', val, start, end, startLine);
      i = end;
      line = ln;
      continue;
    }

    // Double-quoted: identifier in standard SQL, string in MySQL.
    if (ch === '"') {
      const [val, end, ln] = readQuoted(src, i, '"', mysqlish, line);
      push(mysqlish ? 'string' : 'qident', val, start, end, startLine);
      i = end;
      line = ln;
      continue;
    }
    if (ch === '`') {
      const [val, end, ln] = readQuoted(src, i, '`', false, line);
      push('qident', val, start, end, startLine);
      i = end;
      line = ln;
      continue;
    }
    if (ch === '[' && bracketIdent) {
      const close = src.indexOf(']', i + 1);
      if (close > i && !src.slice(i + 1, close).includes('\n')) {
        push('qident', src.slice(i + 1, close), start, close + 1, startLine);
        i = close + 1;
        continue;
      }
    }

    // Dollar-quoted strings ($$ ... $$ and $tag$ ... $tag$) and positional params ($1).
    if (ch === '$') {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(src.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const close = src.indexOf(tag, i + tag.length);
        const end = close < 0 ? n : close + tag.length;
        const body = src.slice(i + tag.length, close < 0 ? n : close);
        push('string', body, start, end, startLine);
        for (let k = i; k < end; k++) if (src[k] === '\n') line++;
        i = end;
        continue;
      }
      if (DIGIT.test(src[i + 1] ?? '')) {
        let j = i + 1;
        while (j < n && DIGIT.test(src[j])) j++;
        push('param', src.slice(i, j), start, j, startLine);
        i = j;
        continue;
      }
    }

    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      push('word', word, start, j, startLine, word.toUpperCase());
      i = j;
      continue;
    }

    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9A-Fa-f]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
      const text = m ? m[0] : ch;
      i += text.length;
      push('number', text, start, i, startLine);
      continue;
    }

    if (ch === ';') {
      i++;
      push(delimiter === ';' ? 'term' : 'punct', ';', start, i, startLine);
      continue;
    }

    if (ch === '?' || (ch === ':' && /[A-Za-z_]/.test(src[i + 1] ?? '') && src[i - 1] !== ':' && src[i + 1] !== ':')) {
      let j = i + 1;
      while (ch === ':' && j < n && WORD_PART.test(src[j])) j++;
      push('param', src.slice(i, j), start, j, startLine);
      i = j;
      continue;
    }

    let matched = null;
    for (const p of MULTI_PUNCT) if (src.startsWith(p, i)) { matched = p; break; }
    const text = matched ?? ch;
    i += text.length;
    push('punct', text, start, i, startLine);
  }
  return out;
}

/** Read a quoted run starting at src[i] === quote. Doubling the quote escapes it. */
function readQuoted(src, i, quote, backslash, line) {
  const n = src.length;
  let j = i + 1;
  let val = '';
  while (j < n) {
    const c = src[j];
    if (c === '\n') line++;
    if (backslash && c === '\\' && j + 1 < n) {
      val += src[j + 1];
      if (src[j + 1] === '\n') line++;
      j += 2;
      continue;
    }
    if (c === quote) {
      if (src[j + 1] === quote) { val += quote; j += 2; continue; }
      return [val, j + 1, line];
    }
    val += c;
    j++;
  }
  return [val, n, line]; // unterminated: swallow to EOF rather than throw
}

/**
 * Split SQL text into statements. Each statement keeps its tokens and original text.
 * @param {string} sql
 * @param {{dialect?: string}} [opts]
 * @returns {{text: string, line: number, tokens: Token[]}[]}
 */
export function splitStatements(sql, opts = {}) {
  const dialect = opts.dialect ?? 'postgresql';
  const src = typeof sql === 'string' ? sql : String(sql ?? '');
  const tokens = tokenize(src, opts);
  const out = [];
  let cur = [];
  // BEGIN/CASE ... END nesting inside CREATE TRIGGER/FUNCTION/PROCEDURE bodies, where a
  // `;` does not end the statement (SQLite triggers, T-SQL procedures, PG BEGIN ATOMIC).
  let blockStack = 0;

  const flush = () => {
    if (cur.length) {
      out.push({ text: src.slice(cur[0].s, cur.at(-1).e), line: cur[0].line, tokens: cur });
    }
    cur = [];
    blockStack = 0;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === 'term') {
      if (blockStack > 0 && tok.v === ';') { cur.push({ ...tok, t: 'punct' }); continue; }
      flush();
      continue;
    }
    cur.push(tok);
    if (tok.t === 'word' && bodyCapable(cur)) {
      if (tok.u === 'BEGIN' && (dialect !== 'postgresql' || tokens[k + 1]?.u === 'ATOMIC')) blockStack++;
      else if (tok.u === 'CASE' && blockStack > 0) blockStack++;
      else if (tok.u === 'END' && blockStack > 0) {
        // `END IF`/`END LOOP` close their own constructs, not the block.
        const nx = tokens[k + 1];
        if (!(nx && nx.t === 'word' && ['IF', 'LOOP', 'WHILE', 'REPEAT'].includes(nx.u))) blockStack--;
      }
    }
  }
  flush();
  return out;
}

/** True when the statement so far is a CREATE of something with a procedural body. */
function bodyCapable(toks) {
  if (toks[0]?.u !== 'CREATE') return false;
  for (let i = 1; i < Math.min(toks.length, 12); i++) {
    if (toks[i].t === 'word' && ['TRIGGER', 'FUNCTION', 'PROCEDURE'].includes(toks[i].u)) return true;
  }
  return false;
}

/** Strip identifier quoting and fold unquoted identifiers to lower case. */
export function identValue(tok) {
  if (!tok) return '';
  if (tok.t === 'qident') return tok.v;
  return tok.v.toLowerCase();
}
