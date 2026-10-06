// Framework heuristics over the raw structure (decorators, call sites, class bodies). These
// are inferences from naming and shape, so they carry source_type 'inference' and never
// claim more than medium confidence. Cross-file composition (a router mounted from another
// module, Django include()) is deliberately not attempted here.

import { edgeFact, nodeFact } from '../../../runtime/graph/facts.mjs';
import { SYNTAX, clientFacts, clientPath, createGroups, operations, readMarker, routeGroupAttrs, typeBase, urlPath } from '../http-ops.mjs';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

const lastSeg = (name) => name.slice(name.lastIndexOf('.') + 1);
const recvOf = (name) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : '');
const lit = (v) => (typeof v === 'string' ? v : null);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** `<int:id>`, `<id>`, `{id}`, `{id:path}` -> `:id`; one leading slash, no doubled slashes. */
export function normalizeRoute(p, { trim = true } = {}) {
  let s = String(p)
    .replace(/<(?:[A-Za-z_]\w*:)?([A-Za-z_]\w*)>/g, ':$1')
    .replace(/\{([A-Za-z_]\w*)(?::[^}]*)?\}/g, ':$1');
  s = `/${s}`.replace(/\/{2,}/g, '/');
  if (trim && s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

/** Django re_path regex -> readable route. */
function regexRoute(rx) {
  return String(rx)
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\(\?P<(\w+)>[^)]*\)/g, ':$1')
    .replace(/\([^)]*\)/g, ':arg')
    .replace(/\\(.)/g, '$1')
    .replace(/[?*+]/g, '');
}

function snake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

function typeText(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.ref) return v.ref;
    if (v.call) return `${v.call}(${(v.args ?? []).filter((a) => typeof a === 'number').join(',')})`.replace('()', '');
  }
  return null;
}

function annType(ann) {
  if (!ann) return null;
  const m = /^(?:\w+\.)?Mapped\[(.*)\]$/.exec(ann.trim());
  return (m ? m[1] : ann).replace(/\s*\|\s*None|None\s*\|\s*/g, '').replace(/^Optional\[(.*)\]$/, '$1').trim();
}

const ABSTRACT_BASE = /(?:^|\.)(?:Protocol|ABC)$/;

/** A class that only declares: a Protocol or ABC base, an ABCMeta metaclass, or an abstract method. */
function abstractClass(rec, symbols) {
  if (rec.bases.some((b) => ABSTRACT_BASE.test(b)) || JSON.stringify(rec.keywords ?? {}).includes('ABCMeta')) return true;
  for (const sym of symbols.values()) {
    if (sym.rec.parent === rec.qual && (sym.rec.decorators ?? []).some((d) => lastSeg(d.name) === 'abstractmethod')) return true;
  }
  return false;
}

/** The base path a class states: a base decorator (`@client("/v1")`) or a class attribute (`base_path = "/v1"`). */
function classBase(rec) {
  const marked = typeBase('python', (rec.decorators ?? []).map((d) => ({ name: d.name, args: { route: lit(d.args[0]) ?? lit(d.kwargs.prefix) ?? lit(d.kwargs.path) } })));
  if (marked) return marked;
  for (const k of SYNTAX.python.baseAttrs) {
    const v = lit(rec.assigns?.[k]);
    if (v) return urlPath(v);
  }
  return '';
}

/**
 * @param {object} a
 * @param {string} a.path
 * @param {object} a.raw raw structure (extract.py or lexical)
 * @param {string} a.moduleId
 * @param {Map<string,{id:string,type:string,rec:object}>} a.symbols by qualified name
 * @param {(line:number)=>object} a.pv heuristic provenance factory
 * @param {(line:number)=>object} a.pvModel provenance for ORM mapping facts
 * @param {object} a.moduleAttrs attributes of the module fact; the route group inputs for link() are added to them
 */
export function frameworkFacts({ path, raw, moduleId, symbols, pv, pvModel, moduleAttrs }) {
  const facts = [];
  const detail = raw.calls_detail ?? [];
  const importedModules = new Set(raw.imports.map((i) => i.module.split('.')[0]));
  const dottedModule = path.replace(/\.py$/, '').split('/').filter((s, i, a) => !(s === '__init__' && i === a.length - 1))
    .filter((s, i) => !(i === 0 && s === 'src')).join('.');
  const symId = (qual) => symbols.get(qual)?.id ?? moduleId;

  // --- Flask / FastAPI ---------------------------------------------------------------
  // Route groups (see SYNTAX.python.groups): a router or blueprint created with a prefix, mounted
  // below an app or another router with another, and handed to functions that register on it.
  const vars = new Map();
  const gs = createGroups('python');
  const create = gs.syn.create ?? {};
  for (const c of detail) {
    if (!c.assign || c.scope || c.owner_class) continue;
    const l = lastSeg(c.name);
    const framework = l === 'Flask' || l === 'Blueprint' ? 'flask' : l === 'FastAPI' || l === 'APIRouter' ? 'fastapi' : null;
    if (!framework) continue;
    vars.set(c.assign, { framework });
    const kw = Object.hasOwn(create, l) ? create[l] : undefined;
    // An app is a root; a router or blueprint is a group, whose prefix may be a variable.
    if (kw === undefined) gs.group(`v:${c.assign}`, {});
    else gs.group(`v:${c.assign}`, { own: kw && c.kwargs[kw] !== undefined ? lit(c.kwargs[kw]) : '', name: c.assign, module: true });
  }
  const funcParams = (scope) => (scope ? symbols.get(scope)?.rec.params ?? null : null);
  const ownerSkips = (scope) => symbols.get(scope)?.type === 'method' && ['self', 'cls'].includes(funcParams(scope)?.[0]);
  /** The group key a name stands for in a scope: a module-level group, or a parameter of the function the scope is. */
  const lookup = (name, scope) => {
    const params = funcParams(scope);
    const index = params ? params.indexOf(name) : -1;
    if (index >= 0) {
      const shift = ownerSkips(scope) ? 1 : 0;
      const key = `p:${scope}:${index}`;
      if (index >= shift) gs.param(key, { fn: lastSeg(scope), index: index - shift });
      return index >= shift ? key : null;
    }
    return vars.has(name) ? `v:${name}` : null;
  };
  const imports = raw.imports ?? [];
  /** What an imported name refers to: the name it has where it is declared and the module it comes from. */
  const imported = (ref) => {
    const [head, ...rest] = ref.split('.');
    for (const imp of imports) {
      if (imp.kind === 'from') {
        for (const n of imp.names ?? []) {
          if ((n.as ?? n.name) !== head) continue;
          return rest.length ? { name: rest[rest.length - 1], hint: `${imp.module}.${n.name}` } : { name: n.name, hint: imp.module };
        }
      } else if (imp.kind === 'import' && (imp.as ?? imp.module.split('.')[0]) === head && rest.length) {
        return { name: rest[rest.length - 1], hint: rest.length > 1 ? rest[rest.length - 2] : imp.as ? imp.module : imp.module };
      }
    }
    return null;
  };
  const mountRows = gs.syn.mount ?? [];
  for (const c of detail) {
    const l = lastSeg(c.name);
    const row = c.name.includes('.') ? mountRows.find((r) => r.name === l) : null;
    const arg = c.args[row?.child]?.ref;
    if (row && arg) {
      const prefix = c.kwargs[row.prefix] === undefined ? '' : lit(c.kwargs[row.prefix]);
      const parent = lookup(recvOf(c.name), c.scope);
      const child = arg.includes('.') ? null : lookup(arg, c.scope);
      if (child && gs.has(child)) gs.mount(child, parent, prefix, row.replaces && c.kwargs[row.prefix] !== undefined);
      else {
        const imp = imported(arg);
        if (imp) gs.mountImported(imp.name, imp.hint, parent, prefix);
      }
      continue;
    }
    if ((gs.syn.create && Object.hasOwn(gs.syn.create, l)) || HTTP_VERBS.has(l)) continue;
    // A call that hands a group to a function: the groups among its positional arguments.
    const args = c.args.map((a) => (a?.ref && !a.ref.includes('.') ? (lookup(a.ref, c.scope) ?? '') : null));
    if (args.some((a) => a !== null)) gs.call(l, null, args);
  }
  if (moduleAttrs) Object.assign(moduleAttrs, gs.moduleAttrs()); // link-only: link() finishes cross-file prefixes and removes them
  const fallback = importedModules.has('fastapi') ? 'fastapi' : importedModules.has('flask') ? 'flask' : null;
  const seenEndpoints = new Set();
  const classOf = (sym) => (sym.type === 'method' ? symbols.get(sym.rec.parent) : null);
  const clientOps = new Map();
  for (const [qual, sym] of symbols) {
    if (sym.type === 'class') continue;
    const owner = classOf(sym);
    // In an abstract or Protocol class, or with a body that does nothing, a decorated method declares a call.
    const client = Boolean(owner) && (abstractClass(owner.rec, symbols) || sym.rec.stub === true);
    const scope = sym.rec.parent && symbols.get(sym.rec.parent)?.type === 'function' ? sym.rec.parent : null;
    for (const d of sym.rec.decorators ?? []) {
      const verb = lastSeg(d.name);
      const recv = recvOf(d.name);
      const route = lit(d.args[0]) ?? lit(d.kwargs.path) ?? lit(d.kwargs.rule);
      if (client) {
        const ops = operations('python', [{ name: d.name, args: { route } }], { base: classBase(owner.rec), client: true, norm: normalizeRoute });
        for (const o of ops) {
          if (!clientOps.has(owner)) clientOps.set(owner, []);
          clientOps.get(owner).push({ ...o, path: clientPath(o.path, normalizeRoute), name: sym.rec.name, line: d.line });
        }
        continue;
      }
      if (!recv && route !== null && readMarker('python', d.name, { route })) {
        // A bare `@get("/x")` on a concrete handler; the class, if any, gives the base path.
        const base = owner ? classBase(owner.rec) : '';
        for (const o of operations('python', [{ name: d.name, args: { route } }], { base, norm: normalizeRoute })) {
          const key = `${o.method} ${o.path}`;
          if (seenEndpoints.has(`${key}|${sym.id}`)) continue;
          seenEndpoints.add(`${key}|${sym.id}`);
          facts.push(nodeFact('endpoint', key, { name: key, path, attrs: { framework: 'decorator', method: o.method, path: o.path, handler: sym.id } }, pv(d.line)));
          facts.push(edgeFact('EXPOSES', sym.id, `endpoint:${key}`, { framework: 'decorator' }, pv(d.line)));
        }
        continue;
      }
      if (!recv || !(HTTP_VERBS.has(verb) || verb === 'route' || verb === 'api_route')) continue;
      const key = lookup(recv, scope);
      const info = vars.get(recv) ?? (fallback ? { framework: fallback } : key ? { framework: 'router' } : null);
      if (!info) continue;
      if (route === null) continue;
      const group = key ? gs.resolve(key) : null;
      const methods = HTTP_VERBS.has(verb) ? [verb.toUpperCase()]
        : strings(d.kwargs.methods).map((m) => m.toUpperCase()).concat([]).sort();
      const full = normalizeRoute(`${group?.prefix ?? ''}/${route}`);
      for (const method of methods.length ? methods : ['GET']) {
        const key = `${method} ${full}`;
        const id = `endpoint:${key}`;
        const attrs = { framework: info.framework, method, path: full, handler: sym.id, router: recv, ...routeGroupAttrs(group) };
        if (!seenEndpoints.has(`${id}|${sym.id}`)) {
          seenEndpoints.add(`${id}|${sym.id}`);
          facts.push(nodeFact('endpoint', key, { name: key, path, attrs }, pv(d.line)));
          facts.push(edgeFact('EXPOSES', sym.id, id, { framework: info.framework }, pv(d.line)));
        }
      }
    }
  }
  for (const [cls, ops] of clientOps) {
    facts.push(...clientFacts({
      modId: moduleId, cid: `${path}#${cls.rec.qual}`, name: cls.rec.qual, path, line: cls.rec.start_line, interfaceId: cls.id, lang: 'python',
      framework: 'decorator', ops, pv,
    }));
  }

  // --- Django URLconf ----------------------------------------------------------------
  if (/(^|\/)urls\.py$/.test(path) || raw.imports.some((i) => i.module === 'django.urls')) {
    for (const c of detail) {
      const l = lastSeg(c.name);
      if (!['path', 're_path', 'url'].includes(l) || c.scope) continue;
      const route = lit(c.args[0]) ?? lit(c.kwargs.route);
      const viewArg = c.args[1] ?? c.kwargs.view;
      if (route === null || viewArg === undefined || viewArg?.call === 'include') continue;
      const view = viewArg?.ref ?? (viewArg?.call ? viewArg.call.replace(/\.as_view$/, '') : null);
      if (!view) continue;
      const full = l === 'path' ? normalizeRoute(route, { trim: false }) : normalizeRoute(regexRoute(route), { trim: false });
      const key = `ANY ${full}`;
      facts.push(nodeFact('endpoint', key, { name: key, path, attrs: { framework: 'django', method: 'ANY', path: full, view, name: lit(c.kwargs.name) } }, pv(c.line)));
      facts.push(edgeFact('EXPOSES', moduleId, `endpoint:${key}`, { framework: 'django', view }, pv(c.line)));
    }
  }

  // --- ORM models -> tables ----------------------------------------------------------
  const importsDjangoModels = raw.imports.some((i) => i.module === 'django.db' && i.names.some((n) => n.name === 'models'))
    || raw.imports.some((i) => i.module === 'django.db.models');
  for (const cls of raw.classes) {
    if (cls.parent) continue;
    const isDjango = cls.bases.some((b) => b === 'models.Model' || (b === 'Model' && importsDjangoModels));
    const tablename = lit(cls.assigns.__tablename__);
    const isSqla = !isDjango && (tablename !== null || cls.bases.includes('db.Model'));
    if (!isDjango && !isSqla) continue;
    const owned = detail.filter((c) => c.owner_class === cls.qual && !c.scope);
    const columns = [];
    let table;
    if (isSqla) {
      table = tablename ?? snake(cls.name);
      for (const c of owned) {
        const l = lastSeg(c.name);
        if (l !== 'Column' && l !== 'mapped_column') continue;
        const nameArg = lit(c.args[0]);
        const name = c.assign ?? nameArg;
        if (!name) continue;
        const rest = c.args.filter((a) => typeof a !== 'string');
        const fk = [...rest, ...Object.values(c.kwargs)].find((a) => a?.call && lastSeg(a.call) === 'ForeignKey');
        const typeArg = rest.find((a) => (a?.ref || a?.call) && !(a?.call && lastSeg(a.call) === 'ForeignKey'));
        const primary = c.kwargs.primary_key === true;
        const optional = c.ann ? /Optional\[|\|\s*None|None\s*\|/.test(c.ann) : null;
        const nullable = typeof c.kwargs.nullable === 'boolean' ? c.kwargs.nullable : primary ? false : optional === null ? true : optional;
        columns.push({
          name: c.assign && nameArg ? nameArg : name,
          type: typeText(typeArg) ?? annType(c.ann),
          nullable,
          primary_key: primary,
          foreign_key: fk ? lit(fk.args[0]) : null,
        });
      }
    } else {
      const meta = raw.classes.find((k) => k.qual === `${cls.qual}.Meta`);
      if (meta?.assigns.abstract === true) continue;
      const parts = path.split('/');
      parts.pop();
      if (parts[parts.length - 1] === 'models') parts.pop();
      const app = parts[parts.length - 1] ?? '';
      table = lit(meta?.assigns.db_table) ?? `${app ? `${app}_` : ''}${cls.name.toLowerCase()}`;
      for (const c of owned) {
        const l = lastSeg(c.name);
        if (!c.assign || l === 'ManyToManyField' || !(l.endsWith('Field') || l === 'ForeignKey')) continue;
        const isFk = l === 'ForeignKey' || l === 'OneToOneField';
        const target = c.args[0] ?? c.kwargs.to;
        columns.push({
          name: isFk ? `${c.assign}_id` : c.assign,
          type: l,
          nullable: c.kwargs.null === true,
          primary_key: c.kwargs.primary_key === true,
          foreign_key: isFk ? lit(target) ?? target?.ref ?? null : null,
        });
      }
      if (!columns.some((c) => c.primary_key)) columns.unshift({ name: 'id', type: 'AutoField', nullable: false, primary_key: true, foreign_key: null });
    }
    const orm = isDjango ? 'django' : 'sqlalchemy';
    facts.push(nodeFact('table', table, { name: table, path, attrs: { columns, orm, model: cls.qual } }, pvModel(cls.start_line)));
    facts.push(edgeFact('OWNS_DATA', moduleId, `table:${table}`, { orm, model: cls.qual }, pvModel(cls.start_line)));
  }

  // --- Celery ------------------------------------------------------------------------
  for (const [qual, sym] of symbols) {
    if (sym.type === 'class') continue;
    const d = (sym.rec.decorators ?? []).find((x) => lastSeg(x.name) === 'task' || lastSeg(x.name) === 'shared_task');
    if (!d) continue;
    if (lastSeg(d.name) === 'task' && !recvOf(d.name)) continue;
    const name = lit(d.kwargs.name) ?? `${dottedModule}.${qual}`;
    facts.push(nodeFact('job', name, { name, path, attrs: { framework: 'celery', function: sym.id, queue: lit(d.kwargs.queue) } }, pv(d.line)));
    facts.push(edgeFact('CONTAINS', moduleId, `job:${name}`, {}, pv(d.line)));
  }

  // --- Messaging: Kafka and RabbitMQ (pika) -----------------------------------------
  const seen = new Set();
  const link = (type, node, nodeType, broker, c, extra = {}, from = symId(c.scope)) => {
    const sig = `${type}|${from}|${nodeType}:${node}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    facts.push(nodeFact(nodeType, node, { name: node, path, attrs: { broker } }, pv(c.line)));
    facts.push(edgeFact(type, from, `${nodeType}:${node}`, { via: lastSeg(c.name), line: c.line, ...extra }, pv(c.line)));
  };
  for (const c of detail) {
    const l = lastSeg(c.name);
    const recv = lastSeg(recvOf(c.name));
    if ((l === 'send' && /producer|kafka|prod/i.test(recv)) || l === 'produce') {
      const topic = lit(c.args[0]) ?? lit(c.kwargs.topic);
      if (topic) link('PUBLISHES', topic, 'topic', 'kafka', c);
    } else if (l === 'KafkaConsumer') {
      for (const t of c.args) if (lit(t)) link('SUBSCRIBES', t, 'topic', 'kafka', c);
    } else if (l === 'subscribe' && /consumer|kafka/i.test(recv)) {
      for (const t of strings(c.args[0] ?? c.kwargs.topics)) link('SUBSCRIBES', t, 'topic', 'kafka', c);
    } else if (l === 'basic_publish') {
      const exchange = lit(c.kwargs.exchange) ?? lit(c.args[0]) ?? '';
      const key = lit(c.kwargs.routing_key) ?? lit(c.args[1]) ?? '';
      if (!exchange && key) link('PUBLISHES', key, 'queue', 'rabbitmq', c);
      else if (exchange) link('PUBLISHES', exchange, 'topic', 'rabbitmq', c, key ? { routing_key: key } : {});
    } else if (l === 'basic_consume') {
      const queue = lit(c.kwargs.queue) ?? lit(c.args[0]);
      if (!queue) continue;
      const cb = c.kwargs.on_message_callback?.ref ?? c.args[1]?.ref;
      const from = cb && symbols.has(cb) ? symbols.get(cb).id : symId(c.scope);
      link('SUBSCRIBES', queue, 'queue', 'rabbitmq', c, {}, from);
    }
  }
  return facts;
}
