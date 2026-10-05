// Heuristic framework detectors over the token stream. Everything here is a pattern match
// on names and shapes (never on semantics), so the adapter marks the resulting facts
// confidence 'medium', and 'inference' where it guesses a topic or queue name. A detector
// that cannot see a literal name simply emits nothing.

import { makeUtil } from './tokutil.mjs';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
const HTTP_SET = new Set(HTTP_METHODS);
const NEST_DECOS = new Map([['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'], ['Delete', 'DELETE'], ['Options', 'OPTIONS'], ['Head', 'HEAD'], ['All', 'ALL']]);
const ROUTER_OBJ = /^(?:app|router|server|fastify|hono|koa|routes?|\w+Router|\w+App|\w+Server|\w+Routes?)$/i;
const NEXT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const CODE_EXT = '(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)';
const APP_ROUTE_RE = new RegExp(`(?:^|/)(?:src/)?app/(?:(.*)/)?route\\.${CODE_EXT}$`);
const APP_PAGE_RE = new RegExp(`(?:^|/)(?:src/)?app/(?:(.*)/)?page\\.${CODE_EXT}$`);
const PAGES_API_RE = new RegExp(`(?:^|/)(?:src/)?pages/api(?:/(.*))?\\.${CODE_EXT}$`);
const PAGES_RE = new RegExp(`(?:^|/)(?:src/)?pages/(.*)\\.${CODE_EXT}$`);
const SVELTE_SERVER_RE = new RegExp(`(?:^|/)src/routes/(?:(.*)/)?\\+server\\.${CODE_EXT}$`);
const SVELTE_PAGE_RE = /(?:^|\/)src\/routes\/(?:(.*)\/)?\+page\.svelte$/;
const ROUTE_ARRAY_NAME = /routes$/i;
const ROUTE_FACTORIES = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', 'forRoot', 'forChild', 'provideRouter']);

/** Joins URL path pieces: always a leading '/', no doubled or trailing slashes (except the root). */
export function joinPath(...parts) {
  const joined = `/${parts.filter((p) => p !== null && p !== undefined && p !== '').join('/')}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** Next.js style `[id]` segments as REST style `:id`. */
function restSegment(seg) {
  const m = /^\[\[?\.\.\.(\w+)\]\]?$/.exec(seg);
  if (m) return `:${m[1]}*`;
  const d = /^\[(\w+)\]$/.exec(seg);
  return d ? `:${d[1]}` : seg;
}

const isGroup = (seg) => /^\(.*\)$/.test(seg) || seg.startsWith('@');

/** Pure path conventions (Next.js app/pages routers, SvelteKit). */
export function conventionRoutes(path, exportNames, req) {
  const out = { endpoints: [], routes: [] };
  const names = new Set(exportNames);
  let m = APP_ROUTE_RE.exec(path) ?? SVELTE_SERVER_RE.exec(path);
  if (m) {
    const segs = (m[1] ?? '').split('/').filter((s) => s && !isGroup(s)).map(restSegment);
    const methods = [...names].filter((x) => NEXT_METHODS.has(x)).sort();
    const framework = path.includes('src/routes/') ? 'sveltekit' : 'nextjs';
    for (const method of methods) out.endpoints.push({ method, path: joinPath(...segs), framework, line: 1 });
    return out;
  }
  m = PAGES_API_RE.exec(path);
  if (m && names.has('default')) {
    const segs = (m[1] ?? '').split('/').filter(Boolean).map(restSegment);
    if (segs[segs.length - 1] === 'index') segs.pop();
    // A pages/api handler serves every method; the comparisons it makes are informational.
    out.endpoints.push({ method: 'ALL', path: joinPath('api', ...segs), framework: 'nextjs', line: 1, methods: req });
    return out;
  }
  m = APP_PAGE_RE.exec(path);
  if (m && names.has('default')) {
    const segs = (m[1] ?? '').split('/').filter((s) => s && !isGroup(s));
    out.routes.push({ path: joinPath(...segs), framework: 'nextjs', line: 1, module: true });
    return out;
  }
  m = PAGES_RE.exec(path);
  if (m && names.has('default') && !/^api(\/|$)/.test(m[1])) {
    const segs = m[1].split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    if (/^_(app|document|error|middleware)$/.test(last)) return out;
    if (last === 'index') segs.pop();
    out.routes.push({ path: joinPath(...segs), framework: 'nextjs', line: 1, module: true });
  }
  m = SVELTE_PAGE_RE.exec(path);
  if (m) {
    const segs = (m[1] ?? '').split('/').filter((s) => s && !isGroup(s));
    out.routes.push({ path: joinPath(...segs), framework: 'sveltekit', line: 1, module: true });
  }
  return out;
}

/**
 * @param {{ path: string, tokens: object[], n: number, match: Int32Array, analysis: object }} input
 */
const MONGO_READS = new Set(['find', 'findOne', 'findAsync', 'findOneAsync', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'findById', 'exists']);
const MONGO_WRITES = new Set(['insert', 'insertAsync', 'update', 'updateAsync', 'upsert', 'upsertAsync', 'remove', 'removeAsync', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'findByIdAndUpdate', 'findByIdAndDelete', 'create']);

export function detectFrameworks({ path, tokens, n, match, analysis }) {
  const U = makeUtil(tokens, n, match);
  const { at, isP, isId, splitArgs, literalOf, objectEntries } = U;
  const imports = new Set(analysis.imports.map((i) => i.specifier));
  const importsAny = (...names) => names.some((x) => [...imports].some((s) => s === x || s.startsWith(`${x}/`)));
  const res = { endpoints: [], routes: [], messaging: [], stores: [], security: [], reqMethods: [], mongo: { collections: [], ops: [] } };

  const serverFramework = importsAny('express') ? 'express'
    : importsAny('fastify') ? 'fastify'
      : importsAny('hono') ? 'hono'
        : importsAny('koa', '@koa/router', 'koa-router') ? 'koa' : 'http';

  const hasChildProcess = imports.has('child_process') || imports.has('node:child_process');
  const bindingBefore = (i) => {
    let j = i;
    while (isP(j - 1, '.') && at(j - 2).t === 'id') j -= 2;
    if (isP(j - 1, '=') && at(j - 2).t === 'id') return at(j - 2).v;
    return null;
  };
  const addSignal = (kind, line, detail) => {
    if (res.security.length < 200) res.security.push({ kind, line, detail });
  };

  const seenArrays = new Set();

  function componentOf(s, e) {
    const t = at(s);
    let component = null;
    let importSpec = null;
    if (t.t === 'jo') component = t.v || null;
    else if (t.t === 'id' && e - s === 1) component = t.v;
    else if (t.t === 'id' && isP(s + 1, '.') && e - s === 3) component = `${t.v}.${at(s + 2).v}`;
    for (let k = s; k < e; k++) {
      if (isId(k, 'import') && isP(k + 1, '(') && at(k + 2).t === 'str') {
        importSpec = at(k + 2).v;
        for (let m = e - 1; m > k; m--) {
          if (isP(m - 1, '.') && at(m).t === 'id') { component = at(m).v; break; }
        }
        break;
      }
    }
    return { component, importSpec };
  }

  function routeArray(open, parent, framework, depth) {
    if (depth > 20 || seenArrays.has(open)) return 0;
    seenArrays.add(open);
    let found = 0;
    for (const r of splitArgs(open)) {
      if (!isP(r.s, '{')) continue;
      const entries = objectEntries(r.s);
      const get = (...keys) => entries.find((e) => keys.includes(e.key));
      const pe = get('path');
      const pathV = pe ? literalOf(pe.s, pe.e) : null;
      const isIndex = !!get('index');
      const ce = get('element', 'component', 'Component', 'loadComponent', 'lazy', 'loadChildren');
      const children = get('children');
      const parentPath = parent;
      let full = parentPath;
      if (pathV !== null) full = pathV.startsWith('/') ? joinPath(pathV) : joinPath(parentPath, pathV);
      const comp = ce ? componentOf(ce.s, ce.e) : { component: null, importSpec: null };
      if ((pathV !== null || isIndex) && (ce || children || pathV !== null) && !(get('redirectTo') && !ce)) {
        if (ce || pathV !== null) {
          res.routes.push({
            path: full || '/', component: comp.component, importSpec: comp.importSpec, framework, line: at(r.s).l, layout: !!children,
          });
          found++;
        }
      }
      if (children && isP(children.s, '[')) found += routeArray(children.s, full, framework, depth + 1);
    }
    return found;
  }

  function jsxRoutes() {
    const stack = [];
    for (let i = 0; i < n; i++) {
      const tk = tokens[i];
      if (tk.t === 'jx' && /(?:^|\.)Route$/.test(tk.v)) { stack.pop(); continue; }
      if (tk.t !== 'jo' || !/(?:^|\.)Route$/.test(tk.v)) continue;
      let j = i + 1;
      let pathV = null;
      let isIndex = false;
      let comp = { component: null, importSpec: null };
      while (j < n && at(j).t !== 'jc') {
        const t = at(j);
        if (t.t === 'ja') {
          const brace = isP(j + 1, '{');
          if (t.v === 'path') {
            if (at(j + 1).t === 'str') pathV = at(j + 1).v;
            else if (brace && at(j + 2).t === 'str') pathV = at(j + 2).v;
          } else if (t.v === 'index') isIndex = true;
          else if (['element', 'Component', 'component', 'lazy'].includes(t.v) && brace) {
            comp = componentOf(j + 2, match[j + 1]);
          }
          if (brace) { j = match[j + 1] + 1; continue; }
        }
        j++;
      }
      const self = at(j).self === true;
      const parent = stack.length ? stack[stack.length - 1] : '';
      let full = parent;
      if (pathV !== null) full = pathV.startsWith('/') ? joinPath(pathV) : joinPath(parent, pathV);
      if (pathV !== null || isIndex) {
        res.routes.push({
          path: full || '/', component: comp.component, importSpec: comp.importSpec, framework: 'react-router', line: tk.l, layout: !self,
        });
      }
      if (!self) stack.push(full);
      i = j;
    }
  }

  function routeArrays() {
    for (let i = 0; i < n; i++) {
      const tk = tokens[i];
      if (tk.t !== 'id') continue;
      if (ROUTE_FACTORIES.has(tk.v) && isP(i + 1, '(') && isP(i + 2, '[') && !isP(i - 1, '.') ) {
        routeArray(i + 2, '', tk.v.startsWith('create') ? 'react-router' : tk.v === 'useRoutes' ? 'react-router' : 'angular', 0);
        continue;
      }
      if (ROUTE_FACTORIES.has(tk.v) && (tk.v === 'forRoot' || tk.v === 'forChild') && isP(i + 1, '(') && isP(i + 2, '[')) {
        routeArray(i + 2, '', 'angular', 0);
        continue;
      }
      if (!ROUTE_ARRAY_NAME.test(tk.v)) continue;
      let k = i + 1;
      if (isP(k, ':')) {
        if (isP(k + 1, '[')) { // object key, e.g. createRouter({ routes: [...] })
          const before = res.routes.length;
          routeArray(k + 1, '', importsAny('vue-router') ? 'vue-router' : 'unknown', 0);
          if (res.routes.length > before) continue;
        }
        const r = U.skipType(k + 1, { eq: true });
        if (isP(r, '=')) k = r;
      }
      if (isP(k, '=') && isP(k + 1, '[')) {
        const fw = importsAny('vue-router') ? 'vue-router' : importsAny('@angular/router') ? 'angular' : importsAny('react-router', 'react-router-dom', '@remix-run/router') ? 'react-router' : 'unknown';
        routeArray(k + 1, '', fw, 0);
      }
    }
    // Drop arrays that were not route tables (no component-ish keys anywhere).
    res.routes = res.routes.filter((r) => r.framework !== 'unknown' || r.component || r.importSpec);
    for (const r of res.routes) if (r.framework === 'unknown') r.framework = 'router';
  }

  function endpointCalls() {
    for (let i = 2; i < n; i++) {
      const tk = tokens[i];
      if (tk.t !== 'id' || !HTTP_SET.has(tk.v) || !isP(i - 1, '.') || !isP(i + 1, '(')) continue;
      const args = splitArgs(i + 1);
      let routePath = null;
      let viaRoute = false;
      let j = i - 2;
      // router.route('/p').get(h).post(h)
      while (isP(j, ')')) {
        const o = match[j];
        const nm = at(o - 1);
        if (nm.t === 'id' && nm.v === 'route' && isP(o - 2, '.')) {
          const a0 = splitArgs(o)[0];
          routePath = a0 ? literalOf(a0.s, a0.e) : null;
          viaRoute = routePath !== null;
          break;
        }
        if (nm.t === 'id' && HTTP_SET.has(nm.v) && isP(o - 2, '.')) { j = o - 3; continue; }
        break;
      }
      let p;
      if (viaRoute) {
        p = routePath;
      } else {
        const obj = at(i - 2);
        if (obj.t !== 'id' || !ROUTER_OBJ.test(obj.v) || args.length < 2) continue;
        p = literalOf(args[0].s, args[0].e);
        if (p === null || !(p.startsWith('/') || p === '*')) continue;
        if (isP(args[args.length - 1].s, '{')) continue;
      }
      const last = args[args.length - 1];
      const handler = last && last.e - last.s === 1 && at(last.s).t === 'id' ? at(last.s).v : undefined;
      const e = { method: tk.v.toUpperCase(), path: joinPath(p === '*' ? '*' : p), framework: serverFramework, line: tk.l };
      if (handler) e.handler = handler;
      res.endpoints.push(e);
    }
  }

  function fastifyRoutes() {
    for (let i = 1; i < n; i++) {
      if (!isId(i, 'route') || !isP(i - 1, '.') || !isP(i + 1, '(') || !isP(i + 2, '{')) continue;
      const entries = objectEntries(i + 2);
      const get = (...k) => entries.find((e) => k.includes(e.key));
      const me = get('method');
      const ue = get('url', 'path');
      if (!me || !ue) continue;
      const url = literalOf(ue.s, ue.e);
      if (url === null) continue;
      const methods = [];
      const lit = literalOf(me.s, me.e);
      if (lit !== null) methods.push(lit);
      else if (isP(me.s, '[')) for (const a of splitArgs(me.s)) { const l = literalOf(a.s, a.e); if (l !== null) methods.push(l); }
      for (const m of methods) res.endpoints.push({ method: m.toUpperCase(), path: joinPath(url), framework: 'fastify', line: at(i).l });
    }
  }

  function nestEndpoints() {
    for (const c of analysis.classes) {
      const ctl = c.decorators.find((d) => d.name === 'Controller');
      if (!ctl) continue;
      const prefix = ctl.args[0] ?? '';
      for (const f of analysis.functions) {
        if (f.cls !== c.qname) continue;
        for (const d of f.decorators) {
          const method = NEST_DECOS.get(d.name);
          if (!method) continue;
          res.endpoints.push({
            method, path: joinPath(prefix, d.args[0] ?? ''), framework: 'nestjs', line: d.line, handler: f.qname, controller: c.qname,
          });
        }
      }
    }
  }

  function requestMethods() {
    const found = new Set();
    for (let i = 1; i < n; i++) {
      if (isId(i, 'method') && isP(i - 1, '.') && (isP(i + 1, '===') || isP(i + 1, '==')) && at(i + 2).t === 'str') found.add(at(i + 2).v.toUpperCase());
    }
    res.reqMethods = [...found].sort();
  }

  function messaging() {
    const add = (dir, kind, name, line, lib) => {
      if (res.messaging.length < 200) res.messaging.push({ dir, kind, name, line, lib });
    };
    const bull = importsAny('bullmq', 'bull');
    for (let i = 1; i < n; i++) {
      const tk = tokens[i];
      if (tk.t !== 'id') continue;
      if (isId(i - 1, 'new') && bull && (tk.v === 'Queue' || tk.v === 'Worker') && isP(i + 1, '(')) {
        const a0 = splitArgs(i + 1)[0];
        const name = a0 ? literalOf(a0.s, a0.e) : null;
        if (name) add(tk.v === 'Queue' ? 'PUBLISHES' : 'SUBSCRIBES', 'queue', name, tk.l, 'bullmq');
        continue;
      }
      if (!isP(i - 1, '.') || !isP(i + 1, '(')) continue;
      // `Meteor.subscribe('name')` and `Meteor.publish('name', fn)` are DDP data publications
      // (reads of a published dataset), not message channels; treating them as consumers
      // produced a hundred idempotency findings on a Meteor application.
      if (isId(i - 2, 'Meteor') && (tk.v === 'subscribe' || tk.v === 'publish')) continue;
      const args = splitArgs(i + 1);
      const first = args[0];
      const lit0 = first ? literalOf(first.s, first.e) : null;
      switch (tk.v) {
        case 'send': {
          if (first && isP(first.s, '{')) {
            const t = objectEntries(first.s).find((e) => e.key === 'topic');
            const name = t ? literalOf(t.s, t.e) : null;
            if (name) add('PUBLISHES', 'topic', name, tk.l, 'kafkajs');
          }
          break;
        }
        case 'subscribe': {
          if (first && isP(first.s, '{')) {
            for (const e of objectEntries(first.s)) {
              if (e.key === 'topic') { const name = literalOf(e.s, e.e); if (name) add('SUBSCRIBES', 'topic', name, tk.l, 'kafkajs'); }
              if (e.key === 'topics' && isP(e.s, '[')) for (const a of splitArgs(e.s)) { const name = literalOf(a.s, a.e); if (name) add('SUBSCRIBES', 'topic', name, tk.l, 'kafkajs'); }
            }
          } else if (lit0) add('SUBSCRIBES', 'topic', lit0, tk.l, 'pubsub');
          break;
        }
        case 'publish': {
          if (lit0) {
            const key = args[1] ? literalOf(args[1].s, args[1].e) : null;
            if (key !== null && args.length >= 3) add('PUBLISHES', 'topic', lit0, tk.l, 'amqplib');
            else add('PUBLISHES', 'topic', lit0, tk.l, 'pubsub');
          }
          break;
        }
        case 'sendToQueue':
          if (lit0) add('PUBLISHES', 'queue', lit0, tk.l, 'amqplib');
          break;
        case 'consume':
          if (lit0) add('SUBSCRIBES', 'queue', lit0, tk.l, 'amqplib');
          break;
        default:
      }
    }
  }

  // MongoDB collections (Meteor `new Mongo.Collection('x')`, Mongoose `mongoose.model('X')`,
  // the driver's `db.collection('x')`) and the reads and writes made through them. Bindings
  // are resolved to their definitions in link; per file, only names that are defined here or
  // imported are kept, so `array.find(...)` on a local value is not a query.
  function mongo() {
    const defs = res.mongo.collections;
    const ops = res.mongo.ops;
    const imported = new Set(analysis.imports.flatMap((i) => (i.bindings ?? []).map((b) => b.local)));
    for (let i = 1; i < n; i++) {
      const tk = tokens[i];
      if (tk.t !== 'id') continue;
      // new Mongo.Collection('name') / new Meteor.Collection('name')
      if (isId(i - 1, 'new') && (tk.v === 'Mongo' || tk.v === 'Meteor') && isP(i + 1, '.') && isId(i + 2, 'Collection') && isP(i + 3, '(')) {
        const a0 = splitArgs(i + 3)[0];
        const name = a0 ? literalOf(a0.s, a0.e) : null;
        const binding = bindingBefore(i - 1);
        if (name && defs.length < 200) defs.push({ binding, name, line: tk.l, orm: 'meteor' });
        continue;
      }
      // mongoose.model('Name', schema)
      if (tk.v === 'model' && isP(i - 1, '.') && isId(i - 2, 'mongoose') && isP(i + 1, '(')) {
        const a0 = splitArgs(i + 1)[0];
        const name = a0 ? literalOf(a0.s, a0.e) : null;
        if (name && defs.length < 200) defs.push({ binding: bindingBefore(i - 2), name, line: tk.l, orm: 'mongoose' });
        continue;
      }
      if (!isP(i - 1, '.') || !isP(i + 1, '(')) continue;
      const kind = MONGO_READS.has(tk.v) ? 'read' : MONGO_WRITES.has(tk.v) ? 'write' : null;
      if (!kind) continue;
      // db.collection('name').find(...)
      if (isP(i - 2, ')') && match[i - 2] !== undefined && isId(match[i - 2] - 1, 'collection') && isP(match[i - 2] - 2, '.')) {
        const a0 = splitArgs(match[i - 2])[0];
        const name = a0 ? literalOf(a0.s, a0.e) : null;
        if (name && ops.length < 500) ops.push({ name, op: tk.v, kind, line: tk.l });
        continue;
      }
      // Binding.find(...), but not this.x.find or a.b.find
      if (at(i - 2).t === 'id' && !isP(i - 3, '.')) {
        const b = at(i - 2).v;
        if (b === 'this' || b === 'Meteor') continue;
        if ((imported.has(b) || defs.some((d) => d.binding === b)) && ops.length < 500) ops.push({ binding: b, op: tk.v, kind, line: tk.l });
      }
    }
  }

  function stores() {
    const zustand = importsAny('zustand');
    const add = (kind, name, binding, line) => {
      if (res.stores.length < 100) res.stores.push({ kind, name, binding, line });
    };
    for (let i = 0; i < n; i++) {
      const tk = tokens[i];
      if (tk.t !== 'id') continue;
      const next = isP(i + 1, '(') || (isP(i + 1, '<') && U.skipAngle(i + 1) > 0);
      if (!next) continue;
      switch (tk.v) {
        case 'createSlice': {
          const o = isP(i + 1, '(') ? i + 1 : U.skipAngle(i + 1);
          const a0 = splitArgs(o)[0];
          if (a0 && isP(a0.s, '{')) {
            const e = objectEntries(a0.s).find((x) => x.key === 'name');
            const name = e ? literalOf(e.s, e.e) : null;
            if (name) add('redux-slice', name, bindingBefore(i), tk.l);
          }
          break;
        }
        case 'configureStore': add('redux-store', bindingBefore(i) ?? 'store', bindingBefore(i), tk.l); break;
        case 'create': case 'createStore':
          if (zustand && !isP(i - 1, '.')) {
            // create<State>()((set) => ...) is the curried TypeScript form
            const b = bindingBefore(i);
            if (b) add('zustand', b, b, tk.l);
          }
          break;
        case 'createContext': {
          const b = bindingBefore(i);
          add('context', b ?? 'context', b, tk.l);
          break;
        }
        case 'defineStore': {
          const a0 = splitArgs(i + 1)[0];
          const name = a0 ? literalOf(a0.s, a0.e) : null;
          if (name) add('pinia', name, bindingBefore(i), tk.l);
          break;
        }
        default:
      }
    }
  }

  function securitySignals() {
    for (let i = 0; i < n; i++) {
      const tk = tokens[i];
      if (tk.t === 'ja') {
        if (tk.v === 'dangerouslySetInnerHTML') addSignal('dangerously-set-inner-html', tk.l, 'dangerouslySetInnerHTML');
        continue;
      }
      if (tk.t !== 'id') continue;
      const afterDot = isP(i - 1, '.') || isP(i - 1, '?.');
      const call = isP(i + 1, '(');
      switch (tk.v) {
        case 'exec': case 'execSync': {
          if (!call || !hasChildProcess) break;
          const a0 = splitArgs(i + 1)[0];
          if (a0 && !(a0.e - a0.s === 1 && (at(a0.s).t === 'str' || at(a0.s).t === 'tpl'))) addSignal('exec-nonliteral', tk.l, `${tk.v}() with a non-literal command`);
          break;
        }
        case 'spawn': case 'spawnSync': case 'execFile': case 'execFileSync':
          if (call && hasChildProcess) {
            for (const a of splitArgs(i + 1)) {
              if (!isP(a.s, '{')) continue;
              const sh = objectEntries(a.s).find((e) => e.key === 'shell');
              if (sh && sh.e - sh.s === 1 && isId(sh.s, 'true')) addSignal('spawn-shell', tk.l, `${tk.v}() with shell: true`);
            }
          }
          break;
        case 'eval':
          if (call && !(afterDot && !isId(i - 2, 'window') && !isId(i - 2, 'globalThis'))) addSignal('eval', tk.l, 'eval()');
          break;
        case 'Function':
          if (call && isId(i - 1, 'new')) addSignal('new-function', tk.l, 'new Function()');
          break;
        case 'runInNewContext': case 'runInThisContext': case 'runInContext':
          if (call && afterDot) addSignal('vm-run', tk.l, `vm.${tk.v}()`);
          break;
        case 'innerHTML': case 'outerHTML':
          if (afterDot && (isP(i + 1, '=') || isP(i + 1, '+='))) addSignal('inner-html', tk.l, `${tk.v} assignment`);
          break;
        case 'dangerouslySetInnerHTML':
          addSignal('dangerously-set-inner-html', tk.l, 'dangerouslySetInnerHTML');
          break;
        case 'write': case 'writeln':
          if (call && afterDot && isId(i - 2, 'document')) addSignal('document-write', tk.l, `document.${tk.v}()`);
          break;
        case 'query': case 'execute': case 'raw': {
          if (!call || !afterDot) break;
          const a0 = at(i + 2);
          if (a0.t === 'tplh') addSignal('sql-interpolation', tk.l, `.${tk.v}() with an interpolated template literal`);
          else if (a0.t === 'str' && isP(i + 3, '+') && /^\s*(select|insert|update|delete|with)\b/i.test(a0.v)) addSignal('sql-interpolation', tk.l, `.${tk.v}() with a concatenated query`);
          break;
        }
        default:
      }
    }
  }

  requestMethods();
  endpointCalls();
  fastifyRoutes();
  nestEndpoints();
  jsxRoutes();
  routeArrays();
  messaging();
  mongo();
  stores();
  securitySignals();
  return res;
}
