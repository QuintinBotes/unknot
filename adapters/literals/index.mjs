// Literals adapter: identifier-like string constants (metric names, configuration keys, routes,
// roles, queue names) as graph nodes, for every language and config format with one lexical
// scan. A runbook or alert is mostly such strings; without nodes none of its claims can be
// checked. `extract` reads one file and records where a string is defined (a constant, a
// config key) or used; `link` makes the constant nodes, infers each one's sub-kind from where
// it appears (labelled inferred), and applies the per-repository cap; `discover` adds the uses
// that go through the constant's name. Prose, log messages and format strings are never indexed.

import { edgeFact, nodeFact, prov } from '../../runtime/graph/facts.mjs';
import { parseYAML } from '../../runtime/core/yaml.mjs';
import { definitionOn } from '../../runtime/graph/search.mjs';

const VERSION = '0.1.5';
const EXTRACTOR = `literals@${VERSION}`;
const MAX_PER_FILE = 200; // distinct strings per file
const MAX_PER_REPO = 20000; // constant nodes per repository
const MAX_SITES = 5; // recorded lines per string per file
const MAX_TEXT = 512 * 1024;
const MAX_LINE = 2000;
const MIN_NAME = 6; // shortest constant name followed to its uses
const MAX_USERS = 200; // a name used by more modules than this is too generic to follow

export const SUBKINDS = Object.freeze(['metric', 'config_key', 'route', 'role', 'queue', 'other']);

const EXTS = 'cs,cshtml,razor,js,mjs,cjs,jsx,ts,mts,cts,tsx,py,go,java,kt,kts,rs,rb,php,scala,swift,c,cc,cpp,h,hpp,json,yaml,yml,toml,ini,properties,env,config';
const EXT_RE = new RegExp(`\\.(?:${EXTS.replace(/,/g, '|')})$`);
const SINGLE_QUOTE = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'rb', 'php', 'json', 'yaml', 'yml', 'toml', 'ini', 'properties', 'env', 'config']);
const NOT_CONFIG = /^\.(?:github|circleci|gitlab|buildkite)\/|(?:^|\/)(?:azure-pipelines\.ya?ml|package(?:-lock)?\.json|composer\.(?:json|lock)|tsconfig[^/]*\.json|jsconfig\.json|global\.json|nuget\.config|\.eslintrc[^/]*|[^/]*\.min\.js|[^/]*\.d\.ts)$/;
const FILE_LIKE = /\.(?:json|xml|ya?ml|cs|js|ts|css|html?|png|jpe?g|gif|svg|txt|md|dll|exe|config|csproj|sln|cshtml|resx|zip|pdf|log|sql)$/i;
const MIME = /^(?:application|text|image|audio|video|multipart|font)\//;
const ROUTE_PARAM = /\{\*?[A-Za-z_][\w:?=.,()*\\-]*\}/g;
const MARKUP = new Set(['cshtml', 'razor']);
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#|--|<!--|;)/;

const extOf = (path) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');
const prov_ = (path, line, confidence = 'medium', source_type = 'ast') => prov({ source_type, source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });

/** Identifier-like: no spaces, 3 to 120 characters, a separator or a route shape; never prose, a URL, a file name or a format string. */
export function isIdentifierLike(s) {
  if (s.length < 3 || s.length > 120 || /\s/.test(s)) return false;
  const route = s.replace(ROUTE_PARAM, '');
  if (/[{}%$<>"'`\\|;,()[\]#!^&]/.test(route)) return false;
  if (!/^[A-Za-z0-9_/]/.test(s) || !/[A-Za-z]/.test(route) || !/[./:_-]/.test(route)) return false;
  if (/[./:_-]$/.test(s) && !s.endsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || MIME.test(s) || FILE_LIKE.test(s)) return false;
  if (/[A-Za-z0-9_-]{24,}/.test(s) && [...s.matchAll(/[A-Za-z0-9_-]{24,}/g)].some(([t]) => /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t))) return false; // a key or token, not a name
  if (/^\d[\d.:/_-]*$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[0-9a-f]{32,}$/i.test(s)) return false;
  return true;
}

const RE = {
  role: /\[\s*Authorize|\bAuthorize\(|IsInRole|HasPermission|HasRole|RequireRole|RequireClaim|RequirePermission|AddPolicy|RequireAuthorization|hasRole|hasAuthority|PreAuthorize|RolesAllowed|has_permission|checkPermission|\bRoles?\s*=/,
  route: /\[\s*(?:Http\w+|Route)\b|\bMap(?:Get|Post|Put|Delete|Patch|Methods|Route|Controller\w*Route)\b|\b(?:app|router|routes?|api|server|bp|blueprint)\.(?:get|post|put|delete|patch|route|all|use)\(|@\w*(?:Get|Post|Put|Delete|Patch|Request)Mapping|\bRouteLink\(|\bUrlHelper\b/,
  metric: /counter|histogram|gauge|metric|statsd|prometheus|\bI?Meter\b|\.(?:Record|Observe|Increment|Timing)\(/i,
  queue: /queue|\.(?:Publish|Subscribe|Enqueue|Dequeue|Consume|SendMessage)\w*\(|\b(?:Publish|Subscribe|Enqueue|Dequeue|Consume)\w*Async\(|TopicName|TopicClient|ServiceBus|RabbitMq|Kafka|\bSqs\b|\bSns\b|routing_?key/i,
  config_key: /IConfiguration|GetSection|GetValue|GetConnectionString|ConfigurationManager|AppSettings\[|Configuration\[|GetEnvironmentVariable|process\.env|os\.environ|getenv|getProperty|@Value\(|GetSetting\w*\(|SettingName|SettingKey|ConfigKey|ConfigName|OptionName/,
};

/** The sub-kind a string's surroundings suggest, with why: a guess, never recorded as fact. */
export function subkindOf(value, line, { fileKind = 'source', flattened = false } = {}) {
  if (flattened || fileKind === 'config') return { subkind: 'config_key', why: flattened ? 'nested key in a configuration file' : 'in a configuration file' };
  if (/^[A-Za-z_][\w-]*(?::[A-Za-z_][\w-]*)+$/.test(value)) return { subkind: 'config_key', why: 'Section:Key shape' };
  if (value.startsWith('/')) return { subkind: 'route', why: 'leading /' };
  if (/\{[^}]+\}/.test(value) && value.includes('/')) return { subkind: 'route', why: 'route parameters' };
  // Only the code around the strings says where one is used: the words inside them (a resource text, this string) say nothing.
  const around = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  for (const k of ['role', 'route', 'metric', 'queue', 'config_key']) {
    const m = RE[k].exec(around);
    if (m) return { subkind: k, why: `line mentions ${m[0].trim().slice(0, 30)}` };
  }
  return { subkind: 'other', why: 'no surrounding context' };
}

/** String literals on a line, skipping interpolated strings and template literals with `${`. */
function literals(line, ext) {
  const out = [];
  const re = /(@?\$?)"((?:[^"\\]|\\.|"")*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[2] !== undefined) {
      if (!m[1].includes('$')) out.push(m[2]);
    } else if (SINGLE_QUOTE.has(ext)) {
      if (m[3] !== undefined) out.push(m[3]);
      else if (!m[4].includes('${')) out.push(m[4]);
    }
  }
  return out;
}

/** Keys of a nested configuration document as `Section:Key`, with the line each is on. */
function flatKeys(path, text, ext) {
  let doc;
  try {
    doc = ext === 'json' ? JSON.parse(text) : parseYAML(text, { filename: path });
  } catch {
    return [];
  }
  const lines = text.split('\n');
  const out = [];
  const walk = (obj, prefix, from) => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || out.length > 2000) return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}:${k}` : k;
      const q = new RegExp(`^\\s*(?:-\\s*)?["']?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:`);
      let at = from;
      while (at < lines.length && !q.test(lines[at])) at++;
      if (at >= lines.length) at = from;
      if (prefix) out.push({ value: key, line: at + 1 });
      walk(v, key, at);
    }
  };
  walk(doc, '', 0);
  return out;
}

/** `key = value` lines of .properties, .ini and .env files. */
function flatLines(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    const m = /^\s*([A-Za-z_][\w.:-]*)\s*[=:]/.exec(l);
    if (m && !COMMENT.test(l)) out.push({ value: m[1], line: i + 1 });
  });
  return out;
}

export default {
  id: 'literals',
  version: VERSION,
  kind: 'language',
  capabilities: { files: [`**/*.{${EXTS}}`], executes: [], network: false },

  extract(file, text, ctx = {}) {
    const path = file.path;
    if (text.length > MAX_TEXT || NOT_CONFIG.test(path) || file.kind === 'doc') return [];
    const ext = extOf(path);
    const max = ctx.options?.max_per_file ?? MAX_PER_FILE;
    const found = new Map(); // value → [{line, form, name, flattened}]
    const add = (value, line, form, name, flattened = false) => {
      const sites = found.get(value) ?? [];
      if (sites.length < MAX_SITES && !sites.some((s) => s.line === line)) sites.push({ line, form, name, flattened });
      found.set(value, sites);
    };
    const flat = ext === 'json' || ext === 'yaml' || ext === 'yml' ? flatKeys(path, text, ext) : ['properties', 'ini', 'env'].includes(ext) ? flatLines(text) : [];
    for (const k of flat) if (isIdentifierLike(k.value)) add(k.value, k.line, 'key', undefined, true);
    const lines = text.split('\n');
    const lineOf = new Map();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.length > MAX_LINE || COMMENT.test(l)) continue;
      for (const s of literals(l, ext)) {
        if (!isIdentifierLike(s) || (MARKUP.has(ext) && !/[./:]/.test(s))) continue; // markup: a hyphenated word is a CSS class
        const d = definitionOn(l, s);
        add(s, i + 1, d?.kind ?? 'use', d?.kind === 'constant' ? d.name : undefined);
        lineOf.set(`${s}\0${i + 1}`, l);
      }
    }
    const facts = [];
    let kept = 0;
    for (const [value, sites] of found) {
      if (kept++ >= max) continue;
      for (const s of sites) {
        const { subkind, why } = subkindOf(value, lineOf.get(`${value}\0${s.line}`) ?? '', { fileKind: file.kind, flattened: s.flattened });
        const attrs = { line: s.line, form: s.form, subkind_hint: subkind, hint_why: why, ...(s.name && { name: s.name }) };
        facts.push(edgeFact(s.form === 'use' ? 'REFERENCES' : 'DEFINES', `module:${path}`, `constant:${value}`, attrs, prov_(path, s.line)));
      }
    }
    if (found.size > max && facts.length) facts[0].attrs = { ...facts[0].attrs, file_capped: found.size - max };
    return facts;
  },

  /** Constant nodes: one per string, sub-kind voted from where it appears, capped per repository. */
  link({ factsByFile, options = {}, notes, stats }) {
    const max = options.max_per_repo ?? MAX_PER_REPO;
    const by = new Map();
    let cappedFiles = 0;
    for (const facts of factsByFile.values()) {
      for (const f of facts) {
        if (f.kind !== 'edge' || (f.type !== 'DEFINES' && f.type !== 'REFERENCES') || !f.to.startsWith('constant:')) continue;
        if (f.attrs.file_capped) cappedFiles++;
        const value = f.to.slice('constant:'.length);
        let c = by.get(value);
        if (!c) by.set(value, (c = { value, defs: 0, uses: 0, votes: {}, evidence: {} }));
        f.type === 'DEFINES' ? c.defs++ : c.uses++;
        const k = f.attrs.subkind_hint;
        if (k && k !== 'other') {
          c.votes[k] = (c.votes[k] ?? 0) + 1;
          c.evidence[k] ??= `${f.provenance.source_ref}: ${f.attrs.hint_why}`;
        }
      }
    }
    const ranked = [...by.values()].sort((a, b) => (b.defs > 0) - (a.defs > 0) || b.defs + b.uses - (a.defs + a.uses) || (a.value < b.value ? -1 : 1));
    const keep = ranked.slice(0, max);
    const out = keep.map((c) => {
      const order = SUBKINDS.filter((k) => c.votes[k]).sort((a, b) => c.votes[b] - c.votes[a] || SUBKINDS.indexOf(a) - SUBKINDS.indexOf(b));
      const subkind = order[0] ?? 'other';
      return nodeFact('constant', c.value, {
        name: c.value,
        attrs: {
          value: c.value, subkind, subkind_basis: 'inferred', subkind_evidence: c.evidence[subkind] ?? 'no surrounding context',
          ...(order.length > 1 && { subkind_votes: c.votes }), defined: c.defs > 0,
        },
      }, prov_(c.evidence[subkind]?.split(':')[0] ?? 'repository', 1, 'low', 'inference'));
    });
    const by_subkind = Object.fromEntries(SUBKINDS.map((k) => [k, 0]));
    for (const n of out) by_subkind[n.attrs.subkind]++;
    if (stats) stats.constants = { nodes: out.length, by_subkind, found: ranked.length, dropped_by_repo_cap: ranked.length - keep.length, files_capped: cappedFiles };
    if (notes && ranked.length > keep.length) notes.push(`constants: kept ${keep.length} of ${ranked.length} identifier-like strings (literals.max_per_repo ${max}); defined strings with the most sites were kept and unknot search still scans for the rest`);
    if (notes && cappedFiles) notes.push(`constants: ${cappedFiles} file(s) held more than ${options.max_per_file ?? MAX_PER_FILE} distinct strings; the rest of each were not indexed (literals.max_per_file)`);
    return out;
  },

  /** Uses through a constant's name: `Metrics.CheckoutLatency` in another file is a use of its string. */
  async discover({ census, readText, factsByFile, options = {} }) {
    const names = new Map(); // constant name → ids defined under it
    for (const facts of factsByFile.values()) {
      for (const f of facts) {
        const name = f.attrs?.name;
        if (f.kind !== 'edge' || f.type !== 'DEFINES' || !name || name.length < MIN_NAME || !f.to.startsWith('constant:')) continue;
        if (!/[a-z]/.test(name) && !name.includes('_')) continue;
        names.set(name, (names.get(name) ?? new Set()).add(f.to));
      }
    }
    const unique = new Map([...names].filter(([, v]) => v.size === 1).map(([n, v]) => [n, [...v][0]]));
    if (!unique.size) return [];
    const users = new Map(); // name → [{path, line}]
    const token = /[A-Za-z_$][\w$]*/g;
    for (const f of census) {
      if ((f.kind !== 'source' && f.kind !== 'test') || f.too_large || f.context || !EXT_RE.test(f.path)) continue;
      let text;
      try {
        text = readText(f.path);
      } catch {
        continue;
      }
      if (text.length > MAX_TEXT) continue;
      const own = new Set((factsByFile.get(f.path) ?? []).filter((x) => x.kind === 'edge' && x.type === 'DEFINES').map((x) => x.attrs.name));
      const seen = new Map();
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > MAX_LINE || COMMENT.test(lines[i])) continue;
        let m;
        token.lastIndex = 0;
        while ((m = token.exec(lines[i]))) {
          if (!unique.has(m[0])) continue;
          const s = seen.get(m[0]) ?? { n: 0, line: i + 1 };
          s.n++;
          seen.set(m[0], s);
        }
      }
      for (const [name, s] of seen) {
        if (own.has(name) && s.n < 2) continue;
        users.set(name, [...(users.get(name) ?? []), { path: f.path, line: s.line }]);
      }
    }
    const out = [];
    for (const [name, list] of users) {
      if (list.length > (options.max_name_users ?? MAX_USERS)) continue;
      for (const u of list) out.push(edgeFact('REFERENCES', `module:${u.path}`, unique.get(name), { line: u.line, form: 'name', via: name, hint_why: 'use through the constant name' }, prov_(u.path, u.line, 'low', 'inference')));
    }
    return out;
  },
};
