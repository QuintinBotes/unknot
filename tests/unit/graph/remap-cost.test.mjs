// A re-map costs in proportion to the change, and the store does not grow with each one (#88).
// Assertions are on work done (calls, files scanned, rows and blobs kept), never on time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkTmp } from '../../helpers/tmp.mjs';
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

test('a reused map reports this run\'s counts and says so in text (#182)', async () => {
  const p = K.makeProject({ files });
  const first = await map(p);
  assert.ok(Object.values(first.adapters).some((a) => a.extracted > 0) && first.discover_files, 'the first map did the work');
  const again = await map(p);
  assert.equal(again.unchanged, true);
  for (const [id, a] of Object.entries(again.adapters)) assert.deepEqual([a.extracted, a.cached], [0, a.files], id);
  for (const [id, l] of Object.entries(again.link ?? {})) assert.equal(l.relinked, 0, id);
  assert.deepEqual([first.projection.hashed > 0, again.projection.hashed], [true, 0], 'nothing was hashed');
  assert.equal(again.discover_files, undefined);
  assert.match(again.generated_at, /^\d{4}-\d\d-\d\dT/);
  // The CLI maps with the project's own config: its second map is the reused one.
  const cli = () => spawnSync(process.execPath, [join(K.REPO_ROOT, 'bin', 'unknot'), 'map', '--cwd', p.dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } }).stdout.split('\n')[0];
  assert.ok(cli().startsWith('Mapped '));
  const line = cli();
  assert.ok(/^Unchanged since the last map: reused generation \d+ from \d{4}-\d\d-\d\dT[^ ]+ \(/.test(line), line);
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

/** The stored graph, minus what differs between maps of the same tree (generation, time, commit). */
const dump = (ctx) => ({
  nodes: ctx.store.all('SELECT * FROM nodes ORDER BY id'),
  edges: ctx.store.all('SELECT * FROM edges ORDER BY id'),
  facts: ctx.store.all('SELECT id, kind, subject, predicate, object, attrs, source_type, source_ref, extractor, confidence, scope, contradicts, path, expires_at, digest FROM facts ORDER BY id'),
  derived: ctx.store.all("SELECT kind, key, body FROM derived WHERE kind != '_done' ORDER BY kind, key, body"),
});

test('clone fingerprints serve the link and are not stored; a re-map after edits, a rename, a deletion and a moved reference equals a cold map', async () => {
  const fixture = (name) => readFileSync(new URL(`../../fixtures/detectors/clones/${name}`, import.meta.url), 'utf8');
  const start = { ...files, 'src/orders.js': fixture('orders.js'), 'src/invoices.js': fixture('invoices.js') };
  const p = K.makeProject({ files: start });
  await map(p);
  const count = (sql) => p.ctx.store.get(`SELECT COUNT(*) AS n FROM ${sql} LIKE '%"fingerprints"%'`).n;
  const clones = (ctx) => ctx.store.all("SELECT id FROM nodes WHERE attrs LIKE '%\"clones\"%' ORDER BY id").map((r) => r.id);
  assert.deepEqual(clones(p.ctx), ['module:src/invoices.js', 'module:src/orders.js']);
  assert.ok(count("file_index WHERE adapter = 'quality' AND facts") > 0, 'the per-file cache keeps them for the next link');
  assert.equal(count('facts WHERE attrs') + count('nodes WHERE attrs'), 0, 'the graph does not');

  const final = { ...start, 'src/invoices.js': `${start['src/invoices.js']}\nexport function extra() { return 1; }\n`, 'src/c.js': "import { a } from './a.js';\nexport const c = a + 1;\n" };
  final['src/orders-renamed.js'] = final['src/orders.js'];
  delete final['src/orders.js'];
  delete final['src/use.js'];
  writeFileSync(join(p.dir, 'src/invoices.js'), final['src/invoices.js']);
  writeFileSync(join(p.dir, 'src/c.js'), final['src/c.js']);
  K.git(p.dir, 'mv', 'src/orders.js', 'src/orders-renamed.js');
  K.git(p.dir, 'rm', '-q', 'src/use.js');
  commit(p, 'edit, rename, delete, move a reference');
  const delta = await map(p);
  assert.ok(delta.cache.extracted > 0 && delta.cache.hits > 0);
  assert.deepEqual(clones(p.ctx), ['module:src/invoices.js', 'module:src/orders-renamed.js']);

  const cold = K.makeProject({ files: final });
  await map(cold);
  const a = dump(p.ctx);
  const b = dump(cold.ctx);
  for (const k of Object.keys(b)) assert.deepEqual(a[k], b[k], `${k} match a cold map`);
});

test('a new commit reads only that commit from git, and the history equals one read in full', async () => {
  const { casGet } = await import('../../../runtime/state/cas.mjs');
  const hconfig = K.cfg({ mode: 'plan', decomposition: { min_shared_commits: 1 } });
  const hmap = (p) => mapRepository(p.ctx, { config: hconfig, configDigest: 'd' });
  const p = K.makeProject({ files });
  const change = (n) => {
    for (const f of ['src/a.js', 'src/b.js']) writeFileSync(join(p.dir, f), `${files[f]}// ${n}\n`);
    commit(p, `change ${n}`);
  };
  for (let n = 1; n <= 3; n++) change(n);
  const first = await hmap(p);
  assert.equal(first.history.commits, 4);
  assert.equal(first.history.commits_read, 4);
  change(4);
  const next = await hmap(p);
  assert.equal(next.history.commits, 5);
  assert.equal(next.history.commits_read, 1, 'only the new commit is read');
  assert.ok(next.history.co_change_pairs > 0);
  const historyFacts = () => casGet(p.ctx, JSON.parse(p.ctx.store.meta('history:cache')).ref).toString('utf8');
  const incremental = historyFacts();

  // Without the per-commit cache every commit is read again: the same history, so the graph does not change.
  for (const k of ['history:commits', 'history:cache', 'map:last']) p.ctx.store.meta(k, '');
  const full = await hmap(p);
  assert.equal(full.history.commits_read, 5);
  assert.equal(historyFacts(), incremental);
  assert.equal(full.generation, next.generation);
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

// A shallow clone, mapped, deepened and mapped again, against a full read of the same state (#88).
const hconfig = K.cfg({ mode: 'plan', decomposition: { min_shared_commits: 1 } });
const hmap = (ctx) => mapRepository(ctx, { config: hconfig, configDigest: 'd' });
const historyOf = async (ctx) => (await import('../../../runtime/state/cas.mjs')).casGet(ctx, JSON.parse(ctx.store.meta('history:cache')).ref).toString('utf8');
const fullRead = async (ctx) => {
  for (const k of ['history:commits', 'history:cache', 'map:last']) ctx.store.meta(k, '');
  const r = await hmap(ctx);
  return { r, facts: await historyOf(ctx) };
};

async function shallowCloneOf(commits) {
  const p = K.makeProject({ files });
  for (let n = 1; n < commits; n++) {
    for (const f of ['src/a.js', 'src/b.js']) writeFileSync(join(p.dir, f), `${files[f]}// ${n}\n`);
    commit(p, `change ${n}`);
  }
  const dir = mkTmp(join(tmpdir(), 'uk-clone-'));
  K.git(dir, 'clone', '-q', '--depth', '2', `file://${p.dir}`, '.');
  return { origin: p, ctx: K.context.openProject(dir, { create: true }), dir };
}

test('a shallow boundary commit is not cached: after --unshallow the history equals a full read', async () => {
  const c = await shallowCloneOf(5);
  const shallow = await hmap(c.ctx);
  assert.match(shallow.history.unmeasured, /shallow/);
  K.git(c.dir, 'fetch', '-q', '--unshallow');
  const deep = await hmap(c.ctx);
  assert.equal(deep.history.unmeasured, undefined);
  const incremental = await historyOf(c.ctx);
  const full = await fullRead(c.ctx);
  assert.equal(incremental, full.facts);
  assert.equal(deep.history.co_change_pairs, full.r.history.co_change_pairs);
});

test('with history on, an incremental map through a deepen and a new commit equals a full read', async () => {
  const c = await shallowCloneOf(6);
  await hmap(c.ctx);
  K.git(c.dir, 'fetch', '-q', '--deepen', '1');
  await hmap(c.ctx);
  for (const f of ['src/a.js', 'src/b.js']) writeFileSync(join(c.dir, f), `${files[f]}// new\n`);
  commit({ dir: c.dir }, 'new');
  const next = await hmap(c.ctx);
  const incremental = await historyOf(c.ctx);
  const full = await fullRead(c.ctx);
  assert.equal(incremental, full.facts);
  assert.equal(next.history.commits, full.r.history.commits);
  assert.equal(next.history.co_change_pairs, full.r.history.co_change_pairs);
});
