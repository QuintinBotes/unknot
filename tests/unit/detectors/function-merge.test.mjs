// A function that is long, complex and deeply nested is one finding, not three.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { diagnose, mergeFunctionFindings, recordDecision } from '../../../runtime/diagnose/engine.mjs';
import { nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { Graph } from '../../../runtime/graph/graph.mjs';

const P = prov({ source_type: 'ast', source_ref: 't.js:1', extractor: 'test@0.0.1', confidence: 'high' });
const mod = (path) => nodeFact('module', path, { name: path, path, attrs: { language: 'js', loc: 300, sloc: 200, is_test: false, parse_quality: 'ast' } }, P);
const fn = (path, name, attrs) => nodeFact('function', `${path}#${name}`, {
  name, path,
  attrs: { start_line: 10, end_line: 149, lines: 140, params: 1, cyclomatic: 1, cognitive: 1, max_nesting: 1, exported: true, kind: 'function', ...attrs },
}, P);

const homes = [];
after(() => homes.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'unknot-merge-'));
  homes.push(dir);
  process.env.UNKNOT_HOME = join(dir, 'home');
  const { openProject } = await import('../../../runtime/context.mjs');
  const { loadConfig } = await import('../../../runtime/policy/config.mjs');
  const ctx = openProject(join(dir, 'project'), { create: true });
  const { config } = loadConfig(ctx, { overrideRaw: { version: 1 } });
  return { ctx, config };
}

const facts = [
  mod('src/a.js'),
  fn('src/a.js', 'parseOrder', { cyclomatic: 31, cognitive: 40, max_nesting: 6 }),
  fn('src/a.js', 'justLong', { lines: 120 }),
];

test('one function tripping three detectors yields a single merged finding', async () => {
  const { ctx, config } = await setup();
  const graph = Graph.fromFacts(facts);
  const { findings } = await diagnose(ctx, { config, graph, only: ['local'] });
  const po = findings.filter((f) => f.key === 'function:src/a.js#parseOrder');
  assert.equal(po.length, 1);
  const f = po[0];
  assert.match(f.title, /parseOrder is 140 lines long, cyclomatic 31 and nested 6 deep/);
  assert.equal(f.related_kinds.length, 2);
  assert.ok(!f.related_kinds.includes(f.kind));
  assert.equal(f.measurements['function.max_nesting'], 6);
  assert.equal(f.measurements['function.cyclomatic'], 31);
  // an unrelated function keeps its own, unmerged finding
  const jl = findings.filter((f2) => f2.key === 'function:src/a.js#justLong');
  assert.equal(jl.length, 1);
  assert.equal(jl[0].related_kinds, undefined);
});

test('the primary keeps its fingerprint, so a recorded decision still applies', async () => {
  const { ctx, config } = await setup();
  const graph = Graph.fromFacts(facts);
  const opts = { config, graph, only: ['local'] };
  const first = (await diagnose(ctx, opts)).findings.find((f) => f.key === 'function:src/a.js#parseOrder');
  const { digest } = await import('../../../runtime/core/canonical.mjs').catch(() => ({}));
  if (digest) assert.equal(first.fingerprint, digest({ kind: first.kind, key: first.key }));
  recordDecision(ctx, { finding: first, decision: 'reject', rationale: 'generated parser, long on purpose', actor: 'human:test', days: 30 });
  const res = await diagnose(ctx, opts);
  // Rejected: no longer listed as open, and exactly one stored finding keeps the primary's fingerprint.
  assert.ok(!res.findings.some((f) => f.key === 'function:src/a.js#parseOrder'));
  const { getFinding } = await import('../../../runtime/diagnose/engine.mjs');
  const stored = getFinding(ctx, first.fingerprint);
  assert.equal(stored.kind, first.kind);
  assert.equal(stored.status, 'suppressed');
  assert.equal(stored.id, first.id ?? stored.id);
  const { detectorFeedback } = await import('../../../runtime/learn/calibration.mjs');
  const fb = detectorFeedback(ctx);
  assert.equal(fb.get(first.detector.id).rejected, 1);
});

test('mergeFunctionFindings leaves other kinds and different symbols alone', () => {
  const mk = (kind, key, score) => ({ kind, key, priority: { score }, measurements: {}, thresholds: {}, evidence: [], patterns: [], title: kind });
  const list = [mk('code.long-function', 'function:a#x', 1), mk('code.deep-nesting', 'function:a#y', 2), mk('code.dead-code', 'function:a#x', 3)];
  mergeFunctionFindings(list);
  assert.equal(list.length, 3);
});
