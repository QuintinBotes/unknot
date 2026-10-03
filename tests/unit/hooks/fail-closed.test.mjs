// End-to-end tests of the real hook process (bin/unknot-hook): the hook must always exit 0,
// answer deny for mutations when it cannot judge policy, and stay silent when it allows.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';

after(() => K.cleanup());

const BIN = join(K.REPO_ROOT, 'bin', 'unknot-hook');

function hook(p, eventName, event, { input, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, eventName], {
    cwd: p.dir,
    input: input ?? JSON.stringify({ cwd: p.dir, hook_event_name: eventName, ...event }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: K.REPO_ROOT, UNKNOT_HOME: p.home, ...env },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `hook must exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim();
  return { out, json: out ? JSON.parse(out) : null, stderr: r.stderr };
}
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? null;

function project(config = 'version: 1\nmode: plan\n') {
  const p = K.makeProject({ files: { '.env': 'TOKEN=abc\n' }, config });
  K.runs.startRun(p.ctx, { command: 'diagnose', actor: 'human:test', config: K.cfg(), configDigest: 'sha256:c', supersede: true });
  return p;
}
const corrupt = (p) => {
  K.store.closeAllStores();
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${p.ctx.paths.db}${suffix}`, { force: true });
  writeFileSync(p.ctx.paths.db, 'this is definitely not a sqlite database'.repeat(50));
};

describe('hook process: normal operation', () => {
  test('allowed calls produce no output; denied calls produce a deny decision', () => {
    const p = project();
    assert.equal(hook(p, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(p.dir, 'src/a.js') } }).out, '');
    const bad = hook(p, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(p.dir, 'src/a.js') } });
    assert.equal(decision(bad), 'deny');
    assert.equal(bad.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(bad.json.hookSpecificOutput.permissionDecisionReason, /Unknot/);
    assert.equal(decision(hook(p, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(p.dir, '.env') } })), 'deny');
  });

  test('writes to .unknot/config.yaml are denied end to end, even with no run', () => {
    const p = K.makeProject({ config: 'version: 1\nmode: plan\n' });
    const r = hook(p, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(p.dir, '.unknot/config.yaml'), content: 'mode: campaign' } });
    assert.equal(decision(r), 'deny');
  });

  test('uninitialised projects are never touched', () => {
    const bare = mkdtempSync(join(tmpdir(), 'uk-bare-'));
    K.git(bare, 'init', '-q');
    const r = hook({ dir: bare, home: process.env.UNKNOT_HOME }, 'PreToolUse', { cwd: bare, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    assert.equal(r.out, '');
    assert.equal(existsSync(join(bare, '.unknot')), false);
    rmSync(bare, { recursive: true, force: true });
  });

  test('UserPromptSubmit through the real process starts a run', () => {
    const p = K.makeProject({ config: 'version: 1\nmode: plan\n' });
    const r = hook(p, 'UserPromptSubmit', { prompt: '/unknot:diagnose' });
    assert.match(r.json.hookSpecificOutput.additionalContext, /started for \/unknot:diagnose/);
    K.store.closeAllStores();
    const reopened = K.context.openProject(p.dir);
    assert.equal(K.runs.activeRun(reopened.store).command, 'diagnose');
  });

  test('unknown event names and empty or garbage stdin never crash the hook', () => {
    const p = project();
    assert.equal(hook(p, 'NoSuchEvent', {}).out, '');
    assert.equal(hook(p, 'SessionStart', {}, { input: '' }).json?.hookSpecificOutput?.hookEventName ?? 'SessionStart', 'SessionStart');
    const garbage = hook(p, 'PreToolUse', {}, { input: '{ not json' });
    assert.equal(decision(garbage), 'deny', 'an event we cannot parse has no known tool and is denied during a run');
    const arr = hook(p, 'PreToolUse', {}, { input: '[1,2,3]' });
    assert.equal(decision(arr), 'deny');
  });
});

describe('hook process: fail-closed when state cannot be read', () => {
  test('corrupt database: mutating tools are denied, with a pointer to the error log', () => {
    const p = project();
    corrupt(p);
    for (const [tool_name, tool_input] of [
      ['Bash', { command: 'ls' }],
      ['Bash', { command: 'rm -rf /' }],
      ['Write', { file_path: join(p.dir, 'src/a.js'), content: 'x' }],
      ['Edit', { file_path: join(p.dir, 'src/a.js') }],
      ['MultiEdit', { file_path: join(p.dir, 'src/a.js') }],
      ['NotebookEdit', { notebook_path: join(p.dir, 'n.ipynb') }],
      ['WebFetch', { url: 'https://example.com' }],
      ['WebSearch', { query: 'q' }],
      ['Task', { subagent_type: 'general-purpose' }],
      ['Agent', {}],
      ['mcp__github__create_issue', {}],
    ]) {
      const r = hook(p, 'PreToolUse', { tool_name, tool_input });
      assert.equal(decision(r), 'deny', tool_name);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /could not evaluate policy/);
      assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /unknot doctor/);
    }
    assert.ok(existsSync(join(p.dir, '.unknot/state/hook-errors.log')));
    assert.match(readFileSync(join(p.dir, '.unknot/state/hook-errors.log'), 'utf8'), /PreToolUse/);
  });

  test('corrupt database: read-only tools produce no output (reads stay possible)', () => {
    const p = project();
    corrupt(p);
    for (const [tool_name, tool_input] of [['Read', { file_path: join(p.dir, 'src/a.js') }], ['Grep', { path: p.dir }], ['Glob', {}], ['TodoWrite', {}]]) {
      assert.equal(hook(p, 'PreToolUse', { tool_name, tool_input }).out, '', tool_name);
    }
  });

  test('corrupt database: PermissionRequest never invents an allow', () => {
    const p = project();
    corrupt(p);
    const r = hook(p, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.notEqual(r.json?.hookSpecificOutput?.decision?.behavior, 'allow');
  });

  test('corrupt database: other events exit 0 silently', () => {
    const p = project();
    corrupt(p);
    for (const [name, ev] of [['PostToolUse', { tool_name: 'Read', tool_response: 'x' }], ['SubagentStart', { agent_id: 'a', agent_type: 'unknot:refactorer' }], ['Stop', {}], ['SessionStart', {}], ['UserPromptSubmit', { prompt: '/unknot:diagnose' }]]) {
      assert.equal(hook(p, name, ev).out, '', name);
    }
  });

  test('unparseable config.yaml during a run: mutations denied', () => {
    const p = project();
    writeFileSync(join(p.ctx.paths.base, 'config.yaml'), 'version: 1\nmode: [oops\n');
    assert.equal(decision(hook(p, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })), 'deny');
    assert.equal(hook(p, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(p.dir, 'src/a.js') } }).out, '');
  });

  test('config with an unknown mode during a run: mutations denied', () => {
    const p = project();
    writeFileSync(join(p.ctx.paths.base, 'config.yaml'), 'version: 1\nmode: ludicrous\n');
    assert.equal(decision(hook(p, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(p.dir, 'src/a.js') } })), 'deny');
  });

  test('a tampered signed organisation policy in UNKNOT_HOME fails closed for mutations', () => {
    const p = project();
    const home = p.home;
    writeFileSync(join(home, 'org-policy.yaml'), 'max_mode: observe\n');
    writeFileSync(join(home, 'org-policy.yaml.sig'), 'AAAA');
    try {
      mkdirSync(join(home, 'trusted-keys'), { recursive: true });
      writeFileSync(join(home, 'trusted-keys', 'k.pem'), K.keys.generateApproverKey(`kt-org-${process.pid}`, 'passphrase-xyz'));
      assert.equal(decision(hook(p, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })), 'deny');
    } finally {
      rmSync(join(home, 'org-policy.yaml'), { force: true });
      rmSync(join(home, 'org-policy.yaml.sig'), { force: true });
      rmSync(join(home, 'trusted-keys'), { recursive: true, force: true });
    }
  });

  test('a secret read is still denied when the ledger cannot be written',
    { todo: 'BUG: handlers.mjs onPreToolUse awaits recordDecision() (ledger append) before returning a deny; if the append throws (locked/full DB) main.mjs falls through to respond(null) for non-MUTATING tools, so Read of .env is allowed' },
    () => {
      const p = project();
      // Simulate a full disk / locked database: the decision log cannot be written.
      p.ctx.store.db.exec("CREATE TRIGGER no_write BEFORE INSERT ON policy_results BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
      K.store.closeAllStores();
      const r = hook(p, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(p.dir, '.env') } });
      assert.equal(decision(r), 'deny');
    });
});
