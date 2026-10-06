// Route groups in JavaScript and TypeScript: a router object routes are registered on, and the
// prefix it is mounted below. The spelling lives in the `groups` row of SYNTAX in
// ../http-ops.mjs; this file reads the token stream.
//
//   const r = express.Router(); r.get('/x', h); app.use('/v1', r);
//   app.use('/v1', ordersRouter)   // ordersRouter imported: the link step joins the prefix
//   function registerOrders(r) { r.get('/x', h) }   registerOrders(v1)

import { createGroups } from '../http-ops.mjs';

const KEYWORD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'require', 'import', 'super', 'typeof', 'return', 'new', 'await', 'void', 'delete', 'async']);
const REGISTRATION = /^(?:get|post|put|patch|delete|options|head|all|use|route|listen|then|catch|finally|on|once|emit|log|info|warn|error|debug)$/;

/**
 * @param {{ at: Function, isP: Function, isId: Function, splitArgs: Function, literalOf: Function, n: number }} U token helpers
 * @param {Int32Array} match bracket table
 * @param {object} analysis structure pass (functions, imports, exports)
 */
export function scanRouteGroups(U, match, analysis) {
  const gs = createGroups('javascript');
  const { at, isP, isId, splitArgs, literalOf, n } = U;
  const syn = gs.syn;

  const funcs = analysis.functions
    .filter((f) => f._bodyStart != null && f.param_names?.length)
    .map((f) => ({ f, from: f._bodyStart, to: isP(f._bodyStart, '{') ? match[f._bodyStart] : U.exprEnd(f._bodyStart) }))
    .filter((x) => x.to >= x.from);
  const allFuncs = analysis.functions.filter((f) => f._bodyStart != null).map((f) => ({ from: f._bodyStart, to: isP(f._bodyStart, '{') ? match[f._bodyStart] : U.exprEnd(f._bodyStart) }));
  const insideFunction = (i) => allFuncs.some((x) => x.from <= i && i <= x.to);
  const funcAt = (i) => funcs.filter((x) => x.from <= i && i <= x.to).sort((a, b) => b.from - a.from)[0] ?? null;

  const bindings = new Map(); // name -> [{ i, key }]
  const bind = (name, i, key) => {
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).push({ i, key });
  };
  // The name a module-level variable is exported under: `export const x`, `export default x`, `module.exports = x`, `exports.y = x`.
  const exportedAs = new Map();
  for (const e of analysis.exports) if (e.local && !e.from) exportedAs.set(e.local, e.name);
  for (let i = 0; i < n; i++) {
    if (isId(i, 'module') && isP(i + 1, '.') && isId(i + 2, 'exports') && isP(i + 3, '=') && at(i + 4).t === 'id') exportedAs.set(at(i + 4).v, 'default');
    else if (isId(i, 'exports') && !isP(i - 1, '.') && isP(i + 1, '.') && at(i + 2).t === 'id' && isP(i + 3, '=') && at(i + 4).t === 'id') exportedAs.set(at(i + 4).v, at(i + 2).v);
    else if (isId(i, 'default') && isId(i - 1, 'export') && at(i + 1).t === 'id') exportedAs.set(at(i + 1).v, 'default');
  }
  const exportName = (local) => exportedAs.get(local) ?? null;

  const importOf = (local) => {
    for (const imp of analysis.imports) {
      for (const b of imp.bindings ?? []) {
        if (b.local === local) return { spec: imp.specifier, name: b.imported === '*' ? (imp.kind === 'require' ? 'default' : '*') : b.imported };
      }
    }
    return null;
  };

  const lookup = (name, i) => {
    const hit = (bindings.get(name) ?? []).filter((b) => b.i <= i).pop();
    const fn = funcAt(i);
    const index = fn ? fn.f.param_names.indexOf(name) : -1;
    if (hit && !(index >= 0 && fn && hit.i < fn.from)) return hit.key;
    if (index >= 0) {
      const key = `p${fn.from}:${index}`;
      gs.param(key, { fn: fn.f.name, index });
      return key;
    }
    return null;
  };

  // Calls, in source order: `name (` with the call its receiver is when that is a call too.
  const byName = new Map(); // token index of a call's name -> call
  const calls = [];
  for (let i = 0; i < n; i++) {
    const t = at(i);
    if (t.t !== 'id' || !isP(i + 1, '(') || KEYWORD.has(t.v)) continue;
    if (isId(i - 1, 'function') || isP(i - 1, '*') && isId(i - 2, 'function')) continue;
    const close = match[i + 1];
    if (close < 0 || close >= n) continue;
    const c = { i, name: t.v, open: i + 1, close, dot: isP(i - 1, '.') ? i - 1 : -1 };
    calls.push(c);
    byName.set(i, c);
  }
  const receiver = (c) => {
    if (c.dot < 0) return null;
    if (at(c.dot - 1).t === 'id') return { name: at(c.dot - 1).v, i: c.dot - 1 };
    if (isP(c.dot - 1, ')')) {
      const open = match[c.dot - 1];
      const inner = byName.get(open - 1);
      return inner ? { call: inner } : null;
    }
    return null;
  };
  const made = new Map();
  const recvKey = (c) => {
    const r = receiver(c);
    if (!r) return null;
    if (r.name) return lookup(r.name, r.i);
    return made.has(r.call) ? made.get(r.call) : recvKey(r.call);
  };
  const chainStart = (c) => {
    const r = receiver(c);
    if (!r) return c.i;
    return r.name ? r.i : chainStart(r.call);
  };
  const assigned = (c) => {
    let s = chainStart(c);
    if (isId(s - 1, 'new')) s--;
    return isP(s - 1, '=') && at(s - 2).t === 'id' ? at(s - 2).v : null;
  };

  const argsOf = (c) => splitArgs(c.open);
  const identOf = (a) => (a.e - a.s === 1 && at(a.s).t === 'id' ? at(a.s).v : null);

  /** What a mounted argument names: a local group, or a group another file exports. */
  const child = (a) => {
    const name = identOf(a);
    if (name) {
      const key = lookup(name, a.s);
      if (key && gs.has(key)) return { key };
      const imp = importOf(name);
      if (imp && imp.name !== '*') return { name: imp.name, hint: imp.spec };
      return null;
    }
    if (a.e - a.s === 3 && at(a.s).t === 'id' && isP(a.s + 1, '.') && at(a.s + 2).t === 'id') { // `ns.router`
      const imp = importOf(at(a.s).v);
      if (imp && imp.name === '*') return { name: at(a.s + 2).v, hint: imp.spec };
      if (imp && imp.name === 'default') return { name: at(a.s + 2).v, hint: imp.spec };
    }
    if (a.e - a.s === 4 && isId(a.s, 'require') && isP(a.s + 1, '(') && at(a.s + 2).t === 'str') return { name: 'default', hint: at(a.s + 2).v };
    return null;
  };

  for (const c of calls) {
    if (syn.create && Object.hasOwn(syn.create, c.name)) {
      const key = `c${c.i}`;
      const name = assigned(c);
      const module = !insideFunction(c.i);
      gs.group(key, { own: '', name: name && module ? exportName(name) : null, module });
      made.set(c, key);
      if (name) bind(name, c.close, key);
      continue;
    }
    const row = c.dot >= 0 ? (syn.mount ?? []).find((r) => r.name === c.name) : null;
    if (row) {
      const args = argsOf(c);
      if (!args.length) continue;
      const last = args[args.length - 1];
      const kid = child(last);
      if (!kid) continue;
      let prefix = '';
      if (args.length > 1) {
        const lit = literalOf(args[0].s, args[0].e);
        prefix = lit === null || lit === undefined ? null : lit;
      }
      const parent = recvKey(c);
      if (kid.key) gs.mount(kid.key, parent, prefix, row.replaces);
      else gs.mountImported(kid.name, kid.hint, parent, prefix);
      continue;
    }
    if (REGISTRATION.test(c.name) || isP(c.close + 1, '{')) continue;
    // A call that hands a group to a function.
    const args = argsOf(c).map((a) => { const name = identOf(a); return name ? (lookup(name, a.s) ?? '') : null; });
    gs.call(c.name, null, args);
  }

  return {
    /** The group resolution of the receiver of the registration whose method name is token `i`. */
    at(i) {
      const key = recvKey({ i, dot: i - 1 });
      return key ? gs.resolve(key) : null;
    },
    has(i) {
      const key = recvKey({ i, dot: i - 1 });
      return Boolean(key && gs.has(key));
    },
    moduleAttrs: () => gs.moduleAttrs(),
  };
}
