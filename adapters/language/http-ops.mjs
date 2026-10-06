// One rule for HTTP operations in every language: a method or function that declares an HTTP
// method and a route template through an attribute, annotation or decorator is an HTTP
// operation. On an interface, an abstract type or a type whose methods have no bodies it is a
// client operation (the declaring module CONSUMES a `contract:` route node); on a concrete
// handler it is an endpoint. A base path from the enclosing type joins the method's route.
//
// Only the spelling differs by language, and it lives in SYNTAX below: how a marker names its
// verb, which markers carry a route or a base path, and how the path joins. The adapters find
// the markers in their own structures and hand them to the functions here. Which library a
// marker comes from is never consulted.
//
// A route group is part of the same rule: an object created with a path prefix (from the app or
// another group, or built with one, or mounted somewhere with one) that routes are registered
// on. Every prefix up the chain joins the route. The adapters find the group calls in their own
// structures; the spelling is the `groups` row of SYNTAX, the chain walk and the cross-file
// resolution (a group handed to a registration function, or mounted from another file) are here.

import { edgeFact, nodeFact } from '../../runtime/graph/facts.mjs';

const VERB = 'Get|Post|Put|Delete|Patch|Head|Options';
const UPPER = VERB.toUpperCase();

/**
 * Per language: `verb` matches a marker name that is a verb (the capture is the verb, or the
 * second capture when the verb is part of a longer name); `mapped` names carry the verb in an
 * argument (`method = ...`); `lined` names carry `"VERB /path"`; `route` names carry only a
 * route; `base` names carry a base path on a type; `serverRoute` says a route-only marker is
 * not a client route (it may be a parameter marker there); `rooted` says a route that starts
 * with `/` replaces the base; `tokens` expands `[controller]` and `[action]`.
 *
 * `groups` spells route groups: `derive` names are calls `parent.Name("/prefix")` that return a
 * group below the receiver; `scoped` names are calls `parent.Name("/prefix", func(g) { ... })`
 * whose callback registers on `g`; `create` maps the name of a constructor to the keyword that
 * carries its prefix (`null`: none); `mount` rows are calls `parent.name(...)` that place a child
 * group below the parent, `child` and `prefix` being a position or a keyword, `replaces` saying
 * the mount prefix overrides the child's own; `receiverArg` says `g.Fn()` hands `g` to `Fn` as its
 * first parameter (extension methods); `exports` says a module-level group may be mounted from
 * another file.
 */
export const SYNTAX = {
  csharp: {
    kind: 'attribute', verb: new RegExp(`^(?:Http)?(${VERB})$`), route: ['Route'], base: ['Route'], rooted: true, tokens: true,
    groups: { derive: ['MapGroup'], receiverArg: true },
  },
  java: {
    kind: 'annotation', verb: new RegExp(`^(?:(${UPPER})|(${VERB})Mapping)$`), mapped: ['RequestMapping'], lined: ['RequestLine'],
    route: ['Path'], serverRoute: true, base: ['RequestMapping', 'Path'],
  },
  typescript: {
    kind: 'decorator', verb: new RegExp(`^(${VERB}|All)$`), base: ['Controller', 'Client', 'Route', 'Path'],
    groups: { create: { Router: null }, mount: [{ name: 'use', prefix: 0, child: 1 }], exports: true },
  },
  python: {
    kind: 'decorator', verb: new RegExp(`^(${VERB.toLowerCase()})$`), base: ['controller', 'client', 'route', 'prefix'], baseAttrs: ['base_path', 'prefix', 'path', 'base_url'],
    groups: {
      create: { APIRouter: 'prefix', Blueprint: 'url_prefix' },
      mount: [{ name: 'include_router', child: 0, prefix: 'prefix' }, { name: 'register_blueprint', child: 0, prefix: 'url_prefix', replaces: true }],
      exports: true,
    },
  },
  go: { groups: { derive: ['Group'], scoped: ['Route'], create: { NewRouter: null }, mount: [{ name: 'Mount', prefix: 0, child: 1 }] } },
};
SYNTAX.kotlin = SYNTAX.java;
SYNTAX.javascript = SYNTAX.typescript;

const NAMED_ROUTE = ['path', 'value', 'template', 'route', 'url'];
const METHOD_WORD = new RegExp(`\\b(${UPPER})\\b`);
const lastSegment = (name) => String(name).slice(String(name).lastIndexOf('.') + 1);

/** Marker arguments as written (`"/x"`, `path = ["/x"]`) split into positional and named raw text. */
export function parseArgs(text) {
  const out = { positional: [], named: {} };
  if (text == null) return out;
  const parts = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const named = /^([A-Za-z_]\w*)\s*(?:=|:)(?![=:])\s*([\s\S]*)$/.exec(t);
    if (named && !t.startsWith('"')) out.named[named[1].toLowerCase()] = named[2];
    else out.positional.push(t);
  }
  return out;
}

const stringsIn = (raw) => [...String(raw ?? '').matchAll(/@?"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]);

/**
 * The route one marker states: the first string of a path-like named argument, else the first
 * positional string. `null` when the marker states none, `''` for an explicit empty route.
 */
function routeIn(args) {
  for (const k of NAMED_ROUTE) {
    const s = stringsIn(args.named[k])[0];
    if (s !== undefined) return s;
  }
  for (const p of args.positional) {
    const s = stringsIn(p)[0];
    if (s !== undefined) return s;
  }
  return null;
}

/**
 * What one marker means for an operation, or null for a marker that says nothing about HTTP.
 * `args` is `{ positional: string[], named: object }` of raw argument text, or `{ route }` when
 * the adapter already read the route (decorators carry literal strings).
 * @returns {{ method?: string, route: string|null, routeOnly?: boolean, base: boolean, mapped?: boolean }|null}
 */
export function readMarker(lang, name, args) {
  const syn = SYNTAX[lang];
  if (!syn) return null;
  const n = lastSegment(name);
  const route = args.route !== undefined ? args.route : routeIn(args);
  const base = syn.base.includes(n);
  const v = syn.verb.exec(n);
  if (v) return { method: (v[1] ?? v[2]).toUpperCase(), route, base: false };
  if (syn.mapped?.includes(n)) {
    const m = METHOD_WORD.exec(String(args.named?.method ?? ''));
    return { method: m ? m[1] : 'ANY', route, base, mapped: true };
  }
  if (syn.lined?.includes(n)) {
    const line = /^\s*([A-Za-z]+)\s+(\S*)/.exec(stringsIn(args.positional?.[0])[0] ?? '');
    return line ? { method: line[1].toUpperCase(), route: line[2], base: false } : null;
  }
  if (syn.route?.includes(n)) return { route, routeOnly: true, base };
  if (base) return { route, base };
  return null;
}

/** The base path a marker run before a type gives: a base marker's route, or a client-level `path` / `url` argument. */
export function typeBase(lang, markers) {
  for (const m of markers) {
    const r = readMarker(lang, m.name, m.args);
    if (r?.base && r.route) return r.route;
  }
  for (const m of markers) {
    if (m.args.route !== undefined) continue;
    for (const k of ['path', 'url', 'baseurl', 'base_url']) {
      const s = stringsIn(m.args.named?.[k])[0];
      if (s) return urlPath(s);
    }
  }
  return '';
}

/** The path of `http://host/v1` is `/v1`; a plain path stays as it is. */
export function urlPath(s) {
  const m = /^[A-Za-z][\w+.-]*:\/\/[^/]*(\/.*)?$/.exec(String(s).trim());
  return m ? (m[1] ?? '') : String(s);
}

/** Join a base path and a route the way the language does; `norm` is the adapter's path normaliser. */
export function joinRoute(lang, base, route, norm, names = {}) {
  const syn = SYNTAX[lang];
  const fill = (s) => (syn.tokens ? s.replace(/\[controller\]/gi, names.controller ?? '').replace(/\[action\]/gi, names.action ?? '') : s);
  const r = fill(route ?? '');
  if (syn.rooted && (r.startsWith('/') || r.startsWith('~/'))) return norm(r.replace(/^~/, ''));
  return norm([fill(base ?? ''), r].filter((p) => p !== '').map((p) => String(p).trim()).join('/'));
}

/**
 * The operations one method's markers declare.
 * @param {string} lang
 * @param {{name: string, args: object}[]} markers the markers on the method
 * @param {{base?: string, client?: boolean, norm: (p: string) => string, names?: object}} ctx
 * @returns {{method: string, path: string}[]}
 */
export function operations(lang, markers, { base = '', client = false, norm, names = {} }) {
  const read = markers.map((m) => readMarker(lang, m.name, m.args)).filter(Boolean);
  const syn = SYNTAX[lang];
  const only = read.find((r) => r.routeOnly && !(client && syn.serverRoute));
  const out = [];
  for (const r of read) {
    if (!r.method) continue;
    const own = r.route;
    const route = own || only?.route || own;
    if (client && route == null) continue;
    out.push({ method: r.method, path: joinRoute(lang, base, route ?? '', norm, names) });
  }
  return out;
}

/** A client route as written: no query string, a catch-all `{**rest}` as a plain parameter. */
export const clientPath = (p, norm) => norm(String(p).replace(/[?#].*$/, '').replace(/\{\*\*?/g, '{'));

/**
 * The facts for one client interface: a `contract` holding its operations, one `contract` per
 * route, and a CONSUMES edge from the declaring module to each route.
 * @param {{modId: string, cid: string, name: string, path: string, line: number, interfaceId?: string, lang: string,
 *   framework: string, ops: {method: string, path: string, name?: string|null, line: number}[],
 *   pv: (line: number) => object}} c
 */
export function clientFacts(c) {
  const { modId, cid, pv } = c;
  const facts = [
    nodeFact('contract', cid, {
      name: c.name,
      path: c.path,
      attrs: {
        kind: 'http_client', framework: c.framework, language: c.lang, interface: c.interfaceId,
        operations: c.ops.map((o) => ({ method: o.method, path: o.path, name: o.name ?? null, line: o.line })),
      },
    }, pv(c.line)),
    edgeFact('CONTAINS', modId, `contract:${cid}`, {}, pv(c.line)),
  ];
  for (const o of c.ops) {
    const oid = `${o.method} ${o.path}`;
    facts.push(nodeFact('contract', oid, { name: oid, attrs: { kind: 'client_operation', method: o.method, path: o.path } }, pv(o.line)));
    facts.push(edgeFact('DEFINES', `contract:${cid}`, `contract:${oid}`, { operation: o.name ?? null }, pv(o.line)));
    facts.push(edgeFact('CONSUMES', modId, `contract:${oid}`, { framework: c.framework, interface: c.name, operation: o.name ?? null }, pv(o.line)));
  }
  return facts;
}

const bare = (n) => String(n).replace(/<.*$/, '').split(/[.:]/).pop();
const tail = (n) => String(n).slice(String(n).lastIndexOf('.') + 1);

/**
 * A client interface is implemented at run time by a generated proxy, so a concrete type in the
 * repository that implements or extends the interface makes it a server-side API declaration
 * instead: its operations are endpoints served by that type. Run from an adapter's link step,
 * where the cross-file inheritance is known. It removes the client facts of such an interface
 * from `factsByFile` (in place) and returns the endpoint facts for the implementers; a method of
 * the implementer that already exposes an endpoint keeps its own.
 * @param {Map<string, object[]>} factsByFile
 * @param {string} extractorPrefix `name@` of the adapter that wrote the client facts
 * @param {(path: string, line: number) => object} pv provenance for the new endpoint facts
 */
export function serverInterfaces(factsByFile, extractorPrefix, pv) {
  const own = (f) => String(f.provenance?.extractor ?? '').startsWith(extractorPrefix);
  const types = new Map();
  const byId = new Map();
  const children = new Map();
  const exposers = new Set();
  const handled = new Set();
  const clients = [];
  for (const [path, facts] of factsByFile) {
    for (const f of facts) {
      if (!own(f)) continue;
      if (f.kind === 'node') {
        if (f.type === 'class' || f.type === 'interface') {
          byId.set(f.id, f);
          if (!types.has(bare(f.name))) types.set(bare(f.name), []);
          types.get(bare(f.name)).push(f);
        } else if (f.type === 'contract' && f.attrs?.kind === 'http_client') clients.push({ path, c: f });
        else if (f.type === 'endpoint' && typeof f.attrs?.handler === 'string') {
          exposers.add(f.attrs.handler);
          if (f.attrs.file) handled.add(`${f.attrs.file}#${f.attrs.handler}`);
        }
      } else if (f.type === 'CONTAINS') {
        if (!children.has(f.from)) children.set(f.from, []);
        children.get(f.from).push(f.to);
      } else if (f.type === 'EXPOSES') exposers.add(f.from);
    }
  }
  const out = [];
  const seen = new Set();
  for (const { path, c } of clients) {
    const iface = byId.get(c.attrs.interface);
    if (!iface) continue;
    const name = bare(iface.name);
    const sole = (types.get(name) ?? []).length === 1;
    const impls = [...byId.values()].filter((t) => t.type === 'class' && t.id !== iface.id
      && [t.attrs?.extends, t.attrs?.implements, t.attrs?.bases].some((l) => [].concat(l ?? []).some((n) => bare(n) === name))
      && (sole || t.path === iface.path));
    if (!impls.length) continue;
    for (const impl of impls) {
      for (const o of c.attrs.operations) {
        const handler = (children.get(impl.id) ?? []).find((id) => tail(id.slice(id.indexOf('#') + 1)) === o.name);
        if (handler && (exposers.has(handler) || handled.has(handler.slice(handler.indexOf(':') + 1)))) continue;
        const eid = `${o.method} ${o.path}`;
        if (!seen.has(eid)) {
          seen.add(eid);
          out.push(nodeFact('endpoint', eid, { name: eid, attrs: { method: o.method, path: o.path, framework: c.attrs.framework, via_interface: iface.name } }, pv(path, o.line)));
        }
        out.push(edgeFact('EXPOSES', handler ?? `module:${impl.path}`, `endpoint:${eid}`, { framework: c.attrs.framework, via_interface: iface.name }, pv(path, o.line)));
      }
    }
    // The interface is not a client: drop its contract and the route facts only it declared.
    const facts = factsByFile.get(path).filter((f) => !(f.id === c.id || (f.kind === 'edge' && (f.from === c.id || f.to === c.id
      || (f.type === 'CONSUMES' && f.attrs?.interface === c.name && f.from === `module:${path}` && String(f.to).startsWith('contract:'))))));
    const used = new Set(facts.filter((f) => f.kind === 'edge').map((f) => f.to));
    factsByFile.set(path, facts.filter((f) => !(f.kind === 'node' && f.type === 'contract' && f.attrs?.kind === 'client_operation' && !used.has(f.id))));
  }
  return out;
}

// ---- route groups ------------------------------------------------------------------------

const GROUP_DEPTH = 8;
const MAX_VARIANTS = 16;
const MAX_CALLS = 600;

const joinPrefix = (...parts) => parts.filter((p) => p != null && p !== '').map((p) => String(p).trim()).join('/');

/**
 * The route groups of one file. An adapter reports what it saw (`group`, `param`, `mount`,
 * `call`) under keys of its own choosing, then asks what a registration receiver stands for.
 * `own` is the prefix a group was created with (`null` when it is not a literal), `parent` the
 * key of the group it hangs below. A key that names no group is a root: an app, with no prefix.
 * @param {string} lang
 */
export function createGroups(lang) {
  const syn = SYNTAX[lang]?.groups ?? {};
  const nodes = new Map();
  const mounts = [];
  const calls = [];
  const groups = {
    syn,
    has: (key) => nodes.has(key),
    /** A group created with prefix `own`, below `parent`; `module` for one that another file may mount. */
    group(key, { own = '', parent = null, name = null, module = false }) {
      nodes.set(key, { own, up: parent ? { parent, prefix: '' } : null, name, module });
    },
    /** Parameter `index` of the function `fn`: whatever group a caller hands in. */
    param(key, { fn, index, ext = false }) {
      if (!nodes.has(key)) nodes.set(key, { param: { fn, index, ext } });
    },
    /** `parent` mounts the local group `child` below `prefix` (`null`: not a literal). */
    mount(child, parent, prefix, replaces = false) {
      const g = nodes.get(child);
      if (!g || g.param) return;
      if (replaces && prefix !== null) g.own = '';
      g.up = { parent, prefix };
    },
    /** `parent` mounts a group declared in another file, named `name` and imported from the module `hint`, below `prefix`. */
    mountImported(name, hint, parent, prefix) {
      if (mounts.length < MAX_CALLS) mounts.push({ name, hint: hint ?? null, parent, prefix });
    },
    /** The prefix up the chain from `key`, the open end only another file can supply, and whether a prefix was not a literal. */
    resolve(key) {
      let prefix = '';
      let unresolved = false;
      let open = null;
      let cur = key;
      for (let i = 0; cur && i < GROUP_DEPTH * 2; i++) {
        const g = nodes.get(cur);
        if (!g) break;
        if (g.param) { open = { kind: 'param', ...g.param }; break; }
        if (g.own === null) unresolved = true;
        else prefix = joinPrefix(g.own, prefix);
        if (!g.up) {
          if (g.module && syn.exports && g.name) open = { kind: 'export', name: g.name };
          break;
        }
        if (g.up.prefix === null) unresolved = true;
        else prefix = joinPrefix(g.up.prefix, prefix);
        cur = g.up.parent;
      }
      return { prefix, open, unresolved };
    },
    /** The compact form of a resolution that a call or a mount carries to the link step; `below` is a prefix that joins under it. */
    ref(key, below = '') {
      const r = key ? groups.resolve(key) : { prefix: '', open: null, unresolved: false };
      return { p: joinPrefix(r.prefix, below), o: r.open, u: r.unresolved || below === null };
    },
    /** A call of `fn` that hands the group keys `recv` and `args` over (`null`: an expression that is no name). */
    call(fn, recv, args) {
      if (calls.length >= MAX_CALLS || (recv == null && args.every((a) => a == null))) return;
      calls.push({ fn, recv, args });
    },
    /** The link-only attributes of the module fact, once the whole file has been read (a mount may come after the call that uses it). */
    moduleAttrs() {
      const seen = new Set();
      const calls_ = [];
      for (const c of calls) {
        const rec = { fn: c.fn, r: c.recv == null ? null : groups.ref(c.recv), a: c.args.map((a) => (a == null ? null : groups.ref(a))) };
        const k = JSON.stringify(rec);
        if (!seen.has(k)) { seen.add(k); calls_.push(rec); }
      }
      const mounts_ = mounts.map((m) => ({ name: m.name, hint: m.hint, ...groups.ref(m.parent, m.prefix) }));
      return { ...(calls_.length ? { route_calls: calls_ } : {}), ...(mounts_.length ? { route_mounts: mounts_ } : {}) };
    },
  };
  return groups;
}

/** The attributes an endpoint fact carries for the group resolution `res`, so the link step can finish its route. */
export function routeGroupAttrs(res) {
  if (!res) return {};
  return { ...(res.unresolved || res.open?.kind === 'param' ? { prefix_unresolved: true } : {}), ...(res.open ? { route_group: { ...res.open, unresolved: res.unresolved } } : {}) };
}

/** The parameters of a function, in order, from its parameter list: `{ name, ext }`, `ext` for a C# `this` parameter. */
export function paramNames(text, lang) {
  const parts = [];
  const s = String(text ?? '');
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c) && s[i - 1] !== '=') depth--;
    else if (c === ',' && depth <= 0) { parts.push(s.slice(from, i)); from = i + 1; }
  }
  parts.push(s.slice(from));
  const out = [];
  for (const part of parts) {
    const t = part.replace(/=[\s\S]*$/, '').replace(/\[[^\]]*\]/g, ' ').trim();
    if (!t) continue;
    const words = t.split(/\s+/);
    out.push({ name: lang === 'go' ? words[0] : words[words.length - 1], ext: words[0] === 'this' });
  }
  return out;
}

const tailOf = (path) => {
  const parts = String(path).replace(/\.[A-Za-z]+$/, '').split('/');
  const last = parts.pop();
  return /^(?:index|__init__|mod)$/.test(last) ? (parts.pop() ?? last) : last;
};
const hintMatches = (hint, path) => {
  const segs = String(hint).split(/[./\\]/).filter(Boolean);
  return segs.length > 0 && segs[segs.length - 1] === tailOf(path);
};

/**
 * Finish the routes whose group prefix is only known in another file: a route registered on a
 * parameter of a registration function takes the prefix of every call in the repository that
 * hands a group to that function, and a route on a group another file mounts takes the mount's
 * prefix. Run from an adapter's link step; it replaces the per-file lists in `factsByFile` and
 * drops the link-only attributes. A parameter that no call gives a group to leaves the endpoint
 * as declared with `prefix_unresolved`.
 * @param {Map<string, object[]>} factsByFile
 * @param {string} extractorPrefix `name@` of the adapter that wrote the facts
 * @param {(p: string) => string} norm the adapter's path normaliser
 */
export function routeGroups(factsByFile, extractorPrefix, norm) {
  const own = (f) => String(f.provenance?.extractor ?? '').startsWith(extractorPrefix);
  const hasLink = (f) => f.kind === 'node' && own(f) && ((f.type === 'module' && (f.attrs.route_calls || f.attrs.route_mounts)) || (f.type === 'endpoint' && f.attrs?.route_group));
  const calls = new Map();
  const mounts = [];
  const defs = new Map();
  const exported = new Map();
  const touched = [];
  for (const [path, facts] of factsByFile) {
    let any = false;
    for (const f of facts) {
      if (f.kind !== 'node' || !own(f)) continue;
      if (hasLink(f)) any = true;
      if (f.type === 'module') {
        for (const c of f.attrs.route_calls ?? []) {
          if (!calls.has(c.fn)) calls.set(c.fn, []);
          calls.get(c.fn).push({ ...c, path });
        }
        for (const m of f.attrs.route_mounts ?? []) mounts.push({ ...m, path });
      } else if (f.type === 'function' || f.type === 'method') {
        const name = String(f.name).split('.').pop();
        if (!defs.has(name)) defs.set(name, new Set());
        defs.get(name).add(f.path ?? path);
      } else if (f.type === 'endpoint' && f.attrs?.route_group?.kind === 'export') {
        if (!exported.has(f.attrs.route_group.name)) exported.set(f.attrs.route_group.name, new Set());
        exported.get(f.attrs.route_group.name).add(path);
      }
    }
    if (any) touched.push(path);
  }
  if (!touched.length) return;

  const dir = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((v) => { const k = `${v.prefix}|${v.unresolved}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_VARIANTS);
  };
  const through = (ref, path, depth, seen) => {
    const outer = ref.o ? outerOf(ref.o, path, depth + 1, seen) : [{ prefix: '', unresolved: false }];
    return outer.map((v) => ({ prefix: joinPrefix(v.prefix, ref.p), unresolved: v.unresolved || ref.u }));
  };
  function outerOf(open, path, depth, seen) {
    const key = `${open.kind}|${open.fn ?? open.name}|${open.index ?? ''}|${path}`;
    if (depth > GROUP_DEPTH || seen.has(key)) return [{ prefix: '', unresolved: true }];
    const next = new Set(seen).add(key);
    let out = [];
    if (open.kind === 'param') {
      const several = (defs.get(open.fn)?.size ?? 0) > 1;
      for (const c of calls.get(open.fn) ?? []) {
        if (several && c.path !== path && dir(c.path) !== dir(path)) continue;
        const ref = open.ext && c.r ? (open.index === 0 ? c.r : c.a[open.index - 1]) : c.a[open.index];
        if (ref) out.push(...through(ref, c.path, depth, next));
      }
      if (!out.length) out = [{ prefix: '', unresolved: true }];
    } else {
      const total = exported.get(open.name)?.size ?? 0;
      for (const m of mounts) {
        if (m.name !== open.name || m.path === path) continue;
        if (m.hint ? !hintMatches(m.hint, path) : total !== 1) continue;
        out.push(...through(m, m.path, depth, next));
      }
      if (!out.length) out = [{ prefix: '', unresolved: false }];
    }
    return dedupe(out);
  }

  for (const path of touched) {
    const rewrites = new Map();
    const kept = [];
    const made = new Set();
    for (const f of factsByFile.get(path)) {
      if (!hasLink(f)) kept.push(f);
      else if (f.type === 'module') {
        delete f.attrs.route_calls;
        delete f.attrs.route_mounts;
        kept.push(f);
      } else {
        const { route_group: open, prefix_unresolved: _u, ...attrs } = f.attrs;
        const ids = [];
        const { unresolved: own_, ...end } = open;
        for (const v of outerOf(end, path, 0, new Set()).map((x) => ({ ...x, unresolved: x.unresolved || own_ }))) {
          const route = norm(joinPrefix(v.prefix, attrs.path));
          const key = `${attrs.method} ${route}`;
          ids.push(`endpoint:${key}`);
          if (made.has(key)) continue;
          made.add(key);
          kept.push({ ...f, id: `endpoint:${key}`, name: key, attrs: { ...attrs, path: route, ...(v.unresolved ? { prefix_unresolved: true } : {}) } });
        }
        if (!rewrites.has(f.id)) rewrites.set(f.id, ids);
      }
    }
    factsByFile.set(path, kept.flatMap((f) => (f.kind === 'edge' && own(f) && rewrites.has(f.to) ? rewrites.get(f.to).map((to) => ({ ...f, to })) : [f])));
  }
}
