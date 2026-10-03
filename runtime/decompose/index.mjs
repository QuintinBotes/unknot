// /unknot:decompose (spec §15A.11): affinity graph → candidates → treatment selection →
// one recommendation per candidate, each with exactly one first slice. Read-only for
// source; writes the recommendation artifacts under .unknot/decompositions/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJSON } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { assertArtifact } from '../core/schema.mjs';
import { globalSignals } from '../diagnose/signals.mjs';
import { Graph } from '../graph/graph.mjs';
import { card } from '../patterns/engine.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { buildAffinity } from './affinity.mjs';
import { findCandidates, nameFor } from './candidates.mjs';
import { analyzeFrontend, isFrontendModule } from './frontend.mjs';
import { selectTreatment } from './select.mjs';

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
  return {
    treatment,
    objective: templates[treatment].objective,
    change_shape: templates[treatment].changes,
    pattern_step: step,
    scope: { include: cand.modules.slice(0, 50).map((m) => m.slice(7)), exclude: [] },
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

/**
 * @param {object} ctx
 * @param {{config: object, run?: object, scope?: string[], target?: 'auto'|'backend'|'frontend', drivers?: string[]}} opts
 */
export async function decompose(ctx, { config, run = null, scope = [], target = 'auto', drivers = [] }) {
  const graph = Graph.fromStore(ctx.store);
  if (!graph.size.nodes) throw new UnknotError('UK_BASELINE_INVALID', 'the graph is empty; run unknot map first');
  const allDrivers = [...new Set([...(config.decomposition.drivers ?? []).map((d) => d.id), ...drivers])];
  const effective = { ...config, decomposition: { ...config.decomposition, drivers: allDrivers.map((id) => ({ id })) } };
  const inScope = (n) => !scope.length || scope.some((s) => (n.path ?? n.id.slice(7)).startsWith(s.replace(/\/$/, '')));
  const source = graph.nodes('module').filter((n) => !n.attrs.is_test && !n.attrs.placeholder && inScope(n));
  const front = source.filter((n) => isFrontendModule(graph, n));
  const targets = target === 'auto' ? [source.length - front.length >= 2 ? 'backend' : null, front.length >= 2 ? 'frontend' : null].filter(Boolean) : [target];
  const global = globalSignals(graph, effective);
  const d = config.decomposition;
  const heuristics = [`weights structural=${d.weights.structural} data=${d.weights.data} evolutionary=${d.weights.evolutionary} semantic=${d.weights.semantic}`, `ownership_alignment>=${d.thresholds.ownership_alignment}`, `co_change_leak<=${d.thresholds.co_change_leak}`, `chatty_calls_p95<=${d.thresholds.chatty_calls_p95}`, `robustness>=${d.thresholds.robustness}`, `size_band=${d.size_band.join('-')}`];
  const recommendations = [];
  const analyses = {};
  for (const t of targets) {
    const modules = (t === 'frontend' ? front : source.filter((n) => !isFrontendModule(graph, n))).map((n) => n.id);
    const affinity = buildAffinity(graph, { modules, weights: d.weights });
    const found = findCandidates(graph, affinity, { sizeBand: d.size_band, robustness: d.thresholds.robustness });
    let fe = null;
    if (t === 'frontend') fe = analyzeFrontend(graph, { scopeFilter: inScope });
    analyses[t] = { modules: modules.length, affinity_edges: affinity.edges.length, components: affinity.components, modularity: found.modularity, robustness: found.stats, top_coupling: found.coupling.slice(0, 10), frontend: fe ? { groups: fe.groups.length, violations: fe.violations.length, shared_modules: fe.shared.length } : undefined };
    const candidates = t === 'frontend' && fe?.groups.length >= 2
      ? fe.groups.map((g, i) => ({ id: `R-${i + 1}`, name: `routes:/${g.name}`, modules: g.modules, size: g.modules.length, robust: true, stability: 1, cohesion: null, metrics: { 'boundary.size': g.modules.length, gaps: [] }, teams: g.teams }))
      : found.candidates;
    for (const cand of candidates) {
      const signals = { ...global, ...cand.metrics, 'boundary.robust': cand.robust ? 1 : 0, ...(fe?.signals ?? {}) };
      if (cand.teams) signals['frontend.teams'] = cand.teams.length || signals['frontend.teams'];
      delete signals.gaps;
      const sel = selectTreatment({ target: t, signals, drivers: allDrivers });
      const id = ctx.store.nextId('DEC', 4);
      const card0 = card(sel.card);
      const rec = {
        schema_version: '1.0',
        id,
        target: t,
        driver: allDrivers,
        candidate: { id: cand.id, name: cand.name ?? nameFor(cand.modules), modules: cand.modules, robust: Boolean(cand.robust), metrics: Object.fromEntries(Object.entries(signals).filter(([k, v]) => typeof v === 'number' && /^(boundary|module|ownership|owners|requests|cycle|tests|frontend|layer)\./.test(k))) },
        treatment: sel.treatment,
        favoring_signals: sel.favoring_signals,
        contraindications_checked: sel.contraindications_checked,
        rejected_treatments: sel.rejected_treatments.map(({ treatment, reason }) => ({ treatment, reason })),
        evidence_gaps: [...new Set([...(cand.metrics.gaps ?? []), ...(fe?.gaps ?? []), ...sel.evidence_gaps.map((g) => `${g} not measured`)])],
        confidence: cand.robust ? sel.confidence : 'low',
        first_slice: firstSlice(sel.treatment, { ...cand, name: cand.name ?? nameFor(cand.modules) }, sel),
        proof_obligations: obligationsFor(sel),
        recovery: { type: (card0.rollback_strategies ?? ['revert'])[0] ?? 'revert' },
        irreversible: false,
        retain_score: sel.treatment === 'T0' ? 1 : +Math.max(0, 1 - 0.25 * sel.favoring_signals.length).toFixed(2),
        heuristics_used: heuristics,
      };
      assertArtifact('decomposition-recommendation', rec);
      recommendations.push({ ...rec, evaluations: sel.evaluations, sequence: sel.sequence, serves: sel.serves, retain_reason: sel.retain_reason });
    }
  }
  const dir = join(ctx.paths.base, 'decompositions');
  mkdirSync(dir, { recursive: true });
  for (const r of recommendations) writeFileSync(join(dir, `${r.id}.json`), `${JSON.stringify(JSON.parse(canonicalJSON(r)), null, 2)}\n`);
  const summary = { targets, drivers: allDrivers, analyses, recommendations: recommendations.map((r) => ({ id: r.id, target: r.target, candidate: r.candidate.name, size: r.candidate.modules.length, treatment: r.treatment, sequence: r.sequence, confidence: r.confidence })) };
  appendEvent(ctx, { type: 'decomposition.recommended', run_id: run?.id, actor: 'runtime:decompose', payload: summary });
  return { ...summary, details: recommendations };
}
