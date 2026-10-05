// Module specifier resolution against the repository census. Pure functions over path sets:
// nothing here touches the filesystem, so resolution is deterministic and cacheable.

const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
export const CODE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TS_SWAP = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const CONDITIONS = ['types', 'import', 'module', 'default', 'require', 'node', 'browser'];

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'test',
]);

/** POSIX normalisation with `.` and `..`. Returns null when the path climbs above the root. */
export function normalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

const join = (dir, rel) => normalize(dir ? `${dir}/${rel}` : rel);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** The npm package name of a bare specifier (scoped names kept, subpaths stripped). */
export function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function flattenExport(entry, out, depth = 0) {
  if (depth > 6 || entry === null || entry === undefined) return;
  if (typeof entry === 'string') out.push(entry);
  else if (Array.isArray(entry)) for (const e of entry) flattenExport(e, out, depth + 1);
  else if (typeof entry === 'object') {
    for (const c of CONDITIONS) if (c in entry) flattenExport(entry[c], out, depth + 1);
    for (const k of Object.keys(entry).sort()) if (!CONDITIONS.includes(k) && !k.startsWith('.')) flattenExport(entry[k], out, depth + 1);
  }
}

function exportTargets(exp, key) {
  const out = [];
  if (exp === null || exp === undefined) return out;
  const isMap = typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'));
  if (!isMap) {
    if (key === '.') flattenExport(exp, out);
    return out;
  }
  if (key in exp) flattenExport(exp[key], out);
  for (const k of Object.keys(exp).sort()) {
    const star = k.indexOf('*');
    if (star === -1 || k === key) continue;
    const pre = k.slice(0, star);
    const suf = k.slice(star + 1);
    if (key.startsWith(pre) && key.endsWith(suf) && key.length >= pre.length + suf.length) {
      const mid = key.slice(pre.length, key.length - suf.length);
      const raw = [];
      flattenExport(exp[k], raw);
      for (const r of raw) out.push(r.replace('*', mid));
    }
  }
  return out;
}

/**
 * @param {{ has: (p: string) => boolean, tsconfigs: Map<string, object>, packages: Array<{ dir: string, name: string|null, attrs: object }> }} env
 */
export function createResolver({ has, tsconfigs, packages }) {
  const pkgByName = new Map();
  for (const p of packages) if (p.name && !pkgByName.has(p.name)) pkgByName.set(p.name, p);

  function probe(base, tsFirst) {
    if (base === null) return null;
    const cands = [];
    const m = /\.(?:js|jsx|mjs|cjs)$/.exec(base);
    if (m) {
      const stem = base.slice(0, -m[0].length);
      const swaps = (TS_SWAP[m[0]] ?? []).map((e) => stem + e);
      if (tsFirst) cands.push(...swaps, base); else cands.push(base, ...swaps);
    } else cands.push(base);
    for (const e of CODE_EXTS) cands.push(base + e);
    for (const e of CODE_EXTS) cands.push(`${base}/index${e}`);
    for (const c of cands) if (has(c)) return c;
    return null;
  }

  const cfgByDir = new Map();
  function configFor(importer) {
    let dir = dirOf(importer);
    const trail = [];
    for (;;) {
      if (cfgByDir.has(dir)) { const v = cfgByDir.get(dir); for (const t of trail) cfgByDir.set(t, v); return v; }
      trail.push(dir);
      const cand = [`${dir ? `${dir}/` : ''}tsconfig.json`, `${dir ? `${dir}/` : ''}jsconfig.json`].find((c) => tsconfigs.has(c));
      if (cand) { for (const t of trail) cfgByDir.set(t, cand); return cand; }
      if (dir === '') { for (const t of trail) cfgByDir.set(t, null); return null; }
      dir = dirOf(dir);
    }
  }

  const effMemo = new Map();
  function effective(cfgPath, depth = 0) {
    if (effMemo.has(cfgPath)) return effMemo.get(cfgPath);
    const own = tsconfigs.get(cfgPath);
    const dir = dirOf(cfgPath);
    let parent = null;
    if (own?.extends && depth < 8) {
      const ext = own.extends;
      if (ext.startsWith('.')) {
        let target = join(dir, ext);
        if (target !== null && !tsconfigs.has(target) && tsconfigs.has(`${target}.json`)) target += '.json';
        if (target !== null && tsconfigs.has(target)) parent = effective(target, depth + 1);
      }
    }
    const baseUrl = own?.baseUrl != null ? join(dir, own.baseUrl) : parent?.baseUrl ?? null;
    let paths = parent?.paths ?? null;
    let pathsBase = parent?.pathsBase ?? null;
    if (own?.paths) {
      paths = own.paths;
      pathsBase = baseUrl ?? dir;
    }
    const eff = { baseUrl, paths, pathsBase };
    effMemo.set(cfgPath, eff);
    return eff;
  }

  function viaPaths(importer, spec) {
    const cfg = configFor(importer);
    if (!cfg) return { hit: null, matched: false };
    const eff = effective(cfg);
    let matched = false;
    if (eff.paths) {
      const keys = Object.keys(eff.paths).sort((a, b) => {
        const pa = a.indexOf('*') === -1 ? a.length : a.indexOf('*');
        const pb = b.indexOf('*') === -1 ? b.length : b.indexOf('*');
        return pb - pa || (a < b ? -1 : 1);
      });
      for (const k of keys) {
        const star = k.indexOf('*');
        let mid = null;
        if (star === -1) { if (k === spec) mid = ''; } else {
          const pre = k.slice(0, star);
          const suf = k.slice(star + 1);
          if (spec.startsWith(pre) && spec.endsWith(suf) && spec.length >= pre.length + suf.length) mid = spec.slice(pre.length, spec.length - suf.length);
        }
        if (mid === null) continue;
        if (k !== '*') matched = true;
        const targets = Array.isArray(eff.paths[k]) ? eff.paths[k] : [];
        for (const t of targets) {
          if (typeof t !== 'string') continue;
          const hit = probe(join(eff.pathsBase ?? '', t.replace('*', mid)), false);
          if (hit) return { hit, matched };
        }
      }
    }
    if (eff.baseUrl !== null) {
      const hit = probe(join(eff.baseUrl, spec), false);
      if (hit) return { hit, matched };
    }
    return { hit: null, matched };
  }

  function packageEntry(pkg, sub) {
    const dir = pkg.dir;
    const a = pkg.attrs;
    const cands = [];
    for (const t of exportTargets(a.exports, sub ? `./${sub}` : '.')) cands.push(t);
    if (!sub) for (const t of [a.types, a.module, a.main]) if (typeof t === 'string') cands.push(t);
    const more = [];
    for (const c of cands) {
      const m = /^(?:\.\/)?(?:dist|lib|build|out)\/(.*)$/.exec(c);
      if (m) more.push(`src/${m[1]}`);
    }
    cands.push(...more);
    if (sub) cands.push(sub, `src/${sub}`, `lib/${sub}`); else cands.push('src/index', 'index', 'lib/index');
    for (const c of cands) {
      const hit = probe(join(dir, c), true);
      if (hit && CODE_RE.test(hit)) return hit;
    }
    return null;
  }

  const appRoots = new Map();
  /** The nearest ancestor directory holding a Meteor app (`.meteor/release`), or null. */
  function appRootOf(importer) {
    let dir = dirOf(importer);
    const trail = [];
    for (;;) {
      if (appRoots.has(dir)) { const v = appRoots.get(dir); for (const t of trail) appRoots.set(t, v); return v; }
      trail.push(dir);
      if (has(dir ? `${dir}/.meteor/release` : '.meteor/release')) { for (const t of trail) appRoots.set(t, dir); return dir; }
      if (!dir) { for (const t of trail) appRoots.set(t, null); return null; }
      dir = dirOf(dir);
    }
  }

  const cache = new Map();

  /**
   * @returns {{ t: 'module', path: string, via: string } | { t: 'dep', name: string, builtin?: boolean, workspace?: boolean }
   *   | { t: 'asset' } | { t: 'ignore' } | { t: 'unresolved', reason: string }}
   */
  function resolve(importer, spec) {
    const ck = `${dirOf(importer)}\0${importer.endsWith('.ts') || importer.endsWith('.tsx')}\0${spec}`;
    if (cache.has(ck)) return cache.get(ck);
    const r = resolveUncached(importer, spec);
    cache.set(ck, r);
    return r;
  }

  function resolveUncached(importer, spec) {
    if (!spec) return { t: 'unresolved', reason: 'empty' };
    if (/^(?:https?:|data:|file:|blob:)/.test(spec) || spec.startsWith('#') || /^[a-z-]+:/.test(spec) && !spec.startsWith('node:')) return { t: 'ignore' };
    if (spec.startsWith('node:')) return { t: 'dep', name: spec, builtin: true };
    const tsFirst = /\.(?:ts|tsx|mts|cts)$/.test(importer);
    if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
      const base = join(dirOf(importer), spec);
      const hit = probe(base, tsFirst);
      if (hit) return CODE_RE.test(hit) ? { t: 'module', path: hit, via: 'relative' } : { t: 'asset' };
      if (base !== null && has(base)) return { t: 'asset' };
      return { t: 'unresolved', reason: 'relative' };
    }
    if (spec.startsWith('/')) {
      // Root-relative: Meteor resolves `/imports/x` against the app (the directory holding
      // `.meteor/`), and several bundlers against the project root. Accept only a file that
      // exists there; anything else stays unresolved.
      const rel = spec.replace(/^\/+/, '');
      for (const root of [appRootOf(importer), '']) {
        if (root === null) continue;
        const hit = probe(root ? join(root, rel) : normalize(rel), tsFirst);
        if (hit) return CODE_RE.test(hit) ? { t: 'module', path: hit, via: 'root-relative' } : { t: 'asset' };
      }
      return { t: 'unresolved', reason: 'absolute' };
    }
    const { hit, matched } = viaPaths(importer, spec);
    if (hit) return CODE_RE.test(hit) ? { t: 'module', path: hit, via: 'tsconfig-paths' } : { t: 'asset' };
    if (matched) return { t: 'unresolved', reason: 'tsconfig-paths' };
    const name = packageName(spec);
    if (pkgByName.has(name)) {
      const sub = spec.length > name.length ? spec.slice(name.length + 1) : '';
      const entry = packageEntry(pkgByName.get(name), sub);
      if (entry) return { t: 'module', path: entry, via: 'workspace' };
      return { t: 'dep', name, workspace: true };
    }
    if (NODE_BUILTINS.has(spec.split('/')[0]) && !spec.startsWith('@')) return { t: 'dep', name: `node:${spec}`, builtin: true };
    if (/^[@~]\//.test(spec)) return { t: 'unresolved', reason: 'alias' };
    return { t: 'dep', name };
  }

  return { resolve, probe, pkgByName };
}
