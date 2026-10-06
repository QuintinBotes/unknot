// Named objectives for `unknot diagnose --objective <name>` and the MCP `findings_list`.
// One table names each finding kind's relevance per objective; extend it by adding a row
// or a column. Any other objective text keeps the free-text category bias in the engine.
//
// Relevance, most to least: 'core' ranks first, 'related' next, 'other' after that, and
// 'folded' is replaced by one count unless every finding is asked for (`--all`).
// A row's `kind` is an exact kind or a `prefix.*`; the exact row wins over a prefix row,
// the longer prefix over a shorter one. A kind with no row, or a row without the
// objective, gets the objective's default. A level may be a function of the finding.

export const OBJECTIVES = {
  decompose: { default: 'related' },
  simplify: { default: 'other' }, // everything, current order
  security: { default: 'other' },
};

export const RELEVANCE = [
  // kind                                      decompose   simplify  security
  { kind: 'module.dependency-cycle', decompose: 'core' },
  { kind: 'module.package-cycle', decompose: 'core' },
  { kind: 'module.hub-module', decompose: 'core' },
  { kind: 'decomposition.co-change-leak', decompose: 'core' },
  { kind: 'decomposition.shared-table-writers', decompose: 'core' },
  { kind: 'decomposition.misplaced-module', decompose: 'core' },
  { kind: 'database.multiple-writers', decompose: 'core' },
  { kind: 'code.large-module', decompose: 'related' },
  { kind: 'code.unused-injected-member', decompose: (f) => (f.measurements?.['cycle.closed'] > 0 ? 'core' : 'folded') }, // core when it closes cycles
  { kind: 'code.*', decompose: 'folded' },
  { kind: 'security.*', security: 'core' },
  { kind: 'delivery.broad-ci-permissions', security: 'core' },
  { kind: 'infrastructure.iam-wildcards', security: 'core' },
  { kind: 'infrastructure.long-lived-keys', security: 'core' },
  { kind: 'infrastructure.privilege-widening-plan', security: 'core' },
  { kind: 'infrastructure.privileged-workloads', security: 'core' },
  { kind: 'infrastructure.public-exposure', security: 'core' },
  { kind: 'infrastructure.local-or-unencrypted-state', security: 'related' },
  { kind: 'infrastructure.mesh-sidecar-without-policy', security: 'related' },
  { kind: 'database.destructive-migration', security: 'related' },
  { kind: 'service.missing-idempotency', security: 'related' },
];

const TIER = { core: 0, related: 1, other: 2, folded: 3 };

export function isNamedObjective(objective) {
  return typeof objective === 'string' && Object.hasOwn(OBJECTIVES, objective.trim().toLowerCase());
}

/** The relevance of one finding kind for a named objective. */
export function relevance(objective, kind, finding = {}) {
  const name = objective.trim().toLowerCase();
  let best = null;
  for (const row of RELEVANCE) {
    if (!row[name]) continue;
    const exact = row.kind === kind;
    const prefix = row.kind.endsWith('.*') && kind.startsWith(row.kind.slice(0, -1));
    if (!exact && !prefix) continue;
    const specificity = exact ? Infinity : row.kind.length;
    if (!best || specificity > best.specificity) best = { specificity, level: row[name] };
  }
  const level = best?.level ?? OBJECTIVES[name].default;
  return typeof level === 'function' ? level(finding) : level;
}

/**
 * Order `findings` (already in ranked order) by relevance to a named objective and fold the
 * 'folded' ones. The sort is stable, so ranking inside a tier is unchanged. With `all` the
 * folded findings follow the relevant ones. Returns null for a text objective.
 */
export function applyObjective(findings, objective, { all = false } = {}) {
  if (!isNamedObjective(objective)) return null;
  const tiered = findings.map((f) => ({ f, tier: TIER[relevance(objective, f.kind, f)] }));
  tiered.sort((a, b) => a.tier - b.tier); // Array#sort is stable
  const shown = tiered.filter((t) => t.tier !== TIER.folded).map((t) => t.f);
  const folded = tiered.filter((t) => t.tier === TIER.folded).map((t) => t.f);
  const hiddenKinds = {};
  if (!all) for (const f of folded) hiddenKinds[f.kind] = (hiddenKinds[f.kind] ?? 0) + 1;
  return {
    findings: all ? [...shown, ...folded] : shown,
    objective: objective.trim().toLowerCase(),
    hidden: all ? 0 : folded.length,
    hidden_kinds: Object.fromEntries(Object.entries(hiddenKinds).sort(([a], [b]) => a.localeCompare(b))),
  };
}
