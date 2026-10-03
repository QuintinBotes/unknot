// Treatment selection (spec §15A.5–15A.6). Every T0–T9 card is evaluated against the
// candidate's measured signals; contraindicated treatments are discarded with their
// reasons; treatments that do not serve a recorded driver are discarded (except the
// driver-free ones); the least invasive survivor wins; retain wins when nothing fits.

import { card, evaluate, index } from '../patterns/engine.mjs';

// Lower is less invasive (spec §15A.6 step 4).
export const INVASIVENESS = Object.freeze({ T0: 0, T1: 1, T2: 2, T4: 2, T5: 2, T6: 3, T8: 4, T9: 4, T7: 5, T3: 6 });
export const DRIVER_FREE = new Set(['T0', 'T1', 'T2', 'T8']);

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

function treatmentCards(target) {
  const allowed = new Set(target === 'frontend' ? FRONTEND : BACKEND);
  const byTreatment = new Map();
  for (const h of index({ category: 'decomposition' })) if (h.treatment && allowed.has(h.treatment)) byTreatment.set(h.treatment, card(h.id));
  return byTreatment;
}

/**
 * @param {object} p
 * @param {'backend'|'frontend'} p.target
 * @param {object} p.signals measured signals for the candidate (vocabulary names)
 * @param {string[]} p.drivers recorded driver ids
 * @returns recommendation core (treatment, evaluations, rejected, gaps, confidence)
 */
export function selectTreatment({ target, signals, drivers }) {
  const cards = treatmentCards(target);
  const evaluations = [];
  for (const [t, c] of cards) evaluations.push({ treatment: t, card: c.id, ...evaluate(c, signals) });
  const rejected = [];
  const viable = [];
  for (const e of evaluations) {
    if (e.treatment === 'T0') continue;
    if (e.fit === 'contraindicated') {
      rejected.push({ treatment: e.treatment, reason: e.reasons.filter((r) => r.startsWith('contraindicated') || r.startsWith('precondition')).join('; ') || 'contraindicated' });
      continue;
    }
    if (e.fit === 'not_applicable') {
      rejected.push({ treatment: e.treatment, reason: 'no applicability signal is present' });
      continue;
    }
    const serves = SATISFIES[e.treatment].filter((d) => drivers.includes(d));
    if (!DRIVER_FREE.has(e.treatment) && !serves.length) {
      rejected.push({ treatment: e.treatment, reason: drivers.length ? `does not serve the recorded driver(s): ${drivers.join(', ')}` : 'no decomposition driver is recorded (spec §15A.2)' });
      continue;
    }
    if (e.fit === 'insufficient_evidence') {
      rejected.push({ treatment: e.treatment, reason: `insufficient evidence: ${e.gaps.join(', ') || 'unmeasured conditions'}`, evidence_needed: e.gaps });
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
  if (chosen?.treatment === 'T3' && ((signals['boundary.shared_table_writers'] ?? 0) > 0 || (signals['boundary.cross_joins'] ?? 0) > 0)) {
    const t6 = evaluations.find((e) => e.treatment === 'T6');
    if (t6 && t6.fit !== 'contraindicated') sequence = ['T6', 'T3'];
    else {
      rejected.push({ treatment: 'T3', reason: 'shared tables must be decomposed first and T6 is contraindicated' });
      chosen = pool.find((p) => p.treatment !== 'T3') ?? null;
      sequence = chosen ? [chosen.treatment] : ['T0'];
    }
  }
  const retain = evaluations.find((e) => e.treatment === 'T0');
  const treatment = chosen ? sequence[0] : 'T0';
  const gaps = [...new Set(evaluations.flatMap((e) => e.gaps))];
  const favouring = chosen ? chosen.checked.filter((c) => c.kind === 'applicability' && c.result === 'true') : [];
  const confidence = !chosen ? 'medium' : favouring.length >= 2 && gaps.length <= 2 ? 'high' : favouring.length >= 1 ? 'medium' : 'low';
  return {
    treatment,
    sequence,
    card: chosen?.card ?? retain?.card ?? 'decomposition.retain',
    serves: chosen?.serves ?? [],
    favoring_signals: favouring.map((c) => ({ signal: c.predicate.metric, value: c.value, source: 'measured', condition: c.id })),
    contraindications_checked: (chosen ?? retain)?.checked.filter((c) => c.kind === 'contraindication').map((c) => ({ id: c.id, result: c.result === 'true' ? 'fail' : c.result === 'false' ? 'pass' : 'unknown', value: c.value })) ?? [],
    rejected_treatments: rejected,
    evidence_gaps: gaps,
    confidence,
    evaluations: evaluations.map(({ treatment: t, fit, reasons }) => ({ treatment: t, fit, reasons })),
    retain_reason: chosen ? null : 'no treatment both fits the measured evidence and serves a recorded driver; retaining is the least risky correct answer until that changes',
  };
}
