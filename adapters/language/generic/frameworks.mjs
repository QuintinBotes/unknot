// Framework-aware heuristics layered over the lexical structure: HTTP endpoints, raw SQL,
// ORM table hints and security signals. Every result here is a guess from naming and
// annotation conventions, so callers label it `inference` with medium or low confidence.
// Regexes run on `lx.plain` (comments gone, strings intact) and are filtered through
// `lx.code` so a match whose first character sits inside a string literal is discarded.

const FIRST_STRING = /"((?:[^"\\\n]|\\.)*)"/;

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

export function snake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

export function pluralize(s) {
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

function pathArg(args) {
  if (args == null) return '';
  const named = /\b(?:value|path|name)\s*=\s*[[{]?\s*@?"([^"]*)"/.exec(args);
  if (named) return named[1];
  const first = /^\s*[[{]?\s*@?"([^"]*)"/.exec(args);
  return first ? first[1] : '';
}

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

const JAVA_ANN = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping|Path|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Entity|Table)\b(?:\s*\(((?:"(?:[^"\\\n]|\\.)*"|[^)"])*)\))?/g;
const CS_ATTR = /\[\s*(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route|Table)\b(?:\s*\(((?:@?"(?:[^"\\\n]|\\.)*"|[^)"])*)\))?/g;
const SPRING_VERB = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };

function annotated(lx, an, re) {
  return bindAnnotations(lx, an, codeMatches(lx, re).map((m) => ({ name: m[1], args: m[2], off: m.index, line: lx.lineOf(m.index), target: null })));
}

function springOrJaxrs(lx, an, endpoints) {
  const anns = annotated(lx, an, JAVA_ANN);
  const prefix = new Map();
  for (const a of anns) {
    if ((a.name === 'RequestMapping' || a.name === 'Path') && a.target?.type) prefix.set(a.target.type.name, pathArg(a.args));
  }
  const byFunc = new Map();
  for (const a of anns) {
    if (!a.target?.func) continue;
    if (!byFunc.has(a.target.func)) byFunc.set(a.target.func, []);
    byFunc.get(a.target.func).push(a);
  }
  for (const [f, list] of byFunc) {
    const pre = prefix.get(f.owner) ?? '';
    const pathAnn = list.find((a) => a.name === 'Path');
    for (const a of list) {
      let method = null;
      let sub = '';
      let framework = 'spring';
      if (SPRING_VERB[a.name]) { method = SPRING_VERB[a.name]; sub = pathArg(a.args); }
      else if (a.name === 'RequestMapping') {
        method = /RequestMethod\.(\w+)/.exec(a.args ?? '')?.[1] ?? 'ANY';
        sub = pathArg(a.args);
      } else if (/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(a.name)) {
        method = a.name;
        sub = pathAnn ? pathArg(pathAnn.args) : '';
        framework = 'jaxrs';
      }
      if (method) endpoints.push({ method, path: joinPath(pre, sub), line: a.line, handler: f, framework });
    }
  }
}

function aspnet(lx, an, endpoints) {
  const anns = annotated(lx, an, CS_ATTR);
  const routeOf = new Map();
  for (const a of anns) if (a.name === 'Route' && a.target?.type) routeOf.set(a.target.type.name, pathArg(a.args));
  for (const a of anns) {
    const f = a.target?.func;
    if (!f || !a.name.startsWith('Http')) continue;
    const method = a.name.slice(4).toUpperCase();
    const own = pathArg(a.args);
    const ctrl = (f.owner ?? '').replace(/Controller$/, '').toLowerCase();
    const fill = (s) => s.replace(/\[controller\]/gi, ctrl).replace(/\[action\]/gi, f.name.toLowerCase());
    const methodRoute = anns.find((b) => b.name === 'Route' && b.target?.func === f);
    const route = own || (methodRoute ? pathArg(methodRoute.args) : '');
    const full = route.startsWith('/') || route.startsWith('~/')
      ? fill(route.replace(/^~/, ''))
      : joinPath(fill(routeOf.get(f.owner) ?? ''), fill(route));
    endpoints.push({ method, path: normPath(full), line: a.line, handler: f, framework: 'aspnet' });
  }
  for (const m of codeMatches(lx, /\.Map(Get|Post|Put|Delete|Patch)\(\s*"([^"\n]*)"/g)) {
    endpoints.push({ method: m[1].toUpperCase(), path: normPath(m[2]), line: lx.lineOf(m.index), handler: null, framework: 'aspnet-minimal' });
  }
}

function goRoutes(lx, an, endpoints) {
  const re = /\b([A-Za-z_]\w*)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options|Any|Handle|HandleFunc)\(\s*"([^"\n]*)"\s*(?:,\s*([\w.]+)\s*[,)])?/g;
  const byName = new Map();
  for (const f of an.funcs) byName.set(f.name, byName.has(f.name) ? null : f);
  for (const m of codeMatches(lx, re)) {
    let [, recv, verb, p, handler] = m;
    let method = verb.toUpperCase();
    if (method === 'HANDLE' || method === 'HANDLEFUNC' || method === 'ANY') method = 'ANY';
    const withMethod = /^([A-Z]+)\s+(\/.*)$/.exec(p);
    if (withMethod) { method = withMethod[1]; p = withMethod[2]; }
    if (!p.startsWith('/') || (recv === 'http' && /^(?:Get|Post|Head)$/.test(verb))) continue;
    endpoints.push({ method, path: normPath(p), line: lx.lineOf(m.index), handler: byName.get(handler?.split('.').pop()) ?? null, framework: 'go-http' });
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
  switch (lang) {
    case 'go': scan(/\bexec\.Command(?:Context)?\(\s*(?:[\w.]+\s*,\s*)?"(?:sh|bash|zsh|cmd(?:\.exe)?)"\s*,\s*"(?:-c|\/c)"/g, 'command_exec'); break;
    case 'java':
      scan(/\bRuntime\.getRuntime\(\)\s*\.exec\(/g, 'command_exec');
      scan(/\bnew\s+ProcessBuilder\(\s*"(?:sh|bash|cmd)"/g, 'command_exec');
      break;
    case 'csharp': scan(/\bProcess\.Start\((?=[^;]*(?:\+|\$"|[Ss]tring\.Format))/g, 'command_exec'); break;
    case 'ruby':
      scan(/(?<![\w.:@$])(?:system|exec|spawn|popen3?)\b\s*[("'\w]/g, 'command_exec');
      scan(/(?<![\w.:@$])(?:eval|instance_eval|class_eval)\b\s*[("'\w]/g, 'code_eval');
      scan(/%x[({[]/g, 'command_exec');
      for (const l of lx.literals) if (l.kind === 'backtick') add('command_exec', l.start);
      break;
    case 'php':
      scan(/(?<![\w$>:])eval\s*\(/g, 'code_eval');
      scan(/(?<![\w$>:])(?:shell_exec|system|exec|passthru|popen|proc_open)\s*\(/g, 'command_exec');
      for (const l of lx.literals) if (l.kind === 'backtick') add('command_exec', l.start);
      for (const m of lx.plain.matchAll(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*\$_(?:GET|POST|REQUEST|COOKIE)/gi)) add('sql_injection_input', m.index);
      break;
    case 'rust': scan(/\bCommand::new\(\s*"(?:sh|bash|cmd(?:\.exe)?)"\s*\)/g, 'command_exec'); break;
    default:
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

/** ORM table hints. `confidence` is 'low' wherever the table name is a naming-convention guess. */
function ormTables(lx, an, lang) {
  const out = [];
  const add = (name, line, confidence, orm) => {
    if (name && !out.some((t) => t.name === name)) out.push({ name, line, confidence, orm });
  };
  if (lang === 'java' || lang === 'kotlin') {
    const anns = annotated(lx, an, JAVA_ANN);
    for (const a of anns) {
      if (a.name !== 'Entity' || !a.target?.type) continue;
      const tbl = anns.find((b) => b.name === 'Table' && b.target?.type === a.target.type);
      const explicit = tbl ? /\bname\s*=\s*"([^"]*)"/.exec(tbl.args ?? '')?.[1] : null;
      if (explicit) add(explicit, a.line, 'medium', 'jpa');
      else add(snake(a.target.type.name), a.line, 'low', 'jpa');
    }
  } else if (lang === 'csharp') {
    const anns = annotated(lx, an, CS_ATTR);
    const explicit = new Map();
    for (const a of anns) {
      if (a.name !== 'Table' || !a.target?.type) continue;
      const name = /^\s*@?"([^"]*)"/.exec(a.args ?? '')?.[1];
      if (name) { explicit.set(a.target.type.name, name); add(name, a.line, 'medium', 'efcore'); }
    }
    for (const m of codeMatches(lx, /\bDbSet<\s*([\w.]+)\s*>\s+(\w+)/g)) {
      const cls = m[1].split('.').pop();
      if (explicit.has(cls)) continue;
      add(snake(m[2]), lx.lineOf(m.index), 'low', 'efcore');
    }
  } else if (lang === 'ruby') {
    const explicit = [...codeMatches(lx, /\bself\.table_name\s*=\s*(['"])([^'"]+)\1/g)];
    for (const t of an.types) {
      const head = lx.code.slice(t.start, t.start + 200);
      if (!/^class\s+[\w:]+\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/.test(head)) continue;
      const own = explicit.find((m) => typeAt(an, m.index) === t);
      if (own) add(own[2], lx.lineOf(own.index), 'medium', 'activerecord');
      else add(pluralize(snake(t.name.split('::').pop())), t.startLine ?? lx.lineOf(t.start), 'low', 'activerecord');
    }
  } else if (lang === 'php') {
    const explicit = [...codeMatches(lx, /\bprotected\s+\$table\s*=\s*(['"])([^'"]+)\1/g)];
    for (const t of an.types) {
      if (!t.extends.includes('Model')) continue;
      const own = explicit.find((m) => typeAt(an, m.index) === t);
      if (own) add(own[2], lx.lineOf(own.index), 'medium', 'eloquent');
      else add(pluralize(snake(t.name)), lx.lineOf(t.start), 'low', 'eloquent');
    }
  }
  return out;
}

/**
 * Collect framework facts for one analysed file.
 * @returns {{ endpoints: object[], tables: object[], sql: object[], signals: object[] }}
 */
export function frameworkInfo(lx, an, lang, path) {
  const endpoints = [];
  if (lang === 'java' || lang === 'kotlin') springOrJaxrs(lx, an, endpoints);
  else if (lang === 'csharp') aspnet(lx, an, endpoints);
  else if (lang === 'go') goRoutes(lx, an, endpoints);
  else if (lang === 'rust') rustRoutes(lx, an, endpoints);
  else if (lang === 'php') laravelRoutes(lx, endpoints);
  else if (lang === 'ruby') {
    if (/(?:^|\/)config\/routes\.rb$/.test(path)) railsRoutes(lx, endpoints);
    else sinatraRoutes(lx, endpoints);
  }
  return { endpoints, tables: ormTables(lx, an, lang), sql: sqlLiterals(lx), signals: securitySignals(lx, lang) };
}
