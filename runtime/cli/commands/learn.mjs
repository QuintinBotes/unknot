// `unknot learn report|propose` — the feedback loop. `report` shows spec §21 metrics and
// per-detector calibration from human decisions; `propose` turns persistent rejections
// into threshold proposals in .unknot/config.proposed.yaml, which only a human can accept.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { stronglyConnected } from '../../graph/algorithms.mjs';
import { Graph } from '../../graph/graph.mjs';
import { detectorFeedback, thresholdProposals } from '../../learn/calibration.mjs';
import { outcomeSnapshot, productMetrics } from '../../learn/metrics.mjs';
import { parseYAML, stringifyYAML } from '../../core/yaml.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { output, table } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'report';
  const { ctx, config, actor } = open(flags);
  const feedback = detectorFeedback(ctx);
  if (sub === 'report') {
    const graph = Graph.fromStore(ctx.store);
    const report = { product: productMetrics(ctx), outcomes: outcomeSnapshot(ctx, graph, { stronglyConnected }), detectors: [...feedback.values()].map(({ rejectedValues, acceptedValues, ...e }) => e), proposals: thresholdProposals(feedback, config) };
    if (flags.json) return output(report, { json: true });
    const p = report.product;
    output([
      `Findings decided: ${p.findings.decided} (accepted ${p.findings.acceptance_rate ?? '—'}, rejected ${p.findings.rejection_rate ?? '—'})`,
      `Slices: ${p.delivery.slices}; proof success ${p.delivery.proof_success_rate ?? '—'}; replan ${p.delivery.replan_rate ?? '—'}; rollback ${p.delivery.rollback_rate ?? '—'}; escaped regressions ${p.delivery.escaped_regression_rate ?? '—'}`,
      `Median hours from finding to review-ready: ${p.delivery.median_hours_finding_to_review_ready ?? '—'}; policy block rate ${p.governance.policy_block_rate ?? '—'}`,
      `Outcomes (generation ${report.outcomes.current.generation}): cycles ${report.outcomes.current.dependency_cycles}, duplicate groups ${report.outcomes.current.duplicate_groups}, shared-writer tables ${report.outcomes.current.shared_writer_tables}${report.outcomes.previous ? ` (was ${report.outcomes.previous.dependency_cycles}/${report.outcomes.previous.duplicate_groups}/${report.outcomes.previous.shared_writer_tables})` : ''}`,
      '',
      'Detector calibration from human decisions:',
      table(report.detectors.map((e) => ({ detector: e.detector, accepted: e.accepted, rejected: e.rejected, precision: e.precision, rank_multiplier: e.multiplier })), ['detector', 'accepted', 'rejected', 'precision', 'rank_multiplier']),
      '',
      report.proposals.length ? `${report.proposals.length} threshold proposal(s); write them with: unknot learn propose` : 'No threshold changes proposed.',
    ].join('\n'));
    return 0;
  }
  if (sub === 'propose') {
    const proposals = thresholdProposals(feedback, config);
    if (!proposals.length) return output('No threshold changes to propose: not enough consistent rejections yet.');
    const base = existsSync(ctx.paths.config) ? parseYAML(readFileSync(ctx.paths.config, 'utf8')) ?? { version: 1 } : { version: 1 };
    base.detectors ??= {};
    for (const p of proposals) base.detectors[p.detector] = { ...(base.detectors[p.detector] ?? {}), [p.option]: p.proposed };
    writeFileSync(ctx.paths.proposedConfig, stringifyYAML(base));
    appendEvent(ctx, { type: 'config.proposed', actor, payload: { source: 'learning', proposals } });
    output([...proposals.map((p) => `${p.detector}.${p.option}: ${p.current} → ${p.proposed} — ${p.reason}`), '', 'Wrote .unknot/config.proposed.yaml. A person reviews it (unknot config diff) and accepts it (unknot config accept) in a terminal.'].join('\n'));
    return 0;
  }
  output('usage: unknot learn report|propose');
  return 2;
}
