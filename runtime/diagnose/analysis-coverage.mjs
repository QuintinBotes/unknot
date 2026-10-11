// Analysis coverage is kept apart from findings: an absent lexical metric is a limitation of
// the map, not evidence that the code is healthy. The mapper records this per language and
// diagnose renders any gaps alongside its findings.

export const LOCAL_ANALYSES = Object.freeze(['size', 'complexity', 'nesting', 'member_count']);

const DISPLAY = Object.freeze({
  size: 'size',
  complexity: 'complexity',
  nesting: 'nesting',
  member_count: 'member-count',
});

const source = (file) => file.kind === 'source' && !file.context;
const moduleFact = (facts) => facts.find((fact) => fact.kind === 'node' && fact.type === 'module') ?? null;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value);

/** What the adapter actually attempted for one source file. */
function fileAnalyses(facts, mod) {
  const ran = new Set(Array.isArray(mod?.attrs?.analyses) ? mod.attrs.analyses.filter((name) => LOCAL_ANALYSES.includes(name)) : []);
  if (!mod) return { ran, candidates: new Set() };
  if (numeric(mod.attrs?.loc) || numeric(mod.attrs?.sloc)) ran.add('size');
  const nodes = facts.filter((fact) => fact.kind === 'node');
  const funcs = nodes.filter((fact) => fact.type === 'function' || fact.type === 'method');
  const classes = nodes.filter((fact) => fact.type === 'class');
  if (funcs.some((fact) => numeric(fact.attrs?.cyclomatic))) ran.add('complexity');
  if (funcs.some((fact) => numeric(fact.attrs?.max_nesting))) ran.add('nesting');
  if (classes.some((fact) => numeric(fact.attrs?.methods))) ran.add('member_count');
  return {
    ran,
    candidates: new Set([
      ...(funcs.length ? ['complexity', 'nesting'] : []),
      ...(classes.length ? ['member_count'] : []),
    ]),
  };
}

/**
 * Per-language analysis status for a map. An analysis with no applicable symbol is not a gap;
 * one with an unhandled source file or a candidate whose metric was not emitted is.
 */
export function analysisCoverage(files, perFile) {
  const byLanguage = new Map();
  for (const file of files) {
    if (!source(file)) continue;
    const language = file.language ?? 'unknown';
    const facts = perFile.get(file.path) ?? [];
    const mod = moduleFact(facts);
    const entry = { path: file.path, mod, ...fileAnalyses(facts, mod) };
    if (!byLanguage.has(language)) byLanguage.set(language, []);
    byLanguage.get(language).push(entry);
  }
  return [...byLanguage].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([language, entries]) => {
    const unread = entries.filter((entry) => !entry.mod);
    const missing = new Set();
    if (unread.length) {
      LOCAL_ANALYSES.forEach((name) => missing.add(name));
    } else {
      for (const name of LOCAL_ANALYSES) {
        const applicable = name === 'size' ? entries : entries.filter((entry) => entry.candidates.has(name) || entry.ran.has(name));
        if (applicable.length && applicable.some((entry) => !entry.ran.has(name))) missing.add(name);
      }
    }
    const absent = LOCAL_ANALYSES.filter((name) => missing.has(name));
    const reason = !absent.length ? null
      : unread.length ? `${unread.length} of ${entries.length} source file${entries.length === 1 ? '' : 's'} had no module fact from an adapter`
        : 'the adapter did not emit the metric for every applicable source file';
    return {
      language,
      files: entries.length,
      ran: LOCAL_ANALYSES.filter((name) => !missing.has(name)),
      missing: absent,
      ...(reason && { reason }),
    };
  });
}

/** Read the mapper's metadata defensively: old maps simply have no coverage notice. */
export function readAnalysisCoverage(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.language === 'string' && Array.isArray(entry.missing)) : [];
  } catch {
    return [];
  }
}

/** Human-readable lines shared by the CLI and tests. */
export function analysisGapLines(coverage) {
  const list = (items) => items.length < 2 ? items[0] : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
  return coverage.filter((entry) => entry.missing?.length).map((entry) => {
    const names = entry.missing.map((name) => DISPLAY[name] ?? name);
    return `  ${entry.language}: ${list(names)} ${names.length === 1 ? 'analysis did' : 'analyses did'} not run (${entry.reason ?? 'no metric was recorded'}).`;
  });
}
