// Route groups in the languages the lexical adapter reads (C#, Go): which object a route is
// registered on, and which prefix that object stands for. The spelling lives in the `groups`
// row of SYNTAX in ../http-ops.mjs; this file only finds calls and their receivers.
//
//   var v1 = app.MapGroup("/v1");  v1.MapGet("/x", h);       app.MapGroup("/a").MapGroup("/b").MapGet(...)
//   r.Route("/v1", func(r chi.Router) { r.Get("/x", h) })    g := r.Group("/v1"); g.GET("/x", h)
//
// A group handed to a function that registers routes on its parameter stays open here: the
// registration carries the function and the parameter, and the link step joins the prefix of the
// calls that name the function.

import { createGroups, paramNames } from '../http-ops.mjs';

const CALL = /(?<![\w$])([A-Za-z_]\w*)\s*\(/g;
const KEYWORD = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'func', 'new', 'typeof', 'nameof', 'sizeof', 'default', 'await', 'fixed', 'when', 'select', 'go', 'defer', 'make', 'append', 'len', 'cap']);
// A registration or a middleware call is not a function that is handed a group to register on.
const REGISTRATION = /^(?:Map(?:Get|Post|Put|Delete|Patch|Methods)|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options|Any|Handle|HandleFunc|Use|With)$/;
const STRING = /^@?"((?:[^"\\\n]|\\.)*)"$|^`([^`]*)`$/;

/** Top-level comma split of an argument list, with each argument's offset. */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === '`') quote = c;
    else if (c !== undefined && '([{'.includes(c)) depth++;
    else if (c !== undefined && ')]}'.includes(c)) depth--;
    else if ((c === ',' && depth === 0) || i === text.length) {
      const raw = text.slice(from, i);
      if (raw.trim() !== '' || i < text.length) out.push({ text: raw.trim(), off: from + raw.length - raw.trimStart().length });
      from = i + 1;
    }
  }
  return out;
}

/** The literal a prefix argument states, `null` when it is not a literal. */
const literal = (arg) => {
  const m = STRING.exec(arg?.text ?? '');
  return m ? (m[1] ?? m[2]) : null;
};

/**
 * @param {object} lx lexed file
 * @param {object} an structure analysis (funcs, pm)
 * @param {string} lang `csharp` or `go`
 */
export function scanRouteGroups(lx, an, lang) {
  const gs = createGroups(lang);
  const syn = gs.syn;
  const none = { at: () => null, attrs: () => ({}), moduleAttrs: () => ({}) };
  if (!syn.derive && !syn.scoped && !syn.create && !syn.mount) return none;
  const { code, plain } = lx;

  // Every call, in source order, with the call its receiver is when that is a call too.
  const calls = [];
  const byOpen = new Map();
  for (const m of plain.matchAll(CALL)) {
    if (code[m.index] !== plain[m.index] || KEYWORD.has(m[1])) continue;
    const nameOff = m.index;
    const open = nameOff + m[0].length - 1;
    const close = an.pm[open];
    if (close < 0 || close === undefined) continue;
    let k = nameOff - 1;
    while (k >= 0 && /\s/.test(plain[k])) k--;
    const c = { name: m[1], nameOff, open, close, dot: plain[k] === '.' ? k : -1, args: splitArgs(plain.slice(open + 1, close)).map((a) => ({ ...a, off: open + 1 + a.off })) };
    calls.push(c);
    byOpen.set(open, c);
  }

  /** What stands left of a call's dot: a bare name, another call, or neither. */
  const receiver = (c) => {
    if (c.dot < 0) return null;
    let k = c.dot - 1;
    while (k >= 0 && /\s/.test(plain[k])) k--;
    if (plain[k] === ')') {
      const open = an.pm[k];
      return open >= 0 && byOpen.has(open) ? { call: byOpen.get(open) } : null;
    }
    const m = /([A-Za-z_]\w*)$/.exec(plain.slice(Math.max(0, k - 60), k + 1));
    return m ? { name: m[1], off: k + 1 - m[1].length } : null;
  };

  // Scopes: a function (its parameters are groups handed in) and a callback of a scoped group.
  const funcs = an.funcs.map((f) => {
    const open = plain.indexOf('(', f.nameOff);
    const close = open >= 0 ? an.pm[open] : -1;
    return { f, key: `f${f.nameOff}`, params: close > open ? paramNames(plain.slice(open + 1, close), lang) : [] };
  });
  const funcAt = (off) => funcs.filter((x) => x.f.start <= off && off <= x.f.end).sort((a, b) => b.f.start - a.f.start)[0] ?? null;
  const callbacks = [];
  const bindings = new Map(); // `${scope}|${name}` -> [{ off, key }]
  const bind = (scope, name, off, key) => {
    const k = `${scope}|${name}`;
    if (!bindings.has(k)) bindings.set(k, []);
    bindings.get(k).push({ off, key });
  };

  const lookup = (name, off) => {
    for (const cb of callbacks.filter((x) => x.start <= off && off <= x.end).sort((a, b) => b.start - a.start)) {
      if (cb.param === name) return cb.key;
      const hit = (bindings.get(`${cb.key}|${name}`) ?? []).filter((b) => b.off <= off).pop();
      if (hit) return hit.key;
    }
    const fn = funcAt(off);
    if (fn) {
      const hit = (bindings.get(`${fn.key}|${name}`) ?? []).filter((b) => b.off <= off).pop();
      if (hit) return hit.key;
      const index = fn.params.findIndex((p) => p.name === name);
      if (index >= 0) {
        const key = `p${fn.f.nameOff}:${index}`;
        gs.param(key, { fn: fn.f.name, index, ext: index === 0 && fn.params[0].ext });
        return key;
      }
    }
    const hit = (bindings.get(`|${name}`) ?? []).filter((b) => b.off <= off).pop();
    return hit ? hit.key : null;
  };
  const scopeKey = (off) => {
    const cb = callbacks.filter((x) => x.start <= off && off <= x.end).sort((a, b) => b.start - a.start)[0];
    return cb ? cb.key : funcAt(off)?.key ?? '';
  };

  const made = new Map(); // call -> group key it returns
  /** The group a call's receiver stands for: null for no group (a root), through calls that only configure a group. */
  const recvKey = (c) => {
    const r = receiver(c);
    if (!r) return null;
    if (r.name) return lookup(r.name, r.off);
    return made.has(r.call) ? made.get(r.call) : recvKey(r.call);
  };
  /** Where the chain a call belongs to starts, for the name it is assigned to. */
  const chainStart = (c) => {
    const r = receiver(c);
    if (!r) return c.nameOff;
    return r.name ? r.off : chainStart(r.call);
  };
  const assigned = (c) => {
    const start = chainStart(c);
    const m = /(?:^|[\s;{(,])([A-Za-z_]\w*)\s*(?::=|=)(?![=>])\s*(?:await\s+)?$/.exec(plain.slice(Math.max(0, start - 80), start));
    return m ? m[1] : null;
  };
  const lastAssign = (c) => {
    const name = assigned(c);
    if (name) bind(scopeKey(c.nameOff), name, c.close, made.get(c));
  };

  const mountRow = (name) => (syn.mount ?? []).find((r) => r.name === name);
  for (const c of calls) {
    if (syn.derive?.includes(c.name) && c.dot >= 0) {
      const key = `d${c.nameOff}`;
      gs.group(key, { own: literal(c.args[0]), parent: recvKey(c) });
      made.set(c, key);
      lastAssign(c);
      continue;
    }
    if (syn.scoped?.includes(c.name) && c.dot >= 0 && c.args.length >= 2) {
      const fn = /\bfunc\s*\(\s*([A-Za-z_]\w*)[^)]*\)[^{]*\{/.exec(plain.slice(c.args[1].off, c.close));
      if (fn) {
        const start = c.args[1].off + fn.index + fn[0].length - 1;
        let depth = 0;
        let end = c.close;
        for (let i = start; i < c.close; i++) {
          if (code[i] === '{') depth++;
          else if (code[i] === '}' && --depth === 0) { end = i; break; }
        }
        const key = `s${c.nameOff}`;
        gs.group(key, { own: literal(c.args[0]), parent: recvKey(c) });
        callbacks.push({ start, end, param: fn[1], key });
        continue;
      }
    }
    if (syn.create && Object.hasOwn(syn.create, c.name)) {
      const key = `c${c.nameOff}`;
      gs.group(key, { own: '' });
      made.set(c, key);
      lastAssign(c);
      continue;
    }
    const row = c.dot >= 0 ? mountRow(c.name) : null;
    if (row) {
      const child = c.args[row.child];
      const key = child && /^[A-Za-z_]\w*$/.test(child.text) ? lookup(child.text, child.off) : null;
      if (key && gs.has(key)) gs.mount(key, recvKey(c), literal(c.args[row.prefix]), row.replaces);
      continue;
    }
    if (REGISTRATION.test(c.name)) continue;
    // A call that hands a group to a function: the receiver (an extension method) or an argument.
    const ref = (text, off) => (/^[A-Za-z_]\w*$/.test(text) ? (lookup(text, off) ?? '') : null);
    const r = receiver(c);
    const recv = !r ? null : r.name ? (lookup(r.name, r.off) ?? '') : (made.get(r.call) ?? recvKey(r.call) ?? '');
    gs.call(c.name, syn.receiverArg ? recv : null, c.args.map((a) => ref(a.text, a.off)));
  }

  return {
    /** The group resolution of the receiver of the call whose dot is at `dot`. */
    at(dot) {
      const c = calls.find((x) => x.dot === dot);
      if (!c) return null;
      const key = recvKey(c);
      return key ? gs.resolve(key) : null;
    },
    moduleAttrs: () => gs.moduleAttrs(),
  };
}
