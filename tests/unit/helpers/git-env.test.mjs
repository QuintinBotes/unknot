// Tests run git without the developer's global or system configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../helpers/kernel.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

// A developer machine: a global hook that leaves a marker, and signing with no key.
function hostile() {
  const d = mkTmp(join(tmpdir(), 'uk-gitenv-'));
  const hooks = join(d, 'hooks');
  mkdirSync(hooks);
  const marker = join(d, 'hook-ran');
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const gitconfig = join(d, 'gitconfig');
  writeFileSync(gitconfig, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent\n`);
  return { d, marker, gitconfig };
}

const COMMIT = `
import { git } from ${JSON.stringify(resolve(REPO_ROOT, 'tests/helpers/kernel.mjs'))};
import { writeFileSync } from 'node:fs';
import { mkTmp } from ${JSON.stringify(resolve(REPO_ROOT, 'tests/helpers/tmp.mjs'))};
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkTmp(join(tmpdir(), 'uk-gitenv-repo-'));
git(dir, 'init', '-q', '-b', 'main');
writeFileSync(join(dir, 'a'), 'a');
git(dir, 'add', '-A');
git(dir, 'commit', '-q', '-m', 'x');
`;

function commitUnder(env) {
  const h = hostile();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', COMMIT], {
    encoding: 'utf8',
    env: { ...process.env, ...env(h) },
  });
  const ran = existsSync(h.marker);
  rmSync(h.d, { recursive: true, force: true });
  return { r, ran };
}

test('control: the hostile configuration does break a plain git commit', () => {
  // Without the helper's isolation the global hook runs and signing fails.
  const h = hostile();
  const dir = mkTmp(join(tmpdir(), 'uk-gitenv-ctl-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: h.gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const run = (...a) => spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...a], { cwd: dir, env, encoding: 'utf8' });
  run('init', '-q');
  writeFileSync(join(dir, 'a'), 'a');
  run('add', '-A');
  const r = run('commit', '-q', '-m', 'x');
  assert.notEqual(r.status, 0);
  rmSync(h.d, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('importing the kernel helper isolates git from a global hook and signing', () => {
  const { r, ran } = commitUnder((h) => ({ GIT_CONFIG_GLOBAL: h.gitconfig, GIT_CONFIG_NOSYSTEM: '0' }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ran, false, 'the global hook ran');
});

test('every test file that runs git imports the isolation (single-file runs)', () => {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'fixtures') walk(p); } else if (e.name.endsWith('.mjs')) files.push(p); } };
  walk(resolve(REPO_ROOT, 'tests'));
  const bad = files.filter((f) => {
    if (f.endsWith('tests/helpers/git-env.mjs') || f.endsWith('tests/helpers/kernel.mjs') || f.endsWith('tests/unit/helpers/git-env.test.mjs')) return false;
    const s = readFileSync(f, 'utf8');
    return /'git'|"git"|git -C|git init/.test(s) && !/helpers\/(kernel|git-env)\.mjs/.test(s);
  }).map((f) => f.slice(REPO_ROOT.length + 1));
  assert.deepEqual(bad, [], 'import tests/helpers/git-env.mjs');
});
