import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';

// Committing thousands of files triggers git's background auto-gc and maintenance, which
// would still be writing into .git while cleanup removes it.
Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false' });
after(() => K.cleanup());

test('an interrupted cold map resumes from the chunks already committed (spec §28)', async () => {
  const files = {};
  for (let i = 0; i < 6000; i++) files[`src/m${i}.js`] = `export const v${i} = ${i};\n`;
  const p = K.makeProject({ files });
  const config = K.cfg({ mode: 'plan' });
  let calls = 0;
  const fake = (failOn) => ({
    id: 'fake-js', kind: 'language', version: '1', capabilities: { files: ['**/*.js'] },
    async extractBatch(items) {
      calls++;
      if (calls === failOn) throw new Error('extractor died');
      return new Map(items.map(({ file }) => [file.path, []]));
    },
  });
  await assert.rejects(mapRepository(p.ctx, { config, configDigest: 'd', adapters: [fake(2)], history: false }), /extractor died/);
  calls = 0;
  const r = await mapRepository(p.ctx, { config, configDigest: 'd', adapters: [fake(0)], history: false });
  assert.equal(r.cache.hits, 5000, 'the first chunk was committed before the failure');
  assert.equal(r.cache.extracted, 6002 - 5000);
  assert.equal(calls, 1);
});

test('a quiet repository reads at least history_min_commits recent commits and says the window was extended', async () => {
  const p = K.makeProject();
  const old = { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(p.dir, 'src/a.js'), `export const a = ${i};\n`);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', `c${i}`], { cwd: p.dir, env: old });
  }
  const config = K.cfg({ mode: 'plan' });
  config.decomposition = { ...config.decomposition, history_days: 30, history_min_commits: 50 };
  const r = await mapRepository(p.ctx, { config, configDigest: 'd' });
  assert.match(r.history.window, /^extended to the latest \d+ commits/);
  assert.ok(r.history.commits >= 3);
  config.decomposition.history_min_commits = 0;
  const r2 = await mapRepository(p.ctx, { config, configDigest: 'd2' });
  assert.equal(r2.history.window, '30 days');
});

test('a degraded batch is not cached: the next map retries it and repeats the notice until it recovers', async () => {
  const p = K.makeProject({ files: { 'src/a.js': 'export const a = 1;\n' } });
  const config = K.cfg({ mode: 'plan' });
  let degrade = true;
  const fake = {
    id: 'fake-js', kind: 'language', version: '1', capabilities: { files: ['**/*.js'] },
    async extractBatch(items, { notes }) {
      if (degrade) notes.push('fake extractor unavailable; read lexically');
      return new Map(items.map(({ file }) => [file.path, []]));
    },
  };
  const first = await mapRepository(p.ctx, { config, configDigest: 'd', adapters: [fake], history: false });
  assert.deepEqual(first.notices, ['fake extractor unavailable; read lexically']);
  const second = await mapRepository(p.ctx, { config, configDigest: 'd', adapters: [fake], history: false });
  assert.deepEqual(second.notices, ['fake extractor unavailable; read lexically'], 'retried, not served from cache');
  assert.equal(second.cache.hits, 0);
  degrade = false;
  const third = await mapRepository(p.ctx, { config, configDigest: 'd', adapters: [fake], history: false });
  assert.equal(third.notices, undefined);
  const fourth = await mapRepository(p.ctx, { config, configDigest: 'd', adapters: [fake], history: false });
  assert.ok(fourth.cache.hits > 0, 'healthy results are cached');
});
