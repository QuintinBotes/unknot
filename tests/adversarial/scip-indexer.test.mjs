import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../helpers/kernel.mjs';
import { mapRepository } from '../../runtime/graph/builder.mjs';
import { INDEXERS, indexerArgv } from '../../adapters/semantic/scip/indexers.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  K.cleanup();
});

const source = { 'package.json': '{"name":"sample"}\n', 'src/a.ts': 'export const answer = 42;\n' };
const row = INDEXERS.find((entry) => entry.language === 'typescript');
const config = (run) => K.cfg({ mode: 'plan', adapters: { scip: { run, languages: ['typescript'] } } });
const output = (project) => join(project.ctx.paths.state, 'adapter-cache', 'scip', 'typescript.scip');

function withPath(dir, fn) {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${before ?? ''}`;
  return Promise.resolve().then(fn).finally(() => {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  });
}

function fakeIndexer({ marker = null, dir = null } = {}) {
  const bin = dir ?? mkdtempSync(join(tmpdir(), 'uk-scip-adversarial-'));
  if (!dir) dirs.push(bin);
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'scip-typescript');
  writeFileSync(file, `#!/usr/bin/env node\n${marker ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');` : ''}\nprocess.exit(0);\n`);
  chmodSync(file, 0o755);
  return bin;
}

test('a tracked SCIP cache file is refused before an indexer can run', async () => {
  const project = K.makeProject({ files: source });
  const cache = output(project);
  mkdirSync(join(project.ctx.paths.state, 'adapter-cache', 'scip'), { recursive: true });
  writeFileSync(cache, 'hostile cache');
  K.git(project.dir, 'add', '-f', '.unknot/state/adapter-cache/scip/typescript.scip');
  const markerDir = mkdtempSync(join(tmpdir(), 'uk-scip-marker-'));
  dirs.push(markerDir);
  const marker = join(markerDir, 'ran');
  const bin = fakeIndexer({ marker });
  const result = await withPath(bin, () => mapRepository(project.ctx, { config: config(true), configDigest: 'd', history: false }));
  assert.equal(result.scip.coverage.typescript.quality, 'lexical');
  assert.match(result.scip.coverage.typescript.reason, /tracked by git/);
  assert.equal(existsSync(marker), false, 'the repository-controlled cache prevented spawning');
});

test('an extra exec-style flag is rejected instead of extending a pinned indexer argv', () => {
  const argv = [...indexerArgv(row, '/private/tmp/typescript.scip'), '--exec=sh'];
  assert.equal(typeof K.broker.checkInternalArgv(argv), 'string');
});

test('an executable resolved from the repository is refused without being spawned', async () => {
  const project = K.makeProject({ files: source });
  const bin = join(project.dir, 'bin');
  mkdirSync(bin);
  const marker = join(project.dir, 'repo-tool-ran');
  fakeIndexer({ marker, dir: bin });
  const result = await withPath(bin, () => mapRepository(project.ctx, { config: config(true), configDigest: 'd', history: false }));
  assert.equal(result.scip.coverage.typescript.quality, 'lexical');
  assert.match(result.scip.coverage.typescript.reason, /resolves inside the repository/);
  assert.equal(existsSync(marker), false);
});

test('a SCIP indexer cannot request writable paths outside its one output file', async () => {
  const project = K.makeProject({ files: source });
  const cache = output(project);
  mkdirSync(join(project.ctx.paths.state, 'adapter-cache', 'scip'), { recursive: true });
  writeFileSync(cache, '');
  await assert.rejects(
    K.broker.brokerExec(project.ctx, {
      argv: indexerArgv(row, cache),
      cwd: project.dir,
      origin: 'internal',
      config: K.cfg(),
      writable: [cache, join(project.dir, 'outside')],
    }),
    (err) => err?.code === 'UK_POLICY_DENIED' && /one SCIP cache output/.test(err.message),
  );
});

test('the strict SCIP sandbox profile does not add a shared temporary directory', () => {
  const profile = K.sandbox.wrap(['scip-typescript', 'index', '--output', '/private/output.scip'], {
    kind: 'macos-sandbox-exec',
    writable: ['/private/output.scip'],
    strictWritable: true,
  }).args[1];
  assert.ok(!profile.includes('(subpath "/private/tmp")'));
  assert.ok(!profile.includes('(subpath "/tmp")'));
  const linux = K.sandbox.wrap(['scip-typescript', 'index', '--output', '/private/output.scip'], {
    kind: 'linux-bwrap',
    writable: ['/private/output.scip'],
    strictWritable: true,
  }).args;
  assert.equal(linux.some((arg, i) => arg === '--tmpfs' && linux[i + 1] === '/tmp'), false, 'the strict bwrap profile does not create a writable /tmp');
});

test('with run off, a marked indexer is never spawned', async () => {
  const project = K.makeProject({ files: source });
  const markerDir = mkdtempSync(join(tmpdir(), 'uk-scip-marker-'));
  dirs.push(markerDir);
  const marker = join(markerDir, 'ran');
  const bin = fakeIndexer({ marker });
  await withPath(bin, () => mapRepository(project.ctx, { config: config(false), configDigest: 'd', history: false }));
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(output(project)), false);
});
