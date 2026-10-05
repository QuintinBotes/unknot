// Module-level (structural) detectors: dependency cycles, stability violations, hubs,
// co-change coupling, leaked internals, bloated APIs, low-cohesion packages and layer
// violations. They read IMPORTS / CO_CHANGES / CONTAINS edges only. Thresholds come from
// config.detectors['module.<name>'] and every one in effect is echoed in the draft.

import { globToRegExp } from '../../core/glob.mjs';
import { condense, instability, shortestCycle, stronglyConnected } from '../../graph/algorithms.mjs';
import { clamp, isTestModule, opt } from './local.mjs';
import { inLibraryDir } from '../conventions.mjs';

const byId = (a, b) => (a.id < b.id ? -1 : 1);
const IMPORT = ['IMPORTS'];

/** Source (non-test) module nodes in stable order. */
function sourceModules(graph) {
  return [...graph.nodes('module')].filter((m) => !isTestModule(m)).sort(byId);
}

/** Module-to-module IMPORTS edges between source modules (tests and externals excluded). */
function moduleImports(graph, mods) {
  const ids = new Set(mods.map((m) => m.id));
  const out = [];
  for (const m of mods) for (const e of graph.out(m.id, IMPORT)) if (ids.has(e.to) && e.to !== m.id) out.push(e);
  return out;
}

/**
 * Package grouping: the CONTAINS parent of type package when there is one, otherwise the
 * first directory segment after any root directory (src, lib, ...) shared by every module.
 * Files at the top of the tree belong to no package (null).
 */
function packageGrouping(graph, mods) {
  const segs = mods.map((m) => (m.path ?? '').split('/').slice(0, -1));
  let skip = 0;
  while (segs.length && segs.every((s) => s.length > skip + 1 && s[skip] === segs[0][skip])) skip++;
  const cache = new Map();
  const groupOf = (id) => {
    if (cache.has(id)) return cache.get(id);
    const n = graph.node(id);
    let g = null;
    if (n && n.type === 'module') {
      const parent = graph.parent(id);
      if (parent && parent.type === 'package') g = parent.id;
      else {
        const dir = (n.path ?? '').split('/').slice(0, -1);
        g = dir.length > skip ? dir.slice(0, skip + 1).join('/') : null;
      }
    }
    cache.set(id, g);
    return g;
  };
  return { groupOf, label: (g) => (g.startsWith('package:') ? (graph.node(g)?.name ?? g) : g) };
}

const pathOf = (graph, id) => graph.node(id)?.path ?? id.replace(/^module:/, '');
const sortedUnique = (a) => [...new Set(a)].sort();

/** Fields shared by every module draft; detectors add the specifics. */
function draft(spec) {
  return {
    quality_impacts: { changeability: 'high', reliability: 'low', security: 'low' },
    blast_radius: 'bounded',
    recovery: { type: 'revert', notes: 'Structural changes land as small commits; reverting restores the previous dependency shape.' },
    ...spec,
  };
}

function define({ name, kinds, defaults = {}, run }) {
  return {
    id: `module.${name}`,
    version: '1.0.0',
    category: 'module',
    kinds,
    detect(ctx) {
      const options = {};
      for (const [k, v] of Object.entries(defaults)) options[k] = opt(ctx.options, k, v);
      return run(ctx.graph, options, ctx.options ?? {});
    },
  };
}

const testsOn = (graph, ids) => ids.reduce((n, id) => n + graph.in(id, 'TESTS').length, 0);
const verifyStructural = (tests) => [
  tests === 0
    ? 'Few or no tests cover these modules: add characterization tests for the imports being moved first.'
    : `Run the ${tests} covering test(s) before and after each step.`,
  'Re-run `unknot map` and confirm the finding disappears and no new cycle appears.',
  'Run the project type check, linter and build.',
];

// ---------------------------------------------------------------------------------------
// dependency-cycle (module level and package level)
// ---------------------------------------------------------------------------------------

const dependencyCycle = define({
  name: 'dependency-cycle',
  kinds: ['module.dependency-cycle', 'module.package-cycle'],
  defaults: { min_size: 2 },
  run(graph, o) {
    const out = [];
    const mods = sourceModules(graph);
    const modIds = new Set(mods.map((m) => m.id));

    for (const comp of stronglyConnected(graph, { edgeTypes: IMPORT, nodeTypes: ['module'] })) {
      const members = comp.filter((id) => modIds.has(id));
      if (members.length < o.min_size) continue;
      const cycle = shortestCycle(graph, members, IMPORT) ?? members.slice(0, 2);
      const paths = cycle.map((id) => pathOf(graph, id));
      const tests = testsOn(graph, members);
      out.push(draft({
        kind: 'module.dependency-cycle',
        title: `${members.length} modules form an import cycle: ${[...paths, paths[0]].join(' -> ')}`,
        scope: members.map((id) => pathOf(graph, id)).slice(0, 50),
        key: `cycle:${members[0]}`,
        evidence: cycle.map((id, i) => ({
          ref: id,
          label: 'observed',
          summary: `imports ${pathOf(graph, cycle[(i + 1) % cycle.length])}`,
          source_ref: `${pathOf(graph, id)}:${graph.out(id, IMPORT).find((e) => e.to === cycle[(i + 1) % cycle.length])?.attrs?.line ?? 1}`,
        })),
        measurements: { 'cycle.size': members.length, 'tests.present': tests },
        thresholds: { min_size: o.min_size, 'min_size.note': 'a cycle of two or more modules is a defect in the acyclic-dependencies sense; no heuristic threshold' },
        why_accidental: 'Modules in a cycle cannot be understood, tested, versioned or released independently; the cycle is rarely a design choice.',
        essential_considerations: ['A cycle can be intentional in tightly coupled mutual recursion (parser and AST visitor) where splitting would be artificial.', 'Type-only or lazily evaluated imports may not form a runtime cycle.'],
        smallest_simplification: `Break the cycle at its weakest edge: move the shared definitions that ${paths[paths.length - 1]} needs from ${paths[0]} into a third module both import, or invert one edge behind an interface.`,
        invariants: ['Exported names and their behaviour are unchanged.', 'Import-time side effects keep their order.'],
        risks: ['Moving a definition changes import order and can expose initialisation-order bugs.', 'Public import paths change unless the old module re-exports.'],
        verification: verifyStructural(tests),
        quality_impacts: { changeability: 'high', reliability: 'medium', security: 'low' },
        blast_radius: members.length > 5 ? 'moderate' : 'bounded',
        factors: { benefit: clamp(Math.round(2 + Math.log2(members.length)), 1, 5), evidence: 0.9, reversibility: 0.9, blast: members.length > 5 ? 3 : 2, cost: clamp(Math.ceil(members.length / 3) + 1, 2, 5), uncertainty: 1 },
        uncertainties: ['Type-only imports are counted as edges when the adapter does not label them, which may overstate a cycle.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the cycle if the modules are one conceptual unit; then merge them or document the grouping so it is treated as a single component.' },
          { id: 'extract-shared', summary: 'Move the shared definitions to a third module that both depend on.' },
          { id: 'invert-dependency', summary: 'Invert one edge behind an interface owned by the depending side.' },
        ],
        patterns: ['domain.acyclic-dependencies', 'domain.dependency-inversion'],
      }));
    }

    // Package-level cycles: condense modules into packages and look for cycles of packages.
    const grouping = packageGrouping(graph, mods);
    const cg = condense(graph, (id) => (modIds.has(id) ? grouping.groupOf(id) : null), IMPORT);
    for (const comp of stronglyConnected(cg, { edgeTypes: ['DEPENDS_ON'] })) {
      if (comp.length < 2) continue;
      const cycle = shortestCycle(cg, comp, ['DEPENDS_ON']) ?? comp.slice(0, 2);
      const labels = cycle.map((g) => grouping.label(g));
      const members = mods.filter((m) => comp.includes(grouping.groupOf(m.id)));
      const edgeLines = cycle.map((g, i) => {
        const h = cycle[(i + 1) % cycle.length];
        const count = cg.out(g, 'DEPENDS_ON').find((e) => e.to === h)?.attrs.count ?? 0;
        return { from: g, to: h, count };
      });
      const sample = (g, h) => {
        for (const m of members) {
          if (grouping.groupOf(m.id) !== g) continue;
          const e = graph.out(m.id, IMPORT).find((x) => grouping.groupOf(x.to) === h);
          if (e) return `${m.path}:${e.attrs?.line ?? 1}`;
        }
        return null;
      };
      const tests = testsOn(graph, members.map((m) => m.id));
      out.push(draft({
        kind: 'module.package-cycle',
        title: `${comp.length} packages depend on each other in a cycle: ${[...labels, labels[0]].join(' -> ')}`,
        scope: sortedUnique(edgeLines.map((l) => sample(l.from, l.to)?.split(':')[0]).filter(Boolean)).slice(0, 50),
        key: `package-cycle:${comp[0]}`,
        evidence: edgeLines.map((l) => ({
          ref: l.from,
          label: 'observed',
          summary: `${grouping.label(l.from)} -> ${grouping.label(l.to)} via ${l.count} import(s)`,
          source_ref: sample(l.from, l.to),
        })),
        measurements: { 'cycle.size': comp.length, 'tests.present': tests },
        thresholds: { min_packages: 2, note: 'packages are CONTAINS package nodes, else the first directory below any shared root (heuristic grouping)' },
        why_accidental: 'Packages that depend on each other in a loop cannot be layered, released or extracted separately.',
        essential_considerations: ['The directory grouping may not match real package boundaries; a cycle between folders of one package is harmless.'],
        smallest_simplification: `Cut the weakest package edge (${[...edgeLines].sort((a, b) => a.count - b.count)[0].count} import(s)) by moving the imported definitions to the depending side or a shared package.`,
        invariants: ['Exported names and behaviour are unchanged.'],
        risks: ['Moving definitions across packages changes public import paths.'],
        verification: verifyStructural(tests),
        quality_impacts: { changeability: 'high', reliability: 'low', security: 'low' },
        blast_radius: 'moderate',
        factors: { benefit: clamp(2 + comp.length, 1, 5), evidence: 0.6, reversibility: 0.9, blast: 3, cost: 4, uncertainty: 2 },
        uncertainties: ['Package membership is inferred from directories unless the adapter emitted package CONTAINS edges.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it if the "packages" are really one component split across folders.' },
          { id: 'merge-packages', summary: 'Merge the cyclic packages into one.' },
          { id: 'extract-shared', summary: 'Extract the mutually needed definitions into a lower package.' },
        ],
        patterns: ['domain.acyclic-dependencies', 'domain.dependency-inversion'],
      }));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// unstable-dependency (Stable Dependencies Principle)
// ---------------------------------------------------------------------------------------

const unstableDependency = define({
  name: 'unstable-dependency',
  kinds: ['module.unstable-dependency'],
  defaults: { stable_max: 0.3, unstable_min: 0.7, min_dependents: 3 },
  run(graph, o) {
    const out = [];
    const mods = sourceModules(graph);
    const ids = mods.map((m) => m.id);
    const edges = moduleImports(graph, mods);
    const emit = ({ key, fromLabel, toLabel, fromI, toI, fromCa, count, ref, source_ref, scope, level, tests }) => {
      out.push(draft({
        kind: 'module.unstable-dependency',
        title: `${level} ${fromLabel} (instability ${fromI.toFixed(2)}) depends on ${toLabel} (instability ${toI.toFixed(2)})`,
        scope,
        key,
        evidence: [{ ref, label: 'observed', summary: `stable ${level} with ${fromCa} dependents imports a volatile one (${count} import(s))`, source_ref }],
        measurements: { 'module.instability': fromI, 'tests.present': tests },
        thresholds: { stable_max: o.stable_max, unstable_min: o.unstable_min, min_dependents: o.min_dependents, note: 'heuristic: Martin instability I = Ce/(Ca+Ce); the cut-offs are conventions' },
        why_accidental: 'A widely depended-on unit that itself depends on volatile code spreads that volatility to all its dependents.',
        essential_considerations: ['Instability reflects current dependencies, not intended volatility; a young module looks unstable only because few use it yet.'],
        smallest_simplification: `Introduce an interface owned by ${fromLabel} that ${toLabel} implements, so the stable side no longer imports the volatile one.`,
        invariants: ['Behaviour of the stable unit is unchanged.', 'Its public exports are unchanged.'],
        risks: ['Adds an interface that has one implementation until a second consumer exists.'],
        verification: verifyStructural(tests),
        factors: { benefit: 2, evidence: 0.6, reversibility: 0.9, blast: 2, cost: 3, uncertainty: 3 },
        uncertainties: ['Heuristic: the principle is a guide, and instability computed from a partial graph can mislead.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it if the "unstable" target is in fact slow-changing (check its churn) or the dependency is a stable data type.' },
          { id: 'invert-dependency', summary: 'Invert the edge with an interface owned by the stable side.' },
        ],
        patterns: ['domain.stable-dependencies', 'domain.dependency-inversion'],
      }));
    };

    // Module level: only modules with enough dependents, so a leaf script never qualifies.
    const mi = instability(graph, ids, IMPORT);
    for (const e of edges) {
      const a = mi.get(e.from);
      const b = mi.get(e.to);
      if (!a || !b || a.instability == null || b.instability == null) continue;
      if (a.instability > o.stable_max || b.instability < o.unstable_min || a.ca < o.min_dependents) continue;
      const ctx = pathOf(graph, e.from);
      emit({
        key: `sdp:${e.from}->${e.to}`, level: 'module', fromLabel: ctx, toLabel: pathOf(graph, e.to), fromI: a.instability, toI: b.instability,
        fromCa: a.ca, count: 1, ref: e.from, source_ref: `${ctx}:${e.attrs?.line ?? 1}`, scope: [ctx, pathOf(graph, e.to)], tests: testsOn(graph, [e.from, e.to]),
      });
    }

    // Package level over the same grouping used for cycles.
    const grouping = packageGrouping(graph, mods);
    const pkgOf = (id) => grouping.groupOf(id);
    const pi = instability(graph, ids, IMPORT, pkgOf);
    const pairs = new Map();
    for (const e of edges) {
      const g = pkgOf(e.from);
      const h = pkgOf(e.to);
      if (g == null || h == null || g === h) continue;
      const k = `${g}\0${h}`;
      if (!pairs.has(k)) pairs.set(k, { g, h, edges: [] });
      pairs.get(k).edges.push(e);
    }
    for (const k of [...pairs.keys()].sort()) {
      const { g, h, edges: es } = pairs.get(k);
      const a = pi.get(g);
      const b = pi.get(h);
      if (!a || !b || a.instability == null || b.instability == null) continue;
      if (a.instability > o.stable_max || b.instability < o.unstable_min || a.ca < o.min_dependents) continue;
      const first = es[0];
      emit({
        key: `sdp-package:${g}->${h}`, level: 'package', fromLabel: grouping.label(g), toLabel: grouping.label(h), fromI: a.instability, toI: b.instability,
        fromCa: a.ca, count: es.length, ref: first.from, source_ref: `${pathOf(graph, first.from)}:${first.attrs?.line ?? 1}`,
        scope: sortedUnique(es.slice(0, 10).flatMap((e) => [pathOf(graph, e.from), pathOf(graph, e.to)])), tests: testsOn(graph, es.map((e) => e.from)),
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// hub-module
// ---------------------------------------------------------------------------------------

const hubModule = define({
  name: 'hub-module',
  kinds: ['module.hub-module'],
  defaults: { fan_in: 15, fan_out: 15 },
  run(graph, o) {
    const out = [];
    const mods = sourceModules(graph);
    const ids = new Set(mods.map((m) => m.id));
    for (const m of mods) {
      const fi = sortedUnique(graph.in(m.id, IMPORT).map((e) => e.from).filter((f) => f !== m.id && ids.has(f)));
      const fo = sortedUnique(graph.out(m.id, IMPORT).map((e) => e.to).filter((t) => t !== m.id && ids.has(t)));
      if (fi.length < o.fan_in || fo.length < o.fan_out) continue;
      const tests = graph.in(m.id, 'TESTS').length;
      out.push(draft({
        kind: 'module.hub-module',
        title: `${m.path} is a hub: ${fi.length} modules import it and it imports ${fo.length}`,
        scope: [m.path],
        key: m.id,
        evidence: [{ ref: m.id, label: 'observed', summary: `fan-in ${fi.length}, fan-out ${fo.length}`, source_ref: `${m.path}:1` }],
        measurements: { 'module.fan_in': fi.length, 'module.fan_out': fo.length, 'module.consumers': fi.length, 'tests.present': tests, ...(m.attrs.churn_commits != null && { 'module.churn': m.attrs.churn_commits }) },
        thresholds: { fan_in: o.fan_in, fan_out: o.fan_out, note: 'heuristic: both directions high means changes ripple in and out' },
        why_accidental: 'A module both widely used and widely dependent is a coupling junction: any change to it or its dependencies touches many unrelated modules.',
        essential_considerations: ['An application composition root or an index/barrel file is expected to import widely.'],
        smallest_simplification: `Split ${m.path} so the part many modules use (stable types) is separate from the part that orchestrates many collaborators.`,
        invariants: ['Public exports remain importable from the original path (re-export).', 'Behaviour is unchanged.'],
        risks: ['Re-exports can hide new cycles.', 'Importers must be re-pointed in a coordinated change if re-exports are dropped.'],
        verification: verifyStructural(tests),
        blast_radius: 'high',
        factors: { benefit: 3, evidence: 0.9, reversibility: 0.9, blast: 4, cost: 4, uncertainty: 2 },
        uncertainties: ['A composition root or barrel file legitimately has high fan-out; check what the module is for before acting.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it if it is a composition root, router or barrel whose job is to connect things.' },
          { id: 'split-module', summary: 'Split the stable shared part from the orchestration part.' },
          { id: 'facade', summary: 'Narrow consumers to a small facade over the hub.' },
        ],
        patterns: ['anti-pattern.big-ball-of-mud', 'domain.module-facade'],
      }));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// shotgun-surgery (change coupling across packages)
// ---------------------------------------------------------------------------------------

const shotgunSurgery = define({
  name: 'shotgun-surgery',
  kinds: ['module.shotgun-surgery'],
  defaults: { min_packages: 4, min_degree: 0.5 },
  run(graph, o) {
    const out = [];
    const mods = sourceModules(graph);
    const ids = new Set(mods.map((m) => m.id));
    const grouping = packageGrouping(graph, mods);
    for (const m of mods) {
      const partners = [];
      for (const e of [...graph.out(m.id, 'CO_CHANGES'), ...graph.in(m.id, 'CO_CHANGES')]) {
        const other = e.from === m.id ? e.to : e.from;
        const degree = e.attrs?.degree ?? 0;
        if (!ids.has(other) || degree < o.min_degree) continue;
        partners.push({ id: other, degree, shared: e.attrs?.shared ?? 0 });
      }
      const pkgs = sortedUnique(partners.map((p) => grouping.groupOf(p.id)).filter((g) => g != null));
      if (pkgs.length < o.min_packages) continue;
      partners.sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
      const tests = graph.in(m.id, 'TESTS').length;
      out.push(draft({
        kind: 'module.shotgun-surgery',
        title: `Changing ${m.path} usually means changing ${partners.length} files across ${pkgs.length} packages`,
        scope: sortedUnique([m.path, ...partners.slice(0, 10).map((p) => pathOf(graph, p.id))]),
        key: m.id,
        evidence: [
          { ref: m.id, label: 'observed', summary: `${partners.length} co-change partners with degree >= ${o.min_degree} in ${pkgs.length} packages`, source_ref: `${m.path}:1` },
          ...partners.slice(0, 4).map((p) => ({ ref: p.id, label: 'observed', summary: `changed together in ${p.shared} commits (degree ${p.degree})`, source_ref: `${pathOf(graph, p.id)}:1` })),
        ],
        measurements: { 'module.churn': m.attrs.churn_commits ?? partners.reduce((n, p) => Math.max(n, p.shared), 0), 'module.co_change_leak': Math.min(1, partners.reduce((mx, p) => Math.max(mx, p.degree), 0)), 'tests.present': tests },
        thresholds: { min_packages: o.min_packages, min_degree: o.min_degree, note: 'heuristic: co-change shows historical coupling, not necessarily a design defect' },
        why_accidental: 'One conceptual change is smeared across many packages, so every change risks missing a spot.',
        essential_considerations: ['Bulk edits (renames, dependency bumps, formatting) can produce co-change that does not reflect coupling.', 'A genuinely cross-cutting concern (logging, auth) will legitimately touch many places.'],
        smallest_simplification: `Gather the duplicated knowledge that ${m.path} and its top partners (${partners.slice(0, 2).map((p) => pathOf(graph, p.id)).join(', ')}) all encode into one module that owns it.`,
        invariants: ['Behaviour of all touched modules is unchanged.'],
        risks: ['Co-change may come from mass edits rather than shared knowledge.', 'Consolidation moves code across package boundaries.'],
        verification: ['Inspect the commits behind the co-change to confirm they share a reason, not a mass edit.', ...verifyStructural(tests)],
        blast_radius: 'moderate',
        factors: { benefit: 3, evidence: 0.6, reversibility: 0.9, blast: 3, cost: 4, uncertainty: 3 },
        uncertainties: ['Derived from git history (inferred coupling), not from the dependency graph.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it if the co-change is a mass edit or a deliberate cross-cutting concern.' },
          { id: 'consolidate', summary: 'Move the shared knowledge into one owning module.' },
          { id: 'introduce-interface', summary: 'Put the changing decision behind one interface so partners stop changing with it.' },
        ],
        patterns: ['anti-pattern.shotgun-surgery', 'domain.package-by-feature'],
      }));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// implementation-leakage
// ---------------------------------------------------------------------------------------

const baseSeg = (p) => p.split('/').pop();
const isPrivateSeg = (s) => /^_[^_]/.test(s) || /^_$/.test(s);

/** Packages with a directory and the entry files they declare (main/exports/bin/...). */
function packageEntries(graph) {
  const pkgs = [];
  for (const p of graph.nodes('package')) {
    const dir = p.attrs?.dir && p.attrs.dir !== '.' ? p.attrs.dir : (p.path?.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '');
    const entries = new Set();
    const collect = (v) => {
      if (typeof v === 'string') entries.add(`${dir ? `${dir}/` : ''}${v.replace(/^\.\//, '')}`.replace(/\.[^./]+$/, ''));
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    for (const k of ['main', 'module', 'exports', 'bin', 'entry', 'types']) collect(p.attrs?.[k]);
    pkgs.push({ id: p.id, dir, entries });
  }
  // Longest directory first so nested workspace packages win over a root manifest.
  return pkgs.filter((p) => p.dir).sort((a, b) => b.dir.length - a.dir.length);
}

const implementationLeakage = define({
  name: 'implementation-leakage',
  kinds: ['module.implementation-leakage'],
  run(graph) {
    const out = [];
    const mods = sourceModules(graph);
    const grouping = packageGrouping(graph, mods);
    const pkgs = packageEntries(graph);
    const ownerOf = (path) => pkgs.find((p) => path === p.dir || path.startsWith(`${p.dir}/`)) ?? null;
    const regionOf = (m) => ownerOf(m.path ?? '')?.id ?? grouping.groupOf(m.id);

    const leaks = new Map(); // target id -> { reason, importers: [{ from, line }] }
    for (const e of moduleImports(graph, mods)) {
      const from = graph.node(e.from);
      const to = graph.node(e.to);
      if (!from.path || !to.path) continue;
      const rf = regionOf(from);
      const rt = regionOf(to);
      if (rf == null || rt == null || rf === rt) continue;
      const owner = ownerOf(to.path);
      const segs = to.path.split('/');
      let reason = null;
      if (segs.includes('internal')) reason = 'lives under an internal/ directory';
      else if (segs.some(isPrivateSeg)) reason = 'lives under an underscore-prefixed (private by convention) path';
      else if (owner && owner.entries.size && !owner.entries.has(to.path.replace(/\.[^./]+$/, '')) && !(baseSeg(to.path).replace(/\.[^.]+$/, '') === 'index' && owner.entries.has(to.path.replace(/\/index\.[^./]+$/, '')))) {
        reason = `is not one of the declared entry points of ${graph.node(owner.id)?.name ?? owner.dir}`;
      }
      if (!reason) continue;
      if (!leaks.has(to.id)) leaks.set(to.id, { reason, importers: [] });
      leaks.get(to.id).importers.push({ from: from.id, line: e.attrs?.line ?? 1 });
    }

    for (const id of [...leaks.keys()].sort()) {
      const { reason, importers } = leaks.get(id);
      const t = graph.node(id);
      const uniq = sortedUnique(importers.map((i) => i.from));
      const tests = graph.in(id, 'TESTS').length;
      out.push(draft({
        kind: 'module.implementation-leakage',
        title: `${uniq.length} module(s) in other packages import ${t.path}, which ${reason}`,
        scope: sortedUnique([t.path, ...uniq.slice(0, 10).map((f) => pathOf(graph, f))]),
        key: id,
        evidence: [
          { ref: id, label: 'observed', summary: `non-public module: ${reason}`, source_ref: `${t.path}:1` },
          ...importers.slice(0, 5).map((i) => ({ ref: i.from, label: 'observed', summary: `imports ${t.path} across a package boundary`, source_ref: `${pathOf(graph, i.from)}:${i.line}` })),
        ],
        measurements: { 'module.consumers': uniq.length, 'module.fan_in': uniq.length, 'tests.present': tests },
        thresholds: { note: 'heuristic: internal/, underscore paths and undeclared entry points are conventions for non-public code' },
        why_accidental: 'Importers depend on internals the owner never promised to keep, so the owner cannot refactor without breaking them.',
        essential_considerations: ['A deliberately shared "internal" helper used by sibling packages of one team may be fine inside a single repository.', 'Package directories inferred without manifests may not be true package boundaries.'],
        smallest_simplification: `Expose what the importers need through the owning package's public entry point (or a small facade) and re-point the ${uniq.length} importer(s) to it.`,
        invariants: ['Behaviour of the exported functions is unchanged.', 'The new public entry exposes only what importers actually use.'],
        risks: ['Widening the public surface commits the owner to supporting it.', 'Importer edits span several packages.'],
        verification: verifyStructural(tests),
        factors: { benefit: 2 + Math.min(2, uniq.length / 3), evidence: 0.6, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 2 },
        uncertainties: ['Public/private status is inferred from path conventions and package manifests, not from a declared visibility rule.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the import if the packages are owned and released together and the path convention is not enforced.' },
          { id: 'module-facade', summary: 'Add a public facade and route importers through it.' },
          { id: 'move-module', summary: 'Move the module into the importing package if it is really theirs.' },
        ],
        patterns: ['domain.module-facade', 'domain.dependency-inversion'],
      }));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// oversized-api
// ---------------------------------------------------------------------------------------

const names = (list) => (Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean) : []);

const oversizedApi = define({
  name: 'oversized-api',
  kinds: ['module.oversized-api'],
  defaults: { min_exports: 10, max_used_ratio: 0.3 },
  run(graph, o) {
    const out = [];
    for (const m of sourceModules(graph)) {
      // A barrel only re-exports; a generated component library exports its whole set by
      // design; types used in public signatures are part of the API, not surplus.
      const exps = Array.isArray(m.attrs.exports) ? m.attrs.exports : [];
      if (exps.length && exps.every((e) => e?.from || e?.kind === 'reexport')) continue;
      if (inLibraryDir(graph, m.path)) continue;
      const exported = sortedUnique(names(exps.filter((e) => !['interface', 'type', 'type_alias', 'enum_type'].includes(e?.kind))));
      if (exported.length < o.min_exports) continue;
      const inbound = graph.in(m.id, IMPORT).filter((e) => e.from !== m.id && !isTestModule(graph.node(e.from)));
      if (!inbound.length) continue;
      // Usage is only knowable when every importer lists names: a namespace/star import hides it.
      let unknown = false;
      const used = new Set();
      for (const e of inbound) {
        const ns = names(e.attrs?.names);
        if (!Array.isArray(e.attrs?.names) || !ns.length || ns.includes('*')) { unknown = true; break; }
        ns.forEach((n) => used.add(n));
      }
      if (unknown) continue;
      const usedExports = exported.filter((n) => used.has(n));
      const ratio = usedExports.length / exported.length;
      if (ratio >= o.max_used_ratio) continue;
      const unused = exported.filter((n) => !used.has(n));
      const tests = graph.in(m.id, 'TESTS').length;
      out.push(draft({
        kind: 'module.oversized-api',
        title: `${m.path} exports ${exported.length} names but only ${usedExports.length} (${Math.round(ratio * 100)}%) are imported anywhere`,
        scope: [m.path],
        key: m.id,
        evidence: [{ ref: m.id, label: 'observed', summary: `${unused.length} exports never imported, e.g. ${unused.slice(0, 5).join(', ')}`, source_ref: `${m.path}:1` }],
        measurements: { 'module.public_exports': exported.length, 'module.consumers': inbound.length, 'symbol.references': usedExports.length, 'tests.present': tests },
        thresholds: { min_exports: o.min_exports, max_used_ratio: o.max_used_ratio, note: 'heuristic: only static named imports are visible; dynamic access and external consumers are not' },
        why_accidental: 'Exports nobody uses widen the surface the module must keep stable and hide the part that matters.',
        essential_considerations: ['The module may be a published library whose consumers are outside this repository.'],
        smallest_simplification: `Stop exporting the ${unused.length} unused names from ${m.path} (make them private), keeping the ${usedExports.length} in use.`,
        invariants: ['The names that are imported keep their signatures and behaviour.'],
        risks: ['External or dynamic consumers may use the unexported names.'],
        verification: verifyStructural(tests),
        blast_radius: 'local',
        factors: { benefit: 2, evidence: 0.6, reversibility: 0.9, blast: 1, cost: 2, uncertainty: 2 },
        uncertainties: ['Usage is derived from static named imports inside this repository.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the wide surface if this is a published API for external callers.' },
          { id: 'narrow-exports', summary: 'Un-export unused names.' },
          { id: 'facade', summary: 'Publish a small facade module and keep the rest internal.' },
        ],
        patterns: ['domain.module-facade', 'anti-pattern.speculative-generality'],
      }));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// low-cohesion-package
// ---------------------------------------------------------------------------------------

const lowCohesionPackage = define({
  name: 'low-cohesion-package',
  kinds: ['module.low-cohesion-package'],
  defaults: { max_internal_ratio: 0.3, min_modules: 3, min_imports: 6 },
  run(graph, o) {
    const out = [];
    const mods = sourceModules(graph);
    const grouping = packageGrouping(graph, mods);
    const stats = new Map();
    for (const e of moduleImports(graph, mods)) {
      const g = grouping.groupOf(e.from);
      if (g == null) continue;
      const s = stats.get(g) ?? { internal: 0, total: 0, modules: new Set(), outward: [] };
      s.total++;
      if (grouping.groupOf(e.to) === g) s.internal++;
      else s.outward.push(e);
      stats.set(g, s);
    }
    for (const m of mods) {
      const g = grouping.groupOf(m.id);
      if (g != null && stats.has(g)) stats.get(g).modules.add(m.id);
    }
    for (const g of [...stats.keys()].sort()) {
      const s = stats.get(g);
      const members = mods.filter((m) => grouping.groupOf(m.id) === g);
      if (members.length < o.min_modules || s.total < o.min_imports) continue;
      const ratio = s.internal / s.total;
      if (ratio >= o.max_internal_ratio) continue;
      const targets = new Map();
      for (const e of s.outward) { const t = grouping.groupOf(e.to); targets.set(t, (targets.get(t) ?? 0) + 1); }
      const topTargets = [...targets].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 3).map(([t, n]) => `${t == null ? '(top level)' : grouping.label(t)} (${n})`);
      const label = grouping.label(g);
      const tests = testsOn(graph, members.map((m) => m.id));
      out.push(draft({
        kind: 'module.low-cohesion-package',
        title: `Package ${label} is mostly outward-looking: ${s.internal} of ${s.total} imports (${Math.round(ratio * 100)}%) stay inside it`,
        scope: members.map((m) => m.path).slice(0, 50),
        key: `package:${g}`,
        evidence: [{ ref: members[0].id, label: 'observed', summary: `${members.length} modules; most imports go to ${topTargets.join(', ')}`, source_ref: `${members[0].path}:1` }],
        measurements: { 'module.fan_out': targets.size, 'module.consumers': stats.get(g).modules.size, 'tests.present': tests },
        thresholds: { max_internal_ratio: o.max_internal_ratio, min_modules: o.min_modules, min_imports: o.min_imports, note: 'heuristic: cohesion judged from import direction alone; grouping is by package node or first directory' },
        why_accidental: 'Modules grouped together but depending mostly on other packages suggest the grouping follows layers or history, not the thing that changes together.',
        essential_considerations: ['A layer-organised package (controllers, adapters) is expected to depend mostly outward.', 'Thin glue packages naturally import more than they share.'],
        smallest_simplification: `Move the modules of ${label} that mostly import one other package into that package (or a feature folder) and leave the genuinely shared ones.`,
        invariants: ['Behaviour is unchanged.', 'Public import paths are re-exported during the move.'],
        risks: ['Moving files changes import paths and git blame continuity.', 'Layered architectures are cohesive in a different sense.'],
        verification: verifyStructural(tests),
        blast_radius: 'moderate',
        factors: { benefit: 2, evidence: 0.6, reversibility: 0.9, blast: 3, cost: 3, uncertainty: 3 },
        uncertainties: ['Heuristic: low cohesion by imports is only a hint of poor boundaries; organisation by layer is a legitimate alternative.'],
        alternatives: [
          { id: 'retain', summary: 'Keep it if the package is a deliberate layer or adapter group.' },
          { id: 'package-by-feature', summary: 'Regroup the modules by the feature they serve.' },
        ],
        patterns: ['domain.package-by-feature', 'anti-pattern.big-ball-of-mud'],
      }));
    }
    return out;
  },
});

// ---------------------------------------------------------------------------------------
// layer-bypass (needs configured layers)
// ---------------------------------------------------------------------------------------

/** options.layers: ordered top -> bottom; each entry a glob, a list of globs or {name, glob(s)}. */
function parseLayers(layers) {
  if (!Array.isArray(layers)) return [];
  return layers.map((l, i) => {
    const globs = typeof l === 'string' ? [l] : Array.isArray(l) ? l : [].concat(l?.globs ?? l?.glob ?? []);
    const name = typeof l === 'object' && !Array.isArray(l) && l?.name ? l.name : (globs[0] ?? `layer-${i}`);
    return { name, index: i, res: globs.map((g) => globToRegExp(g)) };
  });
}

const layerBypass = define({
  name: 'layer-bypass',
  kinds: ['module.layer-bypass'],
  defaults: { min_skipped: 2 },
  run(graph, o, raw) {
    const layers = parseLayers(raw.layers);
    if (layers.length < 2) return [];
    const strict = raw.strict === true;
    const layerOf = (path) => layers.find((l) => l.res.some((re) => re.test(path))) ?? null;
    const mods = sourceModules(graph);
    const groups = new Map();
    for (const e of moduleImports(graph, mods)) {
      const a = layerOf(pathOf(graph, e.from));
      const b = layerOf(pathOf(graph, e.to));
      if (!a || !b || a.index === b.index) continue;
      let kind = null;
      if (a.index > b.index) kind = 'upward';
      else if (strict && b.index - a.index - 1 >= o.min_skipped) kind = 'skip';
      if (!kind) continue;
      const key = `${kind}:${a.name}->${b.name}`;
      if (!groups.has(key)) groups.set(key, { kind, a, b, edges: [] });
      groups.get(key).edges.push(e);
    }
    const out = [];
    for (const key of [...groups.keys()].sort()) {
      const { kind, a, b, edges } = groups.get(key);
      const first = edges[0];
      const tests = testsOn(graph, edges.map((e) => e.from));
      const skipped = b.index - a.index - 1;
      out.push(draft({
        kind: 'module.layer-bypass',
        title: kind === 'upward'
          ? `${edges.length} import(s) from lower layer ${a.name} up to higher layer ${b.name}`
          : `${edges.length} import(s) from ${a.name} skip ${skipped} layers to reach ${b.name}`,
        scope: sortedUnique(edges.slice(0, 20).flatMap((e) => [pathOf(graph, e.from)])),
        key,
        evidence: edges.slice(0, 5).map((e) => ({ ref: e.from, label: 'observed', summary: `imports ${pathOf(graph, e.to)} (${kind === 'upward' ? 'upward' : `skips ${skipped} layers`})`, source_ref: `${pathOf(graph, e.from)}:${e.attrs?.line ?? 1}` })),
        measurements: { 'layer.violations': edges.length, 'tests.present': tests },
        thresholds: { layers: layers.map((l) => l.name), strict, min_skipped: o.min_skipped, note: 'configured: violations are relative to the layer order in config, not inferred' },
        why_accidental: kind === 'upward' ? 'A lower layer reaching up inverts the intended dependency direction and couples it to its callers.' : 'Skipping intermediate layers bypasses the policy (validation, transactions, auth) those layers enforce.',
        essential_considerations: ['The configured layering may not reflect an intentional exception (a shared types module, a composition root).'],
        smallest_simplification: kind === 'upward'
          ? `Invert the dependency in ${pathOf(graph, first.from)}: define an interface in ${a.name} that ${b.name} implements.`
          : `Route ${pathOf(graph, first.from)} through the adjacent layer instead of importing ${pathOf(graph, first.to)} directly.`,
        invariants: ['Behaviour is unchanged.', 'The adjacent layer applies the same checks the bypass skipped.'],
        risks: ['An intermediate layer may need a new pass-through function.', 'The bypassed layer may enforce rules the direct import silently skipped.'],
        verification: verifyStructural(tests),
        blast_radius: 'bounded',
        factors: { benefit: 2 + Math.min(2, edges.length / 5), evidence: 0.9, reversibility: 0.9, blast: 2, cost: 3, uncertainty: 1 },
        uncertainties: ['Layer membership comes from the configured globs; modules matching no layer are ignored.'],
        alternatives: [
          { id: 'retain', summary: 'Keep the import and add an explicit exception if it is a deliberate, documented shortcut.' },
          { id: 'invert-dependency', summary: 'Invert the edge behind an interface owned by the higher layer.' },
          { id: 'route-through-layer', summary: 'Route through the adjacent layer.' },
        ],
        patterns: ['domain.dependency-inversion', 'domain.acyclic-dependencies'],
      }));
    }
    return out;
  },
});

export default [
  dependencyCycle,
  unstableDependency,
  hubModule,
  shotgunSurgery,
  implementationLeakage,
  oversizedApi,
  lowCohesionPackage,
  layerBypass,
];
