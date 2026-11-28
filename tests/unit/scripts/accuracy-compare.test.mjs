import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExplanations, compareReports, GATE, gateReports, renderComparison, renderGate } from '../../../scripts/lib/accuracy-compare.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/accuracy-compare.mjs', import.meta.url));

const report = (unknot, overall, byDetector, recall) => ({
  unknot,
  generated: '2026-01-01T00:00:00.000Z',
  precision: { overall, by_detector: byDetector },
  recall: { by_detector: recall, by_language: {} },
});
const previous = report('0.9.0', { precision: 0.5, factual: 0.75 }, { cycle: { precision: 0.5, factual: 0.8 }, hub: { precision: 0.2, factual: 0.4 } }, { cycle: { found: 3, total: 4 }, hub: { found: 1, total: 4 } });
const current = report('0.10.0', { precision: 0.6, factual: 0.7 }, { cycle: { precision: 0.75, factual: 0.8 }, hub: { precision: 0.1, factual: 0.4 }, seam: { precision: 1, factual: 1 } }, { cycle: { found: 4, total: 4 }, hub: { found: 1, total: 4 } });

test('deltas are in percentage points, per detector and overall', () => {
  const c = compareReports(previous, current);
  assert.equal(c.overall.precision.delta, 10);
  assert.equal(c.overall.factual.delta, -5);
  assert.equal(c.overall.recall.before, 0.5);
  assert.equal(c.overall.recall.after, 0.625);
  assert.equal(c.overall.recall.delta, 13);
  const byName = (list) => Object.fromEntries(list.map((r) => [r.name, r]));
  assert.equal(byName(c.precision).cycle.delta, 25);
  assert.equal(byName(c.precision).hub.delta, -10);
  assert.equal(byName(c.factual).cycle.delta, 0);
  assert.equal(byName(c.recall).cycle.delta, 25);
  assert.equal(byName(c.recall).hub.delta, 0);
});

test('a detector present in only one report has no delta', () => {
  const c = compareReports(previous, current);
  const seam = c.precision.find((r) => r.name === 'seam');
  assert.equal(seam.before, null);
  assert.equal(seam.after, 1);
  assert.equal(seam.delta, null);
  assert.match(renderComparison(c), /\| seam \| n\/a \| 100% \| n\/a \|/);
});

test('rendered Markdown shows the sign of each change', () => {
  const md = renderComparison(compareReports(previous, current));
  assert.match(md, /\| Overall precision \| 50% \| 60% \| \+10 points \|/);
  assert.match(md, /\| Overall factual accuracy \| 75% \| 70% \| -5 points \|/);
  assert.match(md, /\| hub \| 20% \| 10% \| -10 points \|/);
  assert.match(md, /Seeded recall by detector/);
});

test('no previous report is reported, not an error', () => {
  const c = compareReports(null, current);
  assert.equal(c.previous, null);
  assert.match(renderComparison(c), /No previous result to compare with/);
});

test('command line: missing previous file exits 0, missing current file exits 2', () => {
  const dir = mkTmp(join(tmpdir(), 'uk-compare-'));
  try {
    const cur = join(dir, 'current.json');
    writeFileSync(cur, JSON.stringify(current));
    const out = execFileSync(process.execPath, [SCRIPT, join(dir, 'missing.json'), cur], { encoding: 'utf8' });
    assert.match(out, /No previous result to compare with/);
    const prev = join(dir, 'previous.json');
    writeFileSync(prev, JSON.stringify(previous));
    assert.match(execFileSync(process.execPath, [SCRIPT, prev, cur], { encoding: 'utf8' }), /\+10 points/);
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, prev, join(dir, 'nope.json')], { stdio: 'pipe' }), (e) => e.status === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Release gate (#247): reports shaped as scripts/accuracy.mjs writes them.
const REPOS = [{ name: 'petclinic', sha: 'a'.repeat(40) }, { name: 'pocketbase', sha: 'b'.repeat(40) }];
const gated = (unknot, byDetector, recall = {}, extra = {}) => ({
  unknot, generated: '2026-01-01T00:00:00.000Z', seed: 'unknot-1', sample: 20, quick: true, repositories: REPOS,
  precision: { overall: { precision: 0.5, factual: 0.8 }, by_detector: byDetector },
  recall: { by_detector: recall, by_language: {} },
  ...extra,
});
const prec = (precision, labelled) => ({ precision, factual: precision, labelled });
const before = gated('0.4.0', { hub: prec(0.6, 12), seam: prec(0.5, 4) }, { cycle: { found: 2, total: 2 } });
const dropped = gated('0.5.0', { hub: prec(0.4, 11), seam: prec(0.5, 4) }, { cycle: { found: 2, total: 2 } });

test('gate: a precision drop over the threshold on enough labelled findings fails, naming both sides', () => {
  assert.deepEqual(GATE, { maxDropPoints: 10, minLabelled: 10, minSeeded: 1 });
  const g = gateReports(before, dropped, []);
  assert.equal(g.ok, false);
  assert.deepEqual(g.checks.map((c) => [c.detector, c.metric, c.drop, c.beforeN, c.afterN, c.fails]), [['hub', 'precision', 20, 12, 11, true]]);
  assert.match(renderGate(g), /FAIL: hub precision fell from 60% \(12 labelled\) to 40% \(11 labelled\), 20 points, and no explanation for this release/);
  assert.match(renderGate(g), /Gate: FAIL\./);
  assert.equal(gateReports(before, gated('0.5.0', { hub: prec(0.5, 12) }), []).ok, true, 'a drop of exactly the threshold passes');
});

test('gate: an explanation for that detector and release passes and is printed; one for another release does not', () => {
  const g = gateReports(before, dropped, [{ detector: 'hub', release: 'v0.5.0', reason: 'labels corrected after review' }]);
  assert.equal(g.ok, true);
  assert.match(renderGate(g), /explained: hub precision fell from 60% .*: labels corrected after review/);
  assert.equal(gateReports(before, dropped, [{ detector: 'hub', release: '0.4.0', reason: 'old' }]).ok, false);
  assert.equal(gateReports(before, dropped, [{ detector: 'seam', release: '0.5.0', reason: 'other' }]).ok, false);
  assert.throws(() => checkExplanations([{ detector: 'hub', release: '0.5.0' }]), /no reason/);
  assert.throws(() => checkExplanations({}), /array/);
});

test('gate: a detector with fewer labelled findings than the minimum does not fail and says so', () => {
  const g = gateReports(before, gated('0.5.0', { hub: prec(0.6, 12), seam: prec(0.1, 4) }), []);
  assert.equal(g.ok, true);
  assert.match(renderGate(g), /too small to judge: seam precision fell from 50% \(4 labelled\) to 10% \(4 labelled\)/);
});

test('gate: no previous report, or a different corpus, seed or sample size, passes and says why', () => {
  assert.equal(gateReports(null, dropped).ok, true);
  assert.match(renderGate(gateReports(null, dropped)), /No previous release report to compare with/);
  for (const extra of [{ seed: 'other' }, { repositories: [REPOS[0]] }, { sample: 10 }]) {
    const g = gateReports(before, gated('0.5.0', { hub: prec(0.1, 12) }, {}, extra), []);
    assert.equal(g.ok, true);
    assert.match(renderGate(g), /different corpus, seed or sample size/);
  }
});

test('gate: a seeded-recall drop fails unless explained, like precision', () => {
  const lost = gated('0.5.0', { hub: prec(0.6, 12) }, { cycle: { found: 1, total: 2 } });
  const g = gateReports(before, lost, []);
  assert.equal(g.ok, false);
  assert.match(renderGate(g), /FAIL: cycle seeded recall fell from 100% \(2 seeded\) to 50% \(2 seeded\), 50 points/);
  assert.equal(gateReports(before, lost, [{ detector: 'cycle', release: '0.5.0', reason: 'seed moved' }]).ok, true);
});

test('command line: --gate exits 1 on an unexplained drop, 0 when explained or with no previous; without --gate always 0', () => {
  const dir = mkTmp(join(tmpdir(), 'uk-gate-'));
  const prev = join(dir, 'prev.json');
  const cur = join(dir, 'cur.json');
  const none = join(dir, 'none.json');
  writeFileSync(prev, JSON.stringify(before));
  writeFileSync(cur, JSON.stringify(dropped));
  writeFileSync(none, '[]');
  const run = (...a) => execFileSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', stdio: 'pipe' });
  assert.doesNotMatch(run(prev, cur), /Release gate/, 'without --gate nothing changes (FR-001)');
  assert.throws(() => run(prev, cur, '--gate', '--explained', none), (e) => e.status === 1 && /FAIL: hub precision/.test(e.stdout));
  const why = join(dir, 'why.json');
  writeFileSync(why, JSON.stringify([{ detector: 'hub', release: '0.5.0', reason: 'labels corrected' }]));
  assert.match(run(prev, cur, '--gate', '--explained', why), /explained: hub precision[^\n]*labels corrected/);
  assert.match(run(join(dir, 'missing.json'), cur, '--gate', '--explained', none), /No previous release report to compare with/);
  writeFileSync(why, '[{"detector":"hub"}]');
  assert.throws(() => run(prev, cur, '--gate', '--explained', why), (e) => e.status === 2 && /no release/.test(e.stderr));
});

test('the committed explanations file is valid', () => {
  checkExplanations(JSON.parse(readFileSync(new URL('../../../corpus/accuracy-explained.json', import.meta.url), 'utf8')));
});
