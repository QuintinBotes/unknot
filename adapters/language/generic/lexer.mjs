// A comment/string-aware lexer shared by every language the generic adapter covers. It
// is not a parser: it only answers "which characters are real code?" so that later
// regexes cannot be fooled by a keyword inside a string or a brace inside a comment.
// Output keeps the input's length and every newline, so offsets and line numbers from
// the blanked copies are valid in the original text.

/** Per-language lexical features; anything unlisted is off. */
const OPTS = {
  go: { char: true, backtick: true, rawTick: true },
  java: { char: true, tq: true },
  kotlin: { char: true, tq: true, nested: true },
  csharp: { char: true, tq: true, verbatim: true },
  rust: { char: true, nested: true, rustRaw: true, multi: true },
  ruby: { ruby: true, sq: true, multi: true, hash: true, backtick: true },
  php: { php: true, sq: true, multi: true, hash: true, backtick: true },
  scala: { char: true, tq: true, nested: true },
  swift: { tq: true, nested: true },
  c: { char: true },
  cpp: { char: true, cppRaw: true },
  groovy: { sq: true, tq: true },
};

const CHAR_RE = /'(?:\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[^\n])|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\\'\n])'/y;
const RUBY_HEREDOC = /^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/;
const RUBY_PLAIN_HEREDOC = /^<<([A-Z_][A-Z0-9_]+)\b/;
const RUBY_PLAIN_CONTEXT = /(?:[=(,[]|\b(?:puts|print|p|raise|sql|exec|execute|query|eval))\s*$/;
const PHP_HEREDOC = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1[ \t]*(?=\r?\n)/;

const isWord = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/** Overwrite a range with spaces, keeping newlines so line numbers survive. */
function wipe(arr, a, b) {
  for (let k = a; k < b; k++) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
}

/**
 * Lex `text` as `lang`. Never throws and never loops: every branch advances `i`.
 * @returns {{ text: string, code: string, plain: string, literals: object[], lineStarts: number[],
 *   lineOf: (off: number) => number, litAt: (off: number) => object | undefined }}
 */
export function lex(text, lang) {
  const o = OPTS[lang] ?? OPTS.c;
  const n = text.length;
  const plain = text.split('');
  const code = plain.slice();
  const lits = [];
  const pending = [];
  let i = 0;

  const lit = (start, end, vs, ve, kind) => {
    lits.push({ start, end, value: text.slice(vs, ve), kind, line: 0 });
    wipe(code, vs, ve);
  };
  const lineEnd = (from) => {
    const e = text.indexOf('\n', from);
    return e < 0 ? n : e;
  };
  /** Consume the bodies of heredocs queued on the line that just ended. */
  const heredocBodies = (start) => {
    let pos = start;
    for (const h of pending) {
      const bodyStart = pos;
      let found = false;
      while (pos < n) {
        const le = lineEnd(pos);
        const line = text.slice(pos, le);
        const t = line.trimStart();
        const hit = h.ruby ? line.trim() === h.id : t.startsWith(h.id) && !isWord(t[h.id.length]);
        if (hit) { found = true; break; }
        pos = le + 1;
      }
      lits.push({ start: h.start, end: pos, value: text.slice(bodyStart, Math.min(pos, n)), kind: 'heredoc', line: 0 });
      wipe(code, bodyStart, Math.min(pos, n));
      if (found) pos = lineEnd(pos) + 1;
    }
    pending.length = 0;
    return Math.min(pos, n);
  };
  const quoted = (from, q) => {
    const multi = o.multi || q === '`';
    let j = from + 1;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\' && !(o.rawTick && q === '`')) { j += 2; continue; }
      if (ch === q) return [j + 1, j];
      if (ch === '\n' && !multi) return [j, j];
      j++;
    }
    return [n, n];
  };

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '\n') {
      i = pending.length ? heredocBodies(i + 1) : i + 1;
      continue;
    }
    // comments
    if ((o.hash && c === '#' && !(o.php && d === '[')) || (!o.ruby && c === '/' && d === '/')) {
      const e = lineEnd(i);
      wipe(plain, i, e); wipe(code, i, e);
      i = e;
      continue;
    }
    if (o.ruby && c === '=' && (i === 0 || text[i - 1] === '\n') && text.startsWith('=begin', i)) {
      const e = text.indexOf('\n=end', i);
      const stop = e < 0 ? n : lineEnd(e + 1);
      wipe(plain, i, stop); wipe(code, i, stop);
      i = stop;
      continue;
    }
    if (!o.ruby && c === '/' && d === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; }
        else if (o.nested && text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; }
        else j++;
      }
      wipe(plain, i, j); wipe(code, i, j);
      i = j;
      continue;
    }
    // heredocs: the body starts on the next line, so queue and keep lexing this one
    if (o.ruby && c === '<' && d === '<') {
      const m = RUBY_HEREDOC.exec(text.slice(i, i + 80));
      if (m) {
        const plainOk = !m[1] && !m[2] && RUBY_PLAIN_HEREDOC.test(text.slice(i, i + 80))
          && RUBY_PLAIN_CONTEXT.test(text.slice(Math.max(0, i - 40), i));
        if (m[1] || m[2] || plainOk) {
          pending.push({ id: m[3], start: i, ruby: true });
          i += m[0].length;
          continue;
        }
      }
    }
    if (o.php && c === '<' && d === '<' && text[i + 2] === '<') {
      const m = PHP_HEREDOC.exec(text.slice(i, i + 80));
      if (m) {
        pending.push({ id: m[2], start: i, ruby: false });
        i += m[0].length;
        continue;
      }
    }
    // raw strings
    if (o.rustRaw && (c === 'r' || (c === 'b' && d === 'r')) && !isWord(text[i - 1])) {
      let k = i + (c === 'b' ? 2 : 1);
      let h = 0;
      while (text[k] === '#') { h++; k++; }
      if (text[k] === '"') {
        const close = '"' + '#'.repeat(h);
        const e = text.indexOf(close, k + 1);
        const end = e < 0 ? n : e + close.length;
        lits.push({ start: k, end, value: text.slice(k + 1, e < 0 ? n : e), kind: 'raw', line: 0 });
        wipe(code, k + 1, e < 0 ? n : e);
        i = end;
        continue;
      }
    }
    if (o.cppRaw && c === 'R' && d === '"' && (!isWord(text[i - 1]) || /[uUL8]/.test(text[i - 1]))) {
      const paren = text.slice(i + 2, i + 19).indexOf('(');
      const delim = paren < 0 ? null : text.slice(i + 2, i + 2 + paren);
      if (delim !== null && /^[^\s()\\]*$/.test(delim)) {
        const vs = i + 3 + paren;
        const close = ')' + delim + '"';
        const e = text.indexOf(close, vs);
        const end = e < 0 ? n : e + close.length;
        lits.push({ start: i + 1, end, value: text.slice(vs, e < 0 ? n : e), kind: 'raw', line: 0 });
        wipe(code, vs, e < 0 ? n : e);
        i = end;
        continue;
      }
    }
    if (o.tq && (c === '"' || (c === "'" && o.sq)) && d === c && text[i + 2] === c) {
      const e = text.indexOf(c.repeat(3), i + 3);
      lit(i, e < 0 ? n : e + 3, i + 3, e < 0 ? n : e, 'triple');
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (o.verbatim && c === '@' && d === '"') {
      let j = i + 2;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      const end = j < n ? j + 1 : n;
      lit(i + 1, end, i + 2, Math.min(j, n), 'verbatim');
      i = end;
      continue;
    }
    if (c === '"' || (c === "'" && o.sq) || (c === '`' && o.backtick)) {
      const [end, close] = quoted(i, c);
      lit(i, end, i + 1, close, c === '`' ? 'backtick' : 'string');
      i = Math.max(end, i + 1);
      continue;
    }
    if (c === "'" && o.char) {
      CHAR_RE.lastIndex = i;
      const m = CHAR_RE.exec(text);
      if (m) {
        wipe(code, i + 1, i + m[0].length - 1);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }

  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  lits.sort((a, b) => a.start - b.start);
  const byStart = new Map();
  for (const l of lits) {
    l.line = lineOf(l.start);
    byStart.set(l.start, l);
  }
  return {
    text, code: code.join(''), plain: plain.join(''), literals: lits, lineStarts, lineOf,
    lineStartOf: (off) => lineStarts[lineOf(off) - 1],
    litAt: (off) => byStart.get(off),
  };
}
