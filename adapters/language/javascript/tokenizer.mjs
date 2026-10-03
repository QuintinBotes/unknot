// A forgiving JavaScript / TypeScript / JSX tokenizer.
//
// It is not a parser: it exists so that later passes never mistake the inside of a
// string, comment, template literal, regex or JSX text for code. It never throws. When it
// cannot make sense of the input it returns the tokens it has and counts an issue, which
// the adapter reports as `parse_quality: 'degraded'`.
//
// Token shapes ({ t, v, l, e? } where l/e are the first/last line):
//   id      identifiers and keywords (private names keep their '#')
//   num     numeric literal            str   string literal, v = raw content
//   re      regex literal              p     punctuator
//   tpl     template without ${}       tplh/tplm/tplt  head/middle/tail of a template
//   jo      JSX opening tag name       ja    JSX attribute name
//   jc      end of an opening tag ('>' or '/>')        jx  JSX closing tag name
// Template and JSX expression tokens are emitted inline, so a single flat stream is enough
// for the structural pass. Nesting is tracked with an explicit stack, never recursion.

const KEYWORDS_BEFORE_EXPR = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await', 'extends', 'default',
]);

const P3 = new Set(['...', '===', '!==', '**=', '<<=', '&&=', '||=', '??=']);
const P2 = new Set([
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '<<', '**',
]);

const NUMBER_RE = /0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?/y;
const TSX_GENERIC_RE = /<\s*[A-Za-z_$][\w$]*\s*(?:,|extends\s)/y;

const MAX_TOKENS = 4_000_000;
const MAX_FULL = 1200;

function isIdStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
}

function isIdPart(c) {
  return isIdStart(c) || (c >= 48 && c <= 57);
}

/** True when the previous significant token leaves us where an expression may start. */
function exprAllowed(prev) {
  if (!prev) return true;
  switch (prev.t) {
    case 'id': return KEYWORDS_BEFORE_EXPR.has(prev.v);
    case 'num': case 'str': case 're': case 'tpl': case 'tplt': case 'jc': case 'jx': return false;
    case 'p': return !(prev.v === ')' || prev.v === ']' || prev.v === '}' || prev.v === '++' || prev.v === '--');
    default: return true;
  }
}

/**
 * @param {string} text
 * @param {{ jsx?: boolean, ts?: boolean }} [opts]
 * @returns {{ tokens: object[], n: number, loc: number, sloc: number, issues: string[] }}
 */
export function tokenize(text, { jsx = true, ts = false } = {}) {
  const len = text.length;
  const tokens = [];
  const issues = [];
  let lineCount = 1;
  for (let k = text.indexOf('\n'); k !== -1; k = text.indexOf('\n', k + 1)) lineCount++;
  const code = new Uint8Array(lineCount + 2);

  let i = 0;
  let line = 1;
  let mode = 0; // 0 js, 1 inside a JSX tag, 2 JSX children
  const ctx = []; // open '{' contexts: { k: 'b' | 't' | 'ja' | 'jc', base, head, start }
  const jsxStack = [];
  let curBase = 0;
  let tagClosing = false;
  let tagName = '';
  let prev = null;

  const issue = (m) => {
    if (issues.length < 20) issues.push(`${m}@${line}`);
  };

  function emit(t, v, l, e) {
    const tk = { t, v, l };
    if (e !== undefined && e !== l) tk.e = e;
    tokens.push(tk);
    prev = tk;
    const last = e ?? l;
    for (let x = l; x <= last; x++) code[x] = 1;
    return tk;
  }

  function scanString(q) {
    const l0 = line;
    let j = i + 1;
    let terminated = false;
    while (j < len) {
      const ch = text.charCodeAt(j);
      if (ch === 92) {
        if (text.charCodeAt(j + 1) === 10) line++;
        j += 2;
        continue;
      }
      if (ch === q) { terminated = true; break; }
      if (ch === 10) break;
      j++;
    }
    if (!terminated) issue('unterminated string');
    const end = Math.min(j, len);
    emit('str', text.slice(i + 1, end), l0, line);
    i = terminated ? j + 1 : end;
  }

  // Scans template characters from i up to the closing backtick or the next `${`.
  function scanTemplate(head, start) {
    const l0 = line;
    let j = i;
    while (j < len) {
      const ch = text.charCodeAt(j);
      if (ch === 92) {
        if (text.charCodeAt(j + 1) === 10) line++;
        j += 2;
        continue;
      }
      if (ch === 10) { line++; j++; continue; }
      if (ch === 96) {
        const v = text.slice(i, j);
        i = j + 1;
        if (head === null) {
          const tk = emit('tpl', v, l0, line);
          tk.full = text.slice(start, Math.min(i, start + MAX_FULL));
        } else {
          emit('tplt', v, l0, line);
          head.full = text.slice(start, Math.min(i, start + MAX_FULL));
        }
        return;
      }
      if (ch === 36 && text.charCodeAt(j + 1) === 123) {
        const v = text.slice(i, j);
        i = j + 2;
        if (head === null) {
          const tk = emit('tplh', v, l0, line);
          tk.dyn = true;
          ctx.push({ k: 't', head: tk, start });
        } else {
          emit('tplm', v, l0, line);
          ctx.push({ k: 't', head, start });
        }
        return;
      }
      j++;
    }
    issue('unterminated template');
    const tk = emit(head === null ? 'tpl' : 'tplt', text.slice(i, len), l0, line);
    if (head === null) tk.full = text.slice(start, Math.min(len, start + MAX_FULL));
    i = len;
  }

  function scanRegex() {
    let j = i + 1;
    let inClass = false;
    while (j < len) {
      const ch = text.charCodeAt(j);
      if (ch === 10) return false;
      if (ch === 92) { j += 2; continue; }
      if (ch === 91) inClass = true;
      else if (ch === 93) inClass = false;
      else if (ch === 47 && !inClass) break;
      j++;
    }
    if (j >= len) return false;
    j++;
    while (j < len && isIdPart(text.charCodeAt(j))) j++;
    emit('re', text.slice(i, j), line);
    i = j;
    return true;
  }

  function openTag(fromChildren) {
    if (!fromChildren) curBase = jsxStack.length;
    i++; // '<'
    tagClosing = false;
    while (text.charCodeAt(i) === 32) i++;
    if (text.charCodeAt(i) === 47) { tagClosing = true; i++; }
    const s = i;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (isIdPart(c) || c === 46 || c === 58 || c === 45) i++;
      else break;
    }
    tagName = text.slice(s, i);
    emit(tagClosing ? 'jx' : 'jo', tagName, line);
    mode = 1;
  }

  function endTag(selfClosing) {
    if (tagClosing) {
      tagClosing = false;
      if (jsxStack.length > curBase) jsxStack.pop();
      else issue('stray JSX closing tag');
    } else {
      const tk = emit('jc', selfClosing ? '/>' : '>', line);
      if (selfClosing) tk.self = true;
      else jsxStack.push(tagName);
    }
    mode = jsxStack.length <= curBase ? 0 : 2;
  }

  function scanTag(c) {
    if (c === 62) { i++; endTag(false); return; }
    if (c === 47) {
      const nc = text.charCodeAt(i + 1);
      if (nc === 62) { i += 2; endTag(true); return; }
      if (nc === 47) { while (i < len && text.charCodeAt(i) !== 10) i++; return; }
      if (nc === 42) {
        const end = text.indexOf('*/', i + 2);
        const stop = end === -1 ? len : end + 2;
        for (let k = i; k < stop; k++) if (text.charCodeAt(k) === 10) line++;
        i = stop;
        return;
      }
    }
    if (c === 123) {
      emit('p', '{', line);
      ctx.push({ k: 'ja', base: curBase });
      mode = 0;
      i++;
      return;
    }
    if (c === 34 || c === 39) {
      const l0 = line;
      const end = text.indexOf(String.fromCharCode(c), i + 1);
      const stop = end === -1 ? len : end;
      for (let k = i; k < stop; k++) if (text.charCodeAt(k) === 10) line++;
      emit('str', text.slice(i + 1, stop), l0, line);
      i = end === -1 ? len : end + 1;
      return;
    }
    if (isIdStart(c)) {
      const s = i;
      while (i < len) {
        const ch = text.charCodeAt(i);
        if (isIdPart(ch) || ch === 45 || ch === 58 || ch === 46) i++;
        else break;
      }
      emit('ja', text.slice(s, i), line);
      return;
    }
    if (c !== 61) issue('unexpected character in JSX tag');
    i++;
  }

  function scanChildren() {
    let j = i;
    while (j < len) {
      const ch = text.charCodeAt(j);
      if (ch === 60 || ch === 123) break;
      if (ch === 10) line++;
      else if (ch !== 32 && ch !== 9 && ch !== 13) code[line] = 1;
      j++;
    }
    i = j;
    if (i >= len) { issue('unterminated JSX'); return; }
    if (text.charCodeAt(i) === 123) {
      emit('p', '{', line);
      ctx.push({ k: 'jc', base: curBase });
      mode = 0;
      i++;
    } else {
      openTag(true);
    }
  }

  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  if (text.charCodeAt(i) === 35 && text.charCodeAt(i + 1) === 33) {
    while (i < len && text.charCodeAt(i) !== 10) i++;
  }

  while (i < len) {
    if (tokens.length > MAX_TOKENS) { issue('token limit'); break; }
    if (mode === 2) { scanChildren(); continue; }
    const c = text.charCodeAt(i);
    if (c === 10) { line++; i++; continue; }
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12 || c === 0xA0 || c === 0xFEFF || c === 0x2028 || c === 0x2029) { i++; continue; }
    if (mode === 1) { scanTag(c); continue; }

    if (c === 47) { // '/'
      const nc = text.charCodeAt(i + 1);
      if (nc === 47) {
        const e = text.indexOf('\n', i);
        i = e === -1 ? len : e;
        continue;
      }
      if (nc === 42) {
        const end = text.indexOf('*/', i + 2);
        const stop = end === -1 ? len : end + 2;
        if (end === -1) issue('unterminated comment');
        for (let k = text.indexOf('\n', i); k !== -1 && k < stop; k = text.indexOf('\n', k + 1)) line++;
        i = stop;
        continue;
      }
      if (exprAllowed(prev) && scanRegex()) continue;
      if (nc === 61) { emit('p', '/=', line); i += 2; } else { emit('p', '/', line); i++; }
      continue;
    }
    if (c === 39 || c === 34) { scanString(c); continue; }
    if (c === 96) { i++; scanTemplate(null, i - 1); continue; }
    if ((c >= 48 && c <= 57) || (c === 46 && text.charCodeAt(i + 1) >= 48 && text.charCodeAt(i + 1) <= 57)) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(text);
      const e = m ? i + m[0].length : i + 1;
      emit('num', text.slice(i, e), line);
      i = e;
      continue;
    }
    if (isIdStart(c) || (c === 35 && isIdStart(text.charCodeAt(i + 1)))) {
      const s = i;
      i++;
      while (i < len && isIdPart(text.charCodeAt(i))) i++;
      emit('id', text.slice(s, i), line);
      continue;
    }
    if (c === 123) { ctx.push({ k: 'b' }); emit('p', '{', line); i++; continue; }
    if (c === 125) {
      i++;
      const top = ctx.pop();
      if (!top) { issue('unbalanced }'); emit('p', '}', line); continue; }
      if (top.k === 't') { scanTemplate(top.head, top.start); continue; }
      emit('p', '}', line);
      if (top.k === 'ja') { curBase = top.base; mode = 1; }
      else if (top.k === 'jc') { curBase = top.base; mode = 2; }
      continue;
    }
    if (c === 60 && jsx && exprAllowed(prev)) {
      const nc = text.charCodeAt(i + 1);
      if (nc === 62 || isIdStart(nc)) {
        TSX_GENERIC_RE.lastIndex = i;
        if (!(ts && TSX_GENERIC_RE.test(text))) { openTag(false); continue; }
      }
    }
    // Operators and punctuation, longest match first.
    const three = text.substr(i, 3);
    if (P3.has(three)) { emit('p', three, line); i += 3; continue; }
    const two = text.substr(i, 2);
    if (P2.has(two) && !(two === '?.' && text.charCodeAt(i + 2) >= 48 && text.charCodeAt(i + 2) <= 57)) {
      emit('p', two, line);
      i += 2;
      continue;
    }
    emit('p', text[i], line);
    i++;
  }

  if (ctx.length > 0) issue('unclosed brackets');
  if (mode !== 0 && !issues.some((m) => m.startsWith('unterminated JSX'))) issue('unterminated JSX');

  const n = tokens.length;
  const eof = { t: 'eof', v: '', l: line };
  for (let k = 0; k < 4; k++) tokens.push(eof);
  let sloc = 0;
  for (let k = 1; k <= lineCount; k++) if (code[k]) sloc++;
  return { tokens, n, loc: lineCount, sloc, issues };
}
