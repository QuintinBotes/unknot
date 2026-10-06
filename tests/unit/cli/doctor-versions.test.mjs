// doctor says when a session's hooks run another release than the CLI, and when the PATH shim
// predates following the session's loaded version (issue #18).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

after(() => K.cleanup());

const doctor = (p) => {
  const r = spawnSync(process.execPath, [join(K.REPO_ROOT, 'bin', 'unknot'), 'doctor', '--json', '--cwd', p.dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } });
  return JSON.parse(r.stdout).checks ?? JSON.parse(r.stdout);
};

test('hooks of another release seen in the last 15 minutes are reported; older entries are not', () => {
  const p = K.makeProject({ files: { 'src/a.js': 'export const a = 1;\n' } });
  const dir = join(p.dir, '.unknot', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ '0.0.1': { schema: 1, at: new Date().toISOString() }, '0.0.2': { schema: 1, at: new Date(Date.now() - 3600_000).toISOString() } }));
  const c = doctor(p).find((x) => x.name === 'session hooks');
  assert.equal(c?.level, 'warn');
  assert.match(c.detail, /hooks of Unknot 0\.0\.1 ran here in the last 15 minutes while this CLI is \d+\.\d+\.\d+; reload plugins or start a new session/);
  assert.doesNotMatch(c.detail, /0\.0\.2/);
});
