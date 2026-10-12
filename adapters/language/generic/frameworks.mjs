// Framework-aware heuristics layered over the lexical structure: HTTP endpoints, raw SQL,
// ORM table hints and security signals. Every result here is a guess from naming and
// annotation conventions, so callers label it `inference` with medium or low confidence.
// Regexes run on `lx.plain` (comments gone, strings intact) and are filtered through
// `lx.code` so a match whose first character sits inside a string literal is discarded.

import { clientPath, operations, parseArgs, typeBase } from '../http-ops.mjs';
import { language } from '../../../runtime/graph/languages.mjs';
import { ASSIGN_SYNTAX, MARKER_SYNTAX, PARENT_SYNTAX, accessCandidates, mapEntities, ormAttrs, ormLanguages, pluralize, snake } from '../orm-maps.mjs';
import { scanRouteGroups } from './route-groups.mjs';

const genericFramework = (lang) => language(lang)?.genericFramework ?? {};

/** Normalise a route to the repository convention: leading slash, `:id` params, no trailing slash. */
export function normPath(p) {
  let s = `/${p ?? ''}`.replace(/\/+/g, '/');
  s = s.replace(/\{(\*?)([A-Za-z_]\w*)(?::[^}]*)?\??\}/g, ':$1$2');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

function joinPath(...parts) {
  return normPath(parts.filter((p) => p != null && p !== '').map((p) => String(p).trim()).join('/'));
}

export { pluralize, snake };

function real(lx, off) {
  let k = off;
  while (lx.plain[k] === ' ' || lx.plain[k] === '\t') k++;
  return lx.code[k] === lx.plain[k];
}

/** All matches of `re` over plain text whose first character is genuine code. */
function codeMatches(lx, re) {
  const out = [];
  for (const m of lx.plain.matchAll(re)) if (real(lx, m.index)) out.push(m);
  return out;
}

/** Bind each annotation to the first declaration whose name follows it. */
function bindAnnotations(lx, an, anns) {
  const decls = [
    ...an.types.map((t) => ({ nameOff: t.nameOff, type: t })),
    ...an.funcs.map((f) => ({ nameOff: f.nameOff, func: f })),
  ].sort((a, b) => a.nameOff - b.nameOff);
  for (const a of anns) {
    let lo = 0;
    let hi = decls.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (decls[mid].nameOff <= a.off) lo = mid + 1; else hi = mid;
    }
    const d = decls[lo];
    a.target = d && !lx.code.slice(a.off, d.nameOff).includes(';') ? d : null;
  }
  return anns;
}

/** A route below the prefix of the group it is registered on (`g` is that group's resolution, null for the app itself). */
function underGroup(g, route) {
  return { path: normPath(g?.prefix ? `${g.prefix}/${route}` : route), group: g };
}

function minimalApis(lx, endpoints, rg) {
  for (const m of codeMatches(lx, /\.Map(Get|Post|Put|Delete|Patch)\(\s*"([^"\n]*)"/g)) {
    endpoints.push({ method: m[1].toUpperCase(), ...underGroup(rg.at(m.index), m[2]), line: lx.lineOf(m.index), handler: null, framework: 'router' });
  }
}

/** The one HTTP method a handler checks its request against (`r.Method != http.MethodPost`), if it names exactly one. */
function handlerMethod(body) {
  const found = new Set();
  for (const m of String(body ?? '').matchAll(/\.Method\s*[!=]=\s*(?:http\.Method([A-Z][a-z]+)|"([A-Z]+)")/g)) found.add((m[1] ?? m[2]).toUpperCase());
  return found.size === 1 ? [...found][0] : null;
}

function goRoutes(lx, an, endpoints, rg) {
  const re = /(?:\b([A-Za-z_]\w*)|(\)))\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options|Any|Handle|HandleFunc)\(\s*"([^"\n]*)"\s*(?:,\s*([\w.]+)\s*[,)])?/g;
  const byName = new Map();
  for (const f of an.funcs) byName.set(f.name, byName.has(f.name) ? null : f);
  for (const m of codeMatches(lx, re)) {
    let [, recv, , verb, p, handler] = m;
    const group = rg.at(m.index + m[0].indexOf('.'));
    if (!recv && !group) continue; // a call chain that is no group's: a client, not a router
    let method = verb.toUpperCase();
    if (method === 'HANDLE' || method === 'HANDLEFUNC' || method === 'ANY') method = 'ANY';
    const withMethod = /^([A-Z]+)\s+(\/.*)$/.exec(p);
    if (withMethod) { method = withMethod[1]; p = withMethod[2]; }
    if (!p.startsWith('/') || (recv === 'http' && /^(?:Get|Post|Head)$/.test(verb))) continue;
    const fn = byName.get(handler?.split('.').pop()) ?? null;
    if (method === 'ANY' && fn) method = handlerMethod(fn.body) ?? method;
    endpoints.push({ method, ...underGroup(group, p), line: lx.lineOf(m.index), handler: fn, framework: 'router' });
  }
}

function rustRoutes(lx, an, endpoints) {
  const byName = new Map();
  for (const f of an.funcs) byName.set(f.name, byName.has(f.name) ? null : f);
  for (const m of codeMatches(lx, /#\[\s*(get|post|put|delete|patch|head)\s*\(\s*"([^"]*)"/g)) {
    const next = an.funcs.filter((f) => f.nameOff > m.index).sort((a, b) => a.nameOff - b.nameOff)[0] ?? null;
    endpoints.push({ method: m[1].toUpperCase(), path: normPath(m[2]), line: lx.lineOf(m.index), handler: next, framework: 'rust-attr' });
  }
  for (const m of codeMatches(lx, /\.route\(\s*"([^"]*)"\s*,/g)) {
    const open = lx.plain.indexOf('(', m.index);
    const close = open >= 0 ? an.pm[open] : -1;
    if (close < 0) continue;
    const chunk = lx.plain.slice(m.index + m[0].length, close);
    const viaTo = /\.to\(\s*([\w:]+)/.exec(chunk)?.[1];
    for (const v of chunk.matchAll(/\b(get|post|put|delete|patch|head|options)\s*\(\s*([\w:]+)?/g)) {
      const h = (v[2] ?? viaTo)?.split('::').pop();
      endpoints.push({ method: v[1].toUpperCase(), path: normPath(m[1]), line: lx.lineOf(m.index), handler: byName.get(h) ?? null, framework: 'rust-route' });
    }
  }
}

const REST = [
  ['index', 'GET', ''], ['create', 'POST', ''], ['new', 'GET', '/new'], ['show', 'GET', '/:id'],
  ['edit', 'GET', '/:id/edit'], ['update', 'PATCH', '/:id'], ['destroy', 'DELETE', '/:id'],
];

function railsRoutes(lx, endpoints) {
  const lines = lx.plain.split('\n');
  const stack = [''];
  for (let li = 0; li < lines.length; li++) {
    const t = lines[li].trim();
    if (!t) continue;
    const line = li + 1;
    const top = stack[stack.length - 1];
    if (/^end\b/.test(t)) { if (stack.length > 1) stack.pop(); continue; }
    const hasDo = /\bdo\b(?:\s*\|[^|]*\|)?\s*$/.test(t);
    let m = /^(?:namespace|scope)\s+(?::(\w+)|['"]([^'"]+)['"]|path:\s*['"]([^'"]+)['"])/.exec(t);
    if (m) {
      if (hasDo) stack.push(joinPath(top, m[1] ?? m[2] ?? m[3]));
      continue;
    }
    m = /^(resources?)\s+:(\w+)(.*)$/.exec(t);
    if (m) {
      const name = m[2];
      const base = joinPath(top, name);
      const plural = m[1] === 'resources';
      const opt = /\b(only|except):\s*(\[[^\]]*\]|:\w+)/.exec(m[3]);
      const listed = opt ? [...opt[2].matchAll(/\w+/g)].map((x) => x[0]) : null;
      for (const [action, method, suffix] of REST) {
        if (opt && (opt[1] === 'only') !== listed.includes(action)) continue;
        if (!plural && (action === 'index')) continue;
        const sfx = plural ? suffix : suffix.replace('/:id', '');
        endpoints.push({ method, path: normPath(base + sfx), line, handler: null, framework: 'rails', action });
      }
      if (hasDo) stack.push(joinPath(top, name, `:${name.replace(/ies$/, 'y').replace(/s$/, '')}_id`));
      continue;
    }
    m = /^(get|post|put|patch|delete|match)\s+(?::(\w+)|['"]([^'"]+)['"])/.exec(t);
    if (m) {
      endpoints.push({ method: m[1] === 'match' ? 'ANY' : m[1].toUpperCase(), path: joinPath(top, m[3] ?? m[2]), line, handler: null, framework: 'rails' });
      continue;
    }
    if (hasDo || /^(?:if|unless|case|begin|while|until|for)\b/.test(t)) stack.push(top);
  }
}

function laravelRoutes(lx, endpoints) {
  for (const m of codeMatches(lx, /Route::(get|post|put|patch|delete|any|options)\(\s*(['"])([^'"]*)\2/g)) {
    endpoints.push({ method: m[1] === 'any' ? 'ANY' : m[1].toUpperCase(), path: normPath(m[3]), line: lx.lineOf(m.index), handler: null, framework: 'laravel' });
  }
  for (const m of codeMatches(lx, /Route::(resource|apiResource)\(\s*(['"])([^'"]*)\2/g)) {
    const name = m[3].split('.').pop();
    const base = normPath(m[3]);
    const param = `:${name.replace(/ies$/, 'y').replace(/s$/, '')}`;
    const rows = [['GET', ''], ['POST', ''], ['GET', `/${param}`], ['PUT', `/${param}`], ['DELETE', `/${param}`]];
    if (m[1] === 'resource') rows.splice(1, 0, ['GET', '/create']), rows.push(['GET', `/${param}/edit`]);
    for (const [method, sfx] of rows) endpoints.push({ method, path: normPath(base + sfx), line: lx.lineOf(m.index), handler: null, framework: 'laravel' });
  }
}

function sinatraRoutes(lx, endpoints) {
  for (const m of codeMatches(lx, /^[ \t]*(get|post|put|delete|patch)\s+(['"])(\/[^'"\n]*)\2[^\n]*?(?:\bdo\b|\{)/gm)) {
    const off = m.index + m[0].search(/\S/);
    endpoints.push({ method: m[1].toUpperCase(), path: normPath(m[3]), line: lx.lineOf(off), handler: null, framework: 'sinatra' });
  }
}

const SQL_RE = /^\s*(?:SELECT\s+(?:[\s\S]*?\bFROM\b|\d+|\*)|INSERT\s+INTO\b|UPDATE\s+\S+[\s\S]*?\bSET\b|DELETE\s+FROM\b|WITH\s+\S+[\s\S]*?\bAS\s*\(|CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|SEQUENCE|FUNCTION|TRIGGER|EXTENSION|TYPE|SCHEMA)\b|ALTER\s+TABLE\b)/i;

function sqlLiterals(lx) {
  const out = [];
  for (const l of lx.literals) {
    if (l.kind === 'backtick' && l.value.length < 8) continue;
    if (l.value.length < 8 || !SQL_RE.test(l.value)) continue;
    out.push({ text: l.value.trim().replace(/\s+/g, ' ').slice(0, 500), line: l.line });
    if (out.length >= 200) break;
  }
  return out;
}

const SQL_CALL = /\b(?:Query|QueryRow|QueryContext|Exec|ExecContext|executeQuery|executeUpdate|execute|prepareStatement|createQuery|createNativeQuery|ExecuteSqlRaw|ExecuteSqlRawAsync|FromSqlRaw|SqlQuery|query|mysqli_query|raw|find_by_sql|exec_query)\s*\(\s*(?:fmt\.Sprintf\(|String\.format\(|[Ss]tring\.Format\(|\$@?"|f"|"[^"\n]*(?:#\{|\$[A-Za-z_])|"(?:[^"\\\n]|\\.)*"\s*(?:\+|\.\s*\$))/g;

function securitySignals(lx, lang) {
  const out = [];
  const add = (kind, off) => out.push({ kind, line: lx.lineOf(off) });
  const scan = (re, kind) => codeMatches(lx, re).forEach((m) => add(kind, m.index));
  const security = genericFramework(lang).security ?? {};
  for (const rule of security.patterns ?? []) scan(rule.pattern, rule.kind);
  if (security.backtickCommand) for (const l of lx.literals) if (l.kind === 'backtick') add('command_exec', l.start);
  if (security.sqlInjectionInput) {
    for (const m of lx.plain.matchAll(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*\$_(?:GET|POST|REQUEST|COOKIE)/gi)) add('sql_injection_input', m.index);
  }
  scan(SQL_CALL, 'sql_string_building');
  const seen = new Set();
  return out
    .sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
    .filter((s) => {
      const k = `${s.kind}:${s.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 100);
}

function typeAt(an, off) {
  let best = null;
  for (const t of an.types) if (t.start <= off && off <= t.end && (!best || t.start >= best.start)) best = t;
  return best;
}

/**
 * What the generic structure says about each type, in the shape the one ORM rule reads
 * (adapters/language/orm-maps.mjs): its markers, its class-level assignments and its parents.
 */
function ormView(lx, an, lang, path) {
  const style = MARKER_SYNTAX[lang] ?? genericFramework(lang).markers?.style;
  const types = an.types.map((t) => ({
    name: t.name, ref: t, kind: null, line: t.startLine ?? lx.lineOf(t.start),
    bases: [...t.extends, ...t.implements, ...t.bases], markers: [], assigns: {}, embeds: [],
  }));
  const owner = new Map(types.map((v) => [v.ref, v]));
  if (style) {
    const all = markersOf(lx, an, lang, style);
    const skip = nested(lx, all.map((m) => m.off));
    const anns = bindAnnotations(lx, an, all.filter((m) => !skip.has(m.off)).map((m) => ({ ...m, target: null })));
    for (const a of anns) {
      const v = a.target?.type ? owner.get(a.target.type) : null;
      if (v) v.markers.push({ name: a.name.split(/[\\.]/).pop(), args: a.args, line: a.line });
    }
  }
  const parent = PARENT_SYNTAX[lang];
  if (parent) {
    for (const v of types) {
      const p = parent.exec(lx.code.slice(v.ref.start, v.ref.start + 200));
      if (p) v.bases = [p[1]];
    }
  }
  const assign = ASSIGN_SYNTAX[lang];
  if (assign) {
    for (const m of codeMatches(lx, assign.re)) {
      const v = owner.get(typeAt(an, m.index));
      if (v && !v.assigns[assign.key(m)]) v.assigns[assign.key(m)] = { value: m[3], line: lx.lineOf(m.index) };
    }
  }
  return {
    lang, path, imports: [], text: lx.plain, lineOf: (off) => lx.lineOf(off), matches: (re) => codeMatches(lx, re), types,
  };
}

/**
 * ORM mappings in one file: the entity-to-table facts from the shared rule, and the link-only
 * attributes that let link() resolve access through the mapped types from other files.
 * `tables` keeps one entry per table name, as the facts do.
 */
function ormTables(lx, an, lang, path) {
  if (!ormLanguages(lang)) return { tables: [], links: {} };
  const view = ormView(lx, an, lang, path);
  const { mappings, members } = mapEntities(view);
  const tables = [];
  for (const m of mappings) {
    if (tables.some((t) => t.name === m.table)) continue;
    tables.push({
      name: m.table, line: m.line, confidence: m.basis === 'declared' ? 'medium' : 'low', orm: m.orm, basis: m.basis,
      ...(m.deferred && { entity: m.entity }),
    });
  }
  const entities = mappings.map((m) => ({ n: m.entity.split(/::|\./).pop(), t: `public.${m.table}`, o: m.orm }));
  const exposed = members.map((m) => ({ n: m.member, e: m.entity }));
  return { tables, links: ormAttrs(entities, exposed, accessCandidates(lx.plain, lang, (off) => lx.lineOf(off))) };
}

// ---- attribute and annotation operations (one rule, per-language table in ../http-ops.mjs) ----

const TYPE_DECL = /^\s*(?:[a-z]+\s+)*?(class|interface|struct|record|object)\s+([A-Za-z_]\w*)/;
const MEMBER_DECL = /^[^;{(]*?([A-Za-z_]\w*)\s*(?:<[^(){};]*>)?\s*\(/d;

/** Every attribute or annotation in the file, in order: `[Name(args)]` or `@Name(args)`, args as raw text. */
function markersOf(lx, an, lang, style = genericFramework(lang).markers?.style) {
  const out = [];
  const take = (name, nameEnd, off) => {
    let end = nameEnd;
    while (lx.plain[end] === ' ' || lx.plain[end] === '\t') end++;
    let args = null;
    if (lx.plain[end] === '(' && an.pm[end] >= 0) {
      args = lx.plain.slice(end + 1, an.pm[end]);
      end = an.pm[end] + 1;
    }
    out.push({ name, args: parseArgs(args), off, end, line: lx.lineOf(off) });
    return end;
  };
  if (style === 'bracket' || style === 'hash') {
    const hash = style === 'hash';
    for (const m of codeMatches(lx, hash ? /#\[\s*([A-Za-z_\\][\w.\\]*)/g : /\[\s*([A-Za-z_][\w.]*)/g)) {
      let before = m.index - 1;
      while (before >= 0 && /\s/.test(lx.plain[before])) before--;
      if (!hash && before >= 0 && /[\w)]/.test(lx.plain[before])) continue; // an indexer, not an attribute list
      const first = out.length;
      let end = take(m[1], m.index + m[0].length, m.index);
      for (;;) { // `[A, B(x)]`
        const more = /^\s*,\s*([A-Za-z_\\][\w.\\]*)/.exec(lx.plain.slice(end, end + 200));
        if (!more) break;
        end = take(more[1], end + more[0].length, end + more[0].indexOf(more[1]));
      }
      const close = lx.plain.indexOf(']', end);
      if (close >= 0) out[out.length - 1].end = close + 1;
      else out.length = first;
    }
  } else {
    for (const m of codeMatches(lx, /@([A-Za-z_][\w.]*)/g)) {
      if (m[1] === 'interface') continue;
      take(m[1], m.index + m[0].length, m.index);
    }
  }
  return out;
}

/** Offsets that sit inside parentheses: parameter markers and nested argument markers are not a declaration's own. */
function nested(lx, offsets) {
  const want = new Set(offsets);
  const inside = new Set();
  let depth = 0;
  for (let i = 0; i < lx.code.length; i++) {
    const c = lx.code[i];
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    else if (depth > 0 && want.has(i)) inside.add(i);
  }
  return inside;
}

/** The declaration after offset `from`: a type, or a member with its name and `(`. */
function declarationAfter(lx, from, lang) {
  const rest = lx.plain.slice(from, from + 700);
  const t = TYPE_DECL.exec(rest);
  if (t) return { type: t[2] };
  const m = MEMBER_DECL.exec(rest) ?? genericFramework(lang).markers?.functionPattern?.exec(rest);
  if (!m) return null;
  const nameOff = from + m.indices[1][0];
  return { name: m[1], nameOff, open: lx.plain.indexOf('(', nameOff), head: rest.slice(0, m.indices[1][0]) };
}

/**
 * Endpoints and clients declared by attributes and annotations. A run of markers right before a
 * type gives it a base path; a run before a method makes the method an operation. In an
 * interface, an abstract type or on a method without a body the operation is a client's;
 * anywhere else it is an endpoint of the handler that follows.
 */
function markedOperations(lx, an, lang, endpoints, clients) {
  const markerSyntax = genericFramework(lang).markers;
  if (!markerSyntax) return;
  const kind = markerSyntax.kind;
  const all = markersOf(lx, an, lang);
  const skip = nested(lx, all.map((m) => m.off));
  const runs = [];
  for (const m of all) {
    if (skip.has(m.off)) continue;
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && m.off >= prev.end && /^\s*$/.test(lx.plain.slice(prev.end, m.off))) last.push(m);
    else runs.push([m]);
  }
  const typeRuns = new Map();
  const methodRuns = [];
  for (const run of runs) {
    const from = run[run.length - 1].end;
    const decl = declarationAfter(lx, from, lang);
    if (!decl) continue;
    if (decl.type) {
      const t = an.types.find((x) => x.name === decl.type && x.nameOff >= from && x.nameOff - from < 400);
      if (t) typeRuns.set(t, run);
    } else methodRuns.push({ run, decl });
  }
  const byType = new Map();
  for (const { run, decl } of methodRuns) {
    const t = typeAt(an, run[0].off);
    if (!t) continue;
    const abstract = /\babstract\b/.test(lx.code.slice(lx.lineStartOf(t.start), t.start));
    const afterParams = lx.plain.slice(an.pm[decl.open] + 1, an.pm[decl.open] + 600);
    const bodiless = /^[^;{=]*;/.test(afterParams) || /\babstract\b/.test(decl.head);
    const client = t.kind === 'interface' || (abstract && bodiless);
    const names = { controller: t.name.replace(/Controller$/, '').toLowerCase(), action: decl.name.toLowerCase() };
    const ops = operations(lang, run, { base: typeBase(lang, typeRuns.get(t) ?? []), client, norm: normPath, names });
    if (!ops.length) continue;
    const line = run[0].line;
    if (client) {
      if (!byType.has(t)) byType.set(t, []);
      for (const o of ops) byType.get(t).push({ ...o, path: clientPath(o.path, normPath), name: decl.name, line });
    } else {
      const handler = an.funcs.find((f) => f.nameOff === decl.nameOff) ?? null;
      for (const o of ops) endpoints.push({ method: o.method, path: o.path, line, handler, framework: kind });
    }
  }
  for (const [t, ops] of byType) clients.push({ type: t, framework: kind, ops });
}

/**
 * Collect framework facts for one analysed file.
 * @returns {{ endpoints: object[], clients: object[], tables: object[], sql: object[], signals: object[] }}
 */
export function frameworkInfo(lx, an, lang, path) {
  const endpoints = [];
  const clients = [];
  const framework = genericFramework(lang);
  markedOperations(lx, an, lang, endpoints, clients);
  const rg = framework.routeGroups ? scanRouteGroups(lx, an, lang) : null;
  if (framework.routes === 'minimal_api') minimalApis(lx, endpoints, rg);
  else if (framework.routes === 'router') goRoutes(lx, an, endpoints, rg);
  else if (framework.routes === 'attributes') rustRoutes(lx, an, endpoints);
  else if (framework.routes === 'laravel') laravelRoutes(lx, endpoints);
  else if (framework.routes === 'end_routes') {
    if (/(?:^|\/)config\/routes\.rb$/.test(path)) railsRoutes(lx, endpoints);
    else sinatraRoutes(lx, endpoints);
  }
  const orm = ormTables(lx, an, lang, path);
  return { endpoints, clients, tables: orm.tables, ormLinks: orm.links, sql: sqlLiterals(lx), signals: securitySignals(lx, lang), routeLinks: rg?.moduleAttrs() ?? {} };
}
