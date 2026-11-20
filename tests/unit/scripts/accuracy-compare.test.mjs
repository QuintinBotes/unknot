import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports, renderComparison } from '../../../scripts/lib/accuracy-compare.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'uk-compare-'));
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
