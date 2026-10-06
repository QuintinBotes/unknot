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
 */
export const SYNTAX = {
  csharp: { kind: 'attribute', verb: new RegExp(`^(?:Http)?(${VERB})$`), route: ['Route'], base: ['Route'], rooted: true, tokens: true },
  java: {
    kind: 'annotation', verb: new RegExp(`^(?:(${UPPER})|(${VERB})Mapping)$`), mapped: ['RequestMapping'], lined: ['RequestLine'],
    route: ['Path'], serverRoute: true, base: ['RequestMapping', 'Path'],
  },
  typescript: { kind: 'decorator', verb: new RegExp(`^(${VERB}|All)$`), base: ['Controller', 'Client', 'Route', 'Path'] },
  python: { kind: 'decorator', verb: new RegExp(`^(${VERB.toLowerCase()})$`), base: ['controller', 'client', 'route', 'prefix'], baseAttrs: ['base_path', 'prefix', 'path', 'base_url'] },
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
