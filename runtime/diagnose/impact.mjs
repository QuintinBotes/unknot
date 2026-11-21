// What fixing a finding is worth, by kind (#76): the ranking reads this before any tie-breaker.
// A kind with no row is measured by the distinct files in its scope. docs/findings.md lists them.

export const IMPACT = {
  'module.dependency-cycle': { measure: 'cycle.size + cycle.cut_edges: the files in the cycle and the edges that must go', of: (m) => (m['cycle.size'] ?? 0) + (m['cycle.cut_edges'] ?? 0) },
  'module.package-cycle': { measure: 'cycle.size: the packages in the cycle', of: (m) => m['cycle.size'] ?? 0 },
  'module.hub-module': { measure: 'module.fan_in × module.loc / 100: how many files a change can reach, times how much there is to change (in hundreds of lines, so it reads on the scale of a file count)', of: (m) => ((m['module.fan_in'] ?? 0) * (m['module.loc'] ?? 0)) / 100 },
};

export const impactOf = (f) => Math.max(1, IMPACT[f.kind]?.of(f.measurements ?? {}) ?? new Set(f.scope ?? []).size);

/** The priority scaled by the square root of impact, so a large subject outranks a cheap small one. */
export const impactRank = (f) => f.priority.score * Math.sqrt(1 + impactOf(f));

/** Kinds that report one subject from two angles: findings of these kinds with the same files are one finding. */
const SAME_SUBJECT = [['module.dependency-cycle', 'module.package-cycle']];

/**
 * Folds findings about one subject into the one with the highest impact rank, before they are stored:
 * the others' kinds go in its `related_kinds`, their evidence and measurements are added. Mutates `findings`.
 */
export function mergeSameSubject(findings) {
  const family = new Map(SAME_SUBJECT.flatMap((kinds, i) => kinds.map((k) => [k, i])));
  const groups = new Map();
  for (const f of findings) {
    const fam = family.get(f.kind);
    if (fam === undefined || !f.scope?.length) continue;
    const key = `${fam}|${[...f.scope].sort().join('\n')}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const drop = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [kept, ...rest] = group.sort((a, b) => impactRank(b) - impactRank(a) || a.kind.localeCompare(b.kind));
    for (const f of rest) {
      for (const e of f.evidence ?? []) if (!kept.evidence.some((x) => x.ref === e.ref && x.summary === e.summary)) kept.evidence.push(e);
      for (const [k, v] of Object.entries(f.measurements ?? {})) if (!(k in kept.measurements)) kept.measurements[k] = v;
      drop.add(f);
    }
    kept.related_kinds = [...new Set([...(kept.related_kinds ?? []), ...rest.map((f) => f.kind)])].sort();
  }
  for (let i = findings.length - 1; i >= 0; i--) if (drop.has(findings[i])) findings.splice(i, 1);
}

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
