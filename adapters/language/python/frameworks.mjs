// Framework heuristics over the raw structure (decorators, call sites, class bodies). These
// are inferences from naming and shape, so they carry source_type 'inference' and never
// claim more than medium confidence. Cross-file composition (a router mounted from another
// module, Django include()) is deliberately not attempted here.

import { edgeFact, nodeFact } from '../../../runtime/graph/facts.mjs';

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

/**
 * @param {object} a
 * @param {string} a.path
 * @param {object} a.raw raw structure (extract.py or lexical)
 * @param {string} a.moduleId
 * @param {Map<string,{id:string,type:string,rec:object}>} a.symbols by qualified name
 * @param {(line:number)=>object} a.pv heuristic provenance factory
 * @param {(line:number)=>object} a.pvModel provenance for ORM mapping facts
 */
export function frameworkFacts({ path, raw, moduleId, symbols, pv, pvModel }) {
  const facts = [];
  const detail = raw.calls_detail ?? [];
  const importedModules = new Set(raw.imports.map((i) => i.module.split('.')[0]));
  const dottedModule = path.replace(/\.py$/, '').split('/').filter((s, i, a) => !(s === '__init__' && i === a.length - 1))
    .filter((s, i) => !(i === 0 && s === 'src')).join('.');
  const symId = (qual) => symbols.get(qual)?.id ?? moduleId;

  // --- Flask / FastAPI ---------------------------------------------------------------
  const vars = new Map();
  for (const c of detail) {
    if (!c.assign || c.scope || c.owner_class) continue;
    const l = lastSeg(c.name);
    if (l === 'Flask') vars.set(c.assign, { framework: 'flask', prefix: '' });
    else if (l === 'Blueprint') vars.set(c.assign, { framework: 'flask', prefix: lit(c.kwargs.url_prefix) ?? '' });
    else if (l === 'FastAPI') vars.set(c.assign, { framework: 'fastapi', prefix: '' });
    else if (l === 'APIRouter') vars.set(c.assign, { framework: 'fastapi', prefix: lit(c.kwargs.prefix) ?? '' });
  }
  for (const c of detail) {
    const l = lastSeg(c.name);
    const target = c.args[0]?.ref ? vars.get(c.args[0].ref) : null;
    if (!target) continue;
    if (l === 'register_blueprint' && lit(c.kwargs.url_prefix) !== null) target.prefix = c.kwargs.url_prefix;
    else if (l === 'include_router' && lit(c.kwargs.prefix) !== null) target.prefix = c.kwargs.prefix + target.prefix;
  }
  const fallback = importedModules.has('fastapi') ? 'fastapi' : importedModules.has('flask') ? 'flask' : null;
  const seenEndpoints = new Set();
  for (const [qual, sym] of symbols) {
    if (sym.type === 'class') continue;
    for (const d of sym.rec.decorators ?? []) {
      const verb = lastSeg(d.name);
      const recv = recvOf(d.name);
      if (!recv || !(HTTP_VERBS.has(verb) || verb === 'route' || verb === 'api_route')) continue;
      const info = vars.get(recv) ?? (fallback ? { framework: fallback, prefix: '' } : null);
      if (!info) continue;
      const route = lit(d.args[0]) ?? lit(d.kwargs.path) ?? lit(d.kwargs.rule);
      if (route === null) continue;
      const methods = HTTP_VERBS.has(verb) ? [verb.toUpperCase()]
        : strings(d.kwargs.methods).map((m) => m.toUpperCase()).concat([]).sort();
      const full = normalizeRoute(`${info.prefix}/${route}`);
      for (const method of methods.length ? methods : ['GET']) {
        const key = `${method} ${full}`;
        const id = `endpoint:${key}`;
        const attrs = { framework: info.framework, method, path: full, handler: sym.id, router: recv };
        if (!seenEndpoints.has(`${id}|${sym.id}`)) {
          seenEndpoints.add(`${id}|${sym.id}`);
          facts.push(nodeFact('endpoint', key, { name: key, path, attrs }, pv(d.line)));
          facts.push(edgeFact('EXPOSES', sym.id, id, { framework: info.framework }, pv(d.line)));
        }
      }
    }
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
