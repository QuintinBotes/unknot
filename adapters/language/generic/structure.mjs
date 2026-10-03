// Lexical structure for the generic adapter: package/namespace, imports, type and
// function declarations with start/end lines, and per-function metrics. Everything is
// recovered from the blanked `code` copy produced by lexer.mjs using brace matching
// (or def/end matching for Ruby). It is honest about being approximate: no scoping, no
// type resolution, no indentation-sensitive syntax (Scala 3 braceless, Python-likes).

/** Match bracket pairs over the blanked code; unmatched brackets stay -1. */
export function matchPairs(code, open, close) {
  const m = new Int32Array(code.length).fill(-1);
  const st = [];
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (c === open) st.push(i);
    else if (c === close && st.length) {
      const o = st.pop();
      m[o] = i;
      m[i] = o;
    }
  }
  return m;
}

const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;
const CONT_NEXT = /^(?:[:,=.]|->|extends\b|implements\b|with\b|where\b|throws\b|permits\b|&&|\|\|)/;
const CONT_PREV = /(?:\b(?:extends|implements|with|where|throws|permits|new)|[:,=&+*/<-])\s*$/;

/**
 * Walk a declaration header to its body `{`. Parenthesised groups are skipped whole. A
 * newline ends the header unless the next line plainly continues it (Allman brace,
 * `extends`, a trailing comma...), which is what lets brace-less Kotlin/Scala/Swift
 * declarations terminate without a semicolon.
 */
function scanHeader(code, pm, from) {
  const n = code.length;
  const limit = Math.min(n, from + 600);
  let i = from;
  while (i < limit) {
    const c = code.charCodeAt(i);
    if (c === 40) {
      const m = pm[i];
      if (m < 0) return { body: -1, stop: i };
      i = m + 1;
      continue;
    }
    if (c === 123) return { body: i, stop: i };
    if (c === 59 || c === 125) return { body: -1, stop: i };
    if (c === 10) {
      let k = i + 1;
      while (k < n && code.charCodeAt(k) <= 32) k++;
      const ahead = code.slice(k, k + 14);
      if (ahead[0] === '{' || CONT_NEXT.test(ahead) || CONT_PREV.test(code.slice(Math.max(from, i - 24), i))) {
        i = k;
        continue;
      }
      return { body: -1, stop: i };
    }
    i++;
  }
  return { body: -1, stop: Math.min(limit, n) };
}

/** Start of the declaration header: just after the previous `;`, `{` or `}`. */
function headerStart(code, pm, b) {
  const lim = Math.max(0, b - 500);
  let j = b - 1;
  while (j >= lim) {
    const c = code.charCodeAt(j);
    if (c === 41) {
      const o = pm[j];
      if (o < 0) return j + 1;
      j = o - 1;
      continue;
    }
    if (c === 59 || c === 123 || c === 125) return j + 1;
    j--;
  }
  return lim;
}

/** Skip whitespace and leading annotations/attributes so a declaration starts at its signature. */
function skipAnnotations(code, pm, from, lang) {
  let i = from;
  for (let guard = 0; guard < 40; guard++) {
    while (i < code.length && isSpace(code.charCodeAt(i))) i++;
    const c = code[i];
    if (c === '@' && lang !== 'csharp') {
      const m = /^@[\w.]+/.exec(code.slice(i, i + 80));
      if (!m) return i;
      i += m[0].length;
      while (code[i] === ' ') i++;
      if (code[i] === '(' && pm[i] >= 0) i = pm[i] + 1;
    } else if (c === '[' && lang === 'csharp') {
      let depth = 0;
      let j = i;
      while (j < code.length && j < i + 400) {
        if (code[j] === '[') depth++;
        else if (code[j] === ']' && --depth === 0) break;
        j++;
      }
      if (depth !== 0) return i;
      i = j + 1;
    } else return i;
  }
  return i;
}

function stripAngles(s) {
  let t = s;
  for (let k = 0; k < 20 && /<[^<>]*>/.test(t); k++) t = t.replace(/<[^<>]*>/g, '');
  return t;
}

function stripGroups(s) {
  let t = s;
  for (let k = 0; k < 20 && /[([][^()[\]]*[)\]]/.test(t); k++) t = t.replace(/[([][^()[\]]*[)\]]/g, '');
  return t;
}

/** Reduce `public Foo<Bar>(x)`-style base-type text to the bare simple name, or null. */
function simpleName(s) {
  const t = stripAngles(stripGroups(s)).replace(/\b(?:public|private|protected|virtual|internal|final|sealed|open|abstract|implements|extends)\b/g, ' ');
  const last = t.split(/[.:\\]+/).pop().trim();
  const m = /^[A-Za-z_$][\w$]*/.exec(last);
  return m ? m[0] : null;
}

function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === '>' || ch === ']') depth--;
    if (ch === sep && depth <= 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function nameList(s, sep = ',') {
  const out = [];
  for (const p of splitTop(s, sep)) {
    const nm = simpleName(p);
    if (nm && !out.includes(nm)) out.push(nm);
  }
  return out;
}

/** Expand `a::{b, c::{d, e}}` / `a.b.{C, D => E}` / `A\{B, C}` into flat paths. */
function expandGroups(str, sep) {
  const out = [];
  const walk = (prefix, s) => {
    for (const raw of splitTop(s, ',')) {
      const part = raw.trim();
      if (!part) continue;
      const b = part.indexOf('{');
      if (b < 0) {
        const clean = part.replace(/\s+as\s+\w+$/, '').replace(/\s*=>.*$/, '').replace(/^(?:function|const)\s+/, '').trim();
        out.push((prefix + clean).replace(new RegExp(`${sep.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}self$`), ''));
      } else {
        const e = part.lastIndexOf('}');
        walk(prefix + part.slice(0, b).trim(), part.slice(b + 1, e < 0 ? undefined : e));
      }
    }
  };
  walk('', str);
  return out;
}

function parseBases(lang, typeKw, hdr) {
  const out = { extends: [], implements: [], bases: [] };
  const h = hdr.replace(/\bwhere\b[\s\S]*$/, '');
  if (lang === 'java' || lang === 'php') {
    const flat = stripGroups(h);
    const ext = /\bextends\s+([\s\S]*?)(?=\bimplements\b|\bpermits\b|$)/.exec(flat);
    const imp = /\bimplements\s+([\s\S]*?)(?=\bpermits\b|\bextends\b|$)/.exec(flat);
    if (ext) out.extends = nameList(ext[1]);
    if (imp) out.implements = nameList(imp[1]);
  } else if (lang === 'scala') {
    const ext = /\bextends\s+([\s\S]*)$/.exec(h.replace(/\[[^[\]]*\]/g, ''));
    if (ext) {
      const parts = stripGroups(ext[1]).split(/\bwith\b/).map((p) => simpleName(p)).filter(Boolean);
      if (typeKw === 'trait') out.extends = parts;
      else { out.extends = parts.slice(0, 1); out.implements = parts.slice(1); }
    }
  } else if (lang === 'rust') {
    if (typeKw === 'trait') {
      const m = /^[^:]*:\s*([\s\S]*)$/.exec(stripAngles(h));
      if (m) out.extends = nameList(m[1], '+');
    }
  } else if (lang === 'kotlin' || lang === 'csharp' || lang === 'swift' || lang === 'cpp') {
    if (typeKw === 'enum') return out;
    const flat = stripAngles(stripGroups(h));
    const m = /(?<!:):(?!:)([\s\S]*)$/.exec(flat);
    if (m) out.bases = nameList(m[1]);
  }
  return out;
}

// Output is capped at 5,000 facts per file, so scanning past this many declarations is wasted work.
const MAX_DECLS = 5000;
const NAME_BLACKLIST = new Set(['where', 'new', 'extends', 'implements', 'func', 'var', 'let', 'init', 'subscript', 'typealias', 'fun', 'is', 'as', 'of', 'in']);

const TYPE_RES = {
  java: [/(?<![.\w])(@interface|class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g],
  csharp: [/(?<![.\w@])(class|interface|struct|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/g],
  kotlin: [/(?<![.\w:])(class|interface|object)\s+([A-Za-z_]\w*)/g],
  scala: [/(?<![.\w])(class|trait|object)\s+([A-Za-z_]\w*)/g],
  swift: [/(?<![.\w])(class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/g],
  php: [/(?<![\w:>$\\])(class|interface|trait|enum)\s+([A-Za-z_]\w*)/g],
  rust: [/(?<![.\w])(struct|enum|trait)\s+([A-Za-z_]\w*)/g],
  c: [/(?<![.\w])(struct|enum|union)\s+([A-Za-z_]\w*)/g],
  cpp: [/(?<![.\w])(enum\s+(?:class|struct)|class|struct|enum|union)\s+([A-Za-z_]\w*)/g],
};

const KW_FN = {
  kotlin: [/(?<![\w.])fun\s+(?:<[^>\n]*>\s*)?(?:[\w<>?,. ]+\.)?([A-Za-z_]\w*)\s*\(/gd],
  scala: [/(?<![\w.])def\s+([A-Za-z_]\w*|[+\-*/%<>=!&|^~:]+)/gd],
  swift: [/(?<![\w.])func\s+([A-Za-z_]\w*|[+\-*/%<>=!&|^~.]+)\s*(?:<[^>\n]*>\s*)?\(/gd, /(?<![\w.])(init)\??\s*\(/gd],
  rust: [/(?<![\w.])fn\s+([A-Za-z_]\w*)\s*(?:<[^(){};]*>)?\s*\(/gd],
  php: [/(?<![\w$>:])function\s+&?\s*([A-Za-z_]\w*)\s*\(/gd],
  go: [
    /(?<![\w.])func\s*\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/gd,
    /(?<![\w.])func\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/gd,
  ],
};

const CONTROL = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'synchronized', 'fixed', 'when',
  'try', 'return', 'sizeof', 'delegate', 'else', 'do', 'unsafe', 'checked', 'unchecked', 'typeof', 'nameof', 'default', 'await',
  'function', 'base', 'this', 'super', 'alignof', 'decltype', 'static_assert', 'throw']);

const TAIL_RE = /\)\s*(?:(?:const|noexcept(?:\s*\([^)]*\))?|override|final|volatile|mutable|&&?|->\s*[\w:<>*&,\s]+?|throws\s+[\w.<>,\s?]+?|where\s+[^{};]+?|requires\s+[\w:<>]+|=\s*0)\s*)*$/;
const NAME_RE = /([A-Za-z_~$][\w$]*(?:\s*<[^<>;(){}]*>)?(?:\s*::\s*~?[A-Za-z_]\w*(?:<[^<>;(){}]*>)?)*)\s*$/;

/** Locate a function whose body opens at `b` by reading the header backwards (Java, C#, C, C++). */
function headerFunc(code, pm, b, lang) {
  let k = b - 1;
  while (k >= 0 && isSpace(code.charCodeAt(k))) k--;
  if (k < 0 || '=,([;{}'.includes(code[k])) return null;
  let tail = code.slice(Math.max(0, k - 300), k + 1);
  let m = TAIL_RE.exec(tail);
  if (!m) return null;
  let close = k + 1 - tail.length + m.index;
  for (let guard = 0; guard < 40; guard++) {
    const open = pm[close];
    if (open < 0) return null;
    const base = Math.max(0, open - 120);
    const nm = NAME_RE.exec(code.slice(base, open));
    if (!nm) return null;
    const nameOff = base + nm.index;
    const before = code.slice(Math.max(0, nameOff - 30), nameOff);
    if (/(?:^|\W)new\s*$/.test(before) || /(?:\.|->)\s*$/.test(before)) return null;
    // `: base(x)` / `, member(y)` are constructor initialisers, not the function itself
    if (/[,:]\s*$/.test(before) || (CONTROL.has(nm[1]) && (nm[1] === 'base' || nm[1] === 'this'))) {
      let p = nameOff - 1;
      while (p >= 0 && isSpace(code.charCodeAt(p))) p--;
      if (code[p] === ',') {
        p--;
        while (p >= 0 && isSpace(code.charCodeAt(p))) p--;
        if (code[p] !== ')') return null;
        close = p;
        continue;
      }
      if (code[p] === ':') {
        let q = p - 1;
        while (q >= 0 && isSpace(code.charCodeAt(q))) q--;
        tail = code.slice(Math.max(0, q - 300), q + 1);
        m = TAIL_RE.exec(tail);
        if (!m) return null;
        close = q + 1 - tail.length + m.index;
        continue;
      }
      return null;
    }
    if (/\b(?:class|struct|record|interface|enum|union|namespace)\s+$/.test(before)) return null;
    const raw = nm[1].replace(/\s+/g, '');
    const parts = stripAngles(raw).split('::');
    const name = parts.pop();
    if (CONTROL.has(name) || /^[A-Z][A-Z0-9_]+$/.test(name)) return null;
    return { name, owner: parts.length ? parts.pop() : null, nameOff, open, close, params: code.slice(open + 1, close) };
  }
  return null;
}

/** Number of top-level comma-separated parameters; `self`/`this` receivers are not counted. */
export function countParams(text, lang) {
  const t = text.trim();
  if (!t) return 0;
  let depth = 0;
  let count = 1;
  let any = false;
  const segs = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '<') depth++;
    else if (ch === '>' && t[i - 1] !== '-' && t[i - 1] !== '=') depth--;
    if (ch === ',' && depth <= 0) { segs.push(cur); cur = ''; count++; } else cur += ch;
    if (!/\s/.test(ch)) any = true;
  }
  segs.push(cur);
  if (!any) return 0;
  let list = segs.map((s) => s.trim());
  if (list[list.length - 1] === '') list = list.slice(0, -1);
  if (lang === 'rust') list = list.filter((s) => !/^&?\s*(?:'\w+\s+)?(?:mut\s+)?self\b/.test(s));
  return list.length;
}

const DECISION = {
  default: /(?<![\w$.@:#])(?:if|elif|elsif|elseif|for|foreach|while|case|when|catch|rescue|except|unless|until|guard)\b/g,
  ruby: /(?<![\w$.@:#])(?:if|elsif|for|while|when|rescue|unless|until)\b/g,
};
const WORD_LOGIC = /(?<![\w$.@:])(?:and|or)\b/g;
const TERNARY = /(?<=[\s)\]])\?(?![.?:[=])(?=[^\n;{}]*:)/g;
const CONTROL_HEADER = /^\s*\}?\s*(?:else|if|for|foreach|while|switch|try|catch|finally|do|loop|match|when|guard|unless|until|using|lock|synchronized|select|elif)\b/;

const count = (re, s) => {
  let n = 0;
  for (const _ of s.matchAll(re)) n++;
  return n;
};

/** Cyclomatic complexity approximation: 1 + decision keywords + boolean operators + ternaries. */
export function cyclomatic(body, lang) {
  let c = 1 + count(lang === 'ruby' ? DECISION.ruby : DECISION.default, body);
  c += count(/&&|\|\|/g, body);
  if (lang === 'ruby' || lang === 'php') c += count(WORD_LOGIC, body);
  if (lang !== 'rust' && lang !== 'go') c += count(TERNARY, body);
  if (lang === 'rust') c += count(/=>/g, body);
  return c;
}

/**
 * Is the `{` at `i` the body of a control-flow statement? Checks the last non-blank line
 * before it (which handles brace-on-next-line styles, `if init; cond {` in Go and
 * semicolon-free languages), then the keyword in front of a multi-line `( ... )` condition.
 */
function isControlBrace(code, pm, i) {
  const lines = code.slice(Math.max(0, i - 500), i).split('\n');
  let last = lines.length - 1;
  while (last > 0 && lines[last].trim() === '') last--;
  if (CONTROL_HEADER.test(lines[last])) return true;
  let k = i - 1;
  while (k >= 0 && isSpace(code.charCodeAt(k))) k--;
  if (code[k] === ')' && pm[k] >= 0) {
    return /(?:^|[^\w$.])(?:if|for|foreach|while|switch|catch|using|lock|synchronized|when|elif|until|unless)\s*$/.test(code.slice(Math.max(0, pm[k] - 14), pm[k]));
  }
  return false;
}

/** Deepest stack of control-flow braces (if/for/while/switch/try...) inside a body. */
function braceNesting(code, pm, from, to) {
  const stack = [];
  let ctl = 0;
  let max = 0;
  for (let i = from; i < to; i++) {
    const c = code.charCodeAt(i);
    if (c === 123) {
      const isCtl = isControlBrace(code, pm, i);
      stack.push(isCtl);
      if (isCtl && ++ctl > max) max = ctl;
    } else if (c === 125 && stack.length) {
      if (stack.pop()) ctl--;
    }
  }
  return max;
}

function exportedFor(lang, name, prefix) {
  switch (lang) {
    case 'go': return /^[A-Z]/.test(name);
    case 'java': case 'csharp': return /\bpublic\b/.test(prefix);
    case 'kotlin': return !/\b(?:private|internal|protected)\b/.test(prefix);
    case 'scala': case 'php': return !/\b(?:private|protected)\b/.test(prefix);
    case 'rust': return /\bpub\b/.test(prefix);
    case 'swift': return /\b(?:public|open)\b/.test(prefix);
    case 'c': case 'cpp': return !/\bstatic\b/.test(prefix);
    default: return true;
  }
}

/** Nearest enclosing scope for each item, by one sweep over start-sorted ranges. */
function assignOwners(items, scopes) {
  const ss = [...scopes].sort((a, b) => a.start - b.start || b.end - a.end);
  const stack = [];
  let si = 0;
  for (const it of [...items].sort((a, b) => a.nameOff - b.nameOff)) {
    while (si < ss.length && ss[si].start <= it.nameOff) stack.push(ss[si++]);
    while (stack.length && stack[stack.length - 1].end < it.nameOff) stack.pop();
    const top = stack[stack.length - 1];
    if (!it.owner && top && top !== it && top.start <= it.nameOff && it.nameOff <= top.end) it.owner = top.name;
  }
}

/** Ruby has no braces: match `def`/`class`/`module` to their `end` with a keyword stack. */
function rubyScan(lx) {
  const { code } = lx;
  const re = /(?<![\w$@.:])(class|module|def|if|unless|while|until|case|for|begin|do|end)\b(?![?!])(?!\s*:(?!:))/g;
  const stack = [];
  const defs = [];
  const types = [];
  let loopLine = -1;
  // Line start tracked incrementally: matches arrive in order, so this stays linear even on
  // one enormous line.
  let ls = 0;
  let nl = code.indexOf('\n');
  for (const m of code.matchAll(re)) {
    const kw = m[1];
    const idx = m.index;
    while (nl !== -1 && nl < idx) {
      ls = nl + 1;
      nl = code.indexOf('\n', ls);
    }
    if (kw === 'end') {
      const top = stack.pop();
      if (!top) continue;
      if (top.kw === 'def') defs.push({ off: top.off, end: idx + 3, maxNest: top.maxNest });
      else if (top.kw === 'class' || top.kw === 'module') types.push({ kw: top.kw, off: top.off, end: idx + 3 });
      continue;
    }
    const before = code.slice(Math.max(ls, idx - 80), idx);
    let opens = true;
    if (kw === 'if' || kw === 'unless' || kw === 'while' || kw === 'until') {
      opens = /^\s*$/.test(before) || /[=(,;{|&!?:]\s*$/.test(before) || /(?:^|\W)(?:else|then|do|ensure)\s*$/.test(before);
    }
    if (kw === 'do' && loopLine === ls) opens = false;
    if (!opens) continue;
    if (kw === 'while' || kw === 'until' || kw === 'for') loopLine = ls;
    if (kw === 'def') {
      const rest = code.slice(idx, Math.min(idx + 200, nl < 0 ? code.length : nl));
      if (/^def\s+[^\s(=]+(?:\([^)]*\))?\s*=(?![=~>])/.test(rest)) {
        defs.push({ off: idx, end: idx + rest.length, maxNest: 0 });
        continue;
      }
    }
    const ctl = ['if', 'unless', 'while', 'until', 'case', 'for', 'begin'].includes(kw);
    // Each entry remembers its nearest enclosing `def` and its control depth inside it, so
    // nesting is O(1) per keyword however deep the (possibly adversarial) stack gets.
    const parent = stack[stack.length - 1];
    const entry = { kw, off: idx, ctl, maxNest: 0, def: null, depth: 0 };
    if (kw === 'def') entry.def = entry;
    else if (kw !== 'class' && kw !== 'module' && parent?.def) {
      entry.def = parent.def;
      entry.depth = parent.depth + (ctl ? 1 : 0);
      if (ctl) entry.def.maxNest = Math.max(entry.def.maxNest, entry.depth);
    }
    stack.push(entry);
  }
  return { defs: defs.sort((a, b) => a.off - b.off), types: types.sort((a, b) => a.off - b.off) };
}

function litsIn(lx, a, b) {
  const out = [];
  let lo = 0;
  let hi = lx.literals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lx.literals[mid].start < a) lo = mid + 1; else hi = mid;
  }
  for (let k = lo; k < lx.literals.length && lx.literals[k].start < b; k++) out.push(lx.literals[k]);
  return out;
}

function findPackage(code, lang) {
  const pick = (re) => re.exec(code)?.[1] ?? null;
  const all = (re) => [...code.matchAll(re)].map((m) => m[1]);
  switch (lang) {
    case 'java': return { pkg: pick(/^[ \t]*package\s+([\w.]+)\s*;/m), namespaces: [] };
    case 'kotlin': case 'scala': return { pkg: pick(/^[ \t]*package\s+([\w.]+)/m), namespaces: [] };
    case 'go': return { pkg: pick(/^[ \t]*package\s+(\w+)/m), namespaces: [] };
    case 'csharp': return { pkg: null, namespaces: all(/\bnamespace\s+([\w.]+)\s*[;{]/g) };
    case 'php': return { pkg: null, namespaces: all(/^[ \t]*namespace\s+([\w\\]+)\s*[;{]/gm) };
    case 'cpp': return { pkg: null, namespaces: all(/\bnamespace\s+([\w:]+)\s*\{/g) };
    default: return { pkg: null, namespaces: [] };
  }
}

function findImports(lx, lang, pm, types) {
  const { code } = lx;
  const out = [];
  const add = (spec, kind, off) => {
    if (spec) out.push({ spec, kind, line: lx.lineOf(off) });
  };
  const inType = (off) => types.some((t) => t.start < off && off < t.end);
  const re = (r) => code.matchAll(r);
  switch (lang) {
    case 'java':
      for (const m of re(/^[ \t]*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm)) add(m[2], m[1] ? 'static' : 'import', m.index);
      break;
    case 'kotlin':
      for (const m of re(/^[ \t]*import\s+([\w.]*\w(?:\.\*)?)/gm)) add(m[1], 'import', m.index);
      break;
    case 'scala':
      for (const m of re(/^[ \t]*import\s+([^\n;]+)/gm)) {
        for (const p of expandGroups(m[1], '.')) add(p.replace(/\._$/, '._'), 'import', m.index);
      }
      break;
    case 'csharp':
      for (const m of re(/^[ \t]*(?:global\s+)?using\s+(static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm)) add(m[2], m[1] ? 'static' : 'using', m.index);
      break;
    case 'go':
      for (const m of re(/^[ \t]*import\b[ \t]*/gm)) {
        const p = m.index + m[0].length;
        if (code[p] === '(') {
          const close = pm[p];
          for (const l of litsIn(lx, p, close < 0 ? p + 4000 : close)) add(l.value, 'import', l.start);
        } else {
          const skip = /^[\w.]+\s*/.exec(code.slice(p, p + 40));
          const l = lx.litAt(p + (skip ? skip[0].length : 0));
          if (l) add(l.value, 'import', l.start);
        }
      }
      break;
    case 'rust':
      for (const m of re(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm)) {
        for (const p of expandGroups(m[1], '::')) add(p, 'use', m.index);
      }
      for (const m of re(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) add(m[1], 'mod', m.index);
      for (const m of re(/^[ \t]*extern\s+crate\s+(\w+)/gm)) add(m[1], 'use', m.index);
      break;
    case 'ruby':
      for (const m of re(/^[ \t]*(require_relative|require|load)\b[ \t(]*(['"])/gm)) {
        const l = lx.litAt(m.index + m[0].length - 1);
        if (l) add(l.value, m[1], m.index);
      }
      break;
    case 'php':
      for (const m of re(/^[ \t]*use\s+([^;()]+);/gm)) {
        if (inType(m.index)) continue;
        for (const p of expandGroups(m[1].replace(/^\s*(?:function|const)\s+/, ''), '\\')) add(p.replace(/^\\/, ''), 'use', m.index);
      }
      for (const m of re(/(?<![\w$>:])(require_once|require|include_once|include)\b[ \t(]*(?:__DIR__[ \t]*\.[ \t]*)?(['"])/g)) {
        const l = lx.litAt(m.index + m[0].length - 1);
        if (l) add(l.value, m[1], m.index);
      }
      break;
    case 'swift':
      for (const m of re(/^[ \t]*(?:@\w+\s+)*import\s+(?:(?:struct|class|enum|protocol|func|var|let|typealias)\s+)?([\w.]+)/gm)) add(m[1], 'import', m.index);
      break;
    case 'c': case 'cpp':
      for (const m of re(/^[ \t]*#[ \t]*include[ \t]*(?:"|<([^>\n]+)>)/gm)) {
        if (m[1]) add(m[1], 'include_system', m.index);
        else {
          const l = lx.litAt(m.index + m[0].length - 1);
          if (l) add(l.value, 'include_local', m.index);
        }
      }
      break;
    default:
  }
  return out.slice(0, 2000);
}

/**
 * Lexically analyse one file.
 * @param {ReturnType<typeof import('./lexer.mjs').lex>} lx
 * @param {string} lang
 */
export function analyze(lx, lang) {
  const { code } = lx;
  const n = code.length;
  const pm = matchPairs(code, 40, 41);
  const bm = lang === 'ruby' ? null : matchPairs(code, 123, 125);
  const { pkg, namespaces } = findPackage(code, lang);
  const types = [];
  const extraScopes = [];
  const impls = [];
  const funcs = [];

  const addType = (kw, name, kwOff, nameOff, body, stop, hdrFrom) => {
    if (NAME_BLACKLIST.has(name) || types.length >= MAX_DECLS) return;
    const end = body >= 0 ? (bm[body] >= 0 ? bm[body] : n - 1) : stop;
    const hdr = code.slice(hdrFrom, body >= 0 ? body : stop);
    const lineStart = lx.lineStartOf(kwOff);
    const prefix = code.slice(Math.max(lineStart, kwOff - 200), kwOff);
    const typeKind = kw.replace(/\s+/g, ' ').replace('@interface', 'annotation');
    const isIface = /^(?:interface|protocol|trait|annotation)$/.test(typeKind);
    const t = {
      kind: isIface ? 'interface' : 'class',
      typeKind,
      name,
      nameOff,
      start: kwOff,
      end,
      hasBody: body >= 0,
      exported: exportedFor(lang, name, prefix),
      ...parseBases(lang, typeKind.split(' ')[0], hdr),
    };
    types.push(t);
  };

  if (lang === 'ruby') {
    const rs = rubyScan(lx);
    for (const t of rs.types) {
      const m = /^(?:class|module)\s+(?:<<\s*\w+|([A-Z][\w:]*)(?:\s*<\s*([A-Za-z_][\w:]*))?)/.exec(code.slice(t.off, t.off + 200));
      if (!m || !m[1]) continue;
      const rec = {
        kind: 'class', typeKind: t.kw, name: m[1], nameOff: t.off, start: t.off, end: t.end, hasBody: true, exported: true,
        extends: m[2] ? [m[2].split('::').pop()] : [], implements: [], bases: [],
      };
      types.push(rec);
    }
    let rubySkip = -1;
    for (const d of rs.defs) {
      if (d.off < rubySkip) continue;
      rubySkip = d.end;
      const m = /^def\s+(?:(?:self|[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*[?!=]?|\[\]=?|[+\-*/%<>=!~^&|]+)/.exec(code.slice(d.off, d.off + 200));
      if (!m) continue;
      const nameOff = d.off + m[0].length - m[1].length;
      let params = '';
      let k = d.off + m[0].length;
      while (code[k] === ' ') k++;
      if (code[k] === '(' && pm[k] >= 0) params = code.slice(k + 1, pm[k]);
      else if (code[k] !== '\n' && code[k] !== '=' && k < n) params = code.slice(k, code.indexOf('\n', k) < 0 ? n : code.indexOf('\n', k)).replace(/;[\s\S]*$/, '');
      const body = code.slice(d.off, d.end);
      funcs.push({
        name: m[1], owner: null, nameOff, start: d.off, end: d.end, params: countParams(params, lang),
        cyclomatic: cyclomatic(body, lang), maxNesting: d.maxNest, exported: true, body,
      });
    }
  } else {
    // types
    if (lang === 'go') {
      const goType = (sub, base) => {
        for (const m of sub.matchAll(/(?<![\w.])(?:type\s+)?([A-Za-z_]\w*)(?:\[[^\]\n]*\])?\s+(struct|interface)\b/g)) {
          const idx = base + m.index;
          const nameOff = idx + m[0].indexOf(m[1], m[0].startsWith('type') ? 4 : 0);
          let k = idx + m[0].length;
          while (k < n && isSpace(code.charCodeAt(k))) k++;
          if (code[k] === '{') addType(m[2], m[1], idx, nameOff, k, k, k);
        }
      };
      for (const m of code.matchAll(/^type\s+/gm)) {
        const after = m.index + m[0].length;
        if (code[after] === '(') {
          const close = pm[after];
          if (close > 0) goType(code.slice(after + 1, close), after + 1);
        } else goType(code.slice(m.index, code.indexOf('\n', m.index) < 0 ? n : code.indexOf('\n', m.index)), m.index);
      }
    } else if (TYPE_RES[lang]) {
      for (const re of TYPE_RES[lang]) {
        for (const m of code.matchAll(re)) {
          const nameOff = m.index + m[0].length - m[2].length;
          const nameEnd = nameOff + m[2].length;
          if (lang === 'c' || lang === 'cpp') {
            let k = nameEnd;
            while (k < n && isSpace(code.charCodeAt(k))) k++;
            if (code[k] !== '{' && !(lang === 'cpp' && (code[k] === ':' || code.startsWith('final', k)))) continue;
          }
          const sh = scanHeader(code, pm, nameEnd);
          if ((lang === 'c' || lang === 'cpp') && sh.body < 0) continue;
          addType(m[1], m[2], m.index, nameOff, sh.body, sh.stop, nameEnd);
        }
      }
    }
    if (lang === 'c' || lang === 'cpp') {
      for (const m of code.matchAll(/\btypedef\s+(struct|union|enum)\s*(?:\w+\s*)?\{/g)) {
        const b = m.index + m[0].length - 1;
        if (bm[b] < 0) continue;
        const nm = /^\s*\*?\s*([A-Za-z_]\w*)/.exec(code.slice(bm[b] + 1, bm[b] + 80));
        if (nm && !types.some((t) => t.start === m.index)) {
          const nameOff = bm[b] + 1 + nm[0].length - nm[1].length;
          addType(m[1], nm[1], m.index, nameOff, b, b, b);
        }
      }
    }
    if (lang === 'rust') {
      for (const m of code.matchAll(/(?<![\w.])impl\b/g)) {
        const sh = scanHeader(code, pm, m.index + 4);
        if (sh.body < 0) continue;
        const h = code.slice(m.index + 4, sh.body).trim().replace(/^<(?:[^<>]|<[^<>]*>)*>\s*/, '').replace(/\bwhere\b[\s\S]*$/, '');
        const parts = h.split(/\s+for\s+/);
        const typeName = simpleName(parts[parts.length - 1].replace(/^[!&]*\s*(?:dyn\s+|mut\s+)?/, ''));
        const traitName = parts.length > 1 ? simpleName(parts[0].replace(/^!/, '')) : null;
        if (!typeName) continue;
        extraScopes.push({ name: typeName, start: m.index, end: bm[sh.body] >= 0 ? bm[sh.body] : n - 1 });
        if (traitName) impls.push({ type: typeName, trait: traitName, line: lx.lineOf(m.index) });
      }
    }
    if (lang === 'swift') {
      for (const m of code.matchAll(/(?<![\w.])extension\s+([A-Za-z_][\w.]*)/g)) {
        const sh = scanHeader(code, pm, m.index + m[0].length);
        if (sh.body < 0) continue;
        extraScopes.push({ name: m[1].split('.').pop(), start: m.index, end: bm[sh.body] >= 0 ? bm[sh.body] : n - 1 });
      }
    }

    // functions
    const pushFunc = (f) => {
      if (funcs.length >= MAX_DECLS) return;
      const startLineOff = lx.lineStartOf(f.nameOff);
      const bodyFrom = f.bodyStart;
      const body = code.slice(bodyFrom, f.end + 1);
      const nestFrom = code[bodyFrom] === '{' ? bodyFrom + 1 : bodyFrom;
      funcs.push({
        name: f.name,
        owner: f.owner ?? null,
        nameOff: f.nameOff,
        start: f.start ?? startLineOff,
        end: f.end,
        params: countParams(f.params, lang),
        cyclomatic: cyclomatic(body, lang),
        maxNesting: braceNesting(code, pm, nestFrom, f.end),
        exported: exportedFor(lang, f.name, f.prefix ?? code.slice(startLineOff, f.nameOff)),
        body,
      });
    };
    if (lang === 'java' || lang === 'csharp' || lang === 'c' || lang === 'cpp') {
      let skipUntil = -1;
      let b = code.indexOf('{');
      while (b >= 0) {
        if (b > skipUntil && bm[b] >= 0) {
          const f = headerFunc(code, pm, b, lang);
          if (f) {
            const hs = skipAnnotations(code, pm, headerStart(code, pm, b), lang);
            pushFunc({ ...f, bodyStart: b, end: bm[b], start: Math.min(hs, f.nameOff), prefix: code.slice(Math.min(hs, f.nameOff), f.nameOff) });
            skipUntil = bm[b];
          }
        }
        b = code.indexOf('{', Math.max(b, skipUntil) + 1);
      }
    } else if (KW_FN[lang]) {
      let skipUntil = -1;
      const found = [];
      for (const re of KW_FN[lang]) {
        for (const m of code.matchAll(re)) {
          let name;
          let owner = null;
          let nameOff;
          let open;
          if (lang === 'go' && m.indices[2]) {
            owner = m[1];
            name = m[2];
            nameOff = m.indices[2][0];
            open = m.index + m[0].length - 1;
          } else {
            name = m[1];
            nameOff = m.indices[1][0];
            open = m.index + m[0].length - 1;
            if (lang === 'scala') {
              let k = m.index + m[0].length;
              while (code[k] === ' ') k++;
              if (code[k] === '[') {
                let depth = 0;
                while (k < n) {
                  if (code[k] === '[') depth++;
                  else if (code[k] === ']' && --depth === 0) { k++; break; }
                  k++;
                }
                while (code[k] === ' ') k++;
              }
              open = code[k] === '(' ? k : -1;
            }
          }
          found.push({ m, name, owner, nameOff, open });
        }
      }
      found.sort((a, b) => a.nameOff - b.nameOff);
      for (const f of found) {
        if (f.nameOff < skipUntil) continue;
        const close = f.open >= 0 ? pm[f.open] : f.nameOff + f.name.length - 1;
        if (f.open >= 0 && close < 0) continue;
        const after = close + 1;
        const sh = scanHeader(code, pm, after);
        let bodyStart;
        let end;
        if (sh.body >= 0) {
          bodyStart = sh.body;
          end = bm[sh.body] >= 0 ? bm[sh.body] : n - 1;
        } else if ((lang === 'kotlin' || lang === 'scala') && code.slice(after, sh.stop).includes('=')) {
          bodyStart = after;
          end = sh.stop;
        } else continue;
        skipUntil = end;
        const lineStart = lx.lineStartOf(f.m.index);
        pushFunc({
          name: f.name, owner: f.owner, nameOff: f.nameOff, bodyStart, end, start: lineStart,
          params: f.open >= 0 ? code.slice(f.open + 1, close) : '',
          prefix: code.slice(lineStart, f.m.index),
        });
      }
    }
  }

  assignOwners(funcs, [...types.map((t) => ({ name: t.name, start: t.start, end: t.end })), ...extraScopes]);
  for (const f of funcs) {
    f.startLine = lx.lineOf(f.start);
    f.endLine = lx.lineOf(Math.min(f.end, n - 1));
  }
  for (const t of types) {
    t.startLine = lx.lineOf(t.start);
    t.endLine = lx.lineOf(Math.min(t.end, n - 1));
  }
  types.sort((a, b) => a.start - b.start);
  funcs.sort((a, b) => a.start - b.start || a.nameOff - b.nameOff);
  const imports = findImports(lx, lang, pm, types);
  return { pkg, namespaces, imports, types, funcs, impls, pm, bm };
}
