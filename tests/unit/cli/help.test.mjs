import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COMMANDS } from '../../../runtime/cli/main.mjs';

const BIN = new URL('../../../bin/unknot', import.meta.url).pathname;

function testHelp(cmd, subcommands = []) {
  const variants = subcommands.length ? subcommands.map((s) => [cmd, ...s]) : [[cmd]];
  for (const args of variants) {
    const cmdStr = args.join(' ');
    test(`--help on unknot ${cmdStr}`, () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'unknot-help-'));
      const unknotHome = mkdtempSync(join(tmpdir(), 'unknot-home-'));
      try {
        const result = spawnSync(process.execPath, [BIN, ...args, '--help'], {
          cwd: tmpDir,
          env: { ...process.env, UNKNOT_HOME: unknotHome },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, `exit code should be 0, got ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.ok(result.stdout, `stdout should not be empty for ${cmdStr}`);
        assert.match(result.stdout, /unknot|usage|Usage/, `stdout should contain "unknot" or "usage" for ${cmdStr}: ${result.stdout}`);
        assert.ok(!existsSync(join(tmpDir, '.unknot')), `should not create .unknot directory for ${cmdStr}`);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        rmSync(unknotHome, { recursive: true, force: true });
      }
    });
    test(`-h on unknot ${cmdStr}`, () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'unknot-help-'));
      const unknotHome = mkdtempSync(join(tmpdir(), 'unknot-home-'));
      try {
        const result = spawnSync(process.execPath, [BIN, ...args, '-h'], {
          cwd: tmpDir,
          env: { ...process.env, UNKNOT_HOME: unknotHome },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, `exit code should be 0, got ${result.status}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.ok(result.stdout, `stdout should not be empty for ${cmdStr}`);
        assert.match(result.stdout, /unknot|usage|Usage/, `stdout should contain "unknot" or "usage" for ${cmdStr}: ${result.stdout}`);
        assert.ok(!existsSync(join(tmpDir, '.unknot')), `should not create .unknot directory for ${cmdStr}`);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        rmSync(unknotHome, { recursive: true, force: true });
      }
    });
  }
}

// Test top-level commands
for (const cmd of Object.keys(COMMANDS)) {
  testHelp(cmd);
}

// Test subcommands
testHelp('graph', [
  ['stats'],
  ['nodes'],
  ['node', 'id'],
  ['edges'],
  ['cycles'],
  ['hubs'],
  ['neighbourhood', 'id'],
]);

testHelp('decompose', [
  ['list'],
  ['show', 'DEC-id'],
  ['prune'],
]);

testHelp('policy', [
  ['denials'],
  ['effective'],
  ['verify', 'dir'],
]);

testHelp('search', [
  ['text'],
]);

testHelp('cli', [
  ['status'],
  ['install'],
  ['uninstall'],
]);

testHelp('pattern', [
  ['list'],
  ['show', 'id'],
]);

testHelp('audit', [
  ['verify'],
  ['export'],
]);

testHelp('backup', [
  ['create', 'file'],
  ['verify', 'file'],
  ['restore', 'file'],
]);

testHelp('learn', [
  ['report'],
  ['propose'],
]);

testHelp('lane', [
  ['approve', 'CMP-id'],
  ['status', 'CMP-id'],
  ['review', 'CMP-id'],
  ['revoke', 'LN-id'],
]);

testHelp('run', [
  ['start', 'command'],
  ['end'],
  ['show'],
]);

testHelp('keys', [
  ['generate', 'name'],
]);

testHelp('apply', [
  ['slice-id', 'start'],
]);

testHelp('config', [
  ['show'],
  ['diff'],
  ['accept'],
]);

testHelp('slice', [
  ['id'],
]);

test('--help or -h after -- belongs to the command being run, not to Unknot', () => {
  const r = spawnSync(process.execPath, [BIN, 'exec', '--', 'grep', '-h', 'x'], { encoding: 'utf8', cwd: mkdtempSync(join(tmpdir(), 'uk-help-')), env: { ...process.env, UNKNOT_HOME: mkdtempSync(join(tmpdir(), 'uk-help-home-')) } });
  assert.doesNotMatch(r.stdout, /^usage: unknot exec/m);
});
