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

export const DERIVED_KINDS = ['scc', 'scc_strict', 'declared_only', 'public_surface', 'test_code', 'ownership'];
/** Cycles listed per component; consumers needing more recompute that one component. */
export const MAX_CYCLES = 50;
/** Smallest component the cycle detector reports (its default `min_size`). */
export const MIN_FINDING_SIZE = 2;

const IMPORT = ['IMPORTS'];
const isTest = (n) => !n || n.attrs?.is_test === true;

/** The graph without lazy (function-body) and type-only imports: what a runtime cycle needs. */
export function strictView(graph) {
  const strict = Object.create(graph);
  strict.out = (id, type) => graph.out(id, type).filter((e) => !(e.attrs?.lazy || e.attrs?.type_only));
  return strict;
}

/** @returns {Record<string, {key: string, body: object}[]>} the facts by kind, each sorted by key */
export function computeDerived(graph) {
  const sccs = stronglyConnected(graph, { edgeTypes: IMPORT, nodeTypes: ['module'] });
  const strict = stronglyConnected(strictView(graph), { edgeTypes: IMPORT, nodeTypes: ['module'] });
  const compOf = new Map();
  for (const c of sccs) for (const id of c) compOf.set(id, c[0]);

  const scc = sccs.map((members) => {
    const b = cycleBreakdown(graph, members, { edgeTypes: IMPORT, maxCycles: MAX_CYCLES });
    const inComp = new Set(members);
    const strictHere = strict.filter((c) => inComp.has(c[0]));
    const nonTest = (c) => c.filter((id) => !isTest(graph.node(id))).length;
    const reported = strictHere.some((c) => nonTest(c) >= MIN_FINDING_SIZE);
    const reason = reported ? undefined
      : members.length === 1 ? 'a module importing itself is not a dependency cycle'
      : !strictHere.length ? 'closes only through lazy or type-only imports, which are not a runtime cycle'
      : 'fewer than two non-test modules take part';
    return { key: members[0], body: { members, size: members.length, cycles: b.cycles, truncated: b.truncated, cut: b.cut, ...(b.cut_heuristic && { cut_heuristic: true }), ...(b.cut_minimal === false && { cut_minimal: false }), declared_only: b.cut.filter((e) => e.declared_only).length, finding: reported, ...(reason && { reason }) } };
  });

  const declared = graph.edges('IMPORTS').filter((e) => e.attrs?.declared_only && e.from !== e.to)
    .sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))
    .map((e) => {
      const from = graph.node(e.from);
      const to = graph.node(e.to);
      const comp = compOf.get(e.from) !== undefined && compOf.get(e.from) === compOf.get(e.to) ? compOf.get(e.from) : null;
      return { key: `${e.from}>${e.to}`, body: { from: e.from, to: e.to, member: e.attrs.unused_member ?? null, visibility: e.attrs.member_visibility ?? null, line: e.attrs.line ?? null, component: comp, modules: from?.type === 'module' && to?.type === 'module', test: isTest(from) || isTest(to) } };
    });

  return {
    scc,
    scc_strict: strict.map((members) => ({ key: members[0], body: { members } })),
    declared_only: declared,
    ...nodeFacts(graph),
  };
}

/** The facts read straight off module nodes: cheap, so they never wait for the components. */
function nodeFacts(graph) {
  const surface = [];
  const tests = [];
  const owners = [];
  for (const m of [...graph.nodes('module')].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const exports = (m.attrs?.exports ?? []).map((e) => e.name ?? e).filter((x) => typeof x === 'string');
    const members = m.attrs?.public_members ?? [];
    if (exports.length || members.length) surface.push({ key: m.id, body: { exports, public_members: members } });
    if (m.attrs?.is_test === true) tests.push({ key: m.id, body: {} });
    const own = [...new Set(graph.out(m.id, 'OWNED_BY').map((e) => e.to))].sort();
    if (own.length) owners.push({ key: m.id, body: { owners: own } });
  }
  return { public_surface: surface, test_code: tests, ownership: owners };
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
    ctx.store.run("INSERT OR REPLACE INTO derived(generation, kind, key, body) VALUES (?, '_done', '', '{}')", generation);
  });
  return d;
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
    const done = ctx.store.get("SELECT 1 AS ok FROM derived WHERE kind = '_done' AND generation = ?", generation);
    if (done) {
      d = Object.fromEntries(DERIVED_KINDS.map((k) => [k, []]));
      for (const r of ctx.store.db.prepare("SELECT kind, key, body FROM derived WHERE generation = ? AND kind != '_done' ORDER BY rowid").iterate(generation)) d[r.kind].push({ key: r.key, body: JSON.parse(r.body) });
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
