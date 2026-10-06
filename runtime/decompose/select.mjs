// Treatment selection (spec §15A.5–15A.6). Every T0–T9 card is evaluated against the
// candidate's measured signals; contraindicated treatments are discarded with their
// reasons; treatments that do not serve a recorded driver are discarded (except the
// driver-free ones); the least invasive survivor wins; retain wins when nothing fits.

import { card, evaluate, index, test } from '../patterns/engine.mjs';

// Lower is less invasive (spec §15A.6 step 4).
export const INVASIVENESS = Object.freeze({ T0: 0, T1: 1, T2: 2, T4: 2, T5: 2, T6: 3, T8: 4, T9: 4, T7: 5, T3: 6 });
export const DRIVER_FREE = new Set(['T0', 'T1', 'T2', 'T8']);
const BEHAVIOUR_PRESERVING = new Set(['T1', 'T2', 'T4', 'T5', 'T8']);

// Which drivers a treatment can actually satisfy. T6 satisfies none on its own; it is the
// data prerequisite of T3 and is sequenced before it.
export const SATISFIES = Object.freeze({
  T0: [],
  T1: ['team_autonomy', 'build_time'],
  T2: ['build_time', 'team_autonomy'],
  T3: ['independent_deploy', 'independent_scale', 'availability_isolation', 'security_isolation', 'technology_divergence', 'team_autonomy'],
  T4: ['technology_divergence'],
  T5: [],
  T6: [],
  T7: ['independent_deploy', 'team_autonomy', 'technology_divergence', 'build_time'],
  T8: ['team_autonomy', 'build_time'],
  T9: ['team_autonomy', 'independent_deploy'],
});

const BACKEND = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T9'];
const FRONTEND = ['T0', 'T7', 'T8', 'T9', 'T2'];

// Card predicates on these metrics take their threshold from config, so a team that sets
// `decomposition.thresholds` gets the selection it configured (the cards carry defaults).
const THRESHOLD_METRICS = { 'ownership.alignment': 'ownership_alignment', 'module.co_change_leak': 'co_change_leak', 'boundary.calls_per_request_p95': 'chatty_calls_p95' };

export function withThresholds(card, thresholds = {}) {
  const fix = (list) => (list ?? []).map((item) => {
    const key = item.predicate && THRESHOLD_METRICS[item.predicate.metric];
    return key && typeof thresholds[key] === 'number' ? { ...item, predicate: { ...item.predicate, value: thresholds[key] } } : item;
  });
  return { ...card, applicability_signals: fix(card.applicability_signals), preconditions: fix(card.preconditions), contraindications: fix(card.contraindications) };
}

function treatmentCards(target) {
  const allowed = new Set(target === 'frontend' ? FRONTEND : BACKEND);
  const byTreatment = new Map();
  for (const h of index({ category: 'decomposition' })) if (h.treatment && allowed.has(h.treatment)) byTreatment.set(h.treatment, card(h.id));
  return byTreatment;
}

export const SEAM_REASON = 'no routable seam (HTTP route or queue entry) visible in this repository';

// What would measure a signal the graph does not have (named in the readiness table).
const EVIDENCE_FOR = {
  'traces.available': 'import runtime traces (evidence.traces)',
  'boundary.calls_per_request_p95': 'import runtime traces with per-request call counts (evidence.traces)',
  'ownership.alignment': 'CODEOWNERS or a service catalog (evidence.catalogs)',
  'boundary.cross_transactions': 'transaction-boundary facts (SQL or ORM adapters)',
  'boundary.shared_table_writers': 'table access facts (SQL or ORM adapters)',
  'boundary.cross_joins': 'table access facts (SQL or ORM adapters)',
  'module.co_change_leak': 'commit history with enough co-changing commits',
  'ci.per_unit_pipeline': 'CI workflow facts with path filters',
  'contracts.present': 'contract files (OpenAPI, pact) or a catalog naming the endpoints',
  'requests.interceptable': 'traces or a catalog naming the endpoints (evidence.traces, evidence.catalogs)',
  'tests.present': 'tests that cover the scope',
};

const DRIVER_NEEDS = { independent_deploy: 'independent deployment', independent_scale: 'independent scaling', availability_isolation: 'availability isolation', security_isolation: 'security isolation', technology_divergence: 'a different technology stack', team_autonomy: 'team autonomy', build_time: 'a faster build' };
const TREATMENT_WORDS = { T0: 'retaining', T1: 'modularizing in place', T2: 'modularizing in place', T4: 'modularizing in place', T5: 'an additive contract change', T6: 'annotating data ownership', T8: 'modularizing in place', T9: 'a read-only BFF endpoint' };

/** The predicates a treatment fails (signal, value, threshold; one per signal), from an evaluation's checked list. */
function failedPredicates(e, c) {
  const items = new Map([...(c.applicability_signals ?? []), ...(c.preconditions ?? []), ...(c.contraindications ?? [])].map((i) => [i.id, i]));
  const seen = new Set();
  return e.checked.filter((x) => x.predicate && ((x.kind === 'applicability' && x.result === 'false') || (x.kind === 'precondition' && x.result === 'false') || (x.kind === 'contraindication' && x.result === 'true' && items.get(x.id)?.hard)))
    .filter((x) => !seen.has(x.predicate.metric) && seen.add(x.predicate.metric))
    .map((x) => ({ kind: x.kind, signal: x.predicate.metric, value: x.value, op: x.predicate.op, threshold: x.predicate.value, id: x.id }));
}

const predicateText = (f) => `${f.signal}=${f.value} (${f.kind === 'contraindication' ? 'contraindicated when' : 'need'} ${f.op} ${f.threshold})`;

/** A rejection line: failed predicates first, then the evidence that is missing, then any other note. */
function rejection(failed, gaps, ...notes) {
  const parts = [];
  if (failed.length) parts.push(`failed: ${failed.map(predicateText).join('; ')}`);
  if (gaps.length) parts.push(`evidence missing: ${gaps.join(', ')}`);
  parts.push(...notes.filter(Boolean));
  return parts.join('; ');
}

/**
 * Per-predicate readiness of the given treatments: each applicability signal, precondition
 * and contraindication with its measured value, threshold and whether it holds. An
 * unmeasured signal has `value: null`, `met: null` and the evidence that would measure it.
 */
export function readinessFor({ target, signals, thresholds = {}, treatments }) {
  const rows = [];
  const cards = treatmentCards(target);
  for (const t of [...new Set(treatments)].sort()) {
    const c0 = cards.get(t);
    if (!c0) continue;
    const c = withThresholds(c0, thresholds);
    for (const [kind, list] of [['applicability', c.applicability_signals], ['precondition', c.preconditions], ['contraindication', c.contraindications]]) {
      for (const item of list ?? []) {
        if (!item.predicate) continue;
        const { metric, op, value: threshold } = item.predicate;
        const r = test(item.predicate, signals);
        const value = signals[metric] ?? null;
        rows.push({ treatment: t, kind, id: item.id, signal: metric, value, op, threshold, met: r === 'unknown' ? null : r === 'true', missing_evidence: r === 'unknown' ? EVIDENCE_FOR[metric] ?? `a measurement of ${metric}` : null });
      }
    }
  }
  return rows;
}

/**
 * @param {object} p
 * @param {'backend'|'frontend'} p.target
 * @param {object} p.signals measured signals for the candidate (vocabulary names)
 * @param {string[]} p.drivers recorded driver ids
 * @returns recommendation core (treatment, evaluations, rejected, gaps, confidence)
 */
// Metrics renamed for clarity, with the 0.1.x name still accepted until 0.3.0.
const RENAMED = { 'boundary.outbound_dependencies': 'boundary.reverse_deps', 'boundary.outbound_dependencies_test': 'boundary.reverse_deps_test' };
const withRenames = (signals) => {
  const out = { ...signals };
  for (const [now, before] of Object.entries(RENAMED)) if (out[now] === undefined && out[before] !== undefined) out[now] = out[before];
  return out;
};

export function selectTreatment({ target, signals: given, drivers, thresholds = {} }) {
  const signals = withRenames(given);
  const cards = new Map([...treatmentCards(target)].map(([t, c]) => [t, withThresholds(c, thresholds)]));
  // Missing tests do not rule out a behaviour-preserving treatment; they put a
  // characterization slice in front of it (spec §32 Scenario A). Evaluate as if tests
  // existed, and remember which treatments needed that.
  const withTests = { ...signals, 'tests.present': Math.max(1, signals['tests.present'] ?? 0), 'tests.characterization': 1 };
  const testsMissing = (signals['tests.present'] ?? 0) === 0 || signals['tests.characterization'] === 0;
  const evaluations = [];
  for (const [t, c] of cards) {
    const actual = evaluate(c, signals);
    if (testsMissing && actual.fit === 'contraindicated' && BEHAVIOUR_PRESERVING.has(t)) {
      const assumed = evaluate(c, withTests);
      if (assumed.fit !== 'contraindicated') {
        evaluations.push({ treatment: t, card: c.id, ...assumed, needs_characterization: true, reasons: [...assumed.reasons, 'requires characterization tests first (none cover this scope)'] });
        continue;
      }
    }
    evaluations.push({ treatment: t, card: c.id, ...actual });
  }
  const rejected = [];
  const viable = [];
  for (const e of evaluations) {
    if (e.treatment === 'T0') continue;
    const failed = failedPredicates(e, cards.get(e.treatment));
    const extra = { ...(failed.length ? { failed_predicates: failed.map(({ id, kind, ...f }) => f) } : {}), ...(e.gaps.length ? { evidence_needed: e.gaps } : {}) };
    if (e.fit === 'contraindicated') {
      const seam = e.checked.find((x) => x.kind === 'precondition' && x.id === 'requests-interceptable' && x.result === 'false');
      const other = e.reasons.filter((r) => r.startsWith('contraindicated') || r.startsWith('precondition')).filter((r) => !failed.length || /routable seam/.test(r));
      rejected.push({ treatment: e.treatment, reason: rejection(failed, e.gaps, ...other.map((r) => (seam && /routable seam/.test(r) ? SEAM_REASON : r))) || 'contraindicated', ...extra });
      continue;
    }
    if (e.fit === 'not_applicable') {
      rejected.push({ treatment: e.treatment, reason: rejection(failed, e.gaps, 'no applicability signal is present'), ...extra });
      continue;
    }
    const serves = SATISFIES[e.treatment].filter((d) => drivers.includes(d));
    if (!DRIVER_FREE.has(e.treatment) && !serves.length) {
      rejected.push({ treatment: e.treatment, reason: rejection(failed, e.gaps, drivers.length ? `does not serve the recorded driver(s): ${drivers.join(', ')}` : 'no decomposition driver is recorded (spec §15A.2)'), ...extra });
      continue;
    }
    if (e.fit === 'insufficient_evidence') {
      rejected.push({ treatment: e.treatment, reason: rejection(failed, e.gaps) || 'insufficient evidence: unmeasured conditions', ...extra });
      continue;
    }
    viable.push({ ...e, serves });
  }
  // Prefer a treatment that serves a driver; among those, the least invasive. Without a
  // driver, the least invasive driver-free treatment that fits.
  const servesDriver = viable.filter((v) => v.serves.length);
  const pool = drivers.length && servesDriver.length ? servesDriver : viable.filter((v) => DRIVER_FREE.has(v.treatment) || v.serves.length);
  pool.sort((a, b) => INVASIVENESS[a.treatment] - INVASIVENESS[b.treatment] || a.treatment.localeCompare(b.treatment));
  let chosen = pool[0] ?? null;
  // T3 with shared data goes through T6 first: data ownership before the network seam.
  let sequence = chosen ? [chosen.treatment] : ['T0'];
  if (chosen?.needs_characterization) sequence = ['characterization', ...sequence];
  if (chosen?.treatment === 'T3' && ((signals['boundary.shared_table_writers'] ?? 0) > 0 || (signals['boundary.cross_joins'] ?? 0) > 0)) {
    const t6 = evaluations.find((e) => e.treatment === 'T6');
    if (t6 && t6.fit !== 'contraindicated') sequence = ['T6', 'T3'];
    else {
      rejected.push({ treatment: 'T3', reason: 'shared tables must be decomposed first and T6 is contraindicated' });
      chosen = pool.find((p) => p.treatment !== 'T3') ?? null;
      sequence = chosen ? [chosen.treatment] : ['T0'];
      if (chosen?.needs_characterization) sequence = ['characterization', ...sequence];
    }
  }
  // With a recorded driver but nothing safe to do yet, the right first step is to gather
  // the evidence the decision is missing — contracts, runtime observability, ownership —
  // not to change structure or move data (spec §32 Scenario B).
  const prepare = [];
  if (!chosen && drivers.length) {
    if (signals['contracts.present'] !== 1) prepare.push('contracts');
    if (signals['traces.available'] !== 1) prepare.push('observability');
    if (signals['ownership.alignment'] === undefined) prepare.push('ownership');
    if (prepare.length) sequence = prepare;
  }
  const retain = evaluations.find((e) => e.treatment === 'T0');
  const treatment = chosen ? chosen.treatment === 'T3' && sequence[0] === 'T6' ? 'T6' : chosen.treatment : 'T0';
  const drivers_not_served = driversNotServed({ treatment: chosen?.treatment ?? 'T0', serves: chosen?.serves ?? [], drivers, evaluations, rejected });
  const gaps = [...new Set(evaluations.flatMap((e) => e.gaps))];
  const favouring = chosen ? chosen.checked.filter((c) => c.kind === 'applicability' && c.result === 'true') : [];
  const confidence = !chosen ? 'medium' : favouring.length >= 2 && gaps.length <= 2 ? 'high' : favouring.length >= 1 ? 'medium' : 'low';
  return {
    treatment,
    sequence,
    card: chosen?.card ?? retain?.card ?? 'decomposition.retain',
    serves: chosen?.serves ?? [],
    drivers_not_served,
    favoring_signals: favouring.map((c) => ({ signal: c.predicate.metric, value: c.value, source: `measured (${c.id})` })),
    contraindications_checked: (chosen ?? retain)?.checked.filter((c) => c.kind === 'contraindication').map((c) => ({ id: c.id, result: c.result === 'true' ? 'fail' : c.result === 'false' ? 'pass' : 'unknown', value: c.value })) ?? [],
    rejected_treatments: rejected,
    evidence_gaps: gaps,
    confidence,
    evaluations: evaluations.map(({ treatment: t, fit, reasons }) => ({ treatment: t, fit, reasons })),
    prepare,
    selection_reason: chosen ? selectionReason({ treatment, chosen, favouring, drivers }) : null,
    retain_reason: chosen ? null : prepare.length ? `retain until the evidence exists: ${prepare.join(', ')} come first, then decomposition is re-evaluated` : 'no treatment both fits the measured evidence and serves a recorded driver; retaining is the least risky correct answer until that changes',
  };
}

function selectionReason({ treatment, chosen, favouring, drivers }) {
  const names = favouring.map((c) => c.predicate.metric).join(', ');
  const why = `${treatment} is the least invasive treatment that fits the measured evidence${chosen.serves.length ? ` and serves ${chosen.serves.join(', ')}` : ''}${names ? ` (favouring: ${names})` : ''}`;
  const notRetain = chosen.serves.length ? `retaining does not serve the recorded driver(s) ${chosen.serves.join(', ')}` : drivers.length ? 'retaining leaves the structural cost this treatment removes in place' : 'a treatment that needs no driver fits, so documenting alone would leave the measured coupling unaddressed';
  return `${why}; not retained because ${notRetain}`;
}

/**
 * A recorded driver the chosen treatment does not serve, though a more invasive treatment
 * would: say so (and why that treatment was not taken) instead of listing only what is served.
 */
export function driversNotServed({ treatment, serves, drivers, evaluations, rejected }) {
  const out = [];
  for (const driver of drivers) {
    if (serves.includes(driver)) continue;
    const would = evaluations.map((e) => e.treatment).filter((t) => t !== 'T0' && INVASIVENESS[t] > INVASIVENESS[treatment] && SATISFIES[t]?.includes(driver))
      .sort((a, b) => INVASIVENESS[a] - INVASIVENESS[b] || a.localeCompare(b));
    if (!would.length) continue;
    const why = would.map((t) => `${t} ${rejected.find((r) => r.treatment === t) ? `was rejected: ${rejected.find((r) => r.treatment === t).reason}` : 'was not chosen'}`).join(' | ');
    out.push({ driver, would_be_served_by: would, reason: `${TREATMENT_WORDS[treatment] ?? treatment} does not give ${DRIVER_NEEDS[driver] ?? driver}; ${would.join(', ')} would, but ${why}` });
  }
  return out;
}
