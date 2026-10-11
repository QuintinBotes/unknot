import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../../helpers/kernel.mjs';
import * as S from '../../../helpers/scip.mjs';
import { scipChecks } from '../../../../adapters/semantic/scip/locate.mjs';
import { mapRepository } from '../../../../runtime/graph/builder.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  K.cleanup();
});

const source = { 'package.json': '{"name":"sample"}\n', 'src/a.ts': 'export const answer = 42;\n' };
const cache = (project) => join(project.ctx.paths.state, 'adapter-cache', 'scip', 'typescript.scip');
const config = (scip) => K.cfg({ mode: 'plan', adapters: { scip } });

function withPath(dir, fn) {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${before ?? ''}`;
  return Promise.resolve().then(fn).finally(() => {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  });
}

function fakeIndexer(bytes, { marker = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uk-scip-indexer-'));
  dirs.push(dir);
  const script = join(dir, 'scip-typescript');
  const argv = `const at=process.argv.indexOf('--output'); if(at<0) process.exit(2); require('node:fs').writeFileSync(process.argv[at+1], Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'));`;
  const mark = marker ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');` : '';
  writeFileSync(script, `#!/usr/bin/env node\n${argv}${mark}\n`);
  chmodSync(script, 0o755);
  return dir;
}

function indexBytes() {
  return S.index({ documents: [S.document({ path: 'src/a.ts', language: 'typescript' })] });
}

test('an opt-in fake indexer runs through the broker and its valid output becomes semantic', async () => {
  const project = K.makeProject({ files: source });
  const bin = fakeIndexer(indexBytes());
  const result = await withPath(bin, () => mapRepository(project.ctx, { config: config({ run: true, languages: ['typescript'] }), configDigest: 'd', history: false }));
  const attrs = JSON.parse(project.ctx.store.get('SELECT attrs FROM nodes WHERE id = ?', 'module:src/a.ts').attrs);
  assert.equal(attrs.parse_quality, 'semantic');
  assert.equal(result.scip.coverage.typescript.quality, 'semantic');
  assert.match(result.scip.coverage.typescript.reason, /generated/);
  assert.ok(existsSync(cache(project)), 'the generated SCIP file is retained in the private cache');
  const cached = await mapRepository(project.ctx, { config: config({ run: false, languages: ['typescript'] }), configDigest: 'cache', history: false });
  assert.ok(cached.scip.indexes.includes('.unknot/state/adapter-cache/scip/typescript.scip'));
  assert.equal(JSON.parse(project.ctx.store.get('SELECT attrs FROM nodes WHERE id = ?', 'module:src/a.ts').attrs).parse_quality, 'semantic');
});

test('a person-supplied index for the same language wins over an enabled runner', async () => {
  const project = K.makeProject({ files: source });
  const supplied = join(project.dir, 'semantic.scip');
  S.writeIndex(supplied, { documents: [S.document({ path: 'src/a.ts', language: 'typescript' })] });
  const marker = join(mkdtempSync(join(tmpdir(), 'uk-scip-marker-')), 'ran');
  dirs.push(dirname(marker));
  const bin = fakeIndexer(indexBytes(), { marker });
  const result = await withPath(bin, () => mapRepository(project.ctx, { config: config({ run: true, languages: ['typescript'], index: 'semantic.scip' }), configDigest: 'd', history: false }));
  assert.ok(result.scip.indexes.includes('semantic.scip'));
  assert.equal(existsSync(marker), false, 'the runner was not spawned');
  assert.equal(existsSync(cache(project)), false, 'the supplied index did not create a competing cache');
  assert.match(result.scip.coverage.typescript.reason, /person-supplied/);
});

test('a missing selected indexer reports a lexical fallback reason', async () => {
  const project = K.makeProject({ files: source });
  const before = process.env.PATH;
  process.env.PATH = `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`;
  try {
    const result = await mapRepository(project.ctx, { config: config({ run: true, languages: ['typescript'] }), configDigest: 'd', history: false });
    assert.equal(result.scip.coverage.typescript.quality, 'lexical');
    assert.match(result.scip.coverage.typescript.reason, /not installed on PATH/);
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
});

test('doctor reports the marker-selected tool, run setting and repository-code classification', () => {
  const project = K.makeProject({ files: source });
  const check = scipChecks(project.dir, { run: true, languages: ['typescript'] }).find((item) => item.name === 'scip typescript');
  assert.ok(check);
  assert.match(check.detail, /scip-typescript: (installed|not installed)/);
  assert.match(check.detail, /run: on/);
  assert.match(check.detail, /executes repository code: no/);
});
