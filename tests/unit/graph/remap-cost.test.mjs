// A re-map costs in proportion to the change, and the store does not grow with each one (#88).
// Assertions are on work done (calls, files scanned, rows and blobs kept), never on time.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';
import { nodeFact, prov } from '../../../runtime/graph/facts.mjs';

after(() => K.cleanup());

const config = K.cfg({ mode: 'plan' });
const map = (p, extra = {}) => mapRepository(p.ctx, { config, configDigest: 'd', history: false, ...extra });
const commit = (p, msg) => { K.git(p.dir, 'add', '-A'); K.git(p.dir, 'commit', '-q', '-m', msg); };

const files = {
  'src/metrics.js': "export const CHECKOUT_LATENCY = 'checkout.latency.ms';\n",
  'src/use.js': "import { CHECKOUT_LATENCY } from './metrics.js';\nexport function record() { return CHECKOUT_LATENCY; }\n",
  'src/a.js': 'export const a = 1;\n',
  'src/b.js': "import { a } from './a.js';\nexport const b = a + 1;\n",
  'src/c.js': "import { b } from './b.js';\nexport const c = b + 1;\n",
};

test('a re-map of an unchanged tree does no linking, discovery or projection work', async () => {
  const p = K.makeProject({ files });
  const seen = { link: 0, discover: 0 };
  const spy = {
    id: 'spy', version: '1', capabilities: { files: ['**/*.js'] },
    extract: (f) => [nodeFact('module', f.path, { path: f.path }, prov({ source_type: 'ast', source_ref: f.path, extractor: 'spy@1', confidence: 'high' }))],
    link: async () => { seen.link++; return []; },
    discover: async () => { seen.discover++; return []; },
  };
  const first = await map(p, { adapters: [spy] });
  assert.deepEqual(seen, { link: 1, discover: 1 });
  const again = await map(p, { adapters: [spy] });
  assert.deepEqual(seen, { link: 1, discover: 1 }, 'nothing re-linked or rediscovered');
  assert.equal(again.unchanged, true);
  assert.equal(again.generation, first.generation);
  assert.deepEqual([again.nodes, again.edges, again.facts, again.status], [first.nodes, first.edges, first.facts, first.status]);
  // Any changed file makes it a full (incremental) map again.
  writeFileSync(join(p.dir, 'src/a.js'), 'export const a = 2;\n');
  commit(p, 'edit');
  const changed = await map(p, { adapters: [spy] });
  assert.equal(changed.unchanged, undefined);
  assert.deepEqual(seen, { link: 2, discover: 2 });
});

test('a one-file edit rescans one file for constant uses, and the result equals a cold map', async () => {
  const p = K.makeProject({ files });
  const cold = await map(p);
  assert.ok(cold.discover_files.literals.scanned >= 5, 'a cold map scans every source file');
  const uses = (ctx) => ctx.store.all("SELECT id, subject, object, attrs FROM facts WHERE predicate = 'REFERENCES' AND attrs LIKE '%\"via\":\"CHECKOUT_LATENCY\"%' ORDER BY id");
  assert.equal(uses(p.ctx).length, 1);

  writeFileSync(join(p.dir, 'src/c.js'), "import { b } from './b.js';\nexport const c = b + 2;\n");
  commit(p, 'edit c');
  const edited = await map(p);
  assert.deepEqual(edited.discover_files.literals, { scanned: 1, cached: cold.discover_files.literals.scanned - 1 });

  // A new use is seen, a constant newly defined rescans everything (the set of names changed).
  writeFileSync(join(p.dir, 'src/b.js'), "import { CHECKOUT_LATENCY } from './metrics.js';\nexport const b = CHECKOUT_LATENCY;\n");
  commit(p, 'use in b');
  await map(p);
  assert.equal(uses(p.ctx).length, 2);
  const fresh = K.makeProject({ files: { ...files, 'src/b.js': "import { CHECKOUT_LATENCY } from './metrics.js';\nexport const b = CHECKOUT_LATENCY;\n", 'src/c.js': "import { b } from './b.js';\nexport const c = b + 2;\n" } });
  await map(fresh);
  const strip = (rows) => rows.map(({ id, object, attrs }) => ({ id, object, attrs }));
  assert.deepEqual(strip(uses(p.ctx)), strip(uses(fresh.ctx)));
});

test('re-maps replace superseded discovery blobs and leave the write-ahead log empty', async () => {
  const p = K.makeProject({ files });
  const blobs = () => p.ctx.store.get("SELECT COUNT(*) AS n FROM artifacts WHERE label LIKE 'discover.%'").n;
  await map(p);
  const base = blobs();
  assert.ok(base > 0);
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(p.dir, 'src/use.js'), `import { CHECKOUT_LATENCY } from './metrics.js';\n${'\n'.repeat(i + 1)}export function record() { return CHECKOUT_LATENCY; }\n`);
    commit(p, `move ${i}`);
    await map(p);
    assert.equal(blobs(), base, 'one discovery blob per adapter, whatever the number of re-maps');
  }
  assert.equal(p.ctx.store.get('PRAGMA wal_checkpoint(PASSIVE)').log, 0, 'the write-ahead log is folded into the database');
});

test('dropping one adapter\'s previous blob keeps a blob another adapter still references', async () => {
  const { casDrop, casPut } = await import('../../../runtime/state/cas.mjs');
  const p = K.makeProject({ files });
  const ref = casPut(p.ctx, '[]', { label: 'discover.a' });
  assert.equal(casPut(p.ctx, '[]', { label: 'discover.b' }), ref, 'identical content shares one blob');
  p.ctx.store.meta('discover:b', JSON.stringify({ key: 'k', ref }));
  casDrop(p.ctx, ref, 'discover.a');
  assert.ok(p.ctx.store.get('SELECT 1 AS x FROM artifacts WHERE digest = ?', ref), 'still referenced by discover:b');
  p.ctx.store.meta('discover:b', JSON.stringify({ key: 'k', ref: 'sha256:' + '0'.repeat(64) }));
  casDrop(p.ctx, ref, 'discover.a');
  assert.equal(p.ctx.store.get('SELECT 1 AS x FROM artifacts WHERE digest = ?', ref) ?? null, null, 'dropped once nothing references it');
});
