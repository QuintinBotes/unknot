// Shared, bounded lexical view: code offsets survive comment and string masking.
import { lex } from './generic/lexer.mjs';

export const MAX_OPERATIONS = 400;
export const MAX_TEXT = 1_500_000;
export function view(text, lang) {
  return lex(text.slice(0, MAX_TEXT), lang);
}

export function closing(code, start, open = '(', close = ')') {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === open) depth++;
    if (code[i] === close && --depth === 0) return i;
  }
  return -1;
}

export function argumentsOf(raw) {
  const positional = [];
  const named = {};
  let quote = null;
  let depth = 0;
  let from = 0;
  const add = (part) => {
    const text = part.trim();
    if (!text) return;
    const m = /^([A-Za-z_]\w*)\s*(?:=|:)(?![=:])\s*([\s\S]*)$/.exec(text);
    if (m) named[m[1].toLowerCase()] = m[2];
    else positional.push(text);
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if ('"\'`'.includes(c)) quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { add(raw.slice(from, i)); from = i + 1; }
  }
  add(raw.slice(from));
  return { positional, named };
}

export function callsIn(lx) {
  const out = [];
  const ends = new Map();
  const stack = [];
  for (let i = 0; i < lx.code.length; i++) {
    if (lx.code[i] === '(') stack.push(i);
    else if (lx.code[i] === ')' && stack.length) ends.set(stack.pop(), i);
  }
  for (const m of lx.code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    if (out.length >= 10000) break;
    const open = m.index + m[0].lastIndexOf('(');
    const end = ends.get(open) ?? -1;
    if (end < 0) continue;
    const before = lx.code.slice(Math.max(0, m.index - 200), m.index);
    const receiver = /([A-Za-z_][\w.]*)\.\s*$/.exec(before)?.[1] ?? '';
    out.push({ name: m[1], index: m.index, end, line: lx.lineOf(m.index), receiver, before,
      args: argumentsOf(lx.plain.slice(open + 1, end)) });
  }
  return out;
}

/** Only a complete static string is a name. Interpolation and concatenation stay unresolved. */
export function stringValue(raw) {
  const m = /^(?:@)?(["'`])([\s\S]*)\1$/.exec(String(raw ?? '').trim());
  if (!m || m[2].includes('${') || /\\|[\r\n]/.test(m[2]) || m[2].includes(m[1])) return null;
  return m[2];
}
