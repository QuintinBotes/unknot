// Projection keeps each run of facts' keys (#145): a re-map hashes only the runs a change reached and,
// while the kept keys describe the facts table, finds new and stale facts from those runs alone. Every
// step here is compared, row by row, with the same facts projected into an empty store, including the
// cases the runs cannot decide (a fact id held with two signatures, a store written without the stamp).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkTmp } from '../../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-runs-home-'));
const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');

const at = (path, confidence = 'high') => prov({ source_type: 'ast', source_ref: `${path}:1`, extractor: 'test', confidence });
const mod = (i, attrs = {}, confidence) => nodeFact('module', `m${i}.x`, { path: `m${i}.x`, attrs }, at(`m${i}.x`, confidence));
const imp = (i, j) => edgeFact('IMPORTS', `module:m${i}.x`, `module:m${j}.x`, {}, at(`m${i}.x`));

/** 400 modules in a ring of imports, with `edit` applied to the list. */
const factsOf = (edit = (l) => l) => edit(Array.from({ length: 400 }, (_, i) => [mod(i, { n: i }), imp(i, (i + 1) % 400)]).flat());

const rows = (ctx) => {
  const all = (sql) => ctx.store.all(sql).map((r) => ({ ...r }));
  return {
    facts: all('SELECT id, kind, subject, predicate, object, attrs, source_type, source_ref, extractor, confidence, scope, contradicts, path, digest FROM facts ORDER BY id'),
    nodes: all('SELECT * FROM nodes ORDER BY id'),
    edges: all('SELECT * FROM edges ORDER BY id'),
  };
};

test('a re-map finds new and stale facts from the runs a change reached, and stores what projecting from empty stores', () => {
  const ctx = openProject(mkTmp(join(tmpdir(), 'uk-runs-')), { create: true });
  const opts = { commit: 'c', observedAt: '2026-01-01T00:00:00Z' };
  const first = project(ctx, factsOf(), opts);
  assert.equal(first.hashed, 800);
  const step = (name, edit, matched) => {
    const facts = factsOf(edit);
    const r = project(ctx, facts, opts);
    const cold = openProject(mkTmp(join(tmpdir(), 'uk-runs-cold-')), { create: true });
    project(cold, facts, opts);
    assert.deepEqual(rows(ctx), rows(cold), `${name}: the same rows as projecting from empty`);
    assert.equal(r.matched, matched, `${name}: matched by ${matched}`);
    cold.store.close();
    return r;
  };
  const none = step('nothing changed', (l) => l, 'runs');
  assert.equal(none.hashed, 0);
  assert.equal(none.changed, false);
  const one = step('an attribute changed', (l) => l.map((f) => (f.id === 'module:m7.x' ? mod(7, { n: 70 }) : f)), 'runs');
  assert.ok(one.hashed > 0 && one.hashed < 100, `few facts hashed (${one.hashed})`);
  step('a signature changed, the id kept', (l) => l.map((f) => (f.id === 'module:m9.x' ? mod(9, { n: 9 }, 'low') : f)), 'runs');
  step('facts removed and added', (l) => [...l.filter((f) => f.id !== 'module:m30.x' && f.from !== 'module:m31.x'), mod(900), imp(900, 1)], 'runs');
  step('a fact repeated in another run', (l) => [...l, mod(200, { n: 200 })], 'runs');
  step('one copy of the repeated fact removed', (l) => l, 'runs');
  // Whole runs repeated: the same content held by more runs, then fewer, and a new content held twice.
  step('a block of facts repeated', (l) => [...l, ...l.slice(0, 300)], 'runs');
  step('and repeated once more', (l) => [...l, ...l.slice(0, 300), ...l.slice(0, 300)], 'runs');
  step('down to one copy', (l) => l, 'runs');
  step('a new block held twice', (l) => { const extra = [mod(950), imp(950, 2), mod(951), imp(951, 3)]; return [...l, ...extra, ...extra]; }, 'runs');
  // The facts table holds one row per id: an id held with two signatures cannot be told from the runs.
  step('an id held with two signatures', (l) => [...l, mod(5, { n: 5 }, 'low')], 'store');
  step('and gone again', (l) => l, 'store');
  step('back to runs', (l) => l.map((f) => (f.id === 'module:m11.x' ? mod(11, { n: 110 }) : f)), 'runs');
  // A store written without the stamp (an older release, or the stamp of another generation) is matched fact by fact.
  ctx.store.meta('projection:keys', '');
  step('no stamp', (l) => l.map((f) => (f.id === 'module:m12.x' ? mod(12, { n: 120 }) : f)), 'store');
  step('stamped again', (l) => l.map((f) => (f.id === 'module:m13.x' ? mod(13, { n: 130 }) : f)), 'runs');
  ctx.store.close();
});
