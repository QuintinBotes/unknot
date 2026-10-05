// Which perturbation broke a candidate: the robustness sweep keeps only the members that
// stay together in every run, so a candidate below the threshold needs the runs named
// and the members that left in each. Same runs, seeds and defaults as `robustness`.

import { labelPropagation, leiden, makeRng } from '../graph/community.mjs';

const RESOLUTIONS = [0.5, 0.75, 1.25, 1.5];
const TRIALS = 5;
const PERTURBATION = 0.5;
const KEEP_RUNS = 3;
const KEEP_MOVED = 8;

/**
 * @param {{nodes: string[], edges: {a: string, b: string, w: number}[]}} input the affinity graph
 * @param {string[]} members the candidate's clustered members
 * @returns {{run: string, seed: number, moved: string[], moved_total: number}[]} worst first
 */
export function brokenBy(input, members, { seed = 42 } = {}) {
  const runs = RESOLUTIONS.map((r) => ({ run: `resolution ${r}`, seed, partition: leiden(input, { resolution: r, seed }).partition }));
  runs.push({ run: 'label propagation', seed, partition: labelPropagation(input, { seed }) });
  const edges = [...input.edges].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  for (let t = 0; t < TRIALS; t++) {
    const s = seed + 7919 * (t + 1);
    const rng = makeRng(s);
    const noisy = { nodes: input.nodes, edges: edges.map((e) => ({ ...e, w: e.w * Math.max(0, 1 - PERTURBATION + 2 * PERTURBATION * rng()) })) };
    runs.push({ run: `weight perturbation, trial ${t + 1}`, seed: s, partition: leiden(noisy, { resolution: 1, seed }).partition });
  }
  const out = [];
  for (const { run, seed: s, partition } of runs) {
    const counts = new Map();
    for (const m of members) counts.set(partition.get(m), (counts.get(partition.get(m)) ?? 0) + 1);
    let best;
    let n = -1;
    for (const [l, c] of counts) if (c > n || (c === n && String(l) < String(best))) { best = l; n = c; }
    const moved = members.filter((m) => partition.get(m) !== best);
    if (moved.length) out.push({ run, seed: s, moved: moved.slice(0, KEEP_MOVED), moved_total: moved.length });
  }
  return out.sort((a, b) => b.moved_total - a.moved_total || a.run.localeCompare(b.run)).slice(0, KEEP_RUNS);
}
