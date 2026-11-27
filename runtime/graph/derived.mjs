// Derived facts (roadmap item 6): conclusions every command shares, computed once per graph
// generation from the projected graph and stored in `derived(generation, kind, key, body)`.
// `graph cycles`, the cycle and unused-injected-member detectors, decomposition and the
// API-compatibility check read them here instead of deriving their own view, so they cannot
// disagree.
//
//   scc          every strongly connected component over module IMPORTS edges: members,
//                elementary cycles (capped, `truncated`), edges to cut, and whether `diagnose`
//                reports it (`finding`) or why not (`reason`)
//   scc_strict   the same over IMPORTS edges that are neither lazy nor type-only (runtime cycles)
//   declared_only every IMPORTS edge held only by a member nobody uses, with its component
//   public_surface per module: exported symbols and public members
//   test_code    modules that are test code
//   ownership    module -> owners (OWNED_BY)

import { cycleBreakdown, stronglyConnected } from './algorithms.mjs';
import { language } from './languages.mjs';
import { packageName } from '../core/paths.mjs';

export const DERIVED_KINDS = ['scc', 'scc_strict', 'declared_only', 'public_surface', 'test_code', 'ownership'];
/** The only edges derived facts read: a graph of these and every node computes the same facts. */
export const DERIVED_EDGE_TYPES = ['IMPORTS', 'CONTAINS', 'DEPENDS_ON', 'OWNED_BY'];
// Bumped when a stored body changes shape, so facts an older version wrote for the same generation are recomputed.
// 2: scc carries impossible_by_build (#72). 3: rows keep the generation they were written at and the `_done` row of a
// generation names it (`rows`), so a map that changes a few rows does not rewrite the others (#145).
const DERIVED_VERSION = 3;

const doneOf = (ctx, generation) => JSON.parse(ctx.store.get("SELECT body FROM derived WHERE kind = '_done' AND generation = ?", generation)?.body ?? '{}');
/** Whether the stored facts are complete for `generation` and written by this version. */
export const derivedDone = (ctx, generation) => doneOf(ctx, generation).v === DERIVED_VERSION;
/** The generation the rows of `generation`'s facts are stored under, or null when there are none. */
export const rowsGeneration = (ctx, generation) => {
  const done = doneOf(ctx, generation);
  return done.v === DERIVED_VERSION ? done.rows : null;
};
/** Cycles listed per component; consumers needing more recompute that one component. */
export const MAX_CYCLES = 50;
/** Smallest component the cycle detector reports (its default `min_size`). */
export const MIN_FINDING_SIZE = 2;

const IMPORT = ['IMPORTS'];
const isTest = (n) => !n || n.attrs?.is_test === true;

/**
 * The graph without references between files of one package where the language makes the
 * package the unit (`intra_package`, Go): such files form no import cycle.
 */
export function cycleView(graph) {
  const view = Object.create(graph);
  view.out = (id, type) => graph.out(id, type).filter((e) => !e.attrs?.intra_package);
  return view;
}

/** The cycle view without lazy (function-body) and type-only imports: what a runtime cycle needs. */
export function strictView(graph) {
  const base = cycleView(graph);
  const strict = Object.create(graph);
  strict.out = (id, type) => base.out(id, type).filter((e) => !(e.attrs?.lazy || e.attrs?.type_only));
  return strict;
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * Whether a component spans build units its build refuses to have in a cycle (#72): .NET projects,
 * Maven and Gradle modules, crates (`buildUnit`) and Go packages (`packageUnit`), for languages whose
 * row sets `acyclicUnits`. Then an edge is an analysis artifact or the code does not build;
 * `closing_edges` are the edges between units that go against the declared references, each with
 * its `reason`, else every edge whose units' references are not known (Go packages, Maven and Gradle
 * modules, a project with an unresolved reference). When every edge follows a declared reference
 * (a Cargo dev-dependency runs both ways), the build allows it: no mark.
 * A file of a unit whose project file could not be read is unknown, and decides nothing.
 * @returns {{units: string[], closing: object[]} | null}
 */
export function impossibleByBuild(graph, members, view = cycleView(graph)) {
  const unitOf = new Map();
  for (const id of members) {
    const n = graph.node(id);
    const row = language(n?.attrs?.language);
    if (!row?.acyclicUnits) continue;
    if (row.genericSyntax?.packageUnit) { unitOf.set(id, { id: `dir:${dirOf(n.path ?? '')}`, name: dirOf(n.path ?? '') || '.' }); continue; }
    const pkg = graph.in(id, 'CONTAINS').map((e) => graph.node(e.from)).find((p) => p?.type === 'package');
    if (!pkg) continue;
    if (pkg.attrs?.parse_error) continue;
    // Only .NET and Cargo references are read completely (see adapters/language/generic/build-graph.mjs).
    unitOf.set(id, { id: pkg.id, name: packageName(graph, pkg.id), known: ['dotnet', 'cargo'].includes(pkg.attrs?.ecosystem) && !pkg.attrs?.references_unresolved });
  }
  if (new Set([...unitOf.values()].map((u) => u.id)).size < 2) return null;
  const inComp = new Set(members);
  const cross = members.flatMap((id) => view.out(id, 'IMPORTS').filter((e) => inComp.has(e.to) && unitOf.has(id) && unitOf.has(e.to) && unitOf.get(id).id !== unitOf.get(e.to).id));
  if (!cross.length) return null;
  const reaches = (a, b) => {
    const seen = new Set([a]);
    for (const queue = [a]; queue.length;) for (const e of graph.out(queue.pop(), 'DEPENDS_ON')) if (!seen.has(e.to)) { if (e.to === b) return true; seen.add(e.to); queue.push(e.to); }
    return false;
  };
  // An edge follows a reference its source declares; it goes against the build when its target
  // declares the reverse (the edge would close a cycle) or its source declares no path to it.
  const verdict = (e) => {
    const x = unitOf.get(e.from);
    const y = unitOf.get(e.to);
    if (x.known && reaches(x.id, y.id)) return 'declared';
    if (y.known && reaches(y.id, x.id)) return `${y.name} references ${x.name}`;
    return x.known ? `${x.name} does not reference ${y.name}` : 'unknown';
  };
  const judged = cross.map((e) => ({ e, v: verdict(e) }));
  const against = judged.filter((j) => j.v !== 'declared' && j.v !== 'unknown');
  const closingEdges = against.length ? against : judged.filter((j) => j.v === 'unknown');
  if (!closingEdges.length) return null;
  const closing = closingEdges
    .map(({ e, v }) => ({ from: e.from, to: e.to, from_unit: unitOf.get(e.from).name, to_unit: unitOf.get(e.to).name, ...(v !== 'unknown' && { reason: v }) }))
    .sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));
  return { units: [...new Set([...unitOf.values()].map((u) => u.name))].sort(), closing };
}

/** One warning line per component the build forbids. */
export const impossibleWarning = (c) => `cycle across build units ${c.build_units.join(' and ')} cannot be built: one of its edges is an analysis artifact, or the code does not build; check ${c.closing_edges.slice(0, 5).map((e) => `${e.from.replace(/^module:/, '')} → ${e.to.replace(/^module:/, '')}${e.reason ? ` (${e.reason})` : ''}`).join('; ')}${c.closing_edges.length > 5 ? `; and ${c.closing_edges.length - 5} more` : ''}`;

/** A component's body; `strictHere` are the strict (runtime) components among its members. */
function sccBody(graph, view, members, strictHere) {
  const b = cycleBreakdown(view, members, { edgeTypes: IMPORT, maxCycles: MAX_CYCLES });
  const nonTest = (c) => c.filter((id) => !isTest(graph.node(id))).length;
  const reported = strictHere.some((c) => nonTest(c) >= MIN_FINDING_SIZE);
  const reason = reported ? undefined
    : members.length === 1 ? 'a module importing itself is not a dependency cycle'
    : !strictHere.length ? 'closes only through lazy or type-only imports, which are not a runtime cycle'
    : 'fewer than two non-test modules take part';
  const build = impossibleByBuild(graph, members, view);
  return { ...(build && { impossible_by_build: true, build_units: build.units, closing_edges: build.closing }), members, size: members.length, cycles: b.cycles, truncated: b.truncated, cut: b.cut, ...(b.cut_heuristic && { cut_heuristic: true }), ...(b.cut_minimal === false && { cut_minimal: false }), declared_only: b.cut.filter((e) => e.declared_only).length, finding: reported, ...(reason && { reason }) };
}

/** The row of an IMPORTS edge held only by an unused member; `comp` is the component holding both ends, or null. */
function declaredRow(graph, e, comp) {
  const from = graph.node(e.from);
  const to = graph.node(e.to);
  return { key: `${e.from}>${e.to}`, body: { from: e.from, to: e.to, member: e.attrs.unused_member ?? null, visibility: e.attrs.member_visibility ?? null, line: e.attrs.line ?? null, component: comp, modules: from?.type === 'module' && to?.type === 'module', test: isTest(from) || isTest(to) } };
}

/** @returns {Record<string, {key: string, body: object}[]>} the facts by kind, each sorted by key */
export function computeDerived(graph) {
  const view = cycleView(graph);
  const sccs = stronglyConnected(view, { edgeTypes: IMPORT, nodeTypes: ['module'] });
  const strict = stronglyConnected(strictView(graph), { edgeTypes: IMPORT, nodeTypes: ['module'] });
  const compOf = new Map();
  for (const c of sccs) for (const id of c) compOf.set(id, c[0]);

  const scc = sccs.map((members) => {
    const inComp = new Set(members);
    return { key: members[0], body: sccBody(graph, view, members, strict.filter((c) => inComp.has(c[0]))) };
  });

  const declared = graph.edges('IMPORTS').filter((e) => e.attrs?.declared_only && e.from !== e.to)
    .sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))
    .map((e) => declaredRow(graph, e, compOf.get(e.from) !== undefined && compOf.get(e.from) === compOf.get(e.to) ? compOf.get(e.from) : null));

  return {
    scc,
    scc_strict: strict.map((members) => ({ key: members[0], body: { members } })),
    declared_only: declared,
    ...nodeFacts(graph),
  };
}

/** The facts read straight off module nodes: cheap, so they never wait for the components. */
function nodeFacts(graph) {
  const out = { public_surface: [], test_code: [], ownership: [] };
  for (const m of [...graph.nodes('module')].sort((a, b) => (a.id < b.id ? -1 : 1))) for (const [kind, body] of moduleRows(graph, m)) out[kind].push({ key: m.id, body });
  return out;
}

/** What one module puts in the node-level kinds, as [kind, body] pairs. */
function moduleRows(graph, m) {
  const rows = [];
  const exports = (m.attrs?.exports ?? []).map((e) => e.name ?? e).filter((x) => typeof x === 'string');
  const members = m.attrs?.public_members ?? [];
  if (exports.length || members.length) rows.push(['public_surface', { exports, public_members: members }]);
  if (m.attrs?.is_test === true) rows.push(['test_code', {}]);
  const own = [...new Set(graph.out(m.id, 'OWNED_BY').map((e) => e.to))].sort();
  if (own.length) rows.push(['ownership', { owners: own }]);
  return rows;
}

const bodies = (rows) => rows.map((r) => r.body);
const tag = (d, generation) => Object.defineProperty(d, 'generation', { value: generation, enumerable: false });
const NODE_KINDS = new Set(['public_surface', 'test_code', 'ownership']);
const nodeCache = new WeakMap();
const cache = new WeakMap(); // graph -> derived facts (stored ones when read through readDerived)

/** Facts of one kind for an in-memory graph: the ones seeded from the store, else computed once. */
export function derivedFor(graph, kind) {
  let d = cache.get(graph);
  if (!d && NODE_KINDS.has(kind)) {
    // A node-level kind of a graph nothing has seeded: compute only those, not the components.
    const own = nodeCache.get(graph) ?? nodeCache.set(graph, nodeFacts(graph)).get(graph);
    return own[kind];
  }
  if (!d) cache.set(graph, (d = computeDerived(graph)));
  return d[kind];
}

/** The component bodies with the member list of each, in key order. */
export const sccsOf = (graph) => bodies(derivedFor(graph, 'scc'));
export const testSet = (graph) => new Set(derivedFor(graph, 'test_code').map((r) => r.key));

/** Replace the stored facts with those of `graph`, tagged with the generation. */
export function writeDerived(ctx, graph, generation = Number(ctx.store.meta('generation') ?? 0)) {
  const d = computeDerived(graph);
  cache.set(graph, tag(d, generation));
  const ins = ctx.store.db.prepare('INSERT INTO derived(generation, kind, key, body) VALUES (?, ?, ?, ?)');
  ctx.store.tx(() => {
    ctx.store.run('DELETE FROM derived');
    for (const kind of DERIVED_KINDS) for (const r of d[kind]) ins.run(generation, kind, r.key, JSON.stringify(r.body));
    ctx.store.run("INSERT OR REPLACE INTO derived(generation, kind, key, body) VALUES (?, '_done', '', ?)", generation, JSON.stringify({ v: DERIVED_VERSION, rows: generation }));
  });
  return d;
}

/** The stored graph read one node and one adjacency list at a time, in the order `Graph.fromStore` gives them. */
function storeGraph(store) {
  const nodes = new Map();
  const getNode = store.db.prepare('SELECT * FROM nodes WHERE id = ?');
  const edge = (r) => ({ id: r.id, type: r.type, from: r.src, to: r.dst, attrs: JSON.parse(r.attrs), label: r.label, fact_ids: JSON.parse(r.fact_ids) });
  const out = store.db.prepare('SELECT * FROM edges WHERE src = ? ORDER BY id');
  const inn = store.db.prepare('SELECT * FROM edges WHERE dst = ? ORDER BY id');
  const pick = (rows, type) => (type ? rows.filter((r) => (Array.isArray(type) ? type.includes(r.type) : r.type === type)) : rows).map(edge);
  const g = {
    node(id) {
      if (!nodes.has(id)) {
        const r = getNode.get(id);
        nodes.set(id, r ? { id: r.id, type: r.type, name: r.name, path: r.path, attrs: JSON.parse(r.attrs), label: r.label, fact_ids: JSON.parse(r.fact_ids) } : null);
      }
      return nodes.get(id);
    },
    // Only package names (packageName) list nodes by type; there are few.
    nodes: (type) => store.all('SELECT id FROM nodes WHERE type = ? ORDER BY id', type).map((r) => g.node(r.id)),
    out: (id, type) => pick(out.all(id), type),
    in: (id, type) => pick(inn.all(id), type),
  };
  return g;
}

/**
 * Bring the facts of generation `from` to `generation` when projection changed only the rows in
 * `delta` (node ids, and [type, src, dst] of edges written or deleted), reading only what those
 * reach (#145). Components and their strict parts depend on IMPORTS edges alone, and the build
 * check on package containment, packages and their references: a change to any of these returns
 * false, and the caller recomputes everything. Otherwise every component and declared-only edge
 * stays; only the rows of changed modules, and the components and declared-only edges holding
 * one, are worked out again. Rows keep their order (readers take them by rowid, in key order).
 */
export function updateDerived(ctx, delta, from, generation) {
  const at = rowsGeneration(ctx, from);
  if (at === null) return false;
  const typeOf = (id) => id.slice(0, id.indexOf(':'));
  // What a component or declared-only row reads of a node: whether it is one, its type, path, test flag and language.
  const seen = (row) => {
    if (!row) return null;
    const a = JSON.parse(row.attrs);
    return JSON.stringify([row.type, row.path, a.is_test ?? null, a.language ?? null]);
  };
  const touched = new Set(); // modules whose node-level rows may differ
  const mods = new Set(); // nodes whose components and declared-only rows may differ
  for (const [id, [before, after]] of delta.nodes) {
    if (typeOf(id) === 'package') return false;
    if (typeOf(id) === 'module') touched.add(id);
    if (seen(before) !== seen(after)) mods.add(id);
  }
  const owned = new Set();
  for (const [type, src, dst] of delta.edges) {
    if (type === 'IMPORTS' || type === 'DEPENDS_ON' || (type === 'CONTAINS' && typeOf(dst) === 'module')) return false;
    if (type === 'OWNED_BY' && typeOf(src) === 'module') owned.add(src);
  }
  const graph = storeGraph(ctx.store);
  const next = new Map(DERIVED_KINDS.map((k) => [k, new Map()])); // kind → key → body, null when gone
  for (const id of new Set([...touched, ...owned])) {
    const n = graph.node(id);
    const now = new Map(n?.type === 'module' ? moduleRows(graph, n) : []);
    for (const kind of NODE_KINDS) next.get(kind).set(id, now.get(kind) ?? null);
  }
  const stored = (kind) => ctx.store.all('SELECT key, body FROM derived WHERE generation = ? AND kind = ?', at, kind).map((r) => ({ key: r.key, body: JSON.parse(r.body) }));
  if (mods.size) {
    const strict = stored('scc_strict').map((r) => r.body.members);
    const view = cycleView(graph);
    for (const { key, body } of stored('scc')) {
      if (!body.members.some((id) => mods.has(id))) continue;
      const inComp = new Set(body.members);
      next.get('scc').set(key, sccBody(graph, view, body.members, strict.filter((c) => inComp.has(c[0]))));
    }
    for (const { key, body } of stored('declared_only')) {
      if (!mods.has(body.from) && !mods.has(body.to)) continue;
      next.get('declared_only').set(key, declaredRow(graph, graph.out(body.from, 'IMPORTS').find((e) => e.to === body.to), body.component).body);
    }
  }
  const has = ctx.store.db.prepare('SELECT 1 AS ok FROM derived WHERE generation = ? AND kind = ? AND key = ?');
  const set = ctx.store.db.prepare('UPDATE derived SET body = ? WHERE generation = ? AND kind = ? AND key = ?');
  const ins = ctx.store.db.prepare('INSERT INTO derived(generation, kind, key, body) VALUES (?, ?, ?, ?)');
  ctx.store.tx(() => {
    ctx.store.run("DELETE FROM derived WHERE kind = '_done'");
    ctx.store.run("INSERT INTO derived(generation, kind, key, body) VALUES (?, '_done', '', ?)", generation, JSON.stringify({ v: DERIVED_VERSION, rows: at }));
    for (const [kind, changes] of next) {
      if (!changes.size) continue;
      if ([...changes].every(([key, body]) => (body !== null) === Boolean(has.get(at, kind, key)))) {
        for (const [key, body] of changes) if (body !== null) set.run(JSON.stringify(body), at, kind, key);
        continue;
      }
      // A row comes or goes: the kind is written again in key order (only node-level kinds can).
      const rows = new Map(ctx.store.all('SELECT key, body FROM derived WHERE generation = ? AND kind = ?', at, kind).map((r) => [r.key, r.body]));
      for (const [key, body] of changes) if (body === null) rows.delete(key); else rows.set(key, JSON.stringify(body));
      ctx.store.run('DELETE FROM derived WHERE generation = ? AND kind = ?', at, kind);
      for (const key of [...rows.keys()].sort((a, b) => (a < b ? -1 : 1))) ins.run(at, kind, key, rows.get(key));
    }
  });
  return true;
}

/**
 * The current generation's facts of `kind`. A store mapped by an older version has no rows:
 * they are computed from the graph, stored and returned. Seeds the graph's facts so detectors
 * reading through `derivedFor` see exactly what is stored.
 */
export function readDerived(ctx, kind, { graph }) {
  const generation = Number(ctx.store.meta('generation') ?? 0);
  let d = cache.get(graph);
  if (!d || d.generation !== generation) {
    if (derivedDone(ctx, generation)) {
      d = Object.fromEntries(DERIVED_KINDS.map((k) => [k, []]));
      for (const r of ctx.store.iterate("SELECT kind, key, body FROM derived WHERE generation = ? AND kind != '_done' ORDER BY rowid", rowsGeneration(ctx, generation))) d[r.kind].push({ key: r.key, body: JSON.parse(r.body) });
      cache.set(graph, tag(d, generation));
    } else {
      try {
        d = writeDerived(ctx, graph, generation);
      } catch {
        d = tag(computeDerived(graph), generation); // a read-only store: computed, not kept
        cache.set(graph, d);
      }
    }
  }
  return d[kind];
}
