// Community detection on weighted undirected graphs: Leiden (primary), label propagation
// (cross-check), modularity, partition comparison, robustness and cluster metrics for
// the decomposition subsystem (spec §15A.3, §15A.4). The algorithms propose boundaries;
// they never authorize one.
//
// Input everywhere: { nodes: string[], edges: [{ a, b, w }] }. Parallel edges are summed,
// non-positive or non-finite weights are ignored, self-loops are allowed. Node ids are
// sorted internally, so results do not depend on input order, and every random choice
// comes from a seeded PRNG, so identical input and seed give identical output.

import { maxOf, minOf } from '../core/arrays.mjs';

const EPS = 1e-12;

/** mulberry32: a tiny seeded PRNG. Not for security, only for reproducible tie-breaking. */
export function makeRng(seed = 42) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Compile the input into sorted-index adjacency arrays. `deg` counts a self-loop twice. */
function build(input) {
  const ids = [...new Set(input.nodes)].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const maps = ids.map(() => new Map());
  const self = new Float64Array(n);
  for (const { a, b, w } of input.edges) {
    if (!(w > 0) || !Number.isFinite(w)) continue;
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) throw new Error(`community: edge ${a} - ${b} references an unknown node`);
    if (i === j) { self[i] += w; continue; }
    maps[i].set(j, (maps[i].get(j) ?? 0) + w);
    maps[j].set(i, (maps[j].get(i) ?? 0) + w);
  }
  return { ids, index, ...compile(maps, self) };
}

function compile(maps, self) {
  const n = maps.length;
  const nbr = new Array(n);
  const wt = new Array(n);
  const deg = new Float64Array(n);
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const keys = [...maps[i].keys()].sort((x, y) => x - y);
    nbr[i] = Int32Array.from(keys);
    wt[i] = Float64Array.from(keys, (k) => maps[i].get(k));
    let d = 2 * self[i];
    for (const x of wt[i]) d += x;
    deg[i] = d;
    m2 += d;
  }
  return { n, nbr, wt, self, deg, m2 };
}

/** Relabel to 0..k-1 by first appearance (node order), in place of arbitrary labels. */
function canonical(labels) {
  const map = new Map();
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (!map.has(labels[i])) map.set(labels[i], map.size);
    out[i] = map.get(labels[i]);
  }
  return out;
}

/** Largest label + 1 (a loop, not Math.max(...), which overflows the stack on big arrays). */
function countLabels(labels) {
  let k = 0;
  for (const l of labels) if (l >= k) k = l + 1;
  return k;
}

function qualityOf(g, comm, gamma) {
  if (g.m2 === 0) return 0;
  const k = countLabels(comm);
  const inW = new Float64Array(k);
  const tot = new Float64Array(k);
  for (let v = 0; v < g.n; v++) {
    const c = comm[v];
    tot[c] += g.deg[v];
    inW[c] += 2 * g.self[v];
    for (let p = 0; p < g.nbr[v].length; p++) if (comm[g.nbr[v][p]] === c) inW[c] += g.wt[v][p];
  }
  let q = 0;
  for (let c = 0; c < k; c++) q += inW[c] / g.m2 - gamma * (tot[c] / g.m2) ** 2;
  return q;
}

function toArray(g, partition) {
  const labels = new Array(g.n);
  for (let i = 0; i < g.n; i++) labels[i] = partition.has(g.ids[i]) ? partition.get(g.ids[i]) : `\0single:${g.ids[i]}`;
  return canonical(labels);
}

function toMap(g, comm) {
  return new Map(g.ids.map((id, i) => [id, comm[i]]));
}

/**
 * Newman-Girvan modularity with resolution gamma:
 * Q = sum_c [ in_c / 2m - gamma (tot_c / 2m)^2 ]. Nodes missing from the partition count as singletons.
 */
export function modularity(input, partition, resolution = 1) {
  const g = build(input);
  return qualityOf(g, toArray(g, partition), resolution);
}

// ---------------------------------------------------------------------------------
// Leiden
// ---------------------------------------------------------------------------------

/**
 * Fast local moving (Traag et al. 2019, Alg. 2): a queue of nodes, a node moves to the
 * neighbouring community (or an empty one) with the best modularity gain, and only the
 * neighbours it left behind are re-queued. Mutates `comm`; returns whether anything moved.
 */
function moveNodesFast(g, comm, gamma, rng) {
  const { n, nbr, wt, deg, m2 } = g;
  const tot = new Float64Array(n);
  const cnt = new Int32Array(n);
  for (let v = 0; v < n; v++) { tot[comm[v]] += deg[v]; cnt[comm[v]]++; }
  const empties = [];
  for (let c = n - 1; c >= 0; c--) if (cnt[c] === 0) empties.push(c);
  const queue = shuffle(Array.from({ length: n }, (_, i) => i), rng);
  const inQueue = new Uint8Array(n).fill(1);
  const wComm = new Float64Array(n);
  const seen = new Uint8Array(n);
  let moved = false;
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    inQueue[v] = 0;
    const cur = comm[v];
    const kv = deg[v];
    const touched = [];
    for (let p = 0; p < nbr[v].length; p++) {
      const c = comm[nbr[v][p]];
      if (!seen[c]) { seen[c] = 1; touched.push(c); }
      wComm[c] += wt[v][p];
    }
    tot[cur] -= kv;
    cnt[cur]--;
    let best = cur;
    let bestGain = wComm[cur] - (gamma * kv * tot[cur]) / m2;
    for (const c of touched) {
      if (c === cur) continue;
      const gain = wComm[c] - (gamma * kv * tot[c]) / m2;
      if (gain > bestGain + EPS) { best = c; bestGain = gain; }
    }
    // Moving into an empty community has gain 0; only worth it if v has company to leave.
    if (cnt[cur] > 0 && bestGain < -EPS && empties.length) best = empties.pop();
    for (const c of touched) { wComm[c] = 0; seen[c] = 0; }
    tot[best] += kv;
    cnt[best]++;
    if (best !== cur) {
      comm[v] = best;
      moved = true;
      if (cnt[cur] === 0) empties.push(cur);
      for (let p = 0; p < nbr[v].length; p++) {
        const u = nbr[v][p];
        if (comm[u] !== best && !inQueue[u]) { inQueue[u] = 1; queue.push(u); }
      }
    }
  }
  return moved;
}

/**
 * Refinement (Alg. 3): within each community of `comm`, start from singletons and merge
 * well-connected nodes into well-connected sub-communities. A node picks its target at
 * random with probability proportional to exp(dQ / theta) among non-negative gains, so the
 * partition is not forced greedy (this is what lets Leiden escape Louvain's local optima).
 * Returns refined labels (representative node index per node).
 */
function refine(g, comm, gamma, rng, theta) {
  const { n, nbr, wt, deg, m2 } = g;
  const ref = Int32Array.from({ length: n }, (_, i) => i);
  const volR = Float64Array.from(deg);
  const ext = new Float64Array(n);
  const size = new Int32Array(n).fill(1);
  const byComm = new Map();
  for (let v = 0; v < n; v++) {
    if (!byComm.has(comm[v])) byComm.set(comm[v], []);
    byComm.get(comm[v]).push(v);
  }
  const wTo = new Float64Array(n);
  const seen = new Uint8Array(n);
  for (const c of [...byComm.keys()].sort((x, y) => x - y)) {
    const members = byComm.get(c);
    if (members.length === 1) continue;
    let volC = 0;
    for (const v of members) {
      volC += deg[v];
      let e = 0;
      for (let p = 0; p < nbr[v].length; p++) if (comm[nbr[v][p]] === c) e += wt[v][p];
      ext[v] = e;
    }
    for (const v of shuffle([...members], rng)) {
      if (ref[v] !== v || size[v] !== 1) continue; // only singletons move
      if (ext[v] < (gamma * deg[v] * (volC - deg[v])) / m2 - EPS) continue; // v not well connected to C
      const touched = [];
      for (let p = 0; p < nbr[v].length; p++) {
        const u = nbr[v][p];
        if (comm[u] !== c) continue;
        const s = ref[u];
        if (!seen[s]) { seen[s] = 1; touched.push(s); }
        wTo[s] += wt[v][p];
      }
      const cand = [];
      for (const s of touched) {
        // Connectivity (wTo > 0) is required explicitly so refined communities are always connected.
        if (wTo[s] <= 0 || ext[s] < (gamma * volR[s] * (volC - volR[s])) / m2 - EPS) continue;
        const dq = (2 * (wTo[s] - (gamma * deg[v] * volR[s]) / m2)) / m2;
        if (dq >= 0) cand.push([s, dq]);
      }
      let target = v;
      if (cand.length) {
        // "stay a singleton" competes with dq = 0, as in the paper's T set.
        const top = Math.max(0, ...cand.map((x) => x[1]));
        const weights = cand.map(([, dq]) => Math.exp((dq - top) / theta));
        const stay = Math.exp((0 - top) / theta);
        let r = rng() * (weights.reduce((a, b) => a + b, 0) + stay);
        for (let i = 0; i < cand.length; i++) {
          r -= weights[i];
          if (r < 0) { target = cand[i][0]; break; }
        }
      }
      if (target !== v) {
        ext[target] = ext[target] + ext[v] - 2 * wTo[target];
        volR[target] += deg[v];
        size[target]++;
        size[v] = 0;
        ref[v] = target;
      }
      for (const s of touched) { wTo[s] = 0; seen[s] = 0; }
    }
  }
  return ref;
}

/** Collapse each group of `labels` (0..k-1) into one node; strength and total weight are preserved. */
function aggregate(g, labels, k) {
  const maps = Array.from({ length: k }, () => new Map());
  const self = new Float64Array(k);
  for (let v = 0; v < g.n; v++) {
    const a = labels[v];
    self[a] += g.self[v];
    for (let p = 0; p < g.nbr[v].length; p++) {
      const u = g.nbr[v][p];
      const b = labels[u];
      if (a === b) { if (v < u) self[a] += g.wt[v][p]; } else maps[a].set(b, (maps[a].get(b) ?? 0) + g.wt[v][p]);
    }
  }
  return compile(maps, self);
}

/** One Leiden iteration: move, refine, aggregate on the refined partition, repeat. Returns flat labels. */
function leidenIteration(g0, init, gamma, rng, theta) {
  let g = g0;
  let comm = canonical(init);
  const toLevel = Int32Array.from({ length: g0.n }, (_, i) => i);
  for (;;) {
    moveNodesFast(g, comm, gamma, rng);
    comm = canonical(comm);
    const k = countLabels(comm);
    if (k === g.n) break; // every node alone: nothing left to coarsen
    const refined = canonical(refine(g, comm, gamma, rng, theta));
    const kr = countLabels(refined);
    if (kr === g.n) break; // refinement merged nothing: aggregation would be a no-op
    const next = new Int32Array(kr);
    for (let v = 0; v < g.n; v++) next[refined[v]] = comm[v];
    for (let o = 0; o < g0.n; o++) toLevel[o] = refined[toLevel[o]];
    g = aggregate(g, refined, kr);
    comm = canonical(next);
  }
  return Int32Array.from(toLevel, (l) => comm[l]);
}

/** Split communities into connected components (no-op for a correct Leiden, kept as a guarantee). */
function splitDisconnected(g, comm) {
  const out = new Int32Array(g.n).fill(-1);
  let next = 0;
  for (let s = 0; s < g.n; s++) {
    if (out[s] !== -1) continue;
    out[s] = next;
    const stack = [s];
    while (stack.length) {
      const v = stack.pop();
      for (const u of g.nbr[v]) if (out[u] === -1 && comm[u] === comm[s]) { out[u] = next; stack.push(u); }
    }
    next++;
  }
  return canonical(out);
}

/**
 * Leiden community detection (Traag, Waltman, van Eck 2019) maximising resolution-gamma
 * modularity. Communities are numbered by smallest member id, so output is stable.
 *
 * Deviations from the published algorithm, all deliberate:
 * - Quality is modularity only (no CPM); node weights are weighted degrees.
 * - Randomness uses a seeded mulberry32 stream with theta = 0.01 (the paper's default).
 * - Refinement merges only into sub-communities the node is directly connected to
 *   (weight > 0), which makes refined communities connected by construction.
 * - If refinement leaves every node alone while the move phase did not, we stop
 *   coarsening instead of aggregating on the non-refined partition.
 * - Iterations repeat from the previous flat partition until it stops changing or
 *   `maxIterations`; a final connected-components split guards the connectivity guarantee.
 *
 * Complexity: near O(m log n) per iteration in practice; memory O(n + m).
 * @returns {{ partition: Map<string, number>, quality: number }}
 */
export function leiden(input, { resolution = 1, seed = 42, maxIterations = 20 } = {}) {
  const g = build(input);
  if (g.n === 0) return { partition: new Map(), quality: 0 };
  if (g.m2 === 0) return { partition: toMap(g, Int32Array.from({ length: g.n }, (_, i) => i)), quality: 0 };
  const rng = makeRng(seed);
  let comm = Int32Array.from({ length: g.n }, (_, i) => i);
  for (let it = 0; it < Math.max(1, maxIterations); it++) {
    const next = splitDisconnected(g, leidenIteration(g, comm, resolution, rng, 0.01));
    const same = next.every((c, i) => c === comm[i]);
    comm = next;
    if (same) break;
  }
  return { partition: toMap(g, comm), quality: qualityOf(g, comm, resolution) };
}

// ---------------------------------------------------------------------------------
// Label propagation
// ---------------------------------------------------------------------------------

/**
 * Asynchronous weighted label propagation. Visit order is a seeded shuffle each sweep; a
 * node adopts the label with the greatest incident weight, keeping its own label when tied
 * and otherwise taking the smallest, so ties never depend on iteration accidents.
 * @returns {Map<string, number>} partition, communities numbered by smallest member id
 */
export function labelPropagation(input, { seed = 42, maxIterations = 50 } = {}) {
  const g = build(input);
  const rng = makeRng(seed);
  const label = Int32Array.from({ length: g.n }, (_, i) => i);
  const acc = new Map();
  for (let it = 0; it < maxIterations; it++) {
    let changed = false;
    for (const v of shuffle(Array.from({ length: g.n }, (_, i) => i), rng)) {
      if (!g.nbr[v].length) continue;
      acc.clear();
      for (let p = 0; p < g.nbr[v].length; p++) {
        const l = label[g.nbr[v][p]];
        acc.set(l, (acc.get(l) ?? 0) + g.wt[v][p]);
      }
      let top = -Infinity;
      for (const w of acc.values()) if (w > top) top = w;
      let pick = -1;
      if (acc.get(label[v]) !== undefined && acc.get(label[v]) >= top - EPS) pick = label[v];
      else for (const [l, w] of acc) if (w >= top - EPS && (pick === -1 || l < pick)) pick = l;
      if (pick !== label[v]) { label[v] = pick; changed = true; }
    }
    if (!changed) break;
  }
  return toMap(g, canonical(label));
}

// ---------------------------------------------------------------------------------
// Comparing partitions
// ---------------------------------------------------------------------------------

/** Contingency counts over the nodes of p1; nodes absent from p2 get unique labels. */
function contingency(p1, p2) {
  const cells = new Map();
  const rows = new Map();
  const cols = new Map();
  for (const [id, a] of p1) {
    const b = p2.has(id) ? p2.get(id) : `\0missing:${id}`;
    const key = `${String(a)}\u0001${String(b)}`;
    const cell = cells.get(key) ?? { a: String(a), b: String(b), n: 0 };
    cell.n++;
    cells.set(key, cell);
    rows.set(String(a), (rows.get(String(a)) ?? 0) + 1);
    cols.set(String(b), (cols.get(String(b)) ?? 0) + 1);
  }
  return { cells: [...cells.values()], rows, cols, total: p1.size };
}

/**
 * Fraction of nodes whose community differs after optimally matching communities of p1
 * to communities of p2 one-to-one (greedy by overlap, ties by label). Symmetric, in [0, 1].
 */
export function partitionDistance(p1, p2) {
  const { cells, total } = contingency(p1, p2);
  if (total === 0) return 0;
  cells.sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  const usedA = new Set();
  const usedB = new Set();
  let matched = 0;
  for (const c of cells) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    matched += c.n;
  }
  return 1 - matched / total;
}

/** Normalized mutual information (arithmetic-mean normalisation), 1 for identical partitions. */
export function nmi(p1, p2) {
  const { cells, rows, cols, total } = contingency(p1, p2);
  if (total === 0) return 1;
  let h1 = 0;
  for (const n of rows.values()) h1 -= (n / total) * Math.log(n / total);
  let h2 = 0;
  for (const n of cols.values()) h2 -= (n / total) * Math.log(n / total);
  if (h1 < EPS && h2 < EPS) return 1;
  let mi = 0;
  for (const c of cells) mi += (c.n / total) * Math.log((c.n * total) / (rows.get(c.a) * cols.get(c.b)));
  return Math.min(1, Math.max(0, (2 * mi) / (h1 + h2)));
}

// ---------------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------------

/**
 * Stability of the baseline (resolution 1) Leiden communities under: Leiden at each other
 * resolution, one label-propagation run, and `trials` Leiden runs on weights multiplied by
 * a seeded factor in [1 - perturbation, 1 + perturbation]. A member "stays together" in a
 * run if it lies in the run community holding most of its baseline community; a community's
 * stability is the fraction of members that stay together in every run. Robust = >= 0.9,
 * matching the spec's "fewer than 10% of nodes change membership".
 */
export function robustness(input, { resolutions = [0.5, 0.75, 1, 1.25, 1.5], perturbation = 0.5, trials = 5, seed = 42 } = {}) {
  const baseline = leiden(input, { resolution: 1, seed }).partition;
  const edges = [...input.edges].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  const runs = [];
  for (const r of resolutions) {
    if (r === 1) continue; // identical to the baseline by construction
    runs.push({ kind: 'resolution', resolution: r, partition: leiden(input, { resolution: r, seed }).partition });
  }
  runs.push({ kind: 'label-propagation', partition: labelPropagation(input, { seed }) });
  for (let t = 0; t < trials; t++) {
    const rng = makeRng(seed + 7919 * (t + 1));
    const noisy = { nodes: input.nodes, edges: edges.map((e) => ({ ...e, w: e.w * Math.max(0, 1 - perturbation + 2 * perturbation * rng()) })) };
    runs.push({ kind: 'perturbation', trial: t, partition: leiden(noisy, { resolution: 1, seed }).partition });
  }

  const byComm = new Map();
  for (const [id, c] of baseline) {
    if (!byComm.has(c)) byComm.set(c, []);
    byComm.get(c).push(id);
  }
  const communities = [];
  for (const c of [...byComm.keys()].sort((x, y) => x - y)) {
    const members = byComm.get(c).sort();
    let together = new Set(members);
    for (const run of runs) {
      const counts = new Map();
      for (const id of members) {
        const l = run.partition.get(id);
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let bestLabel;
      let bestCount = -1;
      for (const [l, n] of counts) if (n > bestCount || (n === bestCount && String(l) < String(bestLabel))) { bestLabel = l; bestCount = n; }
      together = new Set([...together].filter((id) => run.partition.get(id) === bestLabel));
    }
    const stability = members.length ? together.size / members.length : 1;
    communities.push({ id: c, members, stability, robust: stability >= 0.9 });
  }
  const distances = runs.map((r) => partitionDistance(baseline, r.partition));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const stabilities = communities.map((c) => c.stability);
  return {
    baseline,
    communities,
    runs: runs.map((r, i) => ({ kind: r.kind, resolution: r.resolution, trial: r.trial, distance: distances[i], nmi: nmi(baseline, r.partition) })),
    stats: {
      communities: communities.length,
      robust: communities.filter((c) => c.robust).length,
      robustFraction: communities.length ? communities.filter((c) => c.robust).length / communities.length : 1,
      meanStability: mean(stabilities),
      minStability: minOf(stabilities, 1),
      meanDistance: mean(distances),
      maxDistance: maxOf(distances, 0),
    },
  };
}

// ---------------------------------------------------------------------------------
// Cluster metrics
// ---------------------------------------------------------------------------------

/**
 * Per-cluster size, internal/external weight, cohesion = internal / (internal + external)
 * and volume (sum of weighted degrees), pairwise coupling w(Ci,Cj) / min(vol Ci, vol Cj),
 * and overall modularity. `extras`: { resolution = 1, sizeBand = [5, 20] } (nano/mega flags,
 * the band is a heuristic scaled by the caller to repo granularity).
 */
export function clusterMetrics(input, partition, extras = {}) {
  const { resolution = 1, sizeBand = [5, 20] } = extras;
  const ids = [...new Set(input.nodes)].sort();
  const label = (id) => (partition.has(id) ? partition.get(id) : `\0single:${id}`);
  const clusters = new Map();
  for (const id of ids) {
    const c = label(id);
    if (!clusters.has(c)) clusters.set(c, { id: c, members: [], size: 0, internal: 0, external: 0, volume: 0 });
    const cl = clusters.get(c);
    cl.members.push(id);
    cl.size++;
  }
  const rank = new Map(ids.map((id, i) => [id, i]));
  const between = new Map();
  for (const { a, b, w } of input.edges) {
    if (!(w > 0) || !Number.isFinite(w)) continue;
    const ca = clusters.get(label(a));
    const cb = clusters.get(label(b));
    if (!ca || !cb) throw new Error(`clusterMetrics: edge ${a} - ${b} references an unknown node`);
    if (ca === cb) { ca.internal += w; continue; }
    ca.external += w;
    cb.external += w;
    const [x, y] = rank.get(ca.members[0]) < rank.get(cb.members[0]) ? [ca, cb] : [cb, ca];
    const key = `${x.members[0]}\0${y.members[0]}`;
    const pair = between.get(key) ?? { a: x.id, b: y.id, weight: 0 };
    pair.weight += w;
    between.set(key, pair);
  }
  const list = [...clusters.values()].sort((x, y) => (x.members[0] < y.members[0] ? -1 : 1));
  for (const cl of list) {
    cl.volume = 2 * cl.internal + cl.external;
    cl.cohesion = cl.internal + cl.external > 0 ? cl.internal / (cl.internal + cl.external) : 0;
    cl.sizeFlag = cl.size < sizeBand[0] ? 'nano' : cl.size > sizeBand[1] ? 'mega' : null;
  }
  const vol = new Map(list.map((cl) => [cl.id, cl.volume]));
  const coupling = [...between.keys()].sort().map((k) => {
    const p = between.get(k);
    const denom = Math.min(vol.get(p.a), vol.get(p.b));
    return { a: p.a, b: p.b, weight: p.weight, coupling: denom > 0 ? p.weight / denom : 0 };
  });
  return { clusters: list, coupling, modularity: modularity(input, partition, resolution) };
}
