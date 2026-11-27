// Write modes fail closed without an OS sandbox (#148). Each test tries to reach a brokered
// command in a write mode with the sandbox missing, broken, or spoofed through the environment
// or the configuration, and checks that nothing ran.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, test } from 'node:test';
import * as K from '../helpers/kernel.mjs';
import { hide, restore } from '../helpers/no-sandbox.mjs';
import { mkTmp } from '../helpers/tmp.mjs';

after(() => K.cleanup());

const { brokerExec } = K.broker;
const { sandboxRequired, sandboxInstallHint, wrap } = K.sandbox;
const bin = new URL('../../bin/unknot', import.meta.url).pathname;
const helper = new URL('../helpers/no-sandbox.mjs', import.meta.url).pathname;
const code = (c) => (e) => e?.code === c;
const WRITE_MODES = ['assist', 'governed', 'campaign'];

async function withoutSandbox(fn) {
  hide();
  try {
    assert.equal(K.sandbox.detectSandbox(), 'none');
    return await fn();
  } finally {
    restore();
  }
}

// A command that leaves a mark if it runs at all.
function marking(p) {
  const mark = join(mkTmp(join(tmpdir(), 'uk-mark-')), 'ran');
  return { mark, argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(mark)}, 'x')`], cwd: p.dir, origin: 'configured' };
}

const execEvents = (p) => p.ctx.store.all("SELECT * FROM events WHERE type = 'exec.started'").length;

describe('the requirement', () => {
  test('defaults to required in every write mode, and not in observe or plan', () => {
    for (const mode of WRITE_MODES) assert.equal(sandboxRequired(K.cfg({ mode })), true, mode);
    for (const mode of ['observe', 'plan']) assert.equal(sandboxRequired(K.cfg({ mode })), false, mode);
    assert.equal(K.DEFAULT_CONFIG.security.require_os_sandbox, null);
  });

  test('an unknown mode or a missing config counts as a write mode', () => {
    assert.equal(sandboxRequired(undefined), true);
    assert.equal(sandboxRequired({}), true);
    assert.equal(sandboxRequired(K.cfg({ mode: 'yolo' })), true);
    assert.equal(sandboxRequired(K.cfg({ mode: '__proto__' })), true);
  });

  test('only a literal false opts out; values that look false do not', () => {
    assert.equal(sandboxRequired(K.cfg({ mode: 'assist', security: { require_os_sandbox: false } })), false);
    for (const v of ['false', 0, '', 'no', 'off', [], {}]) {
      assert.equal(sandboxRequired(K.cfg({ mode: 'assist', security: { require_os_sandbox: v } })), true, JSON.stringify(v));
    }
    assert.equal(sandboxRequired(K.cfg({ mode: 'plan', security: { require_os_sandbox: true } })), true);
  });

  test('the refusal names the platform\'s sandbox and how to get it', () => {
    assert.match(sandboxInstallHint('darwin'), /sandbox-exec/);
    assert.match(sandboxInstallHint('linux'), /bubblewrap/);
    assert.match(sandboxInstallHint('linux'), /apt install bubblewrap/);
    assert.match(sandboxInstallHint('linux'), /user namespaces/);
    assert.match(sandboxInstallHint('freebsd'), /no supported OS sandbox on freebsd/);
  });
});

describe('scenario 1: a write mode with no sandbox runs nothing', () => {
  const p = K.makeProject();

  for (const mode of WRITE_MODES) {
    test(`${mode}: a repository command is refused with UK_SANDBOX_REQUIRED and leaves no trace`, () => withoutSandbox(async () => {
      const before = execEvents(p);
      const req = marking(p);
      await assert.rejects(brokerExec(p.ctx, { ...req, config: K.cfg({ mode }) }), (e) => {
        assert.equal(e.code, 'UK_SANDBOX_REQUIRED');
        assert.match(e.message, /no supported OS sandbox on freebsd/);
        assert.match(e.message, /require_os_sandbox: false/);
        assert.equal(e.details.mode, mode);
        return true;
      });
      assert.equal(existsSync(req.mark), false, 'the command did not run');
      assert.equal(execEvents(p), before, 'no exec.started event');
    }));
  }

  test('internal tools are refused too, and so is a call with no config at all', () => withoutSandbox(async () => {
    await assert.rejects(brokerExec(p.ctx, { argv: ['git', 'status'], cwd: p.dir, origin: 'internal', config: K.cfg({ mode: 'assist' }) }), code('UK_SANDBOX_REQUIRED'));
    const req = marking(p);
    await assert.rejects(brokerExec(p.ctx, req), code('UK_SANDBOX_REQUIRED'));
    assert.equal(existsSync(req.mark), false);
  }));

  test('the CLI exits 3 with the code and the hint', () => {
    const q = K.makeProject({ config: `version: 1\nmode: assist\ncommands:\n  test_unit: [${JSON.stringify(process.execPath)}, -e, "require('fs').writeFileSync('ran', 'x')"]\n` });
    const r = spawnSync(process.execPath, ['--import', helper, bin, 'exec', 'test_unit', '--cwd', q.dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: q.home, UNKNOT_TEST_HIDE_SANDBOX: '1' } });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /UK_SANDBOX_REQUIRED/);
    assert.equal(existsSync(join(q.dir, 'ran')), false);
  });
});

describe('spoofing the sandbox does not get a command run', () => {
  const p = K.makeProject();

  test('environment variables that look like a sandbox, and fake sandbox binaries on PATH', () => withoutSandbox(async () => {
    const fakes = mkTmp(join(tmpdir(), 'uk-fake-sandbox-'));
    for (const name of ['sandbox-exec', 'bwrap']) {
      writeFileSync(join(fakes, name), '#!/bin/sh\nwhile [ "$1" != "--" ] && [ $# -gt 0 ]; do shift; done; shift; exec "$@"\n');
      chmodSync(join(fakes, name), 0o755);
    }
    const saved = { ...process.env };
    Object.assign(process.env, { PATH: `${fakes}${delimiter}${process.env.PATH}`, UNKNOT_SANDBOXED: '1', SANDBOX: '1', container: 'docker' });
    try {
      const req = marking(p);
      await assert.rejects(brokerExec(p.ctx, { ...req, config: K.cfg({ mode: 'assist' }) }), code('UK_SANDBOX_REQUIRED'));
      assert.equal(existsSync(req.mark), false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    // Where bubblewrap is the sandbox, the wrapper runs it from a fixed location, never from PATH.
    process.env.PATH = `${fakes}${delimiter}${process.env.PATH}`;
    try {
      const w = wrap(['true'], { kind: 'linux-bwrap' });
      assert.ok(['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].includes(w.file), w.file);
    } finally {
      process.env.PATH = saved.PATH;
    }
  }));

  test('an unaccepted edit cannot opt out', () => withoutSandbox(async () => {
    const q = K.makeProject({ config: 'version: 1\nmode: assist\n' });
    writeFileSync(q.ctx.paths.config, 'version: 1\nmode: assist\nsecurity:\n  require_os_sandbox: false\n');
    const loaded = K.configMod.loadConfig(q.ctx);
    assert.equal(loaded.acceptance, 'changed');
    assert.equal(loaded.config.mode, 'assist');
    assert.notEqual(loaded.config.security.require_os_sandbox, false);
    const req = marking(q);
    await assert.rejects(brokerExec(q.ctx, { ...req, cwd: q.dir, config: loaded.config }), code('UK_SANDBOX_REQUIRED'));
    assert.equal(existsSync(req.mark), false);
  }));

  test('a config nobody accepted cannot reach a write mode, so its opt-out only ever applies in plan', () => {
    const q = K.makeProject();
    writeFileSync(q.ctx.paths.config, 'version: 1\nmode: campaign\nsecurity:\n  require_os_sandbox: false\n');
    const loaded = K.configMod.loadConfig(q.ctx);
    assert.equal(loaded.acceptance, 'unaccepted');
    assert.equal(loaded.config.mode, 'plan');
  });

  test('organization policy forbids the opt-out', () => withoutSandbox(async () => {
    const repo = K.cfg({ mode: 'assist', security: { require_os_sandbox: false } });
    const { config } = K.merge.applyOrgPolicy(repo, { security: { require_os_sandbox: true } });
    assert.equal(config.security.require_os_sandbox, true);
    const req = marking(p);
    await assert.rejects(brokerExec(p.ctx, { ...req, config }), code('UK_SANDBOX_REQUIRED'));
    assert.equal(existsSync(req.mark), false);
    // An organization cannot loosen it either: its false is ignored.
    const loose = K.merge.applyOrgPolicy(K.cfg({ mode: 'assist' }), { security: { require_os_sandbox: false } }).config;
    assert.equal(sandboxRequired(loose), true);
  }));

  test('the config schema refuses a value that is not a boolean', () => {
    const v = (x) => K.configMod.recordAcceptedConfig(K.makeProject().ctx, `version: 1\nsecurity:\n  require_os_sandbox: ${x}\n`, 'human:test');
    assert.throws(() => v('"false"'), code('UK_CONFIG_INVALID'));
    assert.throws(() => v('0'), code('UK_CONFIG_INVALID'));
    v('false');
    v('null');
  });
});

describe('scenarios 2, 3 and 5: what runs without a sandbox, and what it sees', () => {
  const p = K.makeProject();
  const probe = [process.execPath, '-e', 'const fs=require("fs");console.log(JSON.stringify({home:process.env.HOME,files:fs.readdirSync(process.env.HOME),keys:Object.keys(process.env)}))'];
  const secrets = { GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'x', AWS_ACCESS_KEY_ID: 'x', NPM_TOKEN: 'x', DATABASE_URL: 'postgres://x', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', SSH_AUTH_SOCK: '/tmp/agent' };

  async function seen(config) {
    const saved = { ...process.env };
    Object.assign(process.env, secrets);
    try {
      const r = await brokerExec(p.ctx, { argv: probe, cwd: p.dir, origin: 'configured', config });
      return { record: r.record, env: JSON.parse(r.stdout.toString()) };
    } finally {
      for (const k of Object.keys(secrets)) if (!(k in saved)) delete process.env[k];
    }
  }

  for (const mode of ['observe', 'plan']) {
    test(`${mode}: commands run as before, recorded as sandbox none, with a private HOME`, () => withoutSandbox(async () => {
      const { record, env } = await seen(K.cfg({ mode }));
      assert.equal(record.verdict, 'pass');
      assert.equal(record.sandbox, 'none');
      assert.notEqual(env.home, homedir());
      assert.deepEqual(env.files, []);
    }));
  }

  test('an explicit opt-out runs unsandboxed in a write mode, says so in evidence, and hides HOME and credentials', () => withoutSandbox(async () => {
    const before = p.ctx.store.all("SELECT * FROM events WHERE type = 'exec.finished'").length;
    const { record, env } = await seen(K.cfg({ mode: 'campaign', security: { require_os_sandbox: false } }));
    assert.equal(record.verdict, 'pass');
    assert.equal(record.sandbox, 'none (explicitly allowed)');
    const log = readFileSync(join(p.ctx.paths.runs, 'adhoc', 'command-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).sandbox, 'none (explicitly allowed)');
    assert.equal(p.ctx.store.all("SELECT * FROM events WHERE type = 'exec.finished'").length, before + 1);
    assert.notEqual(env.home, homedir());
    assert.deepEqual(env.files, [], 'HOME is empty');
    for (const k of Object.keys(secrets)) assert.ok(!env.keys.includes(k), `${k} reached the command`);
    assert.equal(existsSync(env.home), false, 'the private HOME is removed afterwards');
  }));

  test('with a sandbox, HOME stays the real one (the sandbox hides the credential paths)', { skip: K.sandbox.detectSandbox() === 'none' }, async () => {
    const r = await brokerExec(p.ctx, { argv: [process.execPath, '-e', 'console.log(process.env.HOME)'], cwd: p.dir, origin: 'configured', config: K.cfg({ mode: 'assist' }) });
    assert.equal(r.stdout.toString().trim(), homedir());
    assert.notEqual(r.record.sandbox, 'none');
  });
});

describe('scenario 4: doctor', () => {
  const doctor = (q, env = {}, wrapArgv = []) => {
    const argv = [...wrapArgv, process.execPath, '--import', helper, bin, 'doctor', '--json', '--cwd', q.dir];
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: q.home, ...env } });
    return { status: r.status, checks: JSON.parse(r.stdout).checks, stderr: r.stderr };
  };
  const named = (checks) => checks.find((c) => c.name === 'os sandbox required');

  test('fails in a write mode without a sandbox, naming the fix', () => {
    const q = K.makeProject({ config: 'version: 1\nmode: assist\n' });
    const d = doctor(q, { UNKNOT_TEST_HIDE_SANDBOX: '1' });
    assert.notEqual(d.status, 0);
    assert.equal(named(d.checks)?.level, 'fail');
    assert.match(named(d.checks).detail, /require_os_sandbox: false/);
  });

  test('only warns in plan mode, and says nothing more with a sandbox', () => {
    const q = K.makeProject({ config: 'version: 1\nmode: plan\n' });
    const d = doctor(q, { UNKNOT_TEST_HIDE_SANDBOX: '1' });
    assert.equal(named(d.checks), undefined);
    assert.equal(d.checks.find((c) => c.name === 'os sandbox').level, 'warn');
  });

  test('macOS: a sandbox-exec that exists but cannot run counts as none', { skip: K.sandbox.detectSandbox() !== 'macos-sandbox-exec' }, () => {
    const q = K.makeProject({ config: 'version: 1\nmode: governed\n' });
    const d = doctor(q, {}, ['/usr/bin/sandbox-exec', '-p', '(version 1) (allow default) (deny process-exec (literal "/usr/bin/sandbox-exec"))']);
    assert.notEqual(d.status, 0, d.stderr);
    assert.equal(named(d.checks)?.level, 'fail');
    assert.match(named(d.checks).detail, /sandbox-exec/);
  });
});
