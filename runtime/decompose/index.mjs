// /unknot:decompose (spec §15A.11): affinity graph → candidates → treatment selection →
// one recommendation per candidate, each with exactly one first slice. Read-only for
// source; writes the recommendation artifacts under .unknot/decompositions/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJSON } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { assertArtifact } from '../core/schema.mjs';
import { emptyScopeWarning, scopePredicate } from '../core/scope.mjs';
import { globalSignals } from '../diagnose/signals.mjs';
import { readDerived, testSet } from '../graph/derived.mjs';
import { Graph } from '../graph/graph.mjs';
import { card } from '../patterns/engine.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { buildAffinity } from './affinity.mjs';
import { disambiguate, findCandidates, topFiles } from './candidates.mjs';
import { analyzeFrontend, isFrontendModule } from './frontend.mjs';
import { fingerprintIndex, fingerprintOf, currentGeneration, loadRecords, predecessorOf } from './records.mjs';
import { readinessFor, selectTreatment } from './select.mjs';

const OBLIGATION_KINDS = new Set(['characterization', 'parse', 'lint', 'typecheck', 'unit', 'integration', 'contract', 'architecture-fitness', 'security-scan', 'secrets-scan', 'migration-rehearsal', 'reconciliation', 'infra-plan', 'performance', 'smoke', 'rollback-rehearsal', 'human-review', 'api-compatibility', 'no-new-cycles', 'diff-budget', 'scope-check']);

function firstSlice(treatment, cand, sel) {
  const c = card(sel.card);
  const step = (c.transformations ?? [])[0] ?? 'Document the boundary and its rationale.';
  const where = cand.name;
  const templates = {
    T0: { objective: `Record why ${where} is retained, with the evidence that would change the decision`, changes: 'documentation only' },
    T1: { objective: `Introduce boundary rules for ${where} in warn mode with a baseline of existing violations`, changes: 'boundary configuration and an architecture-fitness check; no source moves' },
    T2: { objective: `Put a facade in front of ${where}; existing call sites keep working through it`, changes: 'add facade module; redirect no callers yet' },
    T3: { objective: `Add an identity routing facade for ${where} at 0% traffic, with parity checks`, changes: 'routing seam only; the monolith stays the system of record' },
    T4: { objective: `Introduce an interface over ${where} with an adapter delegating to the current implementation`, changes: 'interface plus delegating adapter; callers migrate in later slices' },
    T5: { objective: `Expand the contract of ${where} additively so old and new consumers both work`, changes: 'additive change only' },
    T6: { objective: `Annotate data ownership for ${where} and expose cross-boundary reads through a read-only view or wrapper`, changes: 'ownership annotation and read-only access path; no data moves' },
    T7: { objective: `Route ${where} through an identity reverse proxy or framework rewrite, then move one low-coupling route`, changes: 'proxy/rewrite configuration first; no route moves in this slice' },
    T8: { objective: `Introduce feature/layer import rules for ${where} in warn mode with a baseline`, changes: 'lint rules only' },
    T9: { objective: `Add one read-only BFF endpoint for one screen, proxying existing APIs`, changes: 'new endpoint only; clients switch behind a flag later' },
  };
  if (treatment === 'T0' && sel.prepare?.length) {
    return {
      treatment,
      objective: `Establish ${sel.prepare.join(', ')} for ${where} so the decomposition decision can be made on evidence`,
      change_shape: 'tests, instrumentation and ownership records only; no structural change and no data moves',
      pattern_step: 'Gather the missing evidence before choosing a treatment',
      scope: { include: cand.modules.map((m) => m.slice(7)), exclude: [] },
      include_total: cand.modules.length,
      truncated: false,
      sequence: sel.sequence,
      prerequisite: null,
    };
  }
  return {
    treatment,
    objective: templates[treatment].objective,
    change_shape: templates[treatment].changes,
    pattern_step: step,
    scope: { include: cand.modules.map((m) => m.slice(7)), exclude: [] },
      include_total: cand.modules.length,
      truncated: false,
    sequence: sel.sequence,
    prerequisite: sel.sequence[0] === 'characterization' ? 'Add characterization tests that pin current behaviour of the scope before any structural change' : null,
  };
}

function obligationsFor(sel) {
  const c = card(sel.card);
  const kinds = (c.proof_obligations ?? []).filter((k) => OBLIGATION_KINDS.has(k));
  if (!kinds.includes('characterization') && sel.treatment !== 'T0') kinds.unshift('characterization');
  if (sel.treatment !== 'T0' && !kinds.includes('no-new-cycles')) kinds.push('no-new-cycles');
  return [...new Set(kinds)];
}


const MEMBER_SIGNAL = /^(boundary|module|ownership|owners|requests|cycle|tests|layer|frontend)\./;
const EVIDENCE_CAP = 20;

/** Ids a favouring signal was measured on: its own evidence, else the candidate's members. */
function evidenceFor(signal, cand) {
  const own = cand.details?.evidence?.[signal];
  if (own?.length) return [...new Set(own)].slice(0, EVIDENCE_CAP);
  return MEMBER_SIGNAL.test(signal) ? [...new Set(cand.modules)].slice(0, EVIDENCE_CAP) : [];
}

function provenanceFor(config, cliDrivers, allDrivers, given) {
  const byId = new Map((config.decomposition.drivers ?? []).map((d) => [d.id, { source: d.source ?? null, quote: d.quote ?? null }]));
  if (given?.source || given?.quote) for (const id of cliDrivers) byId.set(id, { source: given.source ?? null, quote: given.quote ?? null });
  return allDrivers.map((driver) => ({ driver, source: byId.get(driver)?.source ?? null, quote: byId.get(driver)?.quote ?? null }));
}

/**
 * @param {object} ctx
 * @param {{config: object, run?: object, scope?: string[], target?: 'auto'|'backend'|'frontend', drivers?: string[], driverProvenance?: {source?: string, quote?: string}, dryRun?: boolean}} opts
 */
export async function decompose(ctx, { config, run = null, scope = [], target = 'auto', drivers = [], driverProvenance = null, dryRun = false }) {
  const graph = Graph.fromStore(ctx.store);
  if (!graph.size.nodes) throw new UnknotError('UK_BASELINE_INVALID', 'the graph is empty; run unknot map first');
  readDerived(ctx, 'scc', { graph }); // seeds the stored facts candidates read
  const tests = testSet(graph);
  const allDrivers = [...new Set([...(config.decomposition.drivers ?? []).map((d) => d.id), ...drivers])];
  const effective = { ...config, decomposition: { ...config.decomposition, drivers: allDrivers.map((id) => ({ id })) } };
  const inScope = scopePredicate(graph, scope);
  const res = inScope.scope;
  const scopeInfo = { entries: scope, matched: res.matched, total: res.total, unresolved: res.unresolved };
  const warning = emptyScopeWarning(res);
  // A scope that selects nothing (or names a seed that is not there) records nothing.
  if (!res.all && (res.matched === 0 || res.unresolved.length)) return { targets: [], drivers: allDrivers, analyses: {}, recommendations: [], scope: scopeInfo, warning, dry_run: dryRun, details: [] };
  const source = graph.nodes('module').filter((n) => !tests.has(n.id) && !n.attrs.placeholder && inScope(n));
  const front = source.filter((n) => isFrontendModule(graph, n));
  const targets = target === 'auto' ? [source.length - front.length >= 2 ? 'backend' : null, front.length >= 2 ? 'frontend' : null].filter(Boolean) : [target];
  const global = globalSignals(graph, effective);
  const d = config.decomposition;
  const gen = currentGeneration(ctx);
  const heuristics = [`weights structural=${d.weights.structural} data=${d.weights.data} evolutionary=${d.weights.evolutionary} semantic=${d.weights.semantic}`, `ownership_alignment>=${d.thresholds.ownership_alignment}`, `co_change_leak<=${d.thresholds.co_change_leak}`, `chatty_calls_p95<=${d.thresholds.chatty_calls_p95}`, `robustness>=${d.thresholds.robustness}`, `size_band=${d.size_band.join('-')}`];
  const provenance = allDrivers.length ? provenanceFor(config, drivers, allDrivers, driverProvenance) : [];
  const work = [];
  const analyses = {};
  for (const t of targets) {
    const modules = (t === 'frontend' ? front : source.filter((n) => !isFrontendModule(graph, n))).map((n) => n.id);
    const affinity = buildAffinity(graph, { modules, weights: d.weights });
    const found = findCandidates(graph, affinity, { sizeBand: d.size_band, robustness: d.thresholds.robustness, eligible: modules });
    let fe = null;
    if (t === 'frontend') fe = analyzeFrontend(graph, { scopeFilter: inScope });
    analyses[t] = { modules: modules.length, affinity_edges: affinity.edges.length, components: affinity.components, modularity: found.modularity, robustness: found.stats, top_coupling: found.coupling.slice(0, 10), frontend: fe ? { groups: fe.groups.length, violations: fe.violations.length, shared_modules: fe.shared.length } : undefined };
    const candidates = t === 'frontend' && fe?.groups.length >= 2
      ? fe.groups.map((g, i) => ({ id: `R-${i + 1}`, name: `routes:/${g.name}`, name_basis: 'route', modules: g.modules, size: g.modules.length, robust: true, stability: 1, cohesion: null, metrics: { 'boundary.size': g.modules.length, gaps: [] }, teams: g.teams }))
      : found.candidates;
    for (const cand of candidates) {
      cand.top_files = topFiles(graph, cand.modules);
      work.push({ t, cand, fe });
    }
  }
  disambiguate(work.map((w) => w.cand));
  const known = fingerprintIndex(ctx);
  const prior = loadRecords(ctx);
  // Records this run writes again are nobody's predecessor.
  const claimed = new Set(work.map((w) => known.get(fingerprintOf({ target: w.t, drivers: allDrivers, modules: w.cand.modules }))).filter(Boolean));
  const recommendations = [];
  for (const { t, cand, fe } of work) {
    const signals = { ...global, ...cand.metrics, 'boundary.robust': cand.robust ? 1 : 0, ...(fe?.signals ?? {}) };
    if (cand.teams) signals['frontend.teams'] = cand.teams.length || signals['frontend.teams'];
    delete signals.gaps;
    const sel = selectTreatment({ target: t, signals, drivers: allDrivers, thresholds: d.thresholds });
    const fingerprint = fingerprintOf({ target: t, drivers: allDrivers, modules: cand.modules });
    const existing = known.get(fingerprint) ?? null;
    // A rerun overwrites its own record; only a new boundary takes a new id (never on a dry run).
    const id = existing ?? (dryRun ? 'new' : ctx.store.nextId('DEC', 4));
    // A boundary whose members changed gets a new id; it names the record it replaces. A record
    // a rerun rewrites keeps the link it had.
    const kept = existing && prior.find((r) => r.id === existing && r.supersedes);
    const pred = kept ? { id: kept.supersedes, overlap: kept.supersedes_overlap } : predecessorOf(prior, { target: t, modules: cand.modules, self: existing }, claimed);
    if (pred) claimed.add(pred.id);
    const card0 = card(sel.card);
    const rejectedTreatments = sel.rejected_treatments.map(({ treatment, reason, failed_predicates, evidence_needed }) => ({ treatment, reason, ...(failed_predicates ? { failed_predicates } : {}), ...(evidence_needed?.length ? { evidence_needed } : {}) }));
    const rec = {
      schema_version: '1.0',
      id: id === 'new' ? 'DEC-0000' : id,
      fingerprint,
      ...(pred ? { supersedes: pred.id, supersedes_overlap: pred.overlap } : {}),
      graph_generation: gen,
      // The run that wrote it, so an agent explaining the record can cite a real run.
      run_id: run?.id ?? null,
      scope: { entries: scope, matched: res.matched, total: res.total },
      target: t,
      driver: allDrivers,
      ...(provenance.length ? { driver_provenance: provenance } : {}),
      candidate: {
        id: cand.id,
        name: cand.name,
        name_basis: cand.name_basis,
        top_files: cand.top_files,
        modules: cand.modules,
        robust: Boolean(cand.robust),
        metrics: Object.fromEntries(Object.entries(signals).filter(([k, v]) => typeof v === 'number' && /^(boundary|module|ownership|owners|requests|cycle|tests|frontend|layer|traces|ci|driver)\./.test(k))),
        ...(cand.details?.cycle_detail ? { cycle_detail: cand.details.cycle_detail } : {}),
        // Modules outside the candidate that it imports: the candidate depends on them.
        // reverse_dependency_targets is the 0.1.x name, kept until 0.3.0.
        ...(cand.details?.reverse_targets ? { outbound_dependency_targets: cand.details.reverse_targets, reverse_dependency_targets: cand.details.reverse_targets } : {}),
        ...(cand.folded ? { folded_siblings: cand.folded } : {}),
        ...(cand.details?.owners ? { owners: cand.details.owners, ...(cand.details.unowned ? { unowned_modules: cand.details.unowned } : {}) } : {}),
        ...(cand.broken_by ? { robustness_detail: { stability: cand.stability, threshold: d.thresholds.robustness, broken_by: cand.broken_by } } : {}),
      },
      treatment: sel.treatment,
      favoring_signals: sel.favoring_signals.map((f) => ({
        ...f,
        evidence: evidenceFor(f.signal, cand),
        source: f.signal.startsWith('driver.') ? 'recorded driver (configuration or --driver)' : `measured: ${f.signal}, graph generation ${gen}`,
      })),
      ...(sel.drivers_not_served.length ? { drivers_not_served: sel.drivers_not_served } : {}),
      contraindications_checked: sel.contraindications_checked,
      rejected_treatments: rejectedTreatments,
      readiness: readinessFor({ target: t, signals, thresholds: d.thresholds, treatments: [...rejectedTreatments.map((r) => r.treatment), 'T3', 'T2'] }),
      evidence_gaps: [...new Set([...(cand.metrics.gaps ?? []), ...(fe?.gaps ?? []), ...sel.evidence_gaps.map((g) => `${g} not measured`)])],
      confidence: cand.robust ? sel.confidence : 'low',
      ...(sel.treatment === 'T0' ? { retain_reason: sel.retain_reason } : { selection_reason: sel.selection_reason }),
      first_slice: firstSlice(sel.treatment, cand, sel),
      proof_obligations: obligationsFor(sel),
      recovery: { type: (card0.rollback_strategies ?? ['revert'])[0] ?? 'revert' },
      irreversible: false,
      retain_score: sel.treatment === 'T0' ? 1 : +Math.max(0, 1 - 0.25 * sel.favoring_signals.length).toFixed(2),
      heuristics_used: heuristics,
    };
    assertArtifact('decomposition-recommendation', rec);
    recommendations.push({ ...rec, id, reused: Boolean(existing), evaluations: sel.evaluations, sequence: sel.sequence, serves: sel.serves });
  }
  if (!dryRun) {
    const dir = join(ctx.paths.base, 'decompositions');
    mkdirSync(dir, { recursive: true });
    for (const r of recommendations) {
      const { reused, ...body } = r;
      writeFileSync(join(dir, `${r.id}.json`), `${JSON.stringify(JSON.parse(canonicalJSON(body)), null, 2)}\n`);
    }
  }
  const summary = { targets, drivers: allDrivers, scope: scopeInfo, warning, dry_run: dryRun, analyses, recommendations: recommendations.map((r) => ({ id: r.id, target: r.target, candidate: r.candidate.name, size: r.candidate.modules.length, treatment: r.treatment, sequence: r.sequence, confidence: r.confidence, reused: r.reused })) };
  if (!dryRun) appendEvent(ctx, { type: 'decomposition.recommended', run_id: run?.id, actor: 'runtime:decompose', payload: summary });
  return { ...summary, details: recommendations };
}
