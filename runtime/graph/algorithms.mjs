// Graph algorithms over the in-memory Graph (cycles, impact cones, coupling metrics,
// condensation, DAG ordering). Everything is iterative, so a 200k-node chain cannot blow
// the call stack, and everything iterates in sorted-id order, so identical input gives
// identical output.

import { Graph } from './graph.mjs';

const DEFAULT_EDGES = ['IMPORTS'];

/** Sorted ids of the nodes an algorithm should see, optionally limited by node type. */
function universe(graph, nodeTypes, nodeFilter) {
  const types = nodeTypes ? new Set(nodeTypes) : null;
  const ids = [];
  for (const n of graph.nodeMap.values()) if ((!types || types.has(n.type)) && (!nodeFilter || nodeFilter(n))) ids.push(n.id);
  return ids.sort();
}

/**
 * Strongly connected components via iterative Tarjan. Only components that are real
 * cycles are returned: size > 1, or a single node with a self-loop. Each component is a
 * sorted id list, and the list of components is sorted by first member. `nodeFilter`
 * (node => boolean) restricts the graph to the nodes it accepts: cycles of that subgraph.
 */
export function stronglyConnected(graph, { edgeTypes = DEFAULT_EDGES, nodeTypes, nodeFilter } = {}) {
  const ids = universe(graph, nodeTypes, nodeFilter);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const succOf = (v) => {
    const out = [];
    for (const e of graph.out(ids[v], edgeTypes)) {
      const w = idx.get(e.to);
      if (w !== undefined) out.push(w);
    }
    return out;
  };
  const order = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = [];
  const result = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (order[root] !== -1) continue;
    // Explicit call stack: [node, successors, next successor position].
    const frames = [[root, succOf(root), 0]];
    order[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const [v, succ] = frame;
      if (frame[2] < succ.length) {
        const w = succ[frame[2]++];
        if (order[w] === -1) {
          order[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          frames.push([w, succOf(w), 0]);
        } else if (onStack[w] && order[w] < low[v]) {
          low[v] = order[w];
        }
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1][0];
        if (low[v] < low[parent]) low[parent] = low[v];
      }
      if (low[v] === order[v]) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack[w] = 0;
          comp.push(ids[w]);
        } while (w !== v);
        if (comp.length > 1 || succ.includes(v)) result.push(comp.sort());
      }
    }
  }
  return result.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * One shortest cycle inside a component, as a node-id list in traversal order (the closing
 * edge from the last back to the first is implied). BFS from every member; the search is
 * cut off at the best length so far. Ties go to the lexicographically first start.
 */
export function shortestCycle(graph, component, edgeTypes = DEFAULT_EDGES) {
  const members = new Set(component);
  const starts = [...component].sort();
  let best = null;
  for (const start of starts) {
    if (best && best.length === 1) break;
    const parent = new Map([[start, null]]);
    let frontier = [start];
    let depth = 0;
    let found = null;
    while (frontier.length && found === null && (!best || depth + 1 < best.length)) {
      depth++;
      const next = [];
      for (const v of frontier) {
        const targets = graph.out(v, edgeTypes).map((e) => e.to).filter((t) => members.has(t)).sort();
        for (const t of targets) {
          if (t === start) { found = v; break; }
          if (!parent.has(t)) { parent.set(t, v); next.push(t); }
        }
        if (found !== null) break;
      }
      frontier = next;
    }
    if (found !== null) {
      const cycle = [];
      for (let v = found; v !== null; v = parent.get(v)) cycle.push(v);
      cycle.reverse();
      if (!best || cycle.length < best.length) best = cycle;
    }
  }
  return best;
}

/**
 * What one strongly connected component is made of, in a form a person can act on: its
 * elementary cycles (shortest first, at most `maxCycles` of at most `maxLength` nodes; the
 * search also stops at a work budget, and `truncated` says any limit cut it short) and a
 * small greedy feedback arc set: edges whose removal leaves the component acyclic, declared-
 * only edges first (an edge held only by an injected member nobody uses), then those that
 * close the most listed cycles. Edges are node pairs: a pair is declared-only when every
 * edge between them is, and then carries the unused member.
 */
export function cycleBreakdown(graph, members, { edgeTypes = DEFAULT_EDGES, maxCycles = 50, maxLength = 12 } = {}) {
  const ids = [...members].sort();
  const inSet = new Set(ids);
  const info = new Map();
  const adj = new Map(ids.map((id) => [id, []]));
  for (const from of ids) {
    const byTo = new Map();
    for (const e of graph.out(from, edgeTypes)) if (inSet.has(e.to)) (byTo.get(e.to) ?? byTo.set(e.to, []).get(e.to)).push(e);
    for (const to of [...byTo.keys()].sort()) {
      const es = byTo.get(to);
      const declared = es.every((e) => e.attrs?.declared_only);
      const first = es.find((e) => e.attrs?.line) ?? es[0];
      info.set(`${from}\0${to}`, {
        from, to, declared_only: declared,
        ...(declared && { unused_member: [...new Set(es.map((e) => e.attrs?.unused_member).filter(Boolean))].join(', ') || undefined }),
        ...(first.attrs?.line && { line: first.attrs.line }),
      });
      adj.get(from).push(to);
    }
  }
  const edgeOf = (a, b) => info.get(`${a}\0${b}`);
  const publicEdge = (e, extra = {}) => ({ from: e.from, to: e.to, declared_only: e.declared_only, ...(e.unused_member && { unused_member: e.unused_member }), ...(e.line && { line: e.line }), ...extra });

  // Elementary cycles by increasing length; each starts at its smallest member.
  const cycles = [];
  let truncated = false;
  let budget = 400000;
  for (let len = 1; len <= maxLength && !truncated; len++) {
    const path = [];
    const onPath = new Set();
    const walk = (start, v) => {
      if (truncated) return;
      if (--budget < 0) { truncated = true; return; }
      path.push(v);
      onPath.add(v);
      for (const w of adj.get(v)) {
        if (path.length === len) {
          if (w === start) {
            if (cycles.length >= maxCycles) { truncated = true; break; }
            cycles.push([...path]);
          }
        } else if (w > start && !onPath.has(w)) walk(start, w);
        if (truncated) break;
      }
      path.pop();
      onPath.delete(v);
    };
    for (const start of ids) { walk(start, start); if (truncated) break; }
  }
  if (!truncated && ids.length > maxLength) truncated = true;
  const cyclePairs = (c) => c.map((v, i) => edgeOf(v, c[(i + 1) % c.length]));

  // Greedy feedback arc set over the edges that remain after each cut.
  const removed = new Set();
  const live = (a) => adj.get(a).filter((b) => !removed.has(`${a}\0${b}`));
  const cyclic = (nodes) => {
    const deg = new Map(nodes.map((v) => [v, 0]));
    const set = new Set(nodes);
    for (const a of nodes) for (const b of live(a)) if (set.has(b)) deg.set(b, deg.get(b) + 1);
    const queue = nodes.filter((v) => deg.get(v) === 0);
    let seen = 0;
    while (queue.length) {
      const v = queue.pop();
      seen++;
      for (const b of live(v)) if (set.has(b)) { deg.set(b, deg.get(b) - 1); if (deg.get(b) === 0) queue.push(b); }
    }
    return seen < nodes.length;
  };
  const inDegree = new Map();
  for (const a of ids) for (const b of adj.get(a)) inDegree.set(b, (inDegree.get(b) ?? 0) + 1);
  const cut = [];
  for (let guard = 0; guard < info.size && cyclic(ids); guard++) {
    const closing = new Map();
    for (const c of cycles) {
      const es = cyclePairs(c);
      if (es.some((e) => removed.has(`${e.from}\0${e.to}`))) continue;
      for (const e of es) closing.set(e, (closing.get(e) ?? 0) + 1);
    }
    const comps = componentsOf(ids, live);
    for (const comp of comps) {
      const inComp = new Set(comp);
      let best = null;
      for (const a of comp) for (const b of live(a)) {
        if (!inComp.has(b)) continue;
        const e = edgeOf(a, b);
        const closes = closing.get(e) ?? 0;
        const rank = [e.declared_only ? 0 : 1, -closes, -(live(a).length * (inDegree.get(b) ?? 0))];
        if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && (rank[1] < best.rank[1] || (rank[1] === best.rank[1] && rank[2] < best.rank[2])))) best = { e, rank, closes };
      }
      if (best) { removed.add(`${best.e.from}\0${best.e.to}`); cut.push(best); }
    }
  }
  // Drop any cut that turned out unnecessary, ordinary edges first.
  for (const c of [...cut].sort((x, y) => Number(x.e.declared_only) - Number(y.e.declared_only))) {
    const key = `${c.e.from}\0${c.e.to}`;
    removed.delete(key);
    if (cyclic(ids)) removed.add(key);
    else cut.splice(cut.indexOf(c), 1);
  }
  return {
    members: ids,
    cycles: cycles.map((c) => ({ length: c.length, nodes: c, edges: cyclePairs(c).map((e) => publicEdge(e)) })),
    truncated,
    cut: cut.map((c) => publicEdge(c.e, { closes: c.closes })),
  };
}

/** Components with a cycle among the live edges (iterative Tarjan over plain id lists). */
function componentsOf(ids, live) {
  const set = new Set(ids);
  const order = new Map();
  const low = new Map();
  const on = new Set();
  const stack = [];
  const out = [];
  let counter = 0;
  for (const root of ids) {
    if (order.has(root)) continue;
    const frames = [[root, live(root).filter((b) => set.has(b)), 0]];
    order.set(root, counter); low.set(root, counter++);
    stack.push(root); on.add(root);
    while (frames.length) {
      const f = frames[frames.length - 1];
      const [v, succ] = f;
      if (f[2] < succ.length) {
        const w = succ[f[2]++];
        if (!order.has(w)) { order.set(w, counter); low.set(w, counter++); stack.push(w); on.add(w); frames.push([w, live(w).filter((b) => set.has(b)), 0]); }
        else if (on.has(w) && order.get(w) < low.get(v)) low.set(v, order.get(w));
        continue;
      }
      frames.pop();
      if (frames.length) { const p = frames[frames.length - 1][0]; if (low.get(v) < low.get(p)) low.set(p, low.get(v)); }
      if (low.get(v) === order.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1 || succ.includes(v)) out.push(comp.sort());
      }
    }
  }
  return out;
}

/**
 * Transitive reach from `ids` as Map id -> depth (seeds are depth 0). `direction: 'in'`
 * follows edges backwards, which answers "who is affected if this changes".
 */
export function impactCone(graph, ids, { edgeTypes = DEFAULT_EDGES, direction = 'in', maxDepth = Infinity } = {}) {
  const depth = new Map();
  let frontier = [];
  for (const id of [...ids].sort()) if (!depth.has(id)) { depth.set(id, 0); frontier.push(id); }
  for (let d = 1; frontier.length && d <= maxDepth; d++) {
    const next = [];
    for (const v of frontier) {
      const edges = direction === 'in' ? graph.in(v, edgeTypes) : graph.out(v, edgeTypes);
      for (const e of edges) {
        const w = direction === 'in' ? e.from : e.to;
        if (!depth.has(w)) { depth.set(w, d); next.push(w); }
      }
    }
    frontier = next;
  }
  return depth;
}

/** Distinct dependents of `id` (self-loops excluded: a module does not depend on itself). */
export function fanIn(graph, id, edgeTypes = DEFAULT_EDGES) {
  return new Set(graph.in(id, edgeTypes).map((e) => e.from).filter((f) => f !== id)).size;
}

/** Distinct dependencies of `id`. */
export function fanOut(graph, id, edgeTypes = DEFAULT_EDGES) {
  return new Set(graph.out(id, edgeTypes).map((e) => e.to).filter((t) => t !== id)).size;
}

/**
 * Martin's instability I = Ce / (Ca + Ce) per group. `ids` is the universe (null = every
 * node); `group(id)` maps a node to its module/package (default: the node itself). Ca counts
 * distinct outside nodes depending on the group, Ce distinct outside nodes it depends on.
 * A group with no cross-group edges has instability null rather than a made-up 0.
 * @returns {Map<string, {ca:number, ce:number, instability:number|null}>}
 */
export function instability(graph, ids, edgeTypes = DEFAULT_EDGES, group = (id) => id) {
  const universeIds = ids ? [...ids].sort() : universe(graph);
  const inScope = new Set(universeIds);
  const ca = new Map();
  const ce = new Map();
  for (const id of universeIds) {
    const g = group(id);
    if (g == null) continue;
    if (!ca.has(g)) { ca.set(g, new Set()); ce.set(g, new Set()); }
  }
  for (const id of universeIds) {
    const g = group(id);
    if (g == null) continue;
    for (const e of graph.out(id, edgeTypes)) {
      if (!inScope.has(e.to)) continue;
      const h = group(e.to);
      if (h == null || h === g) continue;
      ce.get(g).add(e.to);
      ca.get(h).add(id);
    }
  }
  const out = new Map();
  for (const g of [...ca.keys()].sort()) {
    const a = ca.get(g).size;
    const e = ce.get(g).size;
    out.set(g, { ca: a, ce: e, instability: a + e === 0 ? null : e / (a + e) });
  }
  return out;
}

/**
 * Quotient graph between groups for package-level views. Edge `attrs.count` (also
 * `attrs.weight`) is the number of underlying edges; intra-group edges are dropped and
 * tallied on the group node as `attrs.internal`. Groups mapped to null/undefined vanish.
 */
export function condense(graph, groupFn, edgeTypes = DEFAULT_EDGES) {
  const out = new Graph();
  const pair = new Map();
  const internal = new Map();
  const ids = universe(graph);
  for (const id of ids) {
    const g = groupFn(id);
    if (g == null) continue;
    if (!out.node(g)) out.addNode(g, 'package', { name: g });
    internal.set(g, internal.get(g) ?? 0);
  }
  for (const id of ids) {
    const g = groupFn(id);
    if (g == null) continue;
    for (const e of graph.out(id, edgeTypes)) {
      const h = groupFn(e.to);
      if (h == null) continue;
      if (g === h) { internal.set(g, internal.get(g) + 1); continue; }
      const key = `${g}\0${h}`;
      pair.set(key, (pair.get(key) ?? 0) + 1);
    }
  }
  for (const [g, count] of internal) out.node(g).attrs.internal = count;
  for (const key of [...pair.keys()].sort()) {
    const [g, h] = key.split('\0');
    if (!out.node(h)) out.addNode(h, 'package', { name: h });
    const count = pair.get(key);
    out.addEdge('DEPENDS_ON', g, h, { count, weight: count });
  }
  return out;
}

/** Nodes with high fan-in or fan-out, busiest first. Thresholds are inclusive. */
export function hubs(graph, { edgeTypes = DEFAULT_EDGES, minFanIn = 10, minFanOut = 10 } = {}) {
  const found = [];
  for (const id of universe(graph)) {
    const fi = fanIn(graph, id, edgeTypes);
    const fo = fanOut(graph, id, edgeTypes);
    if (fi >= minFanIn || fo >= minFanOut) found.push({ id, fanIn: fi, fanOut: fo });
  }
  return found.sort((a, b) => (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut) || (a.id < b.id ? -1 : 1));
}

/**
 * Kahn topological order for slice DAGs. Edges are `{from, to}` or `[from, to]`, meaning
 * from must come before to. Ready nodes are released in sorted order so the result is
 * unique. On a cycle it throws an Error whose `.cycle` holds the offending node ids.
 */
export function topoOrder(nodes, edges) {
  const all = [...new Set(nodes)].sort();
  const known = new Set(all);
  const succ = new Map(all.map((n) => [n, new Set()]));
  const indeg = new Map(all.map((n) => [n, 0]));
  for (const edge of edges) {
    const [from, to] = Array.isArray(edge) ? edge : [edge.from, edge.to];
    if (!known.has(from) || !known.has(to)) throw new Error(`topoOrder: edge ${from} -> ${to} references an unknown node`);
    if (succ.get(from).has(to)) continue;
    succ.get(from).add(to);
    indeg.set(to, indeg.get(to) + 1);
  }
  // Ready list is kept sorted by binary insertion; slice DAGs are small.
  const ready = all.filter((n) => indeg.get(n) === 0);
  const order = [];
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const m of [...succ.get(n)].sort()) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) {
        let lo = 0;
        let hi = ready.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (ready[mid] < m) lo = mid + 1; else hi = mid; }
        ready.splice(lo, 0, m);
      }
    }
  }
  if (order.length === all.length) return order;
  // Every leftover node has an unplaced predecessor, so walking predecessors must repeat.
  const left = new Set(all.filter((n) => indeg.get(n) > 0));
  const pred = new Map();
  for (const n of [...left].sort()) for (const m of succ.get(n)) if (left.has(m) && !pred.has(m)) pred.set(m, n);
  let cur = [...left].sort()[0];
  const seen = new Map();
  const walk = [];
  while (!seen.has(cur)) { seen.set(cur, walk.length); walk.push(cur); cur = pred.get(cur); }
  const cycle = walk.slice(seen.get(cur)).reverse();
  const err = new Error(`topoOrder: cycle detected: ${[...cycle, cycle[0]].join(' -> ')}`);
  err.cycle = cycle;
  throw err;
}


/**
 * The top nodes by fan-in and by fan-out over one or several edge types (distinct neighbours
 * across the union, self loops ignored), for the cartographer's report. `hubs` above is the
 * threshold filter detectors use. With `nodeFilter` only accepted nodes are ranked; their
 * neighbours may be anywhere unless `within` is set, which counts only accepted neighbours.
 * @returns {{edge_type: string, edge_types: string[], fan_in: {id, n}[], fan_out: {id, n}[]}}
 */
export function rankHubs(graph, { edgeType = 'IMPORTS', edgeTypes, nodeType = 'module', limit = 15, nodeFilter, within = false } = {}) {
  const types = edgeTypes?.length ? edgeTypes : [edgeType];
  const wanted = new Set(types);
  const accept = (id) => !nodeFilter || nodeFilter(graph.node(id));
  const inn = new Map();
  const out = new Map();
  for (const e of graph.edges()) {
    if (!wanted.has(e.type) || e.from === e.to) continue;
    if (nodeType && (graph.node(e.from)?.type !== nodeType || graph.node(e.to)?.type !== nodeType)) continue;
    const fromIn = accept(e.from);
    const toIn = accept(e.to);
    if (within && !(fromIn && toIn)) continue;
    if (toIn) {
      if (!inn.has(e.to)) inn.set(e.to, new Set());
      inn.get(e.to).add(e.from);
    }
    if (fromIn) {
      if (!out.has(e.from)) out.set(e.from, new Set());
      out.get(e.from).add(e.to);
    }
  }
  const rank = (m) => [...m].map(([id, s]) => ({ id, n: s.size })).sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1)).slice(0, limit);
  return { edge_type: types.join(','), edge_types: types, fan_in: rank(inn), fan_out: rank(out) };
}

/**
 * Nodes a user-supplied reference names: an exact id, a module path (`src/x.cs` for
 * `module:src/x.cs`), a type name a module declares, or a bare file name.
 */
export function resolveRef(graph, ref) {
  if (graph.node(ref)) return [ref];
  if (graph.node(`module:${ref}`)) return [`module:${ref}`];
  const mods = graph.nodes('module');
  const byType = mods.filter((n) => Array.isArray(n.attrs?.types) && n.attrs.types.includes(ref));
  if (byType.length) return byType.map((n) => n.id).sort();
  return mods
    .filter((n) => {
      const base = (n.path ?? '').split('/').pop();
      return base === ref || base.replace(/\.[^.]+$/, '') === ref;
    })
    .map((n) => n.id)
    .sort();
}

/** Breadth-first subgraph around `roots` (both directions), bounded to `nodeCap` nodes. */
export function neighbourhood(graph, roots, { depth = 1, edgeTypes, nodeCap = 300 } = {}) {
  const seen = new Set(roots);
  const edges = new Map();
  let frontier = [...roots];
  for (let d = 0; d < depth && frontier.length && seen.size < nodeCap; d++) {
    const next = [];
    for (const id of frontier) {
      for (const e of [...graph.out(id, edgeTypes), ...graph.in(id, edgeTypes)]) {
        edges.set(e.id, e);
        for (const end of [e.from, e.to]) {
          if (!seen.has(end) && seen.size < nodeCap) {
            seen.add(end);
            next.push(end);
          }
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: [...seen].map((id) => graph.node(id)).filter(Boolean),
    edges: [...edges.values()].filter((e) => seen.has(e.from) && seen.has(e.to)),
    capped: seen.size >= nodeCap,
  };
}
