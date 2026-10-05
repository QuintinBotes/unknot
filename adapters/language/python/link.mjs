// Cross-file linking for the Python adapter. Recomputed on every map from the cached
// per-file facts, so it only does map lookups: import resolution against source roots,
// call targets through import bindings, class inheritance, tests and package containment.

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { EXTRACTOR, isDjangoConventionPath } from './build.mjs';
import { MANIFEST_RE, manifestKind } from './manifests.mjs';
import { DIST_ALIASES, STDLIB, normalizeDist } from './stdlib.mjs';

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir, rest) => (dir ? `${dir}/${rest}` : rest);
const cleanRoot = (r) => String(r).replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '').replace(/^\.$/, '');

/** Dotted module name of a file relative to a source root, or null when not importable. */
function dottedName(rel) {
  const parts = rel.replace(/\.py$/, '').split('/');
  if (parts[parts.length - 1] === '__init__') parts.pop();
  if (!parts.length || parts.some((s) => !/^[A-Za-z_]\w*$/.test(s))) return null;
  return parts.join('.');
}

/**
 * @param {{files: Map<string,object>, factsByFile: Map<string,object[]>, options?: object}} ctx
 * @returns {object[]} link-time graph facts
 */
export function link(ctx) {
  const factsByFile = ctx.factsByFile ?? new Map();
  const out = [];
  const emitted = new Set();
  const emit = (fact) => {
    const key = fact.kind === 'node' ? fact.id : `${fact.type}|${fact.from}|${fact.to}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    out.push(fact);
  };

  // --- index python modules, symbols and manifests -----------------------------------
  const modules = new Map(); // path -> module fact
  const symbols = new Map(); // path -> Map<qual, nodeId>
  const nodeIds = new Set();
  const manifests = []; // { path, dir, kind, packageId }
  for (const [path, facts] of factsByFile) {
    for (const f of facts) {
      if (f.kind !== 'node') continue;
      nodeIds.add(f.id);
      if (f.type === 'module' && f.attrs.language === 'python') modules.set(path, f);
      else if (f.type === 'function' || f.type === 'method' || f.type === 'class') {
        if (!symbols.has(path)) symbols.set(path, new Map());
        symbols.get(path).set(f.id.slice(f.id.indexOf('#') + 1), f.id);
      } else if (f.type === 'package' && MANIFEST_RE.test(path)) {
        manifests.push({ path, dir: dirOf(path), kind: manifestKind(path), packageId: f.id });
      }
    }
  }
  const pyPaths = new Set([...modules.keys()]);
  for (const p of ctx.files?.keys?.() ?? []) if (p.endsWith('.py')) pyPaths.add(p);

  // --- source roots and the dotted-name index ------------------------------------------
  const roots = new Set(['', 'src']);
  for (const m of manifests) {
    if (m.kind === 'requirements') continue;
    roots.add(m.dir);
    roots.add(join(m.dir, 'src'));
  }
  for (const r of ctx.options?.roots ?? []) roots.add(cleanRoot(r));
  const rootList = [...roots].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const index = new Map(); // dotted -> [{ path, root }]
  const tops = new Set();
  for (const path of [...pyPaths].sort()) {
    for (const root of rootList) {
      if (root && !path.startsWith(`${root}/`)) continue;
      const dotted = dottedName(root ? path.slice(root.length + 1) : path);
      if (!dotted) continue;
      if (!index.has(dotted)) index.set(dotted, []);
      index.get(dotted).push({ path, root });
      tops.add(dotted.split('.')[0]);
    }
  }
  const resolveDotted = (dotted, importer) => {
    const cands = index.get(dotted);
    if (!cands) return null;
    // Prefer the root that contains the importer: that is how the interpreter would see it.
    let best = null;
    for (const c of cands) if (!c.root || importer.startsWith(`${c.root}/`)) if (!best || c.root.length > best.root.length) best = c;
    return (best ?? cands[0]).path;
  };
  const tryRel = (dir, parts) => {
    const base = join(dir, parts.join('/'));
    for (const cand of parts.length ? [`${base}.py`, `${base}/__init__.py`] : [join(dir, '__init__.py')]) {
      if (pyPaths.has(cand)) return cand;
    }
    return null;
  };

  const lowQuality = (path) => modules.get(path)?.attrs.parse_quality === 'lexical';
  const pvFor = (path, line, confidence = 'high') => (lowQuality(path)
    ? prov({ source_type: 'inference', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence: 'low' })
    : prov({ source_type: 'ast', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence }));

  // --- imports: bindings, IMPORTS edges, external dependencies ---------------------------
  const bindings = new Map(); // path -> Map<name, { path, symbol }>
  const importedModules = new Map(); // path -> Set<target path>
  for (const [path, mod] of [...modules].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const bind = new Map();
    bindings.set(path, bind);
    const targets = new Map(); // target path -> { names, line }
    const externals = new Map(); // dependency id -> { top, line, stdlib }
    let cur = {};
    const internal = (target, line, name) => {
      if (target === path) return;
      const t = targets.get(target) ?? { names: [], line, lazy: true, typeOnly: true };
      t.lazy = t.lazy && Boolean(cur.lazy || cur.type_only);
      t.typeOnly = t.typeOnly && Boolean(cur.type_only);
      if (name) t.names.push(name);
      targets.set(target, t);
    };
    const external = (top, line) => {
      if (!top) return;
      const stdlib = STDLIB.has(top);
      const id = stdlib ? `dependency:python:${top}` : `dependency:${normalizeDist(DIST_ALIASES[top] ?? top)}`;
      if (!externals.has(id)) externals.set(id, { top, line, stdlib });
    };

    for (const imp of mod.attrs.imports ?? []) {
      cur = imp;
      const parts = imp.module ? imp.module.split('.') : [];
      if (imp.level > 0) {
        let dir = dirOf(path);
        for (let k = 1; k < imp.level && dir !== null; k++) dir = dir.includes('/') ? dirOf(dir) : dir === '' ? null : '';
        if (dir === null) continue;
        const target = parts.length ? tryRel(dir, parts) : tryRel(dir, []);
        for (const n of imp.names) {
          if (n.name === '*') { if (target) internal(target, imp.line, '*'); continue; }
          const local = n.as ?? n.name;
          const sub = tryRel(dir, [...parts, n.name]);
          if (sub) { bind.set(local, { path: sub, symbol: null }); internal(sub, imp.line, n.name); } else if (target) {
            bind.set(local, { path: target, symbol: n.name });
            internal(target, imp.line, n.name);
          }
        }
        if (!imp.names.length && target) internal(target, imp.line);
        continue;
      }
      if (imp.kind === 'import') {
        let resolvedLen = 0;
        let resolved = null;
        for (let len = parts.length; len > 0; len--) {
          resolved = resolveDotted(parts.slice(0, len).join('.'), path);
          if (resolved) { resolvedLen = len; break; }
        }
        if (!resolved) { if (!tops.has(parts[0])) external(parts[0], imp.line); continue; }
        internal(resolved, imp.line);
        if (imp.as && resolvedLen === parts.length) bind.set(imp.as, { path: resolved, symbol: null });
        else if (!imp.as) {
          for (let len = 1; len <= resolvedLen; len++) {
            const p = resolveDotted(parts.slice(0, len).join('.'), path);
            if (p) bind.set(parts.slice(0, len).join('.'), { path: p, symbol: null });
          }
        }
        continue;
      }
      // from <absolute> import names
      const target = resolveDotted(imp.module, path);
      let any = Boolean(target);
      for (const n of imp.names) {
        if (n.name === '*') { if (target) internal(target, imp.line, '*'); continue; }
        const local = n.as ?? n.name;
        const sub = resolveDotted(`${imp.module}.${n.name}`, path);
        if (sub) { bind.set(local, { path: sub, symbol: null }); internal(sub, imp.line, n.name); any = true; } else if (target) {
          bind.set(local, { path: target, symbol: n.name });
          internal(target, imp.line, n.name);
        }
      }
      if (!any && !tops.has(parts[0])) external(parts[0], imp.line);
      else if (target && !imp.names.length) internal(target, imp.line);
    }

    importedModules.set(path, new Set(targets.keys()));
    const moduleId = `module:${path}`;
    for (const [target, t] of [...targets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      emit(edgeFact('IMPORTS', moduleId, `module:${target}`, { names: [...new Set(t.names)].sort(), line: t.line, ...(t.lazy && { lazy: true }), ...(t.typeOnly && { type_only: true }) }, pvFor(path, t.line)));
    }
    for (const [id, e] of [...externals].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      emit(nodeFact('dependency', id.slice('dependency:'.length), {
        name: id.slice('dependency:'.length),
        attrs: { ecosystem: e.stdlib ? 'python-stdlib' : 'pypi' },
      }, pvFor(path, e.line)));
      emit(edgeFact('IMPORTS', moduleId, id, { line: e.line, external: true, stdlib: e.stdlib }, pvFor(path, e.line)));
    }
  }

  // --- Django conventions that need the project layout (manage.py, sibling apps.py) ------
  const hasManage = [...pyPaths].some((p) => p === 'manage.py' || p.endsWith('/manage.py'));
  for (const [path, mod] of modules) {
    if (mod.attrs.django_convention || !isDjangoConventionPath(path)) continue;
    const base = path.slice(path.lastIndexOf('/') + 1);
    const sibling = ['apps.py', 'admin.py', 'models.py', 'urls.py'].includes(base) && pyPaths.has(join(dirOf(path), 'apps.py'));
    if (hasManage || sibling) emit(nodeFact('module', path, { name: path, path, attrs: { django_convention: true } }, pvFor(path, 1, 'medium')));
  }

  // --- name resolution -----------------------------------------------------------------
  const lookup = (path, qual) => symbols.get(path)?.get(qual) ?? null;
  /** Where a dotted name used in `path` points: { path, qual } or null. */
  const resolveName = (path, name) => {
    if (symbols.get(path)?.has(name)) return { path, qual: name };
    const bind = bindings.get(path);
    if (!bind) return null;
    const parts = name.split('.');
    for (let len = parts.length; len > 0; len--) {
      const b = bind.get(parts.slice(0, len).join('.'));
      if (!b) continue;
      const rest = parts.slice(len);
      const qual = b.symbol ? [b.symbol, ...rest].join('.') : rest.join('.');
      if (!qual) return null;
      return { path: b.path, qual };
    }
    return null;
  };
  const classBases = (path, qual) => {
    const id = lookup(path, qual);
    const node = id ? factsByFile.get(path).find((f) => f.id === id) : null;
    const out2 = [];
    for (const b of node?.attrs.bases ?? []) {
      const r = resolveName(path, b);
      if (r && lookup(r.path, r.qual)?.startsWith('class:')) out2.push(r);
    }
    return out2;
  };
  const findMethod = (path, cls, name, depth = 0) => {
    const own = lookup(path, `${cls}.${name}`);
    if (own) return own;
    if (depth > 5) return null;
    for (const b of classBases(path, cls)) {
      const found = findMethod(b.path, b.qual, name, depth + 1);
      if (found) return found;
    }
    return null;
  };

  // --- CALLS, EXTENDS, Django view exposure --------------------------------------------
  for (const [path, facts] of [...factsByFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!modules.has(path)) continue;
    for (const f of facts) {
      if (f.kind === 'node' && (f.type === 'function' || f.type === 'method')) {
        const cls = f.attrs.class;
        for (const call of f.attrs.calls ?? []) {
          let target = null;
          const parts = call.split('.');
          if ((parts[0] === 'self' || parts[0] === 'cls') && parts.length === 2 && cls) {
            target = findMethod(path, cls, parts[1]);
          } else {
            const r = resolveName(path, call);
            if (r) target = lookup(r.path, r.qual);
          }
          if (target && target !== f.id && !target.startsWith('class:')) {
            emit(edgeFact('CALLS', f.id, target, { callee: call }, pvFor(path, f.attrs.start_line, 'medium')));
          }
        }
      } else if (f.kind === 'node' && f.type === 'class') {
        for (const b of f.attrs.bases ?? []) {
          const r = resolveName(path, b);
          const target = r ? lookup(r.path, r.qual) : null;
          if (target?.startsWith('class:') && target !== f.id) {
            emit(edgeFact('EXTENDS', f.id, target, { base: b }, pvFor(path, f.attrs.start_line)));
          }
        }
      } else if (f.kind === 'edge' && f.type === 'EXPOSES' && f.attrs.view && f.from.startsWith('module:')) {
        const r = resolveName(path, f.attrs.view);
        const target = r ? lookup(r.path, r.qual) : null;
        if (target) emit(edgeFact('EXPOSES', target, f.to, { framework: f.attrs.framework }, f.provenance));
      }
    }
  }

  // --- TESTS ---------------------------------------------------------------------------
  for (const [path, mod] of modules) {
    if (!mod.attrs.is_test) continue;
    for (const target of [...(importedModules.get(path) ?? [])].sort()) {
      if (modules.get(target)?.attrs.is_test) continue;
      emit(edgeFact('TESTS', `module:${path}`, `module:${target}`, {}, pvFor(path, 1)));
    }
  }

  // --- package containment ---------------------------------------------------------------
  const rank = { pyproject: 0, 'setup.cfg': 1, 'setup.py': 2 };
  const byDir = new Map();
  for (const m of manifests) {
    if (!(m.kind in rank)) continue;
    const cur = byDir.get(m.dir);
    if (!cur || rank[m.kind] < rank[cur.kind]) byDir.set(m.dir, m);
  }
  const dirs = [...byDir.keys()].sort((a, b) => b.length - a.length);
  for (const path of [...modules.keys()].sort()) {
    const dir = dirs.find((d) => !d || path.startsWith(`${d}/`));
    if (dir === undefined) continue;
    emit(edgeFact('CONTAINS', byDir.get(dir).packageId, `module:${path}`, {}, pvFor(path, 1)));
  }
  // Modules named by dotted path in strings (settings such as DRF authentication classes,
  // Celery task routes, entry-point tables): referenced, though nothing imports them.
  for (const [path, mod] of modules) {
    for (const ref of mod.attrs?.dotted_strings ?? []) {
      const parts = ref.split('.');
      for (let n = parts.length; n >= 2; n--) {
        const hits = index.get(parts.slice(0, n).join('.'));
        const target = hits?.[0]?.path;
        if (target && target !== path) {
          emit(edgeFact('REFERENCES', `module:${path}`, `module:${target}`, { via: 'dotted string' }, prov({ source_type: 'ast', source_ref: `${path}:1`, extractor: EXTRACTOR, confidence: 'medium' })));
          break;
        }
      }
    }
  }
  return out;
}
