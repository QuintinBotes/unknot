// /unknot:explain <finding> — the ten questions of spec §1.1 for one finding, with the
// provenance of every piece of evidence and the full pattern-fit reasoning.

import { getFinding } from '../../diagnose/engine.mjs';
import { scopeSignals, globalSignals } from '../../diagnose/signals.mjs';
import { Graph } from '../../graph/graph.mjs';
import { card, evaluate } from '../../patterns/engine.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

const QUESTIONS = Object.freeze([
  ['1_what', '1. What complexity exists?'],
  ['2_evidence', '2. What evidence supports that?'],
  ['3_why_accidental', '3. Why is it accidental rather than essential?'],
  ['4_smallest_simplification', '4. What is the smallest useful simplification?'],
  ['5_invariants', '5. What behaviour and qualities must remain unchanged?'],
  ['6_what_could_fail', '6. What could fail?'],
  ['7_verification', '7. How will it be verified?'],
  ['8_recovery', '8. How can it be reversed or restored?'],
  ['9_approvers', '9. Who must approve it?'],
  ['10_uncertainty', '10. What uncertainty remains?'],
]);

const dash = '—';
const inline = (value) => {
  if (value === null || value === undefined || value === '') return dash;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

const bullets = (values) => {
  const items = Array.isArray(values) ? values : values === null || values === undefined ? [] : [values];
  return items.length ? items.map((item) => `- ${inline(item)}`).join('\n') : dash;
};

const fields = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return inline(value);
  const entries = Object.entries(value);
  return entries.length ? entries.map(([key, item]) => `${key.replace(/_/g, ' ')}: ${inline(item)}`).join('\n') : dash;
};

function evidenceLocation(evidence) {
  const refs = [evidence.source_ref, ...(evidence.provenance ?? []).map((p) => p.source_ref)].filter(Boolean);
  return refs.find((ref) => /:\d+(?::\d+)?$/.test(ref)) ?? refs[0] ?? evidence.ref;
}

function renderEvidence(evidence) {
  if (!evidence.length) return dash;
  const lines = [];
  for (const item of evidence) {
    const detail = [item.label, item.summary].filter(Boolean).join(': ') || item.node_label;
    lines.push(`- ${evidenceLocation(item)} — ${detail}`);
    const provenance = (item.provenance ?? []).map((p) => `${p.source_type}, ${p.extractor}, ${p.confidence}`).join('; ');
    if (provenance) lines.push(`  ${provenance}`);
  }
  return lines.join('\n');
}

function answer(key, value) {
  if (key === '2_evidence') return renderEvidence(value);
  if (key === '3_why_accidental') {
    const essential = bullets(value.essential_considerations);
    return `${inline(value.argument)}\n\nEssential considerations:\n${essential}`;
  }
  if (['5_invariants', '6_what_could_fail', '7_verification', '10_uncertainty'].includes(key)) return bullets(value);
  if (key === '8_recovery' || key === '9_approvers') return fields(value);
  return inline(value);
}

/** Readable terminal rendering of the same record that --json returns. */
export function renderExplain(out) {
  const lines = [`${out.id} · ${out.status}`];
  for (const [key, heading] of QUESTIONS) lines.push('', heading, answer(key, out[key]));
  lines.push('', 'Alternatives', bullets(out.alternatives.map((alternative) => `${alternative.id}: ${alternative.summary}`)));
  if (out.pattern_fit.length) lines.push('', 'Pattern fit', bullets(out.pattern_fit.map((fit) => `${fit.id}: ${fit.fit}${fit.reasons?.length ? ` (${fit.reasons.join('; ')})` : ''}`)));
  lines.push('', `Priority: ${out.priority.score}`);
  if (Object.keys(out.measurements).length) lines.push('', 'Measurements', fields(out.measurements));
  if (Object.keys(out.thresholds).length) lines.push('', 'Thresholds', fields(out.thresholds));
  if (out.decisions.length) lines.push('', 'Earlier decisions', bullets(out.decisions.map((decision) => `${decision.decision}: ${decision.rationale} (${decision.actor}, ${decision.at})`)));
  return lines.join('\n');
}

export async function run({ positional, flags }) {
  const { ctx, config } = open(flags);
  const f = getFinding(ctx, positional[0]);
  const g = Graph.fromStore(ctx.store);
  const evidence = f.evidence.map((e) => {
    const node = ctx.store.get('SELECT id, type, label, fact_ids FROM nodes WHERE id = ?', e.ref);
    const prov = node ? ctx.store.all('SELECT source_type, source_ref, extractor, confidence, observed_at, commit_sha FROM facts WHERE id IN (SELECT value FROM json_each(?)) LIMIT 5', node.fact_ids) : [];
    return { ...e, node_label: node?.label ?? 'unknown', provenance: prov };
  });
  const signals = { ...globalSignals(g, config), ...scopeSignals(g, f.evidence.map((e) => e.ref)), ...f.measurements };
  const fit = f.patterns.map((p) => {
    try {
      return evaluate(card(p.id), signals);
    } catch {
      return p;
    }
  });
  const decisions = ctx.store.all('SELECT decision, rationale, actor, suppress_until, at FROM decisions WHERE fingerprint = ? ORDER BY at', f.fingerprint);
  const out = {
    id: f.id,
    status: f.status,
    '1_what': f.title,
    '2_evidence': evidence,
    '3_why_accidental': { argument: f.why_accidental, essential_considerations: f.essential_considerations },
    '4_smallest_simplification': f.smallest_simplification,
    '5_invariants': f.invariants,
    '6_what_could_fail': f.risks,
    '7_verification': f.verification,
    '8_recovery': f.recovery,
    '9_approvers': { risk: f.risk, roles: f.approvers },
    '10_uncertainty': f.uncertainties,
    alternatives: f.alternatives,
    pattern_fit: fit,
    priority: f.priority,
    measurements: f.measurements,
    thresholds: f.thresholds,
    decisions,
  };
  output(flags.json ? out : renderExplain(out), { json: Boolean(flags.json) });
}
