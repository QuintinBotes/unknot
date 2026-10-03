// The learning loop (spec §21.1). Human decisions are the feedback: every accept and
// reject of a finding is evidence about the precision of the detector that produced it.
//
// What the loop may do on its own: re-rank findings by calibrated precision. What it may
// only propose: changing a detector threshold, which goes to config.proposed.yaml for a
// human to accept like any other configuration change. It never disables a detector and
// never edits accepted configuration.

import { nowISO } from '../core/clock.mjs';

const PRIOR = { accepted: 2, rejected: 2 }; // Beta(2,2): neutral, and slow to swing on a few votes

// Detector option ← the measurement that crossed it, for threshold proposals.
export const THRESHOLD_FOR = Object.freeze({
  'local.long-function': { option: 'lines', metric: 'function.lines' },
  'local.complex-function': { option: 'cyclomatic', metric: 'function.cyclomatic' },
  'local.deep-nesting': { option: 'max_nesting', metric: 'function.max_nesting' },
  'local.long-parameter-list': { option: 'params', metric: 'function.params' },
  'local.large-class': { option: 'methods', metric: 'class.methods' },
  'local.large-module': { option: 'sloc', metric: 'module.loc' },
  'local.duplicated-code': { option: 'min_similarity', metric: 'duplication.similarity' },
});

/**
 * Per-detector feedback: accepted/rejected counts and a calibrated precision estimate.
 * @returns {Map<string, {detector, accepted, rejected, precision, multiplier, rejectedValues: number[], acceptedValues: number[]}>}
 */
export function detectorFeedback(ctx) {
  const rows = ctx.store.all(`
    SELECT d.decision, f.body FROM decisions d
    JOIN findings f ON f.fingerprint = d.fingerprint
    WHERE d.at = (SELECT MAX(d2.at) FROM decisions d2 WHERE d2.fingerprint = d.fingerprint)`);
  const out = new Map();
  for (const r of rows) {
    const f = JSON.parse(r.body);
    const id = f.detector?.id ?? f.kind;
    if (!out.has(id)) out.set(id, { detector: id, accepted: 0, rejected: 0, rejectedValues: [], acceptedValues: [] });
    const e = out.get(id);
    const t = THRESHOLD_FOR[id];
    const v = t ? f.measurements?.[t.metric] : undefined;
    if (r.decision === 'accept') {
      e.accepted++;
      if (typeof v === 'number') e.acceptedValues.push(v);
    } else {
      e.rejected++;
      if (typeof v === 'number') e.rejectedValues.push(v);
    }
  }
  for (const e of out.values()) {
    e.precision = +((e.accepted + PRIOR.accepted) / (e.accepted + e.rejected + PRIOR.accepted + PRIOR.rejected)).toFixed(3);
    // 0.5 is the prior; scale ranking by how far feedback moved it, within bounds so a
    // handful of decisions cannot bury or promote a detector entirely.
    e.multiplier = +Math.min(1.5, Math.max(0.3, e.precision / 0.5)).toFixed(3);
  }
  return out;
}

/**
 * Threshold proposals: when people keep rejecting findings just above a threshold and
 * accept the larger ones, the threshold is set too low for this codebase.
 */
export function thresholdProposals(feedback, config, { minDecisions = 4, maxPrecision = 0.45 } = {}) {
  const proposals = [];
  for (const e of feedback.values()) {
    const t = THRESHOLD_FOR[e.detector];
    if (!t || e.accepted + e.rejected < minDecisions || e.precision > maxPrecision || e.rejectedValues.length < 3) continue;
    const current = config.detectors?.[e.detector]?.[t.option];
    const rejectedMax = Math.max(...e.rejectedValues);
    const acceptedMin = e.acceptedValues.length ? Math.min(...e.acceptedValues) : Infinity;
    // Raise the threshold to just above the largest rejected value, but never past a value
    // people accepted: that would hide findings they told us are real.
    const proposed = t.option === 'min_similarity' ? +Math.min(0.95, rejectedMax + 0.05).toFixed(2) : Math.ceil(rejectedMax);
    if (proposed >= acceptedMin) continue;
    if (current != null && proposed <= current) continue;
    proposals.push({
      detector: e.detector,
      option: t.option,
      current: current ?? 'default',
      proposed,
      reason: `${e.rejected} of ${e.accepted + e.rejected} decisions rejected ${e.detector} findings (calibrated precision ${e.precision}); the largest rejected ${t.metric} was ${rejectedMax}${Number.isFinite(acceptedMin) ? `, the smallest accepted ${acceptedMin}` : ''}`,
    });
  }
  return proposals;
}

/** Apply calibration to a ranked finding list (ranking only; priority stays the §12 formula). */
export function calibrate(findings, feedback) {
  return findings.map((f) => {
    const e = feedback.get(f.detector?.id);
    if (!e) return f;
    return { ...f, calibration: { precision: e.precision, decisions: e.accepted + e.rejected, multiplier: e.multiplier, at: nowISO() } };
  });
}
