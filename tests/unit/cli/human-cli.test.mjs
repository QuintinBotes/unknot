import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliPath, humanCommand, requireHumanTTY } from '../../../runtime/cli/util.mjs';
import { run as runCli, shimSource, SHIM_MARK } from '../../../runtime/cli/commands/cli.mjs';

const BIN = cliPath();
const tmp = () => mkdtempSync(join(tmpdir(), 'uk-cli-'));

function withEnv(env, tty, fn) {
  const saved = { env: { ...process.env }, in: process.stdin.isTTY, out: process.stdout.isTTY };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete process.env[k];
  Object.assign(process.env, env);
  process.stdin.isTTY = tty;
  process.stdout.isTTY = tty;
  const restore = () => {
    process.env = saved.env;
    process.stdin.isTTY = saved.in;
    process.stdout.isTTY = saved.out;
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (!result?.then) restore();
  return result?.then ? result.finally(restore) : result;
}

const denial = (what, args) => {
  try {
    requireHumanTTY(what, { args });
  } catch (err) {
    return err;
  }
  return null;
};

test('requireHumanTTY: no terminal says so and points at a separate window; same policy id', () => {
  const err = withEnv({}, false, () => denial('approving a slice', ['approve', 'UK-1']));
  assert.equal(err.code, 'UK_POLICY_DENIED');
  assert.equal(err.details.policy, 'approval.human_only');
  assert.match(err.message, /no interactive terminal detected/);
  assert.match(err.message, /unknot approve UK-1/);
  assert.match(err.message, /separate terminal window/);
  assert.match(err.message, /`!` prefix is not interactive/);
  assert.doesNotMatch(err.message, /agent session/);
  assert.match(err.message, /cli install/);
});

test('requireHumanTTY: a terminal with agent markers is called an agent session; a plain terminal passes', () => {
  const err = withEnv({ CLAUDECODE: '1' }, true, () => denial('approving a slice', ['approve', 'UK-1']));
  assert.equal(err.details.policy, 'approval.human_only');
  assert.match(err.message, /looks like an agent session/);
  assert.doesNotMatch(err.message, /no interactive terminal/);
  assert.equal(withEnv({}, true, () => denial('approving a slice', ['approve'])), null);
});

test('humanCommand: the full path first until the stable command is installed; install is offered once, never for itself', () => {
  const dir = tmp();
  const home = tmp();
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  try {
    process.env.PATH = dir;
    process.env.HOME = home;
    const text = humanCommand('config diff');
    assert.equal(text.split('\n')[0], `node ${BIN} config diff`, 'a bare unknot would fail in a new terminal');
    assert.equal(text.split(`node ${BIN} cli install`).length, 2, 'the install command appears once');
    assert.equal(humanCommand('cli install'), `node ${BIN} cli install`);
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(join(home, '.local/bin/unknot'), '#!/usr/bin/env node\n// unknot-cli-shim: test\n');
    assert.equal(humanCommand('config diff'), 'unknot config diff', 'once the shim is installed the short form works');
    rmSync(join(home, '.local/bin/unknot'));
    writeFileSync(join(dir, 'unknot'), '#!/bin/sh\n');
    assert.equal(humanCommand(['config', 'diff']), 'unknot config diff', 'a stable unknot on PATH');
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeVersions(root, versions) {
  for (const v of versions) {
    const bin = join(root, v, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'unknot'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(v)} + ' ' + process.argv.slice(2).join(' '));\nprocess.exitCode = 7;\n`);
    chmodSync(join(bin, 'unknot'), 0o755);
  }
}

test('the shim runs the newest installed version with the same arguments and exit code', () => {
  const dir = tmp();
  try {
    fakeVersions(join(dir, 'cache'), ['0.1.9', '0.1.10', '0.0.99']);
    const shim = join(dir, 'unknot');
    writeFileSync(shim, shimSource(join(dir, 'cache', '0.1.9', 'bin', 'unknot')));
    chmodSync(shim, 0o755);
    const r = spawnSync(process.execPath, [shim, 'status', '--json'], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '0.1.10 status --json');
    assert.equal(r.status, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inside a session the shim runs the version the session loaded (its bin on PATH), not the newest', () => {
  const dir = tmp();
  try {
    fakeVersions(join(dir, 'cache'), ['0.1.9', '0.1.10']);
    const shim = join(dir, 'unknot');
    writeFileSync(shim, shimSource(join(dir, 'cache', '0.1.10', 'bin', 'unknot')));
    chmodSync(shim, 0o755);
    const run = (path) => spawnSync(process.execPath, [shim, 'status'], { encoding: 'utf8', env: { ...process.env, PATH: path } }).stdout.trim();
    assert.equal(run(`/usr/bin:${join(dir, 'cache', '0.1.9', 'bin')}/`), '0.1.9 status');
    assert.equal(run('/usr/bin'), '0.1.10 status');
    // A bin directory outside the plugin's versions directory is not the session's plugin.
    fakeVersions(join(dir, 'elsewhere'), ['0.0.1']);
    assert.equal(run(`${join(dir, 'elsewhere', '0.0.1', 'bin')}:/usr/bin`), '0.1.10 status');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli install and uninstall are denied without a terminal; status reports ownership', () => {
  const dir = tmp();
  const cli = (...args) => spawnSync(process.execPath, [BIN, 'cli', ...args, '--dir', dir], { encoding: 'utf8' });
  try {
    const denied = cli('install');
    assert.equal(denied.status, 3);
    assert.match(denied.stderr, /no interactive terminal detected/);
    const status = JSON.parse(cli('status', '--json').stdout);
    assert.equal(status.shim.installed, false);
    assert.equal(status.cli_path, BIN);
    writeFileSync(join(dir, 'unknot'), '#!/bin/sh\necho mine\n');
    assert.equal(JSON.parse(cli('status', '--json').stdout).shim.foreign, true);
    writeFileSync(join(dir, 'unknot'), shimSource());
    assert.equal(JSON.parse(cli('status', '--json').stdout).shim.installed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli install refuses a foreign file, replaces its own shim; uninstall removes only ours', async () => {
  const dir = tmp();
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await withEnv({}, true, async () => {
      writeFileSync(join(dir, 'unknot'), 'foreign');
      await assert.rejects(() => runCli({ positional: ['install'], flags: { dir } }), /was not written by unknot/);
      await assert.rejects(() => runCli({ positional: ['uninstall'], flags: { dir } }), /not written by unknot/);
      assert.equal(readFileSync(join(dir, 'unknot'), 'utf8'), 'foreign');
      rmSync(join(dir, 'unknot'));
      await runCli({ positional: ['install'], flags: { dir } });
      assert.ok(readFileSync(join(dir, 'unknot'), 'utf8').includes(SHIM_MARK));
      await runCli({ positional: ['install'], flags: { dir } });
      await runCli({ positional: ['uninstall'], flags: { dir } });
      assert.throws(() => readFileSync(join(dir, 'unknot')));
    });
  } finally {
    process.stdout.write = write;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init reports state_dir (ignored or not) and doctor reports the CLI check', () => {
  const dir = tmp();
  const env = { ...process.env, UNKNOT_HOME: join(dir, '.home') };
  const unknot = (...args) => spawnSync(process.execPath, [BIN, ...args, '--cwd', dir], { encoding: 'utf8', env }).stdout;
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    assert.deepEqual(JSON.parse(unknot('init', '--json')).state_dir, { path: '.unknot', ignored: false, exclude_line: '.unknot/' });
    const text = unknot('init');
    assert.match(text, /already ignored by \.unknot\/\.gitignore/);
    assert.match(text, /\.git\/info\/exclude/);
    assert.match(text, /read-only assessment/);
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.unknot/\n');
    assert.equal(JSON.parse(unknot('init', '--json')).state_dir.ignored, true);
    assert.match(unknot('init'), /ignored by git here/);
    const check = JSON.parse(unknot('doctor', '--json')).checks.find((c) => c.name === 'unknot cli');
    assert.ok(check.detail.includes(BIN));
    assert.match(check.detail, /shim/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
