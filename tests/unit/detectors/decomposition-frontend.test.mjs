import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-home-'));
const { Graph } = await import('../../../runtime/graph/graph.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { openProject } = await import('../../../runtime/context.mjs');
const { diagnose } = await import('../../../runtime/diagnose/engine.mjs');
const { DEFAULT_CONFIG } = await import('../../../runtime/policy/defaults.mjs');

const p = prov({ source_type: 'ast', extractor: 'test@1.0.0' });
const mod = (path, attrs = {}) => nodeFact('module', path, { path, attrs }, p);

function fixture({ coupled = true } = {}) {
  const facts = [nodeFact('table', 'public.orders', {}, p)];
  for (const m of ['app/orders/a.ts', 'app/orders/c.ts', ...(coupled ? ['app/billing/b.ts'] : [])]) {
    facts.push(mod(m), edgeFact('MUTATES', `module:${m}`, 'table:public.orders', {}, p));
  }
  for (let i = 0; i < 5; i++) {
    facts.push(mod(`app/billing/x${i}.ts`));
    if (coupled) facts.push(edgeFact('IMPORTS', `module:app/billing/x${i}.ts`, 'module:app/orders/c.ts', {}, p));
  }
  facts.push(mod('src/features/cart/ui.tsx', { language: 'typescript' }));
  for (let i = 0; i < 3; i++) {
    facts.push(mod(`src/features/checkout/m${i}.tsx`, { language: 'typescript' }));
    if (coupled) facts.push(edgeFact('IMPORTS', 'module:src/features/cart/ui.tsx', `module:src/features/checkout/m${i}.tsx`, {}, p));
  }
  return Graph.fromFacts(facts);
}

test('decomposition and frontend detectors fire on coupling and stay quiet without it', async () => {
  const ctx = openProject(mkdtempSync(join(tmpdir(), 'uk-proj-')), { create: true });
  const config = structuredClone(DEFAULT_CONFIG);
  const hot = await diagnose(ctx, { config, graph: fixture(), only: ['decomposition', 'frontend'] });
  assert.deepEqual(hot.errors, []);
  const kinds = hot.findings.map((f) => f.kind).sort();
  assert.ok(kinds.includes('decomposition.shared-table-writers'), kinds.join());
  assert.ok(kinds.includes('decomposition.misplaced-module'), kinds.join());
  assert.ok(kinds.includes('frontend.cross-feature-imports'), kinds.join());
  for (const f of hot.findings) assert.ok(f.alternatives.some((a) => a.id === 'retain'));

  const ctx2 = openProject(mkdtempSync(join(tmpdir(), 'uk-proj-')), { create: true });
  const cold = await diagnose(ctx2, { config, graph: fixture({ coupled: false }), only: ['decomposition', 'frontend'] });
  assert.deepEqual(cold.errors, []);
  assert.deepEqual(cold.findings.map((f) => f.kind), [], 'expected non-findings (spec 26.3)');
});
