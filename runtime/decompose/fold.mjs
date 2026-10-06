// Sibling folding: a module just outside a candidate that only the candidate uses, and that
// sits in a directory the candidate occupies (or below one where it has several members), is
// part of it in everything but the clustering. Left outside it would count as a reverse
// dependency of its own owner. A whole small cluster used only from one candidate joins it.

const dirOf = (id) => id.slice(7).split('/').slice(0, -1).join('/');

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {string[][]} clusters member ids of every candidate
 * @param {Iterable<string>} eligible modules that may be folded (source, in scope, this target)
 * @returns {{folds: Map<number, {module: string, via: string, importers: string[], cluster?: number}[]>, absorbed: Map<number, number>}}
 *   folds per cluster index; absorbed maps a cluster that joined another to the one it joined
 */
export function foldSiblings(graph, clusters, eligible) {
  const owner = new Map();
  clusters.forEach((ms, i) => ms.forEach((m) => owner.set(m, i)));
  const pool = [...eligible].sort();
  const importersOf = (id) => [...new Set(graph.in(id, 'IMPORTS').map((e) => e.from).filter((f) => f !== id && graph.node(f)?.type === 'module' && !graph.node(f).attrs?.is_test))].sort();
  const folded = new Set();
  const folds = new Map();
  const absorbed = new Map();
  clusters.forEach((members, i) => {
    if (absorbed.has(i)) return;
    const mine = new Set(members);
    const count = new Map();
    const via = new Map();
    for (const m of members) {
      count.set(dirOf(m), (count.get(dirOf(m)) ?? 0) + 1);
      if (!via.has(dirOf(m))) via.set(dirOf(m), m);
    }
    // Below a directory only where the candidate has several members, and never below the
    // repository root or a top-level directory: that would reach half the code base.
    const roots = [...count].filter(([d, n]) => n >= 2 && d.split('/').length >= 2).map(([d]) => d);
    const anchor = (id) => {
      const d = dirOf(id);
      if (via.has(d)) return via.get(d);
      const r = roots.find((x) => d.startsWith(`${x}/`));
      return r ? via.get(r) : null;
    };
    const out = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const id of pool) {
        if (mine.has(id) || folded.has(id) || !anchor(id)) continue;
        const o = owner.get(id);
        if (o !== undefined && o !== i) {
          if (absorbed.has(o) || clusters[o].some((m) => folded.has(m))) continue;
          const other = new Set(clusters[o]);
          // The other cluster joins only whole, only from within reach, and only if nothing
          // outside this candidate and itself uses it.
          if (!clusters[o].every((m) => anchor(m) && importersOf(m).every((f) => mine.has(f) || other.has(f)))) continue;
          if (!clusters[o].some((m) => importersOf(m).some((f) => mine.has(f)))) continue;
          for (const m of clusters[o]) {
            mine.add(m);
            folded.add(m);
            out.push({ module: m, via: anchor(m), importers: importersOf(m), cluster: o });
          }
          absorbed.set(o, i);
          grew = true;
          continue;
        }
        if (o === i) continue;
        const importers = importersOf(id);
        if (!importers.length || !importers.every((f) => mine.has(f))) continue;
        mine.add(id);
        folded.add(id);
        out.push({ module: id, via: anchor(id), importers });
        grew = true;
      }
    }
    if (out.length) folds.set(i, out);
  });
  return { folds, absorbed };
}

export const foldReason = (f) => `only imported by ${f.importers.length === 1 ? f.importers[0].slice(7) : `${f.importers.length} candidate members`}; ${dirOf(f.module) === dirOf(f.via) ? 'same directory as' : 'below the directory of'} ${f.via.slice(7)}${f.cluster !== undefined ? ' (its whole cluster is used only from here)' : ''}`;
