// A flag that takes a value is refused when given without one, and `map --adapter` refuses an id
// no adapter has, before anything is written (#186).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { parseArgs } from '../../../runtime/cli/util.mjs';

after(() => K.cleanup());

test('a bare value-taking flag is a usage error naming the flag and what it expects', () => {
  assert.throws(() => parseArgs(['map', '--adapter']), (e) => e.code === 'UK_CONFIG_INVALID' && e.message === '--adapter needs a value: --adapter <id>[,<id>...]');
  assert.throws(() => parseArgs(['plan', 'x', '--findings', '--json']), /--findings needs a value: --findings <F-id>/);
  assert.throws(() => parseArgs(['plan', 'x', '--proposal']), /--proposal needs a value: --proposal <file>/);
  assert.throws(() => parseArgs(['diagnose', '--fail-on']), /--fail-on needs a value: --fail-on new:<severity>/);
  // Switches, and flags whose bare form means something, keep parsing as before.
  assert.deepEqual(parseArgs(['map', '--adapter', 'javascript', '--json']).flags.adapter, 'javascript');
  assert.equal(parseArgs(['architecture', '--out']).flags.out, true);
  assert.equal(parseArgs(['map', '--replace']).flags.replace, true);
});

const cli = (p, ...args) => spawnSync(process.execPath, [join(K.REPO_ROOT, 'bin', 'unknot'), ...args, '--cwd', p.dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } });

test('map --adapter with an unknown id, or no id, changes nothing', () => {
  const p = K.makeProject({ files: { 'src/a.js': "import { b } from './b.js';\nexport const a = b;\n", 'src/b.js': 'export const b = 1;\n' } });
  assert.equal(cli(p, 'map').status, 0);
  const stats = () => JSON.parse(cli(p, 'graph', 'stats', '--json').stdout);
  const before = stats();
  for (const args of [['--adapter', 'nosuch'], ['--adapter', 'javascript,nosuch'], ['--adapter']]) {
    const r = cli(p, 'map', ...args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^unknot map: UK_CONFIG_INVALID: /);
    if (args[1]) assert.match(r.stderr, /unknown adapter nosuch; the adapters are .*javascript/);
    assert.deepEqual(stats(), before);
  }
  const ok = cli(p, 'map', '--adapter', 'javascript');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Mapped /);
});
