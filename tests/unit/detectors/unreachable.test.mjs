import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
const { openProject } = await import('../../../runtime/context.mjs');
const { diagnose } = await import('../../../runtime/diagnose/engine.mjs');
const { DEFAULT_CONFIG } = await import('../../../runtime/policy/defaults.mjs');
const { default: local } = await import('../../../runtime/diagnose/detectors/local.mjs');
const { runFixture } = await import('../adapters/javascript/helpers.mjs');

test('local.unreachable-code is registered', () => {
  assert.ok(local.some((d) => d.id === 'local.unreachable-code' && d.kinds.includes('code.unreachable-code')));
});

test('diagnose() flags only the dead functions, from the real adapter facts, with zero engine errors', async () => {
  const { graph } = runFixture('unreachable');
  const ctx = openProject(mkdtempSync(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const det = local.find((d) => d.id === 'local.unreachable-code');

  const drafts = det.detect({ graph, options: {} });
  assert.deepEqual(drafts.map((d) => d.key).sort(), [
    'function:src/dead.js#afterThrow',
    'function:src/dead.js#diffHash',
    'function:src/dead.js#ifElseBoth',
    'function:src/dead.js#loopJump',
  ]);
  const d = drafts.find((x) => x.key.endsWith('#diffHash'));
  assert.equal(d.kind, 'code.unreachable-code');
  assert.equal(d.evidence[0].source_ref, 'src/dead.js:12');
  assert.equal(d.factors.evidence, 0.9);
  assert.equal(d.measurements['symbol.references'], 0);
  assert.equal(d.recovery.type, 'revert');
  assert.ok(d.alternatives.some((a) => a.id === 'retain' && /comment/.test(a.summary)));
  assert.deepEqual(d.patterns, ['code.remove-dead-code']);

  const res = await diagnose(ctx, { config, graph, only: ['local'] });
  assert.deepEqual(res.errors.filter((e) => !/not installed|unknown property "risk"/.test(e.error)), []);
});
