// Cross-file linking: import resolution, call targets, inheritance, tests, route components
// and package containment. It works only from the cached per-file facts, so it is cheap to
// recompute on every map. Resolution is by name and path (no type information), so call
// and inheritance edges are marked confidence 'medium'.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { EXTRACTOR } from './config.mjs';
import { createResolver, normalize as normalizePath } from './resolver.mjs';

const KIND_ORDER = ['static', 'reexport', 'require', 'dynamic', 'type'];

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function linkFacts(ctx) {
  const files = ctx.files;
  // factsByFile holds every adapter's facts; this linker reasons only about its own.
  const byFile = new Map();
  for (const [path, facts] of ctx.factsByFile) {
    const own = facts.filter((f) => String(f.provenance?.extractor ?? '').startsWith('javascript@'));
    if (own.length) byFile.set(path, own);
  }
  const paths = [...byFile.keys()].sort(cmp);

  const mods = new Map(); // path -> module attrs
  const symbols = new Map(); // path -> Map<qname, { id, type, node }>
  const packages = [];
  const tsconfigs = new Map();
  const routeNodes = [];
  for (const path of paths) {
    for (const f of byFile.get(path)) {
      if (f.kind !== 'node') continue;
      if (f.type === 'module' && f.attrs.imports) mods.set(path, f.attrs);
      else if (f.type === 'package') packages.push({ path, dir: f.attrs.dir ?? dirOf(path), name: f.attrs.name, id: f.id, attrs: f.attrs });
      else if (f.type === 'build_target') tsconfigs.set(path, f.attrs);
      else if (f.type === 'route' && f.attrs.components) routeNodes.push({ path, f });
      else if (['function', 'method', 'class', 'interface'].includes(f.type)) {
        const q = f.id.slice(f.id.indexOf('#') + 1);
        if (!symbols.has(path)) symbols.set(path, new Map());
        symbols.get(path).set(q, { id: f.id, type: f.type, node: f });
      }
    }
  }
  packages.sort((a, b) => cmp(a.path, b.path));

  const has = (p) => files.has(p) || byFile.has(p);
  const R = createResolver({ has, tsconfigs, packages });
  const out = [];
  const emittedNodes = new Set();
  const P = (path, line, confidence = 'high') => prov({ source_type: 'ast', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });

  // ---- imports -----------------------------------------------------------------

  const importEdges = new Map(); // from|to -> aggregate
  const unresolved = new Map(); // path -> [{ specifier, line }]
  const resolvedImports = new Map(); // path -> Map<specifier, resolution>
  for (const path of paths) {
    const attrs = mods.get(path);
    if (!attrs) continue;
    const resMap = new Map();
    resolvedImports.set(path, resMap);
    for (const imp of attrs.imports) {
      const r = R.resolve(path, imp.specifier);
      resMap.set(imp.specifier, r);
      if (r.t === 'unresolved') {
        if (!unresolved.has(path)) unresolved.set(path, []);
        unresolved.get(path).push({ specifier: imp.specifier, line: imp.line, reason: r.reason });
        continue;
      }
      if (r.t === 'asset' || r.t === 'ignore') continue;
      const to = r.t === 'module' ? `module:${r.path}` : `dependency:${r.name}`;
      if (r.t === 'dep' && !emittedNodes.has(to)) {
        emittedNodes.add(to);
        out.push(nodeFact('dependency', r.name, { name: r.name, attrs: r.builtin ? { external: true, builtin: true } : { external: true } }, P(path, imp.line)));
      }
      const key = `${path}|${to}`;
      let agg = importEdges.get(key);
      if (!agg) {
        agg = { from: `module:${path}`, to, names: new Set(), kinds: new Set(), line: imp.line, path, via: r.via ?? null, internal: r.t === 'module' };
        importEdges.set(key, agg);
      }
      for (const nm of imp.names) agg.names.add(nm);
      agg.kinds.add(imp.kind);
      agg.line = Math.min(agg.line, imp.line);
    }
  }
  for (const agg of [...importEdges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to))) {
    const kinds = KIND_ORDER.filter((k) => agg.kinds.has(k));
    const attrs = { names: [...agg.names].sort(), kind: kinds[0], line: agg.line };
    if (kinds.length > 1) attrs.kinds = kinds;
    // `import type` and `export type ... from` are erased at compile time: no runtime edge.
    if (kinds.length === 1 && kinds[0] === 'type') attrs.type_only = true;
    out.push(edgeFact('IMPORTS', agg.from, agg.to, attrs, P(agg.path, agg.line, agg.via === 'relative' || !agg.internal ? 'high' : 'medium')));
  }
  for (const [path, list] of [...unresolved.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    out.push(nodeFact('module', path, { name: path, path, attrs: { unresolved: list } }, P(path, list[0].line, 'medium')));
  }

  // ---- exports and bindings ----------------------------------------------------

  const bindingCache = new Map();
  function bindingsOf(path) {
    if (bindingCache.has(path)) return bindingCache.get(path);
    const m = new Map();
    const attrs = mods.get(path);
    for (const imp of attrs?.imports ?? []) {
      if (imp.kind === 'reexport') continue;
      const r = resolvedImports.get(path)?.get(imp.specifier);
      if (!r || r.t !== 'module') continue;
      for (const b of imp.bindings ?? []) if (!m.has(b.local)) m.set(b.local, { imported: b.imported ?? '*', target: r.path });
    }
    bindingCache.set(path, m);
    return m;
  }

  function resolveExport(path, name, depth = 0, seen = new Set()) {
    const key = `${path}\0${name}`;
    if (depth > 8 || seen.has(key)) return null;
    seen.add(key);
    const attrs = mods.get(path);
    if (!attrs) return null;
    for (const e of attrs.exports) if (e.name === name && !e.from) return { path, local: e.local ?? name };
    for (const e of attrs.exports) {
      if (e.name !== name || !e.from) continue;
      const r = resolvedImports.get(path)?.get(e.from);
      if (!r || r.t !== 'module') continue;
      // Prefer the re-export that binds this name: `export * from './x'` and
      // `export Y from './x'` share a specifier, and only the second binds Y.
      const cands = attrs.imports.filter((i) => i.specifier === e.from && (i.kind === 'reexport' || i.kind === 'type'));
      const imp = cands.find((i) => (i.bindings ?? []).some((x) => x.local === name)) ?? cands[0];
      const b = imp?.bindings?.find((x) => x.local === name);
      const hit = resolveExport(r.path, b?.imported ?? name, depth + 1, seen);
      if (hit) return hit;
    }
    if (name !== 'default') {
      for (const e of attrs.exports) {
        if (e.name !== '*' || !e.from) continue;
        const r = resolvedImports.get(path)?.get(e.from);
        if (!r || r.t !== 'module') continue;
        const hit = resolveExport(r.path, name, depth + 1, seen);
        if (hit) return hit;
      }
    }
    return null;
  }

  const sym = (path, q) => symbols.get(path)?.get(q) ?? null;

  /** Resolves a dotted name used in `path` to a symbol, via local scope or an import binding. */
  function resolveName(path, name, callerQ, wanted) {
    const parts = name.split('.');
    const first = parts[0];
    if (parts.length === 1) {
      let q = callerQ;
      for (;;) {
        const s = sym(path, q ? `${q}.${first}` : first);
        if (s && wanted.includes(s.type)) return s;
        if (!q) break;
        q = q.includes('.') ? q.slice(0, q.lastIndexOf('.')) : '';
      }
    } else {
      const s = sym(path, parts.join('.'));
      if (s && wanted.includes(s.type) ) return s;
    }
    const b = bindingsOf(path).get(first);
    if (!b) return null;
    let rest = parts.slice(1);
    let r;
    if (b.imported === '*') {
      if (parts.length === 1) r = resolveExport(b.target, 'default');
      else { r = resolveExport(b.target, parts[1]); rest = parts.slice(2); }
    } else r = resolveExport(b.target, b.imported);
    if (!r) return null;
    const q = rest.length ? `${r.local}.${rest.join('.')}` : r.local;
    const s = sym(r.path, q);
    return s && wanted.includes(s.type) ? s : null;
  }

  // ---- calls, inheritance ------------------------------------------------------

  const agg = new Map();
  function addEdge(type, from, to, path, line) {
    if (from === to && type !== 'CALLS') return;
    const key = `${type}|${from}|${to}`;
    const hit = agg.get(key);
    if (hit) { hit.count++; hit.line = Math.min(hit.line, line); return; }
    agg.set(key, { type, from, to, path, line, count: 1 });
  }

  for (const path of paths) {
    if (!mods.has(path)) continue;
    for (const f of byFile.get(path)) {
      if (f.kind !== 'node') continue;
      const q = f.id.slice(f.id.indexOf('#') + 1);
      if (f.type === 'function' || f.type === 'method') {
        const cls = f.attrs.class;
        for (const c of f.attrs.calls ?? []) {
          let target = null;
          if (c.name.startsWith('this.') && cls && c.name.split('.').length === 2) {
            const s = sym(path, `${cls}.${c.name.slice(5)}`);
            if (s && (s.type === 'method' || s.type === 'function')) target = s;
          } else if (!c.name.startsWith('this.') && !c.name.startsWith('super.')) {
            target = resolveName(path, c.name, q, c.new ? ['class'] : ['function', 'method']);
          }
          if (!target) continue;
          addEdge(c.new ? 'INSTANTIATES' : 'CALLS', f.id, target.id, path, c.line);
        }
      } else if (f.type === 'class') {
        const ext = f.attrs.extends;
        if (ext) {
          const t = resolveName(path, ext, '', ['class']);
          if (t) addEdge('EXTENDS', f.id, t.id, path, f.attrs.start_line);
        }
        for (const impl of f.attrs.implements ?? []) {
          const t = resolveName(path, impl, '', ['class', 'interface']);
          if (t) addEdge('IMPLEMENTS', f.id, t.id, path, f.attrs.start_line);
        }
      }
    }
  }
  for (const a of [...agg.values()].sort((x, y) => cmp(x.type, y.type) || cmp(x.from, y.from) || cmp(x.to, y.to))) {
    out.push(edgeFact(a.type, a.from, a.to, { line: a.line, count: a.count }, P(a.path, a.line, 'medium')));
  }

  // ---- tests -------------------------------------------------------------------

  for (const agg2 of [...importEdges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to))) {
    if (!agg2.internal || !mods.get(agg2.path)?.is_test) continue;
    const target = agg2.to.slice('module:'.length);
    if (mods.get(target)?.is_test) continue;
    out.push(edgeFact('TESTS', agg2.from, agg2.to, { names: [...agg2.names].sort(), line: agg2.line }, P(agg2.path, agg2.line, 'medium')));
  }

  // ---- route components --------------------------------------------------------

  for (const { path, f } of routeNodes.sort((a, b) => cmp(a.f.id, b.f.id) || cmp(a.path, b.path))) {
    const file = f.attrs.file ?? path;
    for (const comp of f.attrs.components) {
      let target = null;
      if (comp.import_spec) {
        const r = R.resolve(file, comp.import_spec);
        if (r.t === 'module') target = r.path;
      }
      if (!target && comp.name) {
        const name = comp.name.split('.')[0];
        const b = bindingsOf(file).get(name);
        if (b) {
          const r = b.imported === '*' ? resolveExport(b.target, comp.name.split('.')[1] ?? 'default') : resolveExport(b.target, b.imported);
          target = r ? r.path : b.target;
        } else if (sym(file, name)) target = file;
      }
      if (!target) continue;
      const attrs = { component: comp.name };
      if (comp.layout) attrs.layout = true;
      out.push(edgeFact('RENDERS', f.id, `module:${target}`, attrs, P(file, f.attrs.line ?? 1, 'medium')));
    }
  }

  // ---- packages ----------------------------------------------------------------

  const byDirLen = [...packages].sort((a, b) => b.dir.length - a.dir.length || cmp(a.path, b.path));
  const pkgFor = new Map();
  function nearestPackage(path) {
    const d = dirOf(path);
    if (pkgFor.has(d)) return pkgFor.get(d);
    const hit = byDirLen.find((p) => p.dir === '' || d === p.dir || d.startsWith(`${p.dir}/`)) ?? null;
    pkgFor.set(d, hit);
    return hit;
  }
  for (const path of paths) {
    if (!mods.has(path)) continue;
    const pkg = nearestPackage(path);
    if (pkg) out.push(edgeFact('CONTAINS', pkg.id, `module:${path}`, {}, P(pkg.path, 1)));
  }
  // Files named by path in code (spawned scripts, workers): the module starts them, so they
  // are referenced even though nothing imports them.
  for (const [path, attrs] of mods) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const m of attrs.path_mentions ?? []) {
      const rel = m.replace(/^\.\//, '');
      const target = [dir ? normalizePath(`${dir}/${rel}`) : rel, rel].find((c) => c && c !== path && ctx.files.has(c));
      if (target) out.push(edgeFact('REFERENCES', `module:${path}`, `module:${target}`, { via: 'path string' }, P(path, 1, 'medium')));
    }
  }

  // MongoDB collections: resolve each binding used for a read or write to the module that
  // defines the collection (through imports and re-exports), so data affinity and the
  // database detectors see which modules share a collection.
  const collectionOf = new Map(); // `${path}\0${binding}` -> definition
  for (const [path, attrs] of mods) for (const c of attrs.mongo_collections ?? []) if (c.binding) collectionOf.set(`${path}\0${c.binding}`, { ...c, path });
  const tables = new Set();
  const mongoEdges = new Set();
  const table = (c, path) => {
    if (tables.has(c.name)) return;
    tables.add(c.name);
    out.push(nodeFact('table', c.name, { name: c.name, path, attrs: { engine: 'mongodb', kind: 'collection', orm: c.orm ?? null, defined_in: path } }, P(path, c.line ?? 1, c.orm === 'driver' ? 'medium' : 'high')));
  };
  for (const [path, attrs] of [...mods].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const c of attrs.mongo_collections ?? []) table(c, path);
    for (const o of attrs.mongo_ops ?? []) {
      let c = null;
      if (o.name) c = { name: o.name, orm: 'driver', line: o.line };
      else {
        c = collectionOf.get(`${path}\0${o.binding}`) ?? null;
        if (!c) {
          const imp = attrs.imports.find((i) => (i.bindings ?? []).some((b) => b.local === o.binding));
          const b = imp?.bindings.find((x) => x.local === o.binding);
          const r = imp ? resolvedImports.get(path)?.get(imp.specifier) : null;
          if (r?.t === 'module') {
            const hit = resolveExport(r.path, b.imported);
            if (hit) c = collectionOf.get(`${hit.path}\0${hit.local}`) ?? null;
          }
        }
      }
      if (!c) continue;
      if (o.name) table(c, path);
      const type = o.kind === 'write' ? 'MUTATES' : 'QUERIES';
      const key = `${type}\0${path}\0${c.name}`;
      if (mongoEdges.has(key)) continue;
      mongoEdges.add(key);
      out.push(edgeFact(type, `module:${path}`, `table:${c.name}`, { line: o.line, kind: o.op, via: 'mongodb' }, P(path, o.line, 'medium')));
    }
  }

  const workspaceNames = R.pkgByName;
  for (const pkg of packages) {
    for (const [group, deps] of Object.entries(pkg.attrs.dependencies ?? {})) {
      for (const dep of Object.keys(deps).sort()) {
        const other = workspaceNames.get(dep);
        if (other && other !== pkg) out.push(edgeFact('DEPENDS_ON', pkg.id, other.id, { range: deps[dep], group, workspace: true }, P(pkg.path, 1)));
      }
    }
  }
  return out;
}
