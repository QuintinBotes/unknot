// What fixing a finding is worth, by kind (#76): the ranking reads this before any tie-breaker.
// A kind with no row is measured by the distinct files in its scope. docs/concepts.md lists them.

export const IMPACT = {
  'module.dependency-cycle': { measure: 'cycle.size + cycle.cut_edges: the files in the cycle and the edges that must go', of: (m) => (m['cycle.size'] ?? 0) + (m['cycle.cut_edges'] ?? 0) },
  'module.package-cycle': { measure: 'cycle.size: the packages in the cycle', of: (m) => m['cycle.size'] ?? 0 },
  'module.hub-module': { measure: 'module.fan_in × module.loc / 100: how many files a change can reach, times how much there is to change (in hundreds of lines, so it reads on the scale of a file count)', of: (m) => ((m['module.fan_in'] ?? 0) * (m['module.loc'] ?? 0)) / 100 },
};

export const impactOf = (f) => Math.max(0, IMPACT[f.kind]?.of(f.measurements ?? {}) ?? new Set(f.scope ?? []).size);

/** The priority scaled by the square root of impact, so a large subject outranks a cheap small one. */
export const impactRank = (f) => f.priority.score * Math.sqrt(1 + impactOf(f));

/** Highest `rank` first; ties go to the larger impact, then to the id, so the order is the same on every run. */
export const byRank = (rank) => (a, b) => rank(b) - rank(a) || impactOf(b) - impactOf(a) || a.id.localeCompare(b.id);

export const DEFAULT_MAX_PER_KIND = 10;

/** At most `cap` findings of each kind first, in rank order; the rest follow in rank order, so nothing is hidden. */
export function capPerKind(ranked, cap) {
  if (!(cap > 0)) return ranked;
  const seen = new Map();
  const head = [];
  const rest = [];
  for (const f of ranked) {
    const n = seen.get(f.kind) ?? 0;
    seen.set(f.kind, n + 1);
    (n < cap ? head : rest).push(f);
  }
  return [...head, ...rest];
}
