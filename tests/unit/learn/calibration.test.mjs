// The feedback loop end to end: findings → human decisions → calibrated ranking and a
// threshold proposal that respects what people accepted.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { openProject } = await import('../../../runtime/context.mjs');
const { diagnose, recordDecision } = await import('../../../runtime/diagnose/engine.mjs');
const { DEFAULT_CONFIG } = await import('../../../runtime/policy/defaults.mjs');
const { detectorFeedback, thresholdProposals } = await import('../../../runtime/learn/calibration.mjs');
const { productMetrics } = await import('../../../runtime/learn/metrics.mjs');

const p = prov({ source_type: 'ast', extractor: 'test@1.0.0' });

function graph() {
  const facts = [nodeFact('module', 'src/a.py', { path: 'src/a.py', attrs: { language: 'python' } }, p)];
  // Functions just over the 80-line threshold (people will reject these) and well over it
  // (people will accept these).
  for (const [name, lines] of [['f84', 84], ['f88', 88], ['f92', 92], ['f95', 95], ['g200', 200], ['g250', 250]]) {
    facts.push(nodeFact('function', `src/a.py#${name}`, { name, path: 'src/a.py', attrs: { lines, cyclomatic: 3, params: 1, exported: true } }, p));
    facts.push(edgeFact('CONTAINS', 'module:src/a.py', `function:src/a.py#${name}`, {}, p));
  }
  return Graph.fromFacts(facts);
}

test('decisions calibrate the detector and propose a threshold between rejected and accepted values', async () => {
  const ctx = openProject(mkdtempSync(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const first = await diagnose(ctx, { config, graph: graph(), only: ['local'] });
  const long = first.findings.filter((f) => f.kind === 'code.long-function');
  assert.equal(long.length, 6);
  for (const f of long) {
    const big = f.measurements['function.lines'] >= 200;
    recordDecision(ctx, { finding: f, decision: big ? 'accept' : 'reject', rationale: big ? 'genuinely too long, worth splitting' : 'fine at this size for our codebase', actor: 'human:test', days: 30 });
  }
  const fb = detectorFeedback(ctx).get('local.long-function');
  assert.equal(fb.accepted, 2);
  assert.equal(fb.rejected, 4);
  assert.ok(fb.precision < 0.5 && fb.multiplier < 1, JSON.stringify(fb));

  const [proposal] = thresholdProposals(detectorFeedback(ctx), config);
  assert.equal(proposal.detector, 'local.long-function');
  assert.equal(proposal.option, 'lines');
  assert.equal(proposal.proposed, 95, 'just above the largest rejected value');
  assert.ok(proposal.proposed < 200, 'never past a value people accepted');

  // Rejected findings are suppressed; the calibration rides along on what remains.
  const again = await diagnose(ctx, { config, graph: graph(), only: ['local'] });
  assert.ok(again.findings.every((f) => f.kind !== 'code.long-function'), 'all six were decided');
  const metrics = productMetrics(ctx);
  assert.equal(metrics.findings.decided, 6);
  assert.equal(metrics.findings.rejection_rate, 0.667);
});

test('no proposal without enough consistent feedback', async () => {
  const ctx = openProject(mkdtempSync(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const res = await diagnose(ctx, { config, graph: graph(), only: ['local'] });
  const f = res.findings.find((x) => x.kind === 'code.long-function');
  recordDecision(ctx, { finding: f, decision: 'reject', rationale: 'one data point is not a pattern', actor: 'human:test', days: 30 });
  assert.deepEqual(thresholdProposals(detectorFeedback(ctx), config), []);
});
