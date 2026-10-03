// /unknot:explain <finding> — the ten questions of spec §1.1 for one finding, with the
// provenance of every piece of evidence and the full pattern-fit reasoning.

import { getFinding } from '../../diagnose/engine.mjs';
import { scopeSignals, globalSignals } from '../../diagnose/signals.mjs';
import { Graph } from '../../graph/graph.mjs';
import { card, evaluate } from '../../patterns/engine.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

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
  output(out, { json: true });
}
