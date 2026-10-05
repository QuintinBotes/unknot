// Unreachable statements: code that follows an unconditional return/throw/break/continue
// in the same block. Token based, like the structural pass: a small statement scanner that
// knows just enough control flow to see that `if/else`, nested blocks and `try/catch/finally`
// can complete abruptly. It under-reports by design (loops, switches and labels never
// count as terminating), because a wrong "dead" claim costs more than a missed one.
//
// Only a block's own statements are reported. A `return` inside a nested block, a different
// `case` arm or an `if` without braces never makes the code after that statement dead.

import { makeUtil } from './tokutil.mjs';

export const MAX_UNREACHABLE = 20;

const NOT_JUMP_NEXT = new Set([':', ',', '=', '.', '?.', ')', ']']);
// A `{` after one of these opens a statement block rather than an object literal.
const BLOCK_PREV_P = new Set([')', '=>', ';', '}', '{']);
const BLOCK_PREV_ID = new Set(['else', 'try', 'finally', 'do']);
// Declarations that are hoisted or erased, so they are reachable (or inert) after a jump.
const SKIP_START = new Set(['function', 'class', 'interface', 'declare', 'abstract', 'export', 'import', 'enum', 'namespace', 'module']);

/** Map of function record to [{ line, after }] for every function with a block body. */
export function findUnreachable(tokens, n, match, functions) {
  const U = makeUtil(tokens, n, match);
  const { at, isP, isId, exprEnd } = U;
  const owners = functions.filter((f) => f._bodyStart !== undefined && isP(f._bodyStart, '{') && match[f._bodyStart] > f._bodyStart);
  const bodyStarts = new Map(owners.map((f) => [f._bodyStart, f]));
  const results = new Map(owners.map((f) => [f, []]));

  const isGroup = (k) => isP(k, '(') || isP(k, '[') || isP(k, '{');
  const closeOf = (k) => Math.min(match[k] < 0 ? n : match[k], n);

  /** { end, term }: index of the statement's last token and the jump that ends it, if any. */
  function stmt(i, limit) {
    const t = at(i);
    const clamp = (end) => Math.min(Math.max(end, i), limit);
    if (t.t === 'p' && t.v === '{') return { end: clamp(closeOf(i)), term: blockTerm(i) };
    if (t.t !== 'id') return { end: clamp(exprEnd(i, true)), term: null };
    switch (t.v) {
      case 'return': case 'throw': case 'break': case 'continue': {
        const nx = at(i + 1);
        const term = nx.t === 'p' && NOT_JUMP_NEXT.has(nx.v) ? null : t.v;
        return { end: clamp(exprEnd(i, true)), term };
      }
      case 'if': {
        if (!isP(i + 1, '(')) break;
        const a = stmt(closeOf(i + 1) + 1, limit);
        if (isId(a.end + 1, 'else')) {
          const b = stmt(a.end + 2, limit);
          return { end: b.end, term: a.term && b.term ? a.term : null };
        }
        return { end: a.end, term: null };
      }
      case 'try': {
        if (!isP(i + 1, '{')) break;
        const b = stmt(i + 1, limit);
        let end = b.end;
        let catchTerm = null;
        let hasCatch = false;
        let finTerm = null;
        if (isId(end + 1, 'catch')) {
          hasCatch = true;
          let k = end + 2;
          if (isP(k, '(')) k = closeOf(k) + 1;
          if (!isP(k, '{')) return { end: clamp(end), term: null };
          const c = stmt(k, limit);
          catchTerm = c.term;
          end = c.end;
        }
        if (isId(end + 1, 'finally') && isP(end + 2, '{')) {
          const f = stmt(end + 2, limit);
          finTerm = f.term;
          end = f.end;
        }
        const body = b.term && (!hasCatch || catchTerm) ? b.term : null;
        return { end: clamp(end), term: finTerm ?? body };
      }
      case 'for': case 'while': case 'with': {
        let k = i + 1;
        if (isId(k, 'await')) k++;
        if (!isP(k, '(')) break;
        return { end: stmt(closeOf(k) + 1, limit).end, term: null };
      }
      case 'do': {
        const b = stmt(i + 1, limit);
        let end = b.end;
        if (isId(end + 1, 'while') && isP(end + 2, '(')) end = closeOf(end + 2);
        if (isP(end + 1, ';')) end++;
        return { end: clamp(end), term: null };
      }
      case 'switch':
        if (isP(i + 1, '(') && isP(closeOf(i + 1) + 1, '{')) return { end: clamp(closeOf(closeOf(i + 1) + 1)), term: null };
        break;
      case 'function': case 'class': {
        // Declarations end at the close of the body `{`. Type syntax in the header is not
        // the body: generic arguments (`extends Base<{ a: 1 }>`) and an object-type return
        // annotation (`function f(): { a: string } {`) both contain braces (found on an
        // unfamiliar repository: the real body was then read as a bare block).
        let k = i + 1;
        while (k < limit && !isP(k, '{') && !isP(k, ';')) {
          if (isP(k, '<')) {
            const r = U.skipAngle(k);
            k = r > 0 ? r : k + 1;
          } else if (isP(k, ':') && t.v === 'function') {
            k = U.skipType(k + 1, { body: true });
          } else k = isGroup(k) ? closeOf(k) + 1 : k + 1;
        }
        return { end: clamp(isP(k, '{') ? closeOf(k) : k), term: null };
      }
      default:
    }
    return { end: clamp(exprEnd(i, true)), term: null };
  }

  /** The jump that every path through the block ends with, or null. */
  function blockTerm(open) {
    const c = closeOf(open);
    let i = open + 1;
    while (i < c) {
      if (isP(i, ';')) { i++; continue; }
      const s = stmt(i, c - 1);
      if (s.term) return s.term;
      i = s.end + 1;
    }
    return null;
  }

  /** Index just past a `case x:` / `default:` label, or -1 when i is not one. */
  function labelEnd(i, c) {
    if (isId(i, 'default') && isP(i + 1, ':')) return i + 2;
    if (!isId(i, 'case')) return -1;
    let q = 0;
    for (let k = i + 1; k < c; k++) {
      if (isGroup(k)) { k = closeOf(k); continue; }
      if (isP(k, '?')) q++;
      else if (isP(k, ':')) { if (q === 0) return k + 1; q--; }
    }
    return -1;
  }

  function skippable(i) {
    const t = at(i);
    if (t.t !== 'id') return false;
    if (SKIP_START.has(t.v)) return true;
    if (t.v === 'async' && isId(i + 1, 'function')) return true;
    return t.v === 'type' && at(i + 1).t === 'id' && (isP(i + 2, '=') || isP(i + 2, '<'));
  }

  function scanBlock(open, out) {
    const c = closeOf(open);
    let dead = null;
    let reported = false;
    let i = open + 1;
    while (i < c) {
      if (isP(i, ';')) { i++; continue; }
      const lab = labelEnd(i, c);
      if (lab !== -1) { dead = null; reported = false; i = lab; continue; }
      const s = stmt(i, c - 1);
      if (dead && !reported && !skippable(i) && out.length < MAX_UNREACHABLE) {
        out.push({ line: at(i).l, after: dead });
        reported = true;
      }
      if (!dead && s.term) dead = s.term;
      i = s.end + 1;
    }
  }

  // One forward pass: every statement block is attributed to the innermost function.
  const stack = [];
  const ends = [];
  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    if (t.t !== 'p') continue;
    if (t.v === '}') {
      if (ends.length && ends[ends.length - 1] === i) { ends.pop(); stack.pop(); }
      continue;
    }
    if (t.v !== '{') continue;
    const owner = bodyStarts.get(i);
    if (owner) { stack.push(owner); ends.push(closeOf(i)); }
    const cur = stack.length ? stack[stack.length - 1] : null;
    if (!cur) continue;
    const prev = at(i - 1);
    const isBlock = owner || (prev.t === 'p' ? BLOCK_PREV_P.has(prev.v) : prev.t === 'id' && BLOCK_PREV_ID.has(prev.v));
    if (isBlock) scanBlock(i, results.get(cur));
  }
  return results;
}
