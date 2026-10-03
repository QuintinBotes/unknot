// Helpers shared by the structural pass and the framework detectors. They operate on the
// flat token stream from tokenizer.mjs plus a bracket-match table, and never recurse over
// nesting: groups are skipped by jumping to their matching close.

const BOF = Object.freeze({ t: 'bof', v: '', l: 0 });

// Words that cannot start a new value after a line break.
const NOT_VALUE_START = new Set(['in', 'instanceof', 'of', 'as', 'satisfies', 'extends', 'implements', 'is', 'else']);

/**
 * Builds the matching table for ( ) [ ] { } tokens. Unmatched openers map to `n` so
 * callers can treat them as "runs to the end of the file". Returns the number of
 * mismatches so the adapter can report a degraded parse.
 */
export function buildMatch(tokens, n) {
  const match = new Int32Array(n + 4).fill(-1);
  const stack = [];
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const tk = tokens[i];
    if (tk.t !== 'p') continue;
    const v = tk.v;
    if (v === '(' || v === '[' || v === '{') {
      stack.push(i);
    } else if (v === ')' || v === ']' || v === '}') {
      const want = v === ')' ? '(' : v === ']' ? '[' : '{';
      if (stack.length && tokens[stack[stack.length - 1]].v === want) {
        const o = stack.pop();
        match[o] = i;
        match[i] = o;
      } else {
        bad++;
        let k = stack.length - 1;
        while (k >= 0 && tokens[stack[k]].v !== want) k--;
        if (k >= 0) {
          const o = stack[k];
          for (let m = k + 1; m < stack.length; m++) match[stack[m]] = n;
          stack.length = k;
          match[o] = i;
          match[i] = o;
        }
      }
    }
  }
  bad += stack.length;
  for (const o of stack) match[o] = n;
  return { match, bad };
}

/** @param {object[]} tokens @param {number} n real token count @param {Int32Array} match */
export function makeUtil(tokens, n, match) {
  const EOF = tokens[n];
  const at = (k) => (k < 0 ? BOF : k > n ? EOF : tokens[k]);
  const isP = (k, v) => {
    const t = at(k);
    return t.t === 'p' && t.v === v;
  };
  const isId = (k, v) => {
    const t = at(k);
    return t.t === 'id' && (v === undefined || t.v === v);
  };
  const endLine = (t) => t.e ?? t.l;

  function isValueEnd(t) {
    switch (t.t) {
      case 'id': return !NOT_VALUE_START.has(t.v);
      case 'num': case 'str': case 're': case 'tpl': case 'tplt': case 'jx': return true;
      case 'jc': return t.self === true;
      case 'p': return t.v === ')' || t.v === ']' || t.v === '}';
      default: return false;
    }
  }

  function startsValue(t) {
    switch (t.t) {
      case 'id': return !NOT_VALUE_START.has(t.v);
      case 'num': case 'str': case 'tpl': case 'tplh': return true;
      default: return false;
    }
  }

  /**
   * Index of the last token of the expression (or, with `stmt`, statement) starting at s.
   * It ends at a `,`/`;` or unbalanced closer at the starting level, or where automatic
   * semicolon insertion would apply (a value followed by a value on a new line).
   */
  function exprEnd(s, stmt = false) {
    let j = s;
    let pv = null;
    while (j < n) {
      const t = tokens[j];
      if (t.t === 'p') {
        const v = t.v;
        if (v === '(' || v === '[' || v === '{') {
          const m = match[j];
          pv = m < n ? tokens[m] : null;
          j = m + 1;
          continue;
        }
        if (v === ')' || v === ']' || v === '}') return j - 1;
        if (v === ';') return stmt ? j : j - 1;
        if (v === ',' && !stmt) return j - 1;
      } else if (pv && j > s && t.l > endLine(pv) && isValueEnd(pv) && startsValue(t)) {
        return j - 1;
      }
      pv = t;
      j++;
    }
    return n - 1;
  }

  /** Top-level comma separated ranges inside the group opened at `open`. */
  function splitArgs(open) {
    const close = match[open];
    const out = [];
    if (close < 0) return out;
    let s = open + 1;
    let j = s;
    const stop = Math.min(close, n);
    while (j < stop) {
      const t = tokens[j];
      if (t.t === 'p') {
        if (t.v === '(' || t.v === '[' || t.v === '{') { j = match[j] + 1; continue; }
        if (t.v === ',') {
          if (j > s) out.push({ s, e: j });
          s = j + 1;
        }
      }
      j++;
    }
    if (stop > s) out.push({ s, e: stop });
    return out;
  }

  /** The string value when [s, e) is exactly one plain string/template literal, else null. */
  function literalOf(s, e) {
    if (e - s !== 1) return null;
    const t = at(s);
    if (t.t === 'str' || t.t === 'tpl') return t.v;
    return null;
  }

  /** Entries of the object literal opened at `open`: [{ key, s, e }] with [s, e) the value. */
  function objectEntries(open) {
    const out = [];
    for (const r of splitArgs(open)) {
      let s = r.s;
      if (isP(s, '...')) continue;
      let isAsync = false;
      if (isId(s, 'async') && !isP(s + 1, ':') && !isP(s + 1, ',') && !isP(s + 1, '(')) { isAsync = true; s++; }
      const kt = at(s);
      let key = null;
      let after = s + 1;
      if (kt.t === 'id' || kt.t === 'str' || kt.t === 'num') key = kt.v;
      else if (isP(s, '[')) { key = '[computed]'; after = match[s] + 1; }
      if (key === null) continue;
      if (isP(after, ':')) out.push({ key, s: after + 1, e: r.e, async: isAsync });
      else if (isP(after, '(')) out.push({ key, s: after, e: r.e, method: true });
      else if (after >= r.e) out.push({ key, s, e: r.e, shorthand: true });
    }
    return out;
  }

  /** After the `<` at k, the index just past its matching `>`; -1 when it does not look like type arguments. */
  function skipAngle(k) {
    let depth = 0;
    let j = k;
    const limit = Math.min(n, k + 600);
    while (j < limit) {
      const t = tokens[j];
      if (t.t === 'p') {
        const v = t.v;
        if (v === '<') depth++;
        else if (v === '>') { depth--; if (depth === 0) return j + 1; }
        else if (v === '(' || v === '[' || v === '{') { j = match[j] + 1; continue; }
        else if (v === ';' || v === ')' || v === ']' || v === '}' || v === '&&' || v === '||') return -1;
      }
      j++;
    }
    return -1;
  }

  const isTypeEnd = (t) => t.t === 'id' || t.t === 'str' || t.t === 'num' || t.t === 'tpl' ||
    (t.t === 'p' && (t.v === '>' || t.v === ')' || t.v === ']' || t.v === '}'));

  const CONT_NEXT = new Set(['|', '&', '.', '?', ':', '=>', '[', '<', '>', '=']);
  const CONT_WORDS = new Set(['extends', 'keyof', 'typeof', 'readonly', 'infer', 'is', 'asserts', 'in', 'as', 'unique', 'new', 'import']);

  /**
   * Skips a TypeScript type that starts at k and returns the index of the first token
   * after it. `stop` picks the terminators: { eq } stops at '=', { arrow } at '=>', { body }
   * at the '{' that opens a function body, { nl } at a line break between complete types.
   */
  function skipType(k, stop = {}) {
    let depth = 0;
    let prev = at(k - 1);
    while (k < n) {
      const t = tokens[k];
      if (t.t === 'p') {
        const v = t.v;
        if (v === '(' || v === '[' || v === '{') {
          if (v === '{' && depth === 0 && stop.body && isTypeEnd(prev)) return k;
          const m = match[k];
          prev = m < n ? tokens[m] : prev;
          k = m + 1;
          continue;
        }
        if (v === '<') depth++;
        else if (v === '>') { if (depth > 0) depth--; }
        else if (depth === 0) {
          if (v === ';' || v === ',' || v === ')' || v === ']' || v === '}') return k;
          if (v === '=' && stop.eq) return k;
          if (v === '=>' && stop.arrow) return k;
          if (v === '=' ) return k;
        }
      } else if (stop.nl && depth === 0 && t.l > endLine(prev) && isTypeEnd(prev) &&
        !(prev.t === 'id' && CONT_WORDS.has(prev.v)) && !(t.t === 'p' && CONT_NEXT.has(t.v)) &&
        !(t.t === 'id' && CONT_WORDS.has(t.v))) {
        return k;
      }
      prev = t;
      k++;
    }
    return n;
  }

  return { n, at, isP, isId, endLine, isValueEnd, startsValue, exprEnd, splitArgs, literalOf, objectEntries, skipAngle, skipType, isTypeEnd };
}
