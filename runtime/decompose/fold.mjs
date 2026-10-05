// Sibling folding: a module just outside a candidate that only the candidate uses, and
// that sits in a directory the candidate already occupies, is part of it in everything but
// the clustering. Left outside it would count as a reverse dependency of its own owner.

const dirOf = (id) => id.slice(7).split('/').slice(0, -1).join('/');

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {string[][]} clusters member ids of every candidate
 * @param {Iterable<string>} eligible modules that may be folded (source, in scope, this target)
 * @returns {Map<number, {module: string, via: string, importers: string[]}[]>} per cluster index
 */
export function foldSiblings(graph, clusters, eligible) {
  const taken = new Set(clusters.flat());
  const pool = [...eligible].sort();
  const out = new Map();
  clusters.forEach((members, i) => {
    const mine = new Set(members);
    const dirs = new Map();
    for (const m of members) if (!dirs.has(dirOf(m))) dirs.set(dirOf(m), m);
    const folded = [];
    // Folding one module can leave another used only from inside the candidate.
    for (let grew = true; grew;) {
      grew = false;
      for (const id of pool) {
        if (taken.has(id) || !dirs.has(dirOf(id))) continue;
        const importers = [...new Set(graph.in(id, 'IMPORTS').map((e) => e.from).filter((f) => f !== id && graph.node(f)?.type === 'module' && !graph.node(f).attrs?.is_test))].sort();
        if (!importers.length || !importers.every((f) => mine.has(f))) continue;
        mine.add(id);
        taken.add(id);
        folded.push({ module: id, via: dirs.get(dirOf(id)), importers });
        grew = true;
      }
    }
    if (folded.length) out.set(i, folded);
  });
  return out;
}

export const foldReason = (f) => `only imported by ${f.importers.length === 1 ? f.importers[0].slice(7) : `${f.importers.length} candidate members`}; same directory as ${f.via.slice(7)}`;
