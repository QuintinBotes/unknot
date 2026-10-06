// Scopes accumulate across maps; --replace maps exactly the given ones (#22).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';

after(() => K.cleanup());

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const map = (p, scope = [], extra = {}) => mapRepository(p.ctx, { config: K.cfg({ mode: 'plan' }), configDigest: 'd', scope, history: false, ...extra });
const files = () => ({
  'pkg/a/one.js': "import { two } from '../b/two.js';\nexport const one = () => two;\n",
  'pkg/b/two.js': 'export const two = 2;\n',
  'pkg/c/three.js': 'export const three = 3;\n',
});
const modules = (p) => p.ctx.store.db.prepare("SELECT id FROM nodes WHERE type = 'module' AND id LIKE 'module:pkg/%' ORDER BY id").all().map((r) => r.id);
const imports = (p) => p.ctx.store.db.prepare("SELECT src, dst FROM edges WHERE type = 'IMPORTS' AND src LIKE 'module:pkg/%'").all();

test('map A then map B keeps A and the edges between them, and says A was kept', async () => {
  const p = K.makeProject({ files: files() });
  const first = await map(p, ['pkg/a']);
  assert.deepEqual(first.scope.covered, ['pkg/a']);
  assert.ok(!first.notices?.some((n) => /kept from earlier maps/.test(n)));
  const second = await map(p, ['pkg/b']);
  assert.deepEqual(second.scope, { whole: false, covered: ['pkg/a', 'pkg/b'], kept: ['pkg/a'], dropped: [], missing: [] });
  assert.ok(second.notices.some((n) => n === 'kept from earlier maps: pkg/a; use --replace to map only pkg/b'), JSON.stringify(second.notices));
  assert.deepEqual(modules(p), ['module:pkg/a/one.js', 'module:pkg/b/two.js']);
  assert.ok(imports(p).some((e) => e.src === 'module:pkg/a/one.js' && e.dst === 'module:pkg/b/two.js'), JSON.stringify(imports(p)));
  assert.ok(second.cache.hits > 0, 'the kept scope comes from the file cache');
});

test('--replace maps only the given scopes and names what it dropped', async () => {
  const p = K.makeProject({ files: files() });
  await map(p, ['pkg/a']);
  const r = await map(p, ['pkg/b'], { replace: true });
  assert.deepEqual(r.scope, { whole: false, covered: ['pkg/b'], kept: [], dropped: ['pkg/a'], missing: [] });
  assert.ok(r.notices.some((n) => /dropped from earlier maps: pkg\/a/.test(n)), JSON.stringify(r.notices));
  assert.deepEqual(modules(p), ['module:pkg/b/two.js']);
  assert.equal(JSON.parse(p.ctx.store.meta('mapped_scopes')).scopes.join(), 'pkg/b');
});

test('a whole-repository map after scoped maps records the whole repository', async () => {
  const p = K.makeProject({ files: files() });
  await map(p, ['pkg/a']);
  const r = await map(p);
  assert.equal(r.scope.whole, true);
  assert.ok(r.notices.some((n) => /whole repository now covers the earlier scopes: pkg\/a/.test(n)));
  assert.deepEqual(JSON.parse(p.ctx.store.meta('mapped_scopes')), { whole: true, scopes: [] });
  assert.equal(modules(p).length, 3);
  const later = await map(p, ['pkg/c']);
  assert.equal(later.scope.whole, true, 'a scoped map after a whole map still covers the whole repository');
  assert.equal(modules(p).length, 3);
  assert.ok(later.notices.some((n) => /kept from earlier maps: the whole repository/.test(n)));
});

test('a scope deleted from disk is dropped with a notice', async () => {
  const p = K.makeProject({ files: files() });
  await map(p, ['pkg/a']);
  rmSync(join(p.dir, 'pkg/a'), { recursive: true });
  const r = await map(p, ['pkg/b']);
  assert.deepEqual(r.scope.missing, ['pkg/a']);
  assert.deepEqual(r.scope.covered, ['pkg/b']);
  assert.ok(r.notices.some((n) => n === 'scope no longer on disk, dropped: pkg/a'), JSON.stringify(r.notices));
  assert.deepEqual(modules(p), ['module:pkg/b/two.js']);
});

test('the CLI names the covered scopes in map and status; --replace takes the scope after it', () => {
  const p = K.makeProject({ files: files() });
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: p.dir, encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } });
    return r.stdout + r.stderr;
  };
  cli('map', 'pkg/a', '--no-history');
  const out = cli('map', 'pkg/b', '--no-history');
  assert.match(out, /Covers: pkg\/a, pkg\/b\./);
  assert.match(out, /Note: kept from earlier maps: pkg\/a; use --replace to map only pkg\/b/);
  assert.match(cli('status'), /Covers: pkg\/a, pkg\/b/);
  const replaced = cli('map', '--replace', 'pkg/c', '--no-history');
  assert.match(replaced, /Covers: pkg\/c\./);
  assert.match(replaced, /dropped from earlier maps: pkg\/a, pkg\/b/);
  assert.match(cli('status', '--json'), /"scope": \{\s*"whole": false,\s*"scopes": \[\s*"pkg\/c"/);
});
