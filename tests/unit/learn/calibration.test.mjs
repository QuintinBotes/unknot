// The feedback loop end to end: findings → human decisions → calibrated ranking and a
// threshold proposal that respects what people accepted.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkTmp } from '../../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-home-'));
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
  const ctx = openProject(mkTmp(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const first = await diagnose(ctx, { config, graph: graph(), only: ['local'] });
  const long = first.findings.filter((f) => f.kind === 'code.long-function');
  assert.equal(long.length, 6);
  for (const f of long) {
    const big = f.measurements['function.lines'] >= 200;
    recordDecision(ctx, { finding: f, decision: big ? 'accept' : 'reject', ...(!big && { reason: 'wrong' }), rationale: big ? 'genuinely too long, worth splitting' : 'fine at this size for our codebase', actor: 'human:test', days: 30 });
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
  const ctx = openProject(mkTmp(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const res = await diagnose(ctx, { config, graph: graph(), only: ['local'] });
  const f = res.findings.find((x) => x.kind === 'code.long-function');
  recordDecision(ctx, { finding: f, decision: 'reject', rationale: 'one data point is not a pattern', actor: 'human:test', days: 30 });
  assert.deepEqual(thresholdProposals(detectorFeedback(ctx), config), []);
});

test('a rejection says why: only wrong is a false positive, not-worth lowers actionability (#147)', async () => {
  const ctx = openProject(mkTmp(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const long = (await diagnose(ctx, { config, graph: graph(), only: ['local'] })).findings.filter((f) => f.kind === 'code.long-function');
  const decide = (f, decision, reason) => recordDecision(ctx, { finding: f, decision, reason, rationale: 'a reason of ten characters', actor: 'human:test', days: 30 });
  assert.equal(decide(long[0], 'accept').reason, undefined, 'an acceptance has no reason');
  assert.equal(decide(long[1], 'reject', 'wrong').reason, 'wrong');
  assert.equal(decide(long[2], 'reject', 'not-worth').reason, 'not-worth');
  assert.equal(decide(long[3], 'reject', 'other').reason, 'other');
  assert.equal(decide(long[4], 'reject').reason, 'other', 'no reason stores other');
  assert.throws(() => decide(long[5], 'reject', 'meh'), /reason must be one of wrong, not-worth, other/);
  assert.throws(() => decide(long[5], 'accept', 'wrong'), /only when rejecting/);
  assert.deepEqual(ctx.store.all('SELECT reason FROM decisions ORDER BY id').map((r) => r.reason), [null, 'wrong', 'not-worth', 'other', 'other']);

  const fb = detectorFeedback(ctx).get('local.long-function');
  assert.deepEqual([fb.accepted, fb.rejected, fb.wrong, fb.not_worth, fb.other], [1, 4, 1, 1, 2]);
  assert.equal(fb.precision, 0.5, 'precision: accepted against wrong only, (1+2)/(1+1+4)');
  assert.equal(fb.actionability, 0.5, 'actionability: accepted against not-worth only');
  const m = productMetrics(ctx).findings;
  assert.equal(m.false_positive_rate, 0.2, 'one wrong of five decisions');
  assert.equal(m.not_worth_rate, 0.2);
  assert.equal(m.rejection_rate, 0.8);
});

test('not worth doing never proposes a threshold, however many there are (#147)', async () => {
  const ctx = openProject(mkTmp(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const long = (await diagnose(ctx, { config, graph: graph(), only: ['local'] })).findings.filter((f) => f.kind === 'code.long-function');
  for (const f of long) {
    const big = f.measurements['function.lines'] >= 200;
    recordDecision(ctx, { finding: f, decision: big ? 'accept' : 'reject', ...(!big && { reason: 'not-worth' }), rationale: 'true, but not worth our time', actor: 'human:test', days: 30 });
  }
  const fb = detectorFeedback(ctx).get('local.long-function');
  assert.equal(fb.precision, 0.667, 'no false positives');
  assert.equal(fb.actionability, 0.4);
  assert.deepEqual(thresholdProposals(detectorFeedback(ctx), config), []);
});
