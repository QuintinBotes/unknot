// Pure-JS fallback for the Python adapter: an indentation- and regex-based reader that
// produces the same raw structure as extract.py with lower fidelity. It is used when
// python3 is unavailable or not permitted. It never evaluates anything; it only reads text.
//
// Known gaps against extract.py: match/case is not counted, a def whose body sits on the
// def line has no metrics, and call chains rooted in a call (`a().b()`) are not followed.

const MAX_CALLS = 500;
const MAX_DETAIL = 1500;
const MAX_ITEMS = 300;
const MAX_STR = 500;

const SQL_RE = new RegExp(
  '^\\s*(?:SELECT\\b[\\s\\S]*?\\bFROM\\b|INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\b|UPDATE\\b[\\s\\S]*?\\bSET\\b|DELETE\\s+FROM\\b'
  + '|WITH\\b[\\s\\S]*?\\bAS\\s*\\(|(?:CREATE|ALTER)\\s+(?:OR\\s+REPLACE\\s+)?(?:UNIQUE\\s+)?(?:TEMP(?:ORARY)?\\s+)?'
  + '(?:TABLE|INDEX|VIEW|SEQUENCE|TRIGGER|FUNCTION|SCHEMA|EXTENSION|TYPE|DATABASE)\\b)',
  'i',
);

const NOT_CALLS = new Set([
  'if', 'elif', 'while', 'for', 'and', 'or', 'not', 'in', 'is', 'return', 'yield', 'await', 'lambda', 'assert',
  'del', 'raise', 'with', 'as', 'except', 'else', 'def', 'class', 'import', 'from', 'async', 'case', 'match',
]);

/**
 * Split source into logical lines (bracket continuations joined), with comments removed
 * and string contents blanked in `code` so keyword matching never sees string text.
 * @returns {{lines: Array<{indent:number,line:number,endLine:number,raw:string,code:string,strings:Array}>}}
 */
export function scan(text) {
  const lines = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let depth = 0;
  let cur = null;

  const begin = () => {
    // Measure indentation at the start of a physical line that begins a logical line.
    let indent = 0;
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\f')) {
      indent = text[i] === '\t' ? Math.floor(indent / 8) * 8 + 8 : indent + 1;
      i++;
    }
    cur = { indent, line, endLine: line, raw: '', code: '', strings: [] };
  };
  const finish = () => {
    if (cur && cur.raw.trim()) {
      cur.endLine = line;
      lines.push(cur);
    }
    cur = null;
  };

  while (i < n) {
    if (!cur) {
      begin();
      if (i >= n) break;
    }
    const c = text[i];
    if (c === '\n') {
      i++;
      if (depth === 0) {
        finish();
      } else {
        cur.raw += ' ';
        cur.code += ' ';
      }
      line++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      i += text[i + 1] === '\r' ? 3 : 2;
      line++;
      cur.raw += ' ';
      cur.code += ' ';
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const prefix = /[A-Za-z]{0,2}$/.exec(cur.raw)[0].toLowerCase();
      const triple = text[i + 1] === c && text[i + 2] === c;
      const q = triple ? c.repeat(3) : c;
      const startLine = line;
      let j = i + q.length;
      let value = '';
      let closed = false;
      while (j < n) {
        if (text[j] === '\\' && j + 1 < n) {
          value += text[j] + text[j + 1];
          if (text[j + 1] === '\n') line++;
          j += 2;
          continue;
        }
        if (text.startsWith(q, j)) {
          closed = true;
          j += q.length;
          break;
        }
        if (text[j] === '\n') {
          if (!triple) break; // unterminated single-quoted string: stop at the line end
          line++;
        }
        value += text[j];
        j++;
      }
      const lit = text.slice(i, j).replace(/[\r\n]/g, ' ');
      cur.raw += lit;
      cur.code += q + ' '.repeat(Math.max(0, lit.length - q.length * (closed ? 2 : 1))) + (closed ? q : '');
      cur.strings.push({ value, line: startLine, f: prefix.includes('f') });
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    cur.raw += c;
    cur.code += c;
    i++;
  }
  finish();
  return { lines };
}

// --- literal / call-argument mini parser -------------------------------------------------
// Mirrors extract.py's `enc`: literals as-is, names as {ref}, calls as {call,args,kwargs}.

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function readString(s, i) {
  const m = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(s.slice(i, i + 5));
  if (!m) return null;
  const q = m[2];
  let j = i + m[0].length;
  let value = '';
  while (j < s.length) {
    if (s[j] === '\\' && j + 1 < s.length) {
      value += s[j + 1] === q[0] ? s[j + 1] : s[j] + s[j + 1];
      j += 2;
      continue;
    }
    if (s.startsWith(q, j)) return { value, end: j + q.length, f: /f/i.test(m[1]) };
    value += s[j++];
  }
  return { value, end: j, f: /f/i.test(m[1]) };
}

function skipBalanced(s, i) {
  const open = s[i];
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const str = readString(s, j);
    if (str) { j = str.end - 1; continue; }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
  }
  return s.length;
}

/** Consume leftover operator text up to the next top-level `,` or closer. */
function skipExpr(s, i) {
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === ',' || c === ')' || c === ']' || c === '}') break;
    if (c === '(' || c === '[' || c === '{') { j = skipBalanced(s, j); continue; }
    const str = readString(s, j);
    if (str) { j = str.end; continue; }
    j++;
  }
  return j;
}

function parseValue(s, i, depth = 0) {
  i = skipWs(s, i);
  const start = i;
  if (depth > 8) { // pathological nesting: keep the text, stop recursing
    const end = Math.max(skipExpr(s, i), i + 1);
    return [{ expr: s.slice(start, end).trim().slice(0, 160) }, end];
  }
  let value;
  const str = readString(s, i);
  if (str) {
    let text = str.value;
    let end = str.end;
    let isF = str.f;
    for (;;) { // adjacent literals concatenate
      const k = skipWs(s, end);
      const next = readString(s, k);
      if (!next) break;
      text += next.value;
      isF = isF || next.f;
      end = next.end;
    }
    i = end;
    value = isF && text.includes('{') ? { fstring: text.replace(/\{[^}]*\}/g, '{}').slice(0, MAX_STR) } : text.slice(0, MAX_STR);
  } else if (/[-\d]/.test(s[i] ?? '') && /^-?\d/.test(s.slice(i, i + 3))) {
    const m = /^-?\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?/.exec(s.slice(i));
    i += m[0].length;
    value = Number(m[0].replace(/_/g, ''));
  } else if (s[i] === '[' || s[i] === '(') {
    const closer = s[i] === '[' ? ']' : ')';
    const isTuple = s[i] === '(';
    i++;
    const items = [];
    let comma = false;
    for (let guard = 0; guard < 200; guard++) {
      i = skipWs(s, i);
      if (i >= s.length || s[i] === closer) { i++; break; }
      if (s[i] === ',') { comma = true; i++; continue; }
      const before = i;
      const [v, next] = parseValue(s, i, depth + 1);
      items.push(v);
      i = next;
      if (i === before) i++;
    }
    value = isTuple && items.length === 1 && !comma ? items[0] : items.slice(0, 30);
  } else if (s[i] === '{') {
    i = skipBalanced(s, i);
    value = { expr: 'dict' };
  } else {
    const m = /^[A-Za-z_][\w.]*/.exec(s.slice(i));
    if (!m) {
      i = skipExpr(s, i);
      return [{ expr: s.slice(start, i).trim().slice(0, 160) }, i];
    }
    i += m[0].length;
    if (m[0] === 'True') value = true;
    else if (m[0] === 'False') value = false;
    else if (m[0] === 'None') value = null;
    else if (s[i] === '(' && depth < 3) {
      const parsed = parseArgs(s, i + 1, depth + 1);
      value = { call: m[0], args: parsed.args, kwargs: parsed.kwargs };
      i = parsed.end;
    } else if (s[i] === '(' || s[i] === '[') {
      i = skipBalanced(s, i);
      value = { expr: s.slice(start, i).slice(0, 160) };
    } else {
      value = { ref: m[0] };
    }
  }
  const k = skipWs(s, i);
  if (k < s.length && !',)]}:'.includes(s[k])) {
    // An operator follows (concatenation, `or`, a ternary): the whole thing is an expression.
    const end = skipExpr(s, k);
    return [{ expr: s.slice(start, end).trim().slice(0, 160) }, end];
  }
  return [value, i];
}

/** Parse call arguments starting just after the opening paren. */
export function parseArgs(s, i, depth = 0) {
  const args = [];
  const kwargs = {};
  for (let guard = 0; guard < 100; guard++) {
    i = skipWs(s, i);
    if (i >= s.length) break;
    if (s[i] === ')') { i++; break; }
    if (s[i] === ',') { i++; continue; }
    const before = i;
    const kw = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(s.slice(i));
    if (kw) {
      const [v, next] = parseValue(s, i + kw[0].length, depth);
      kwargs[kw[1]] = v;
      i = next;
    } else if (s[i] === '*') {
      i = skipExpr(s, i);
    } else {
      const [v, next] = parseValue(s, i, depth);
      if (args.length < 20) args.push(v);
      i = next;
    }
    if (i === before) i++;
  }
  return { args, kwargs, end: i };
}

function decoratorRecord(raw, line) {
  const text = raw.trim().slice(1).trim();
  const paren = text.indexOf('(');
  if (paren === -1) return { name: text, args: [], kwargs: {}, line };
  const { args, kwargs } = parseArgs(text, paren + 1);
  return { name: text.slice(0, paren).trim(), args, kwargs, line };
}

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function matchParen(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === '(') depth++;
    else if (code[j] === ')' && --depth === 0) return j;
  }
  return -1;
}

const CONTROL_RE = /^(?:async\s+)?(if|elif|else|for|while|try|except|finally|with)\b/;

/** Metrics from a function's own logical lines (nested definitions excluded by the caller). */
function measure(own) {
  let cc = 1;
  let cog = 0;
  let depth = 0;
  const stack = [];
  for (const l of own) {
    while (stack.length && stack[stack.length - 1].indent >= l.indent) stack.pop();
    const nest = stack.filter((s) => s.cog).length;
    const m = CONTROL_RE.exec(l.code);
    let rest = l.code;
    if (m) {
      rest = l.code.slice(m[0].length);
      const kw = m[1];
      if (kw === 'if' || kw === 'for' || kw === 'while') { cc += 1; cog += 1 + nest; stack.push({ indent: l.indent, cog: true }); }
      else if (kw === 'elif') { cc += 1; cog += 1; stack.push({ indent: l.indent, cog: true }); }
      else if (kw === 'else') { cog += 1; stack.push({ indent: l.indent, cog: true }); }
      else if (kw === 'except') { cc += 1; cog += 1 + nest; stack.push({ indent: l.indent, cog: true }); }
      else stack.push({ indent: l.indent, cog: false });
      depth = Math.max(depth, stack.length);
    }
    // Boolean operators: each one is a branch; each run of the same operator costs one cognitive point.
    let prev = null;
    for (const b of rest.matchAll(/\b(and|or)\b/g)) {
      cc += 1;
      if (b[1] !== prev) cog += 1;
      prev = b[1];
    }
    const ternary = (rest.match(/\belse\b/g) ?? []).length;
    const ifs = (rest.match(/\bif\b/g) ?? []).length;
    const fors = (rest.match(/\bfor\b/g) ?? []).length;
    cc += ternary + Math.max(0, ifs - ternary) + fors;
    cog += ternary * (1 + nest);
  }
  return { cc, cog, depth };
}

function cleanReturn(text) {
  return text.trim().replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Reads Python source without a parser. Same shape as one extract.py record.
 * @returns {object}
 */
export function lexicalAnalyze(path, text) {
  const { lines } = scan(text);
  const rawLines = text.split(/\r\n|\r|\n/);
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const sloc = rawLines.filter((l) => l.trim() && !l.trim().startsWith('#')).length;

  const functions = [];
  const classes = [];
  const imports = [];
  const sql = [];
  const env = [];
  const security = [];
  const detail = [];
  const moduleCalls = [];
  const moduleCallSet = new Set();
  const scopes = []; // { kind, indent, qual, rec, own }
  let pending = [];
  let lastEnd = 1;
  let typeChecking = null; // indent of an open `if TYPE_CHECKING:` block

  const pop = (endLine) => {
    const s = scopes.pop();
    s.rec.end_line = endLine;
    if (s.kind === 'fn') {
      const mm = measure(s.own);
      s.rec.cyclomatic = mm.cc;
      s.rec.cognitive = mm.cog;
      s.rec.max_nesting = mm.depth;
    }
  };
  const scopeFn = () => {
    for (let k = scopes.length - 1; k >= 0; k--) {
      if (scopes[k].kind === 'fn') return scopes[k].qual;
      return null;
    }
    return null;
  };
  const addSec = (kind, line, name, extra = {}) => {
    if (security.length < MAX_ITEMS) security.push({ kind, line, scope: scopeFn(), name, ...extra });
  };

  for (const l of lines) {
    while (scopes.length && l.indent <= scopes[scopes.length - 1].indent) pop(lastEnd);
    lastEnd = l.endLine;
    const top = scopes[scopes.length - 1] ?? null;
    const code = l.code.trim();
    const rawText = l.raw.trim();
    if (typeChecking !== null && l.indent <= typeChecking) typeChecking = null;
    if (/^if\s+(?:typing\.)?TYPE_CHECKING\s*:/.test(code)) typeChecking = l.indent;

    if (code.startsWith('@')) {
      pending.push(decoratorRecord(rawText, l.line));
      continue;
    }

    const def = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(code);
    const cls = def ? null : /^class\s+([A-Za-z_]\w*)\s*(?:\(|:)/.exec(code);
    if (def) {
      const open = code.indexOf('(', def[0].length - 1);
      const close = matchParen(code, open);
      const paramText = close === -1 ? '' : code.slice(open + 1, close);
      const after = close === -1 ? '' : rawText.slice(close + 1);
      const ret = /^\s*->\s*(.+?)\s*:\s*(?:[^:]*)$/.exec(after) ?? /^\s*->\s*(.+?)\s*:/.exec(after);
      const inClass = top?.kind === 'cls';
      const parsedParams = splitTop(paramText)
        .map((p) => /^(\*{0,2})([A-Za-z_]\w*)/.exec(p))
        .filter(Boolean)
        .map((m) => m[1] + m[2]);
      // extract.py lists named parameters first, then *args, then **kwargs; match that order.
      let params = [
        ...parsedParams.filter((p) => !p.startsWith('*')),
        ...parsedParams.filter((p) => p.startsWith('*') && !p.startsWith('**')),
        ...parsedParams.filter((p) => p.startsWith('**')),
      ];
      const names = pending.map((d) => d.name);
      if (inClass && params.length && ['self', 'cls'].includes(params[0]) && !names.includes('staticmethod')) params = params.slice(1);
      let kind = inClass ? 'method' : 'function';
      for (const want of ['staticmethod', 'classmethod', 'property']) if (inClass && names.includes(want)) kind = want;
      const qual = top ? `${top.qual}.${def[2]}` : def[2];
      const rec = {
        name: def[2], qual, parent: top?.qual ?? null, in_class: inClass, kind, start_line: l.line, end_line: l.endLine,
        params, cyclomatic: 1, cognitive: 0, max_nesting: 0, decorators: pending, async: Boolean(def[1]),
        returns: ret ? cleanReturn(ret[1]) : null, calls: [],
      };
      pending = [];
      functions.push(rec);
      scopes.push({ kind: 'fn', indent: l.indent, qual, rec, own: [], seen: new Set() });
      continue;
    }
    if (cls) {
      const open = code.indexOf('(');
      const colon = code.indexOf(':');
      const hasBases = open !== -1 && (colon === -1 || open < colon);
      const close = hasBases ? matchParen(code, open) : -1;
      const baseText = hasBases && close !== -1 ? rawText.slice(open + 1, close) : '';
      const bases = [];
      const keywords = {};
      for (const b of splitTop(baseText)) {
        const kw = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(b);
        if (kw) keywords[kw[1]] = parseValue(kw[2], 0)[0];
        else bases.push(b);
      }
      const qual = top ? `${top.qual}.${cls[1]}` : cls[1];
      const rec = {
        name: cls[1], qual, parent: top?.qual ?? null, start_line: l.line, end_line: l.endLine, bases, keywords,
        decorators: pending, assigns: {},
      };
      pending = [];
      classes.push(rec);
      scopes.push({ kind: 'cls', indent: l.indent, qual, rec, own: [] });
      continue;
    }
    pending = [];

    // imports
    let m;
    if ((m = /^import\s+(.+)$/.exec(rawText))) {
      for (const part of splitTop(m[1])) {
        const im = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(part);
        if (im) imports.push({ kind: 'import', level: 0, module: im[1], as: im[2] ?? null, names: [], line: l.line, ...(typeChecking !== null && { type_only: true }) });
      }
    } else if ((m = /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(rawText))) {
      const names = splitTop(m[3].replace(/[()]/g, ''))
        .map((p) => /^(\*|\w+)(?:\s+as\s+(\w+))?$/.exec(p))
        .filter(Boolean)
        .map((p) => ({ name: p[1], as: p[2] ?? null }));
      imports.push({ kind: 'from', level: m[1].length, module: m[2], names, line: l.line, ...(typeChecking !== null && { type_only: true }) });
    }

    if (top?.kind === 'fn') top.own.push({ indent: l.indent, code: l.code });

    // class-level plain assignments
    if (top?.kind === 'cls' && Object.keys(top.rec.assigns).length < 60) {
      const a = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)\s*(.+)$/.exec(rawText);
      if (a) top.rec.assigns[a[1]] = parseValue(a[2], 0)[0];
    }

    // string literals: bare strings are docstrings, anything else may be SQL
    const bare = code.replace(/[\s"'rRbBuUfF]/g, '') === '';
    if (!bare) {
      for (const s of l.strings) {
        const body = s.f ? s.value.replace(/\{[^}]*\}/g, '{}') : s.value;
        if (sql.length < MAX_ITEMS && body.length >= 12 && SQL_RE.test(body)) sql.push({ line: s.line, text: body.slice(0, MAX_STR) });
      }
    }

    // environment reads
    for (const e of rawText.matchAll(/os\.environ\[\s*['"]([^'"]+)['"]\s*\]/g)) {
      if (env.length < MAX_ITEMS) env.push({ name: e[1], line: l.line, required: true });
    }
    for (const e of rawText.matchAll(/(?:os\.getenv|os\.environ\.get|(?<![\w.])getenv|(?<![\w.])environ\.get)\(\s*['"]([^'"]+)['"]/g)) {
      if (env.length < MAX_ITEMS) env.push({ name: e[1], line: l.line, required: false });
    }

    // calls
    const assign = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=(?!=)\s*/.exec(code);
    const fnQual = scopeFn();
    for (const c of code.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
      const name = c[1];
      if (NOT_CALLS.has(name)) continue;
      const fn = fnQual ? scopes.find((s) => s.kind === 'fn' && s.qual === fnQual) : null;
      if (fn) {
        if (!fn.seen.has(name) && fn.seen.size < MAX_CALLS) { fn.seen.add(name); fn.rec.calls.push(name); }
      } else if (!moduleCallSet.has(name) && moduleCallSet.size < MAX_CALLS) {
        moduleCallSet.add(name);
        moduleCalls.push(name);
      }
      const argStart = c.index + c[0].length;
      const isAssigned = assign && assign[0].length === c.index;
      const { args, kwargs } = parseArgs(rawText, argStart);
      if ((args.length || Object.keys(kwargs).length || isAssigned) && detail.length < MAX_DETAIL) {
        detail.push({
          name, args, kwargs, line: l.line, scope: fnQual, owner_class: top?.kind === 'cls' ? top.qual : null,
          assign: isAssigned ? assign[1] : null, ann: isAssigned && assign[2] ? assign[2].trim() : null,
        });
      }
    }

    // security signals
    if (/(?<![\w.])(?:subprocess\.\w+|Popen|check_output|check_call)\s*\(/.test(code) && /shell\s*=\s*True/.test(rawText)) {
      addSec('shell_true', l.line, 'subprocess');
    }
    if (/(?<![\w.])os\.system\s*\(/.test(code)) addSec('os_system', l.line, 'os.system');
    if (/(?<![\w.])os\.popen\s*\(/.test(code)) addSec('os_popen', l.line, 'os.popen');
    for (const e of code.matchAll(/(?<![\w.])(eval|exec)\s*\(/g)) addSec(e[1], l.line, e[1]);
    if (/(?<![\w.])(?:c?[pP]ickle|_pickle)\.loads?\s*\(/.test(code)) addSec('pickle_load', l.line, 'pickle.load');
    if (/(?<![\w.])marshal\.loads?\s*\(/.test(code)) addSec('marshal_load', l.line, 'marshal.load');
    if (/(?<![\w.])yaml\.unsafe_load\s*\(/.test(code)) addSec('yaml_unsafe_load', l.line, 'yaml.unsafe_load');
    else if (/(?<![\w.])yaml\.load\s*\(/.test(code) && !/SafeLoader/.test(rawText)) addSec('yaml_unsafe_load', l.line, 'yaml.load');
    const ex = /\.(execute|executemany|executescript|raw)\s*\(\s*([rRbB]?[fF]?[rR]?)(['"])(.*?)\3\s*(%|\+|\.format\()?/.exec(rawText);
    if (ex) {
      const how = /[fF]/.test(ex[2]) && ex[4].includes('{') ? 'fstring' : ex[5] === '%' ? 'percent' : ex[5] === '+' ? 'concat' : ex[5] ? 'format' : null;
      if (how) addSec('sql_injection', l.line, `.${ex[1]}`, { how });
    }
  }
  while (scopes.length) pop(lastEnd);

  return {
    path, loc: rawLines.length, sloc, functions, classes, imports, calls: moduleCalls, calls_detail: detail,
    sql, env, security,
  };
}
