import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliPath } from '../../../runtime/cli/util.mjs';

const home = mkdtempSync(join(tmpdir(), 'uk-home-'));
const env = { ...process.env, UNKNOT_HOME: home };
delete env.CLAUDECODE;
const vcs = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
const cli = (cwd, ...args) => spawnSync(process.execPath, [cliPath(), ...args], { cwd, env, encoding: 'utf8' });

function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'uk-ws-'));
  const root = join(parent, 'root');
  const a = join(parent, 'a');
  for (const d of [root, a]) {
    mkdirSync(d);
    writeFileSync(join(d, 'x.txt'), 'x');
    vcs(d, 'init', '-q');
    vcs(d, 'add', '-A');
    vcs(d, 'commit', '-qm', 'init');
  }
  mkdirSync(join(parent, 'plain'));
  return { parent, root, a };
}

const errorOf = (r) => JSON.parse(r.stdout).error;

test('workspace add writes the proposal, not the config, with a source and the human step', () => {
  const { root } = setup();
  const r = cli(root, 'workspace', 'add', 'alpha', '../a');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /config accept/);
  assert.ok(existsSync(join(root, '.unknot', 'config.proposed.yaml')));
  assert.ok(!existsSync(join(root, '.unknot', 'config.yaml')));
  assert.match(readFileSync(join(root, '.unknot', 'config.proposed.yaml'), 'utf8'), /alpha/);
  const sources = JSON.parse(readFileSync(join(root, '.unknot', 'state', 'config.proposed.sources.json'), 'utf8'));
  assert.deepEqual(sources.entries['workspace.repositories'], { source: 'workspace add' });
  const diff = cli(root, 'config', 'diff');
  assert.match(diff.stdout, /workspace\.repositories.*\[workspace add\]/);
});

test('workspace add rejects a non-git path, duplicates and a path inside .unknot', () => {
  const { root, a, parent } = setup();
  assert.equal(cli(root, 'workspace', 'add', 'alpha', '../a').status, 0);
  const bad = (args, re) => {
    const r = cli(root, 'workspace', 'add', ...args, '--json');
    assert.equal(r.status, 1, r.stdout);
    assert.match(errorOf(r).message, re);
  };
  bad(['p', '../plain'], /not the root of a git repository/);
  mkdirSync(join(parent, 'b'));
  vcs(join(parent, 'b'), 'init', '-q');
  bad(['alpha', '../b'], /named alpha is already listed/);
  bad(['other', a], /already listed as alpha/);
  mkdirSync(join(root, '.unknot', 'inner'), { recursive: true });
  vcs(join(root, '.unknot', 'inner'), 'init', '-q');
  bad(['inner', '.unknot/inner'], /inside this root's \.unknot/);
});

test('workspace remove deletes the entry', () => {
  const { root } = setup();
  cli(root, 'workspace', 'add', 'alpha', '../a');
  assert.equal(cli(root, 'workspace', 'remove', 'alpha').status, 0);
  assert.doesNotMatch(readFileSync(join(root, '.unknot', 'config.proposed.yaml'), 'utf8'), /alpha/);
  assert.equal(cli(root, 'workspace', 'remove', 'alpha').status, 1);
});

test('list and map with an unaccepted proposal fail with a distinct code; status shows the accept step', () => {
  const { root } = setup();
  cli(root, 'workspace', 'add', 'alpha', '../a');
  for (const sub of ['list', 'map']) {
    const r = cli(root, 'workspace', sub, '--json');
    assert.equal(r.status, 1);
    assert.equal(errorOf(r).code, 'UK_WORKSPACE_UNACCEPTED');
    assert.match(errorOf(r).message, /unaccepted proposal; a person reviews/);
  }
  const s = cli(root, 'status');
  assert.match(s.stdout, /For you, in your own terminal/);
  assert.match(s.stdout, /unknot config accept/);
  assert.match(s.stdout, /lists workspace repositories/);
});
