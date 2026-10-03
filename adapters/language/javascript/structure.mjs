// Structural pass: functions, classes, metrics, imports, exports and calls from the token
// stream. This is a single forward walk with an explicit frame stack, not a parser. Where
// JavaScript is ambiguous it picks the reading that keeps metrics stable and says nothing
// it cannot see; unknown shapes are skipped rather than guessed.
//
// Metrics follow the task definition: cyclomatic = 1 + if/for/while/do/case/catch/?:/&&/||/??
// (and their assignment forms); cognitive follows SonarSource (structure + nesting, flat
// `else`, one increment per run of like boolean operators, labelled jumps). Anonymous
// callbacks are not nodes: their complexity is charged to the enclosing named function.

import { SQL_RE } from './sql.mjs';
import { makeUtil } from './tokutil.mjs';

const NOT_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'void', 'delete', 'await',
  'yield', 'import', 'super', 'in', 'of', 'instanceof', 'with', 'else', 'do', 'throw', 'case', 'async',
  'new', 'class', 'extends', 'require', 'constructor', 'this',
]);
const MEMBER_MODS = new Set([
  'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'override', 'declare', 'async',
  'accessor', 'get', 'set',
]);
const PEND_KEEP = new Set(['export', 'default', 'abstract', 'declare', 'class']);
const HOC_NAMES = new Set(['useCallback', 'memo', 'forwardRef', 'observer', 'useMemo']);
const PRIMITIVE_TYPES = new Set(['void', 'string', 'number', 'boolean', 'any', 'unknown', 'never', 'null', 'undefined', 'object', 'bigint', 'symbol']);
const OBJ_PREV_P = new Set(['=', '(', ',', ':', '?', '[', '&&', '||', '??', '...', '||=', '&&=', '??=', '!', '+']);
const OBJ_PREV_ID = new Set(['return', 'default', 'yield', 'await', 'typeof', 'case']);

const MAX_CALLS = 500;
const MAX_SQL = 100;

/**
 * @param {object[]} tokens
 * @param {number} n real token count (tokens[n..] are EOF sentinels)
 * @param {Int32Array} match bracket table from buildMatch
 * @param {{ ts?: boolean }} [opts]
 */
export function analyze(tokens, n, match, { ts = false } = {}) {
  const U = makeUtil(tokens, n, match);
  const { at, isP, isId, exprEnd, splitArgs, skipAngle, skipType, objectEntries } = U;

  const out = {
    functions: [], classes: [], interfaces: [], types: [], imports: [], exports: [], calls: [],
    envReads: new Set(), sql: [], directives: [],
  };

  const frames = [];
  const ROOT = { close: n + 1, fn: null, fl: null, own: null, scope: '', nest: 0, cd: 0, cls: null };
  const reg = new Map(); // body start token -> frame descriptor
  const jump = new Map(); // token -> token to continue from (types, parameter lists)
  const hints = new Map(); // expression start -> { name | full }
  const objects = new Map(); // '{' token -> qualified prefix of a name-bound object literal
  const classBodies = new Set();
  const doWhile = new Set();
  const bs = []; // open bracket kinds: { kind, prefix }
  const bops = []; // last boolean operator per bracket depth
  const tern = []; // bracket depths of open ternaries
  const usedQ = new Map();
  const exportedLocals = new Set();
  let pend = []; // decorators waiting for a class

  const top = () => (frames.length ? frames[frames.length - 1] : ROOT);

  // Directives such as 'use client' sit at the very start of the file.
  for (let k = 0; k < 3 && at(k).t === 'str'; k++) {
    out.directives.push(at(k).v);
    if (isP(k + 1, ';')) k++;
  }

  // ---- naming ---------------------------------------------------------------------

  const qualify = (name, fr) => (fr.scope ? `${fr.scope}.${name}` : name);

  function uniqueQ(q, line) {
    const c = usedQ.get(q) ?? 0;
    usedQ.set(q, c + 1);
    return c === 0 ? q : `${q}~${line}`;
  }

  function lastSegment(q) {
    const k = q.lastIndexOf('.');
    return k === -1 ? q : q.slice(k + 1);
  }

  // ---- records --------------------------------------------------------------------

  function paramInfo(open) {
    const names = [];
    for (const r of splitArgs(open)) {
      let s = r.s;
      while (isP(s, '@')) { // parameter decorators
        s++;
        while (at(s).t === 'id' || isP(s, '.')) s++;
        if (isP(s, '(')) s = match[s] + 1;
      }
      while (at(s).t === 'id' && /^(public|private|protected|readonly|override)$/.test(at(s).v) && at(s + 1).t !== 'p') s++;
      if (isP(s, '...')) s++;
      const t = at(s);
      if (t.t === 'id') { if (t.v !== 'this') names.push(t.v); } else if (isP(s, '{')) names.push('{}');
      else if (isP(s, '[')) names.push('[]');
    }
    return names;
  }

  function newFn(o) {
    const line = at(o.startTok).l;
    const end = at(Math.min(o.bodyEnd, n - 1));
    const rec = {
      type: o.cls ? 'method' : 'function',
      qname: uniqueQ(o.qname, line),
      name: lastSegment(o.qname),
      kind: o.kind,
      start_line: line,
      end_line: Math.max(end.e ?? end.l, line),
      params: o.paramNames.length,
      param_names: o.paramNames,
      cyclomatic: 1,
      cognitive: 0,
      max_nesting: 0,
      exported: false,
      async: !!o.async,
      generator: !!o.generator,
      returns: o.expr ? 1 : 0,
      return_type: o.retType ?? null,
      calls: [],
      decorators: o.decorators ?? [],
      parent: o.parent ?? null,
      cls: o.cls ?? null,
      _seen: new Set(),
    };
    rec.lines = rec.end_line - rec.start_line + 1;
    out.functions.push(rec);
    reg.set(o.bodyStart, { k: 'fn', node: rec, close: o.bodyClose });
    return rec;
  }

  function anonBody(bodyStart, bodyClose) {
    if (!reg.has(bodyStart)) reg.set(bodyStart, { k: 'anon', close: bodyClose });
  }

  function retTypeText(from, to) {
    if (!ts || to <= from) return null;
    let s = '';
    for (let k = from; k < to && s.length < 120; k++) {
      if (at(k).t === 'id' && at(k - 1).t === 'id' && k > from) s += ' ';
      s += at(k).v;
    }
    return s.replace(/^:/, '') || null;
  }

  function bodyAfterParams(close) {
    const b = close + 1;
    if (isP(b, '{')) return b;
    if (ts && isP(b, ':')) {
      const r = skipType(b + 1, { body: true });
      return isP(r, '{') ? r : -1;
    }
    return -1;
  }

  // ---- frames ---------------------------------------------------------------------

  function pushFrame(d, t) {
    let f;
    const close = Math.min(d.close, t.close);
    switch (d.k) {
      case 'fn':
        f = { close, fn: d.node, fl: d.node, own: d.node, scope: d.node.qname, nest: 0, cd: 0, cls: d.node.cls ? t.cls : null };
        break;
      case 'anon':
        f = { close, fn: t.fn, fl: null, own: t.own, scope: t.scope, nest: t.nest + 1, cd: t.cd, cls: null };
        break;
      case 'ctrl': {
        const cd = t.cd + 1;
        if (t.fn && cd > t.fn.max_nesting) t.fn.max_nesting = cd;
        f = { close, fn: t.fn, fl: t.fl, own: t.own, scope: t.scope, nest: t.nest + 1, cd, cls: t.cls };
        break;
      }
      case 'class':
        f = { close, fn: null, fl: null, own: d.node, scope: d.node.qname, nest: 0, cd: 0, cls: d.node };
        break;
      default: // ns
        f = { close, fn: null, fl: null, own: t.own, scope: d.scope, nest: 0, cd: 0, cls: null, ns: true };
    }
    frames.push(f);
    return f;
  }

  function ctrlBody(b, t) {
    if (!t.fn || reg.has(b) || b > n) return;
    if (isP(b, '{')) reg.set(b, { k: 'ctrl', close: match[b] });
    else if (at(b).t !== 'eof') reg.set(b, { k: 'ctrl', close: exprEnd(b, true) });
  }

  function credit(t, cyc, cog) {
    if (!t.fn) return;
    t.fn.cyclomatic += cyc;
    t.fn.cognitive += cog;
  }

  // ---- calls ----------------------------------------------------------------------

  function recordCall(i, t) {
    const nameTok = tokens[i];
    if (NOT_CALL.has(nameTok.v)) return;
    let j = i;
    const parts = [nameTok.v];
    while ((isP(j - 1, '.') || isP(j - 1, '?.')) && at(j - 2).t === 'id') {
      parts.unshift(at(j - 2).v);
      j -= 2;
    }
    if (isP(j - 1, '.') || isP(j - 1, '?.') || isId(j - 1, 'function')) return;
    const rec = { name: parts.join('.'), line: nameTok.l };
    if (isId(j - 1, 'new')) rec.new = true;
    const list = t.fn ? t.fn.calls : out.calls;
    const seen = t.fn ? t.fn._seen : (out._seen ??= new Set());
    const key = `${rec.name}:${rec.line}:${rec.new ? 1 : 0}`;
    if (list.length >= MAX_CALLS || seen.has(key)) return;
    seen.add(key);
    list.push(rec);
  }

  // ---- declarations ---------------------------------------------------------------

  function patternBindings(k) {
    const res = [];
    const object = isP(k, '{');
    for (const r of splitArgs(k)) {
      let s = r.s;
      if (isP(s, '...')) continue;
      const kt = at(s);
      if (object) {
        if (kt.t !== 'id' && kt.t !== 'str') continue;
        if (isP(s + 1, ':')) {
          if (at(s + 2).t === 'id') res.push({ imported: kt.v, local: at(s + 2).v });
        } else res.push({ imported: kt.v, local: kt.v });
      } else if (kt.t === 'id') res.push({ imported: null, local: kt.v });
    }
    return res;
  }

  /** Walks `a = 1, b: T = f()` after const/let/var. With `collect` it only returns names. */
  function declarators(k, collect) {
    const names = [];
    for (let guard = 0; guard < 400; guard++) {
      const t = at(k);
      let bind;
      if (t.t === 'id') { bind = { name: t.v, bindings: null }; k++; } else if (isP(k, '{') || isP(k, '[')) {
        const close = match[k];
        if (close >= n) break;
        bind = { name: null, bindings: patternBindings(k) };
        k = close + 1;
      } else break;
      names.push(bind);
      if (isP(k, '!')) k++;
      if (isP(k, ':')) {
        const r = skipType(k + 1, { eq: true, nl: true });
        if (!collect) jump.set(k, r);
        k = r;
      }
      if (isP(k, '=')) {
        const s = k + 1;
        if (!collect) initHints(bind, s);
        k = exprEnd(s) + 1;
      }
      if (isP(k, ',')) { k++; continue; }
      break;
    }
    return names;
  }

  function initHints(bind, s) {
    const t = at(s);
    if (bind.name) {
      hints.set(s, { name: bind.name });
      if (isP(s, '{')) objects.set(s, qualify(bind.name, top()));
      if (t.t === 'id' && HOC_NAMES.has(t.v) && isP(s + 1, '(')) hints.set(s + 2, { name: bind.name });
      else if (t.t === 'id' && at(s + 1).v === '.' && HOC_NAMES.has(at(s + 2).v) && isP(s + 3, '(')) hints.set(s + 4, { name: bind.name });
    }
    if (bind.name && t.t === 'id') {
      let lz = -1;
      if ((t.v === 'lazy' || t.v === 'dynamic') && isP(s + 1, '(')) lz = s;
      else if (t.v === 'React' && isP(s + 1, '.') && isId(s + 2, 'lazy') && isP(s + 3, '(')) lz = s + 2;
      if (lz !== -1) {
        const e = exprEnd(s);
        for (let k = s; k <= e; k++) if (isId(k, 'import') && isP(k + 1, '(')) { lazyBind.set(k, bind.name); break; }
      }
    }
    if (t.t === 'id' && t.v === 'require' && isP(s + 1, '(') && at(s + 2).t === 'str') {
      requireBind.set(s, bind.name ? [{ imported: '*', local: bind.name }] : bind.bindings);
    }
    if (t.t === 'id' && t.v === 'process' && isP(s + 1, '.') && isId(s + 2, 'env') && bind.bindings) {
      for (const b of bind.bindings) if (b.imported) out.envReads.add(b.imported);
    }
  }
  const requireBind = new Map();
  const lazyBind = new Map(); // import( token -> local name for const X = lazy(() => import('./x'))

  // ---- imports and exports --------------------------------------------------------

  function addImport(rec) {
    out.imports.push(rec);
  }

  function addExport(name, kind, line, local, from) {
    const e = { name, kind, line, local: local ?? null };
    if (from) e.from = from;
    out.exports.push(e);
    if (local && !from) exportedLocals.add(local);
  }

  function onImport(i) {
    const line = tokens[i].l;
    if (isP(i + 1, '(')) {
      if (at(i + 2).t === 'str' && (isP(i + 3, ')') || isP(i + 3, ','))) {
        const lb = lazyBind.get(i);
        addImport({
          specifier: at(i + 2).v, names: lb ? ['default'] : [], bindings: lb ? [{ imported: 'default', local: lb }] : [], kind: 'dynamic', line,
        });
      }
      return i + 1;
    }
    if (isP(i + 1, '.') && isId(i + 2, 'meta')) {
      if (isP(i + 3, '.') && isId(i + 4, 'env') && isP(i + 5, '.') && at(i + 6).t === 'id') out.envReads.add(at(i + 6).v);
      return i + 1;
    }
    let k = i + 1;
    if (at(k).t === 'str') {
      addImport({ specifier: at(k).v, names: [], bindings: [], kind: 'static', line });
      return k + 1;
    }
    let typeOnly = false;
    if (isId(k, 'type') && !isId(k + 1, 'from') && (at(k + 1).t === 'id' || isP(k + 1, '{') || isP(k + 1, '*'))) {
      typeOnly = true;
      k++;
    }
    const bindings = [];
    let allType = true;
    let any = false;
    if (at(k).t === 'id' && !isId(k, 'from')) {
      if (isP(k + 1, '=')) { // import x = require('y')
        if (isId(k + 2, 'require') && isP(k + 3, '(') && at(k + 4).t === 'str') {
          addImport({ specifier: at(k + 4).v, names: ['*'], bindings: [{ imported: '*', local: at(k).v }], kind: 'require', line });
          return k + 6;
        }
        return k + 1;
      }
      bindings.push({ imported: 'default', local: at(k).v });
      allType = false;
      any = true;
      k++;
      if (isP(k, ',')) k++;
    }
    if (isP(k, '*')) {
      if (isId(k + 1, 'as') && at(k + 2).t === 'id') bindings.push({ imported: '*', local: at(k + 2).v });
      allType = false;
      any = true;
      k += 3;
    } else if (isP(k, '{')) {
      const close = match[k];
      for (const r of splitArgs(k)) {
        let s = r.s;
        let isType = false;
        if (isId(s, 'type') && at(s + 1).t === 'id' && !isId(s + 1, 'as')) { isType = true; s++; } else if (isId(s, 'type') && at(s + 1).t === 'id' && isId(s + 1, 'as') && at(s + 2).t === 'id' && at(s + 3).t === 'id') { isType = true; s++; }
        const nt = at(s);
        if (nt.t !== 'id' && nt.t !== 'str') continue;
        const local = isId(s + 1, 'as') ? at(s + 2).v : nt.v;
        bindings.push({ imported: nt.v, local, type: isType || undefined });
        if (!isType) allType = false;
        any = true;
      }
      k = close + 1;
    }
    if (isId(k, 'from') && at(k + 1).t === 'str') {
      let end = k + 2;
      if ((isId(end, 'with') || isId(end, 'assert')) && isP(end + 1, '{')) end = match[end + 1] + 1;
      const kind = typeOnly || (any && allType) ? 'type' : 'static';
      const names = bindings.map((b) => b.imported);
      addImport({ specifier: at(k + 1).v, names: [...new Set(names)].sort(), bindings, kind, line });
      return end;
    }
    return i + 1;
  }

  function onExport(i) {
    const line = tokens[i].l;
    let k = i + 1;
    let isDefault = false;
    if (isId(k, 'default')) { isDefault = true; k++; }
    let typeOnly = false;
    if (isId(k, 'type') && (isP(k + 1, '{') || isP(k + 1, '*'))) { typeOnly = true; k++; }
    if (isP(k, '*')) {
      let alias = null;
      if (isId(k + 1, 'as') && at(k + 2).t === 'id') { alias = at(k + 2).v; k += 2; }
      if (isId(k + 1, 'from') && at(k + 2).t === 'str') {
        const spec = at(k + 2).v;
        addImport({ specifier: spec, names: ['*'], bindings: [], kind: typeOnly ? 'type' : 'reexport', line });
        addExport(alias ?? '*', 'reexport', line, null, spec);
      }
      return i + 1;
    }
    if (isP(k, '{') && !isDefault) {
      const close = match[k];
      const from = isId(close + 1, 'from') && at(close + 2).t === 'str' ? at(close + 2).v : null;
      const bindings = [];
      for (const r of splitArgs(k)) {
        let s = r.s;
        if (isId(s, 'type') && at(s + 1).t === 'id' && !isId(s + 1, 'as')) s++;
        const nt = at(s);
        if (nt.t !== 'id' && nt.t !== 'str') continue;
        const exported = isId(s + 1, 'as') ? at(s + 2).v : nt.v;
        addExport(exported, typeOnly ? 'type' : 'value', line, from ? null : nt.v, from);
        if (from) bindings.push({ imported: nt.v, local: exported });
      }
      if (from) {
        addImport({ specifier: from, names: [...new Set(bindings.map((b) => b.imported))].sort(), bindings, kind: typeOnly ? 'type' : 'reexport', line });
      }
      return i + 1;
    }
    while (isId(k, 'declare') || isId(k, 'abstract') || (isId(k, 'async') && isId(k + 1, 'function'))) k++;
    const kw = at(k);
    if (kw.t !== 'id') {
      if (isDefault) exportDefaultExpr(k, line);
      return i + 1;
    }
    switch (kw.v) {
      case 'function': {
        let j = k + 1;
        if (isP(j, '*')) j++;
        const name = at(j).t === 'id' && isP(j + 1, '(') || (at(j).t === 'id' && isP(j + 1, '<')) ? at(j).v : null;
        if (isDefault) {
          addExport('default', 'function', line, name ?? 'default');
          if (!name) hints.set(isId(k - 1, 'async') ? k - 1 : k, { name: 'default' });
        } else if (name) addExport(name, 'function', line, name);
        break;
      }
      case 'class': {
        const name = at(k + 1).t === 'id' && !['extends', 'implements'].includes(at(k + 1).v) ? at(k + 1).v : null;
        if (isDefault) {
          addExport('default', 'class', line, name ?? 'default');
          if (!name) hints.set(k, { name: 'default' });
        } else if (name) addExport(name, 'class', line, name);
        break;
      }
      case 'const': case 'let': case 'var':
        if (isId(k + 1, 'enum') && at(k + 2).t === 'id') {
          addExport(at(k + 2).v, 'enum', line, at(k + 2).v);
          break;
        }
        for (const b of declarators(k + 1, true)) {
          if (b.name) addExport(b.name, 'variable', line, b.name);
          else for (const x of b.bindings ?? []) addExport(x.local, 'variable', line, x.local);
        }
        break;
      case 'interface': case 'type': case 'enum': case 'namespace': case 'module': {
        const nm = at(k + 1);
        if (nm.t !== 'id') break;
        const kind = kw.v === 'module' ? 'namespace' : kw.v;
        addExport(nm.v, kind, line, nm.v);
        break;
      }
      default:
        if (isDefault) exportDefaultExpr(k, line);
    }
    return i + 1;
  }

  function exportDefaultExpr(s, line) {
    const t = at(s);
    let local = null;
    if (t.t === 'id' && (isP(s + 1, ';') || at(s + 1).l > t.l || at(s + 1).t === 'eof') && !['function', 'class', 'async'].includes(t.v)) local = t.v;
    addExport('default', 'value', line, local);
    hints.set(s, { name: 'default' });
    if (isP(s, '{')) objects.set(s, 'default');
    if (t.t === 'id' && HOC_NAMES.has(t.v) && isP(s + 1, '(')) hints.set(s + 2, { name: 'default' });
    else if (t.t === 'id' && at(s + 1).v === '.' && HOC_NAMES.has(at(s + 2).v) && isP(s + 3, '(')) hints.set(s + 4, { name: 'default' });
  }

  function onCjs(i) {
    const line = tokens[i].l;
    let k;
    if (isId(i, 'module')) {
      if (!(isP(i + 1, '.') && isId(i + 2, 'exports'))) return;
      k = i + 3;
      if (isP(k, '=')) {
        const s = k + 1;
        const t = at(s);
        if (isP(s, '{')) {
          objects.set(s, '');
          for (const e of objectEntries(s)) {
            const single = e.e - e.s === 1 && at(e.s).t === 'id' ? at(e.s).v : null;
            addExport(e.key, 'value', line, e.shorthand ? e.key : single ?? e.key);
          }
        } else {
          addExport('default', 'value', line, t.t === 'id' && at(s + 1).l > t.l ? t.v : null);
          hints.set(s, { name: 'default' });
        }
        return;
      }
      if (isP(k, '.') && at(k + 1).t === 'id' && isP(k + 2, '=')) {
        cjsNamed(at(k + 1).v, k + 3, line);
      }
      return;
    }
    // exports.name = ...
    if (isP(i + 1, '.') && at(i + 2).t === 'id' && isP(i + 3, '=')) cjsNamed(at(i + 2).v, i + 4, line);
  }

  function cjsNamed(name, s, line) {
    const t = at(s);
    addExport(name, 'value', line, t.t === 'id' && at(s + 1).l > t.l ? t.v : name);
    hints.set(s, { name });
  }

  // ---- functions and classes ------------------------------------------------------

  function onFunction(i, t) {
    let j = i + 1;
    const gen = isP(j, '*');
    if (gen) j++;
    let name = null;
    if (at(j).t === 'id') { name = at(j).v; j++; }
    if (isP(j, '<')) { const r = skipAngle(j); if (r > 0) j = r; }
    if (!isP(j, '(')) return i + 1;
    const c = match[j];
    if (c >= n) return i + 1;
    const body = bodyAfterParams(c);
    if (body === -1) return i + 1;
    const startTok = isId(i - 1, 'async') && !isP(i - 2, '.') ? i - 1 : i;
    const hint = hints.get(startTok);
    const bodyClose = match[body];
    const nm = hint ? (hint.full ?? qualify(hint.name, t)) : name ? qualify(name, t) : null;
    if (nm) {
      newFn({
        qname: nm, kind: 'function', startTok, bodyStart: body, bodyClose, bodyEnd: bodyClose, async: startTok !== i,
        generator: gen, paramNames: paramInfo(j), retType: retTypeText(c + 1, body), parent: t.own?.qname ?? null,
        cls: hint?.cls ?? null,
      });
    } else anonBody(body, bodyClose);
    return body;
  }

  function registerArrow(startTok, paramNames, a, kind, t) {
    const b = a + 1;
    if (reg.has(b)) return;
    const isBlock = isP(b, '{');
    const bodyClose = isBlock ? match[b] : exprEnd(b);
    const hint = hints.get(startTok);
    if (hint) {
      newFn({
        qname: hint.full ?? qualify(hint.name, t), kind: hint.cls ? 'arrow' : kind, startTok, bodyStart: b, bodyClose, bodyEnd: bodyClose,
        async: isId(startTok, 'async'), paramNames, expr: !isBlock, parent: t.own?.qname ?? null, cls: hint.cls ?? null,
      });
    } else anonBody(b, bodyClose);
  }

  function isTypeArrow(a) {
    if (!ts) return false;
    const b = at(a + 1);
    if (b.t !== 'id' || !PRIMITIVE_TYPES.has(b.v)) return false;
    const nx = at(a + 2);
    return nx.t === 'p' && ['>', ',', ')', ';', '=', '|', '&', '[', '}'].includes(nx.v) && !(b.v === 'void' && nx.v === '0');
  }

  function onOpenParen(i, t) {
    const c = match[i];
    if (c >= n) return -1;
    const nx = at(c + 1);
    let a = -1;
    if (nx.t === 'p' && nx.v === '=>') a = c + 1;
    else if (ts && nx.t === 'p' && nx.v === ':') {
      const r = skipType(c + 2, { arrow: true });
      if (isP(r, '=>')) a = r;
    }
    const topBracket = bs.length ? bs[bs.length - 1] : null;
    if (a !== -1) {
      let startTok = i;
      if (isId(i - 1, 'async') && !isP(i - 2, '.')) startTok = i - 1;
      else if (ts && isP(i - 1, '>')) {
        let j = i - 1;
        while (j > 0 && i - j < 60 && !isP(j, '<')) j--;
        if (isP(j, '<')) startTok = j;
      }
      const before = at(startTok - 1);
      const typePos = ts && before.t === 'p' && (before.v === '<' || before.v === '|' || before.v === '&' ||
        (before.v === ':' && !(topBracket && topBracket.kind === 'obj')));
      if (!typePos && !isTypeArrow(a)) {
        registerArrow(startTok, paramInfo(i), a, 'arrow', t);
        return a + 1;
      }
    }
    // Method shorthand inside an object literal: { name(...) { ... } }
    if (topBracket && topBracket.kind === 'obj') {
      const kt = at(i - 1);
      let keyIdx = i - 1;
      let name = kt.v;
      if (isP(i - 1, ']')) { name = '[computed]'; keyIdx = match[i - 1]; }
      if ((kt.t === 'id' || kt.t === 'str' || isP(i - 1, ']')) && !NOT_CALL.has(kt.v)) {
        const before = at(keyIdx - 1);
        let startTok = keyIdx;
        let kind = 'method';
        let isAsync = false;
        let p = before;
        let pi = keyIdx - 1;
        while (p.t === 'id' && (p.v === 'async' || p.v === 'get' || p.v === 'set') || (p.t === 'p' && p.v === '*')) {
          if (p.v === 'get') kind = 'getter';
          else if (p.v === 'set') kind = 'setter';
          else if (p.v === 'async') isAsync = true;
          startTok = pi;
          pi--;
          p = at(pi);
        }
        if (p.t === 'p' && (p.v === '{' || p.v === ',')) {
          const body = bodyAfterParams(c);
          if (body !== -1) {
            const bodyClose = match[body];
            if (topBracket.prefix !== null) {
              const full = topBracket.prefix ? `${topBracket.prefix}.${name}` : name;
              newFn({
                qname: full, kind, startTok, bodyStart: body, bodyClose, bodyEnd: bodyClose, async: isAsync,
                paramNames: paramInfo(i), retType: retTypeText(c + 1, body), parent: t.own?.qname ?? null,
              });
            } else anonBody(body, bodyClose);
            return body;
          }
        }
      }
    }
    return -1;
  }

  function parseDecorator(k) {
    let j = k + 1;
    let name = '';
    if (at(j).t === 'id') {
      name = at(j).v;
      j++;
      while (isP(j, '.') && at(j + 1).t === 'id') { name += `.${at(j + 1).v}`; j += 2; }
    }
    let args = [];
    if (isP(j, '(')) {
      const c = match[j];
      for (const r of splitArgs(j)) {
        const lit = U.literalOf(r.s, r.e);
        if (lit !== null) args.push(lit);
        else if (isP(r.s, '{')) {
          for (const e of objectEntries(r.s)) {
            const v = U.literalOf(e.s, e.e);
            if (v !== null && (e.key === 'path' || e.key === 'name')) { args = [v, ...args]; break; }
          }
        }
      }
      j = c + 1;
    }
    return { deco: { name, args, line: at(k).l }, end: j };
  }

  function onClass(i, t) {
    const p = at(i - 1);
    if (p.t === 'p' && (p.v === '.' || p.v === '?.')) return i + 1;
    let j = i + 1;
    let name = null;
    if (at(j).t === 'id' && !['extends', 'implements'].includes(at(j).v)) { name = at(j).v; j++; }
    if (name === null && !(isId(j, 'extends') || isP(j, '{') || isId(j, 'implements'))) return i + 1;
    if (name !== null && !(isP(j, '{') || isP(j, '<') || isId(j, 'extends') || isId(j, 'implements'))) return i + 1;
    if (isP(j, '<')) { const r = skipAngle(j); if (r > 0) j = r; }
    let ext = null;
    const impl = [];
    while (j < n && !isP(j, '{')) {
      if (isId(j, 'extends') || isId(j, 'implements')) {
        const isExt = at(j).v === 'extends';
        j++;
        for (;;) {
          let nm = '';
          while (at(j).t === 'id' && !(nm === '' && at(j).v === 'implements')) {
            nm += at(j).v;
            j++;
            if (isP(j, '.') && at(j + 1).t === 'id') { nm += '.'; j++; } else break;
          }
          if (isP(j, '<')) { const r = skipAngle(j); j = r > 0 ? r : j + 1; }
          if (isP(j, '(')) j = match[j] + 1;
          if (nm) { if (isExt) ext = nm; else impl.push(nm); }
          if (!isExt && isP(j, ',')) { j++; continue; }
          break;
        }
        continue;
      }
      j++;
      if (j - i > 400) return i + 1;
    }
    if (!isP(j, '{')) return i + 1;
    const open = j;
    const close = match[open];
    const hint = hints.get(i) ?? (isId(i - 1, 'abstract') ? hints.get(i - 1) : undefined);
    const baseName = name ?? hint?.name ?? null;
    if (baseName === null) { classBodies.add(open); return i + 1; }
    const startTok = isId(i - 1, 'abstract') ? i - 1 : i;
    const line = at(startTok).l;
    const cls = {
      qname: uniqueQ(qualify(baseName, t), line),
      name: baseName,
      start_line: line,
      end_line: Math.max(at(Math.min(close, n - 1)).l, line),
      extends: ext,
      implements: impl,
      decorators: pend,
      abstract: isId(i - 1, 'abstract'),
      exported: false,
      parent: t.own?.qname ?? null,
      methods: [],
    };
    cls.lines = cls.end_line - cls.start_line + 1;
    pend = [];
    out.classes.push(cls);
    classBodies.add(open);
    reg.set(open, { k: 'class', node: cls, close });
    scanMembers(cls, open, close);
    return i + 1;
  }

  function scanMembers(cls, open, close) {
    let k = open + 1;
    const stop = Math.min(close, n);
    let guard = 0;
    while (k < stop && guard++ < 100000) {
      const decos = [];
      while (isP(k, '@')) { const d = parseDecorator(k); decos.push(d.deco); k = d.end; }
      const mods = new Set();
      let gen = false;
      let staticBlock = false;
      for (;;) {
        const t = at(k);
        if (t.t !== 'id' || !MEMBER_MODS.has(t.v)) break;
        const nx = at(k + 1);
        if (nx.t === 'eof' || (nx.t === 'p' && ['(', '=', ';', ':', '?', '!', '<', '}', ','].includes(nx.v))) break;
        if (t.v === 'static' && nx.t === 'p' && nx.v === '{') { staticBlock = true; break; }
        mods.add(t.v);
        k++;
      }
      if (staticBlock) { k = match[k + 1] + 1; continue; }
      if (isP(k, '*')) { gen = true; k++; }
      const nt = at(k);
      let name;
      const nameIdx = k;
      if (nt.t === 'id' || nt.t === 'str' || nt.t === 'num') { name = nt.v; k++; } else if (isP(k, '[')) {
        const close = match[k];
        name = '[';
        for (let m = k + 1; m < close && name.length < 40; m++) name += at(m).v;
        name = `${name.replace(/\./g, '_')}]`; // a dot would read as a scope separator in the qualified name
        k = close + 1;
      } else { k++; continue; }
      if (isP(k, '?') || isP(k, '!')) k++;
      if (isP(k, '<')) { const r = skipAngle(k); if (r > 0) k = r; }
      const full = `${cls.qname}.${name}`;
      if (isP(k, '(')) {
        const c = match[k];
        if (c >= n) break;
        const body = bodyAfterParams(c);
        if (body !== -1) {
          const bodyClose = match[body];
          let kind = 'method';
          if (name === 'constructor' && !mods.has('static')) kind = 'constructor';
          else if (mods.has('get')) kind = 'getter';
          else if (mods.has('set')) kind = 'setter';
          const rec = newFn({
            qname: full, kind, startTok: nameIdx, bodyStart: body, bodyClose, bodyEnd: bodyClose, async: mods.has('async'),
            generator: gen, paramNames: paramInfo(k), retType: retTypeText(c + 1, body), parent: cls.qname, cls: cls.qname,
            decorators: decos,
          });
          rec.visibility = mods.has('private') || name.startsWith('#') ? 'private' : mods.has('protected') ? 'protected' : 'public';
          rec.static = mods.has('static');
          cls.methods.push(rec.qname);
          jump.set(nameIdx, k); // keep the member name from being read as a call
          jump.set(k, body);
          k = bodyClose + 1;
        } else {
          k = exprEnd(c + 1, true) + 1; // overload or abstract signature
          jump.set(nameIdx, k);
        }
        continue;
      }
      if (isP(k, ':')) {
        const r = skipType(k + 1, { eq: true, nl: true });
        jump.set(k, r);
        k = r;
      }
      if (isP(k, '=')) {
        const v = k + 1;
        hints.set(v, { full, cls: cls.qname });
        k = exprEnd(v, true) + 1;
      } else if (isP(k, ';') || isP(k, ',')) k++;
      else if (k === nameIdx + 1) k++;
    }
  }

  function onInterface(i, t) {
    const nameTok = at(i + 1);
    const r = skipType(i + 2, { body: true });
    if (!isP(r, '{')) return i + 1;
    const close = match[r];
    const rec = { qname: qualify(nameTok.v, t), name: nameTok.v, start_line: tokens[i].l, end_line: at(Math.min(close, n - 1)).l, exported: false };
    rec.lines = rec.end_line - rec.start_line + 1;
    out.interfaces.push(rec);
    return close + 1;
  }

  function atStmtStart(i) {
    const p = at(i - 1);
    if (p.t === 'bof') return true;
    if (p.t === 'p' && (p.v === ';' || p.v === '}' || p.v === '{')) return true;
    if (p.t === 'id' && (p.v === 'export' || p.v === 'declare' || p.v === 'default')) return true;
    return p.l < tokens[i].l && U.isValueEnd(p);
  }

  // ---- main walk ------------------------------------------------------------------

  function braceKind(i) {
    if (classBodies.has(i)) return 'class';
    if (objects.has(i)) return 'obj';
    const p = at(i - 1);
    if (p.t === 'ja') return 'jsx';
    if (p.t === 'p') {
      if (p.v === '{') return bs.length && bs[bs.length - 1].kind === 'jsx' ? 'obj' : 'block';
      return OBJ_PREV_P.has(p.v) ? 'obj' : 'block';
    }
    if (p.t === 'id' && OBJ_PREV_ID.has(p.v)) return 'obj';
    return 'block';
  }

  function onP(i, tk, t) {
    const v = tk.v;
    switch (v) {
      case '{': {
        const kind = braceKind(i);
        bs.push({ kind, prefix: kind === 'obj' && objects.has(i) ? objects.get(i) : null });
        bops[bs.length] = undefined;
        return i + 1;
      }
      case '(': {
        const r = onOpenParen(i, t);
        if (r !== -1) return r;
        bs.push({ kind: 'paren', prefix: null });
        bops[bs.length] = undefined;
        return i + 1;
      }
      case '[':
        bs.push({ kind: 'arr', prefix: null });
        bops[bs.length] = undefined;
        return i + 1;
      case '}': case ')': case ']':
        bs.pop();
        while (tern.length && tern[tern.length - 1] > bs.length) tern.pop();
        return i + 1;
      case '?': {
        const nx = at(i + 1);
        if (nx.t === 'p' && (nx.v === ':' || nx.v === ',' || nx.v === ')' || nx.v === '=' || nx.v === ';')) return i + 1;
        credit(t, 1, 1 + t.nest);
        tern.push(bs.length);
        bops[bs.length] = undefined;
        return i + 1;
      }
      case '&&': case '||': case '??': case '&&=': case '||=': case '??=':
        if (t.fn) {
          t.fn.cyclomatic++;
          if (bops[bs.length] !== v) t.fn.cognitive++;
        }
        bops[bs.length] = v;
        return i + 1;
      case ':': {
        bops[bs.length] = undefined;
        if (tern.length && tern[tern.length - 1] === bs.length) { tern.pop(); return i + 1; }
        const b = bs.length ? bs[bs.length - 1] : null;
        if (b && b.kind === 'obj' && b.prefix !== null) {
          const kt = at(i - 1);
          if (kt.t === 'id' || kt.t === 'str') {
            const q = b.prefix ? `${b.prefix}.${kt.v}` : kt.v;
            hints.set(i + 1, { full: q });
            if (isP(i + 1, '{')) objects.set(i + 1, q);
            const nt = at(i + 1);
            if (nt.t === 'id' && HOC_NAMES.has(nt.v) && isP(i + 2, '(')) hints.set(i + 3, { full: q });
          }
        }
        return i + 1;
      }
      case '=':
        bops[bs.length] = undefined;
        // `Legacy.prototype.run = function () {}` and `ns.fn = () => {}` name the function.
        if (isP(i - 2, '.') && at(i - 1).t === 'id' && !hints.has(i + 1)) {
          let j = i - 1;
          const parts = [at(j).v];
          while (isP(j - 1, '.') && at(j - 2).t === 'id') { parts.unshift(at(j - 2).v); j -= 2; }
          if (parts[0] !== 'this' && parts[0] !== 'module' && parts[0] !== 'exports' && atStmtStart(j)) {
            hints.set(i + 1, { full: parts.filter((x) => x !== 'prototype').join('.') });
          }
        }
        return i + 1;
      case ';': case ',':
        bops[bs.length] = undefined;
        return i + 1;
      case '@': {
        const d = parseDecorator(i);
        pend.push(d.deco);
        return d.end;
      }
      default:
        return i + 1;
    }
  }

  function onId(i, tk, t) {
    const v = tk.v;
    const prev = at(i - 1);
    const afterDot = prev.t === 'p' && (prev.v === '.' || prev.v === '?.');
    if (!afterDot) {
      if (isP(i + 1, '=>')) { // single-parameter arrow function
        const asyncArrow = isId(i - 1, 'async') && !isP(i - 2, '.');
        registerArrow(asyncArrow ? i - 1 : i, [v], i + 1, 'arrow', t);
        return i + 2;
      }
      switch (v) {
        case 'function': return onFunction(i, t);
        case 'class': return onClass(i, t);
        case 'import': return onImport(i);
        case 'export': return t.ns ? i + 1 : onExport(i);
        case 'const': case 'let': case 'var': {
          const nx = at(i + 1);
          if ((nx.t === 'id' && nx.v !== 'enum') || isP(i + 1, '{') || isP(i + 1, '[')) declarators(i + 1, false);
          return i + 1;
        }
        case 'if':
          if (isP(i + 1, '(')) {
            credit(t, 1, isId(i - 1, 'else') ? 1 : 1 + t.nest);
            ctrlBody(match[i + 1] + 1, t);
          }
          return i + 1;
        case 'else':
          if (!isId(i + 1, 'if') && !isP(i + 1, ':')) {
            credit(t, 0, 1);
            ctrlBody(i + 1, t);
          }
          return i + 1;
        case 'for': {
          const open = isP(i + 1, '(') ? i + 1 : isId(i + 1, 'await') && isP(i + 2, '(') ? i + 2 : -1;
          if (open !== -1) {
            credit(t, 1, 1 + t.nest);
            ctrlBody(match[open] + 1, t);
          }
          return i + 1;
        }
        case 'while':
          if (doWhile.has(i)) return i + 1;
          if (isP(i + 1, '(')) {
            credit(t, 1, 1 + t.nest);
            ctrlBody(match[i + 1] + 1, t);
          }
          return i + 1;
        case 'do':
          if (isP(i + 1, '{') || (at(i + 1).t === 'id')) {
            credit(t, 1, 1 + t.nest);
            if (t.fn) {
              ctrlBody(i + 1, t);
              if (isP(i + 1, '{')) doWhile.add(match[i + 1] + 1);
            }
          }
          return i + 1;
        case 'switch':
          if (isP(i + 1, '(')) {
            credit(t, 0, 1 + t.nest);
            ctrlBody(match[i + 1] + 1, t);
          }
          return i + 1;
        case 'case':
          if (!isP(i + 1, ':')) credit(t, 1, 0);
          return i + 1;
        case 'catch': {
          const b = isP(i + 1, '(') ? match[i + 1] + 1 : i + 1;
          credit(t, 1, 1 + t.nest);
          ctrlBody(b, t);
          return i + 1;
        }
        case 'return':
          if (t.fl) t.fl.returns++;
          bops[bs.length] = undefined;
          return i + 1;
        case 'break': case 'continue':
          if (t.fn && at(i + 1).t === 'id' && at(i + 1).l === tk.l) t.fn.cognitive++;
          return i + 1;
        case 'interface':
          if (at(i + 1).t === 'id' && atStmtStart(i)) return onInterface(i, t);
          return i + 1;
        case 'type':
          if (at(i + 1).t === 'id' && (isP(i + 2, '=') || isP(i + 2, '<')) && atStmtStart(i)) {
            const e = exprEnd(i + 2, true);
            out.types.push({ qname: qualify(at(i + 1).v, t), name: at(i + 1).v, start_line: tk.l, end_line: at(Math.min(e, n - 1)).l });
            return e + 1;
          }
          return i + 1;
        case 'enum':
          if (at(i + 1).t === 'id' && isP(i + 2, '{')) return match[i + 2] + 1;
          return i + 1;
        case 'declare':
          if (['module', 'global', 'namespace'].includes(at(i + 1).v)) {
            let j = i + 1;
            while (j < n && !isP(j, '{') && !isP(j, ';')) j++;
            if (isP(j, '{')) return match[j] + 1;
          }
          return i + 1;
        case 'namespace': case 'module':
          if (at(i + 1).t === 'id' && isP(i + 2, '{') && atStmtStart(i)) {
            reg.set(i + 2, { k: 'ns', scope: qualify(at(i + 1).v, t), close: match[i + 2] });
            return i + 2;
          }
          if (v === 'module') onCjs(i);
          return i + 1;
        case 'exports':
          onCjs(i);
          return i + 1;
        case 'require':
          if (isP(i + 1, '(') && at(i + 2).t === 'str' && isP(i + 3, ')')) {
            const b = requireBind.get(i);
            addImport({
              specifier: at(i + 2).v, names: b ? [...new Set(b.map((x) => x.imported ?? '*'))].sort() : [],
              bindings: b ?? [], kind: 'require', line: tk.l,
            });
            return i + 4;
          }
          return i + 1;
        case 'process':
          if (isP(i + 1, '.') && isId(i + 2, 'env')) {
            if (isP(i + 3, '.') && at(i + 4).t === 'id') out.envReads.add(at(i + 4).v);
            else if (isP(i + 3, '[') && at(i + 4).t === 'str') out.envReads.add(at(i + 4).v);
          }
          return i + 1;
        default:
      }
    }
    if (isP(i + 1, '(') && isMethodHead(i)) return i + 1;
    if (isP(i + 1, '(')) recordCall(i, t);
    else if (ts && isP(i + 1, '<')) {
      const r = skipAngle(i + 1);
      if (r > 0 && isP(r, '(')) recordCall(i, t);
    }
    return i + 1;
  }

  // `name(...) {` directly inside an object literal is a method definition, not a call.
  function isMethodHead(i) {
    const b = bs.length ? bs[bs.length - 1] : null;
    if (!b || b.kind !== 'obj') return false;
    let p = at(i - 1);
    let k = i - 1;
    while ((p.t === 'id' && (p.v === 'async' || p.v === 'get' || p.v === 'set')) || (p.t === 'p' && p.v === '*')) { k--; p = at(k); }
    if (!(p.t === 'p' && (p.v === '{' || p.v === ','))) return false;
    const c = match[i + 1];
    return c < n && (isP(c + 1, '{') || (ts && isP(c + 1, ':')));
  }

  function onString(i, tk) {
    let s;
    if (tk.t === 'tplh') s = tk.full ? tk.full.slice(1).replace(/`$/, '') : tk.v;
    else s = tk.v;
    if (s.length < 12 || out.sql.length >= MAX_SQL) return;
    const head = s.length > 4000 ? s.slice(0, 4000) : s;
    if (SQL_RE.test(head)) out.sql.push({ text: s.slice(0, 500), line: tk.l });
  }

  let i = 0;
  while (i < n) {
    while (frames.length && frames[frames.length - 1].close < i) frames.pop();
    let t = top();
    const d = reg.get(i);
    if (d) t = pushFrame(d, t);
    const tk = tokens[i];
    if (pend.length && !(tk.t === 'id' && PEND_KEEP.has(tk.v)) && !(tk.t === 'p' && tk.v === '@')) pend = [];
    const j = jump.get(i);
    if (j !== undefined) { i = j; continue; }
    switch (tk.t) {
      case 'id': i = onId(i, tk, t); break;
      case 'p': i = onP(i, tk, t); break;
      case 'str': case 'tpl': case 'tplh': onString(i, tk); i++; break;
      default: i++;
    }
  }

  // ---- post-processing ------------------------------------------------------------

  for (const f of out.functions) {
    delete f._seen;
    if (!f.cls && !f.qname.includes('.')) f.exported = exportedLocals.has(f.qname);
  }
  delete out._seen;
  const classExported = new Map();
  for (const c of out.classes) {
    c.exported = !c.qname.includes('.') && exportedLocals.has(c.qname);
    classExported.set(c.qname, c.exported);
  }
  for (const f of out.functions) {
    if (f.cls) f.exported = (classExported.get(f.cls) ?? false) && f.visibility !== 'private';
  }
  for (const x of out.interfaces) x.exported = exportedLocals.has(x.qname);
  for (const x of out.types) x.exported = exportedLocals.has(x.qname);
  const fnNames = new Set(out.functions.filter((f) => !f.cls).map((f) => f.qname));
  const clsNames = new Set(out.classes.map((c) => c.qname));
  for (const e of out.exports) {
    if (e.kind === 'variable' && e.local && fnNames.has(e.local)) e.kind = 'function';
    else if (e.kind === 'value' && e.local && fnNames.has(e.local)) e.kind = 'function';
    else if (e.kind === 'value' && e.local && clsNames.has(e.local)) e.kind = 'class';
  }
  return out;
}
