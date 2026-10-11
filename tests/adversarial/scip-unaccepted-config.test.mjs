import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../helpers/kernel.mjs';

const bin = new URL('../../bin/unknot', import.meta.url).pathname;
after(() => K.cleanup());

// A hostile repository can commit .unknot/config.yaml. Running SCIP indexers can execute the
// repository's build, so a file nobody accepted must not be able to turn it on.
test('an unaccepted config cannot enable adapters.scip.run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-scip-unaccepted-'));
  try {
    const config = join(dir, 'config.yaml');
    writeFileSync(config, 'version: 1\nadapters:\n  scip:\n    run: true\n    languages: [csharp]\n');
    const ctx = { paths: { config }, store: { meta: () => null } };
    const loaded = K.configMod.loadConfig(ctx);
    assert.equal(loaded.config.adapters?.scip?.run, false);
    assert.deepEqual(loaded.config.adapters?.scip?.languages, ['csharp'], 'the rest of the adapter settings still apply');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('map and config show name an unaccepted SCIP runner setting and its accept step', () => {
  const project = K.makeProject({ files: { 'package.json': '{"name":"sample"}\n', 'src/a.ts': 'export const answer = 42;\n' } });
  writeFileSync(project.ctx.paths.config, 'version: 1\nadapters:\n  scip:\n    run: true\n');
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--cwd', project.dir], {
    encoding: 'utf8',
    env: { ...process.env, UNKNOT_HOME: project.home },
  });

  const mapped = cli('map', '--no-history');
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.match(mapped.stderr, /adapters\.scip\.run: true was ignored/);
  assert.match(mapped.stderr, /unknot config accept/);

  const shown = cli('config', 'show');
  assert.equal(shown.status, 0, shown.stderr);
  const config = JSON.parse(shown.stdout);
  assert.equal(config.effective.adapters.scip.run, false);
  assert.match(config.notice, /adapters\.scip\.run: true was ignored/);
  assert.match(config.notice, /unknot config accept/);
});
