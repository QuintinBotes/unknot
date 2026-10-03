import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';

const { brokerExec, checkInternalArgv, minimalEnv, adapterExec } = K.broker;
const { casGet } = K.cas;
const { sha256 } = K.canonical;

after(() => K.cleanup());

const p = K.makeProject();
const config = K.cfg();
const code = (c) => (e) => e?.code === c;
const node = (script, extra = {}) => ({ argv: [process.execPath, '-e', script], cwd: p.dir, origin: 'configured', config, ...extra });
const exec = (req) => brokerExec(p.ctx, req);

describe('internal argv rules (checkInternalArgv)', () => {
  const denied = [
    ['git', 'push'], ['git', 'push', '--force', 'origin', 'main'], ['git', 'push', 'origin'], ['git', '-c', 'core.fsmonitor=x', 'status'], ['git', 'clone', 'x'], ['git', 'fetch'], ['git', 'pull'],
    ['git', 'remote', 'add', 'x', 'y'], ['git'], ['git', '--version'], ['git', '-C', '/tmp', 'status'],
    ['terraform', 'apply'], ['terraform', 'apply', '-auto-approve'], ['terraform', 'destroy'], ['terraform', 'state', 'rm', 'x'], ['terraform', 'import', 'a', 'b'], ['terraform', 'taint', 'x'], ['terraform', 'login'],
    ['terraform', 'force-unlock', 'id'], ['terraform', 'console'], ['terraform', 'refresh'], ['terraform', 'push'], ['terraform', 'plan'], ['terraform', 'workspace', 'delete', 'x'], ['terraform'],
    ['tofu', 'apply'], ['tofu', 'destroy'], ['tofu', 'state', 'push', 'f'],
    ['terraform', '-chdir=infra', 'apply'], ['terraform', '-chdir=infra', 'destroy'],
    ['kubectl', 'apply', '-f', 'x.yaml'], ['kubectl', 'create', '-f', 'x.yaml'], ['kubectl', 'apply', '-f', 'x', '--dry-run=none'], ['kubectl', 'apply', '--dry-run=true', '-f', 'x'], ['kubectl', 'apply', '--dry-run', '-f', 'x'],
    ['kubectl', 'delete', 'ns', 'x'], ['kubectl', 'exec', 'p', '--', 'sh'], ['kubectl', 'patch', 'x'], ['kubectl', 'replace', '-f', 'x'], ['kubectl', 'get', 'secrets'],
    ['helm', 'install', 'r', 'c'], ['helm', 'upgrade', 'r', 'c'], ['helm', 'uninstall', 'r'], ['helm', 'rollback', 'r'], ['helm', 'repo', 'add', 'a', 'b'], ['helm', 'dependency', 'update'], ['helm', 'dependency', 'build'], ['helm', 'dependency'],
    ['rm', '-rf', '/'], ['curl', 'http://x'], ['bash', '-c', 'x'], ['sh'], ['sudo', 'git', 'status'], ['docker', 'run', 'x'], ['npm', 'install'], ['make'],
  ];
  for (const argv of denied) {
    test(`denies ${argv.join(' ')}`, () => assert.equal(typeof checkInternalArgv(argv), 'string'));
  }

  const allowed = [
    ['git', 'status'], ['git', 'rev-parse', 'HEAD'], ['git', 'log', '--oneline'], ['git', 'diff', '--numstat'], ['git', 'worktree', 'list'],
    ['terraform', 'version'], ['terraform', 'validate'], ['terraform', 'show', '-json', 'plan.bin'], ['terraform', 'fmt', '-check'],
    ['kubectl', 'version'], ['kubectl', 'diff', '-f', 'x'], ['kubectl', 'apply', '-f', 'x', '--dry-run=client'], ['kubectl', 'create', '-f', 'x', '--dry-run=server'], ['kubectl', 'kustomize', 'dir'],
    ['helm', 'template', 'c'], ['helm', 'lint', 'c'], ['helm', 'dependency', 'list'], ['kustomize', 'build', 'dir'],
    ['gitleaks', 'detect'], ['trivy', 'config', '.'], ['/usr/bin/git', 'status'],
  ];
  for (const argv of allowed) {
    test(`allows ${argv.join(' ')}`, () => assert.equal(checkInternalArgv(argv), null));
  }

  test('executables must be bare names, not repository-controlled paths named like a tool',
    {},
    () => {
      for (const argv of [['./git', 'status'], ['bin/terraform', 'validate'], ['/tmp/evil/git', 'status'], ['../git', 'log']]) {
        assert.equal(typeof checkInternalArgv(argv), 'string', argv.join(' '));
      }
    });

  test('a later --dry-run flag cannot override an earlier dry-run=client',
    {},
    () => {
      assert.equal(typeof checkInternalArgv(['kubectl', 'apply', '-f', 'x', '--dry-run=client', '--dry-run=none']), 'string');
    });

  for (const argv of [['helm', 'template', 'c', '--post-renderer', './evil.sh'], ['kustomize', 'build', '--enable-exec', 'dir'], ['kustomize', 'build', '--enable-alpha-plugins', 'dir'], ['kubectl', 'kustomize', '--enable-exec', 'dir']]) {
    test(`plugin/exec flags are refused: ${argv.join(' ')}`,
      {},
      () => assert.equal(typeof checkInternalArgv(argv), 'string'));
  }
});

describe('brokerExec: pre-flight refusals (nothing is spawned)', () => {
  test('bad argv shapes', async () => {
    for (const argv of [[], 'ls', null, undefined, ['ls', 5], ['ls', null], ['a\0b'], ['ls', 'a\0'], [''].concat([undefined])]) {
      await assert.rejects(exec({ argv, cwd: p.dir, origin: 'configured' }), code('UK_POLICY_DENIED'), JSON.stringify(argv));
    }
  });

  test('internal denials surface as UK_POLICY_DENIED with the argv', async () => {
    for (const argv of [['git', 'push'], ['terraform', 'apply'], ['terraform', 'destroy'], ['terraform', 'state', 'list'], ['kubectl', 'apply', '-f', 'x'], ['helm', 'install', 'a', 'b'], ['rm', '-rf', 'x']]) {
      await assert.rejects(exec({ argv, cwd: p.dir, origin: 'internal' }), (e) => e.code === 'UK_POLICY_DENIED' && Array.isArray(e.details.argv), argv.join(' '));
    }
  });

  test('the default origin is internal', async () => {
    await assert.rejects(exec({ argv: ['rm', 'x'], cwd: p.dir }), code('UK_POLICY_DENIED'));
  });

  test('unknown origins are refused', async () => {
    for (const origin of ['user', 'model', '', 'INTERNAL', null]) {
      if (origin === null) continue;
      await assert.rejects(exec({ argv: ['true'], cwd: p.dir, origin }), code('UK_POLICY_DENIED'), String(origin));
    }
  });

  test('org forbid_executables blocks even configured commands', async () => {
    await assert.rejects(exec({ argv: ['/bin/echo', 'x'], cwd: p.dir, origin: 'configured', config: { ...config, forbid_executables: ['echo'] } }), code('UK_POLICY_DENIED'));
  });

  test('cwd outside the project is refused, including via symlink and ..', async () => {
    const outside = join(tmpdir(), 'uk-outside-link');
    rmSync(outside, { force: true });
    symlinkSync(tmpdir(), join(p.dir, 'escape'));
    for (const cwd of [tmpdir(), '/', join(p.dir, '..'), join(p.dir, 'escape'), join(p.dir, 'src', '..', '..')]) {
      await assert.rejects(exec({ argv: ['true'], cwd, origin: 'configured' }), code('UK_SCOPE_VIOLATION'), cwd);
    }
  });

  test('network requires limits.max_network_requests > 0', async () => {
    for (const cfg of [config, undefined, K.cfg({ limits: { max_network_requests: 0 } })]) {
      await assert.rejects(exec({ argv: ['true'], cwd: p.dir, origin: 'configured', network: true, config: cfg }), (e) => e.code === 'UK_POLICY_DENIED' && /network/.test(e.message));
    }
  });

  test('require_os_sandbox without a sandbox is refused by wrap()', () => {
    assert.throws(() => K.sandbox.wrap(['true'], { kind: 'none', requireSandbox: true }), code('UK_POLICY_DENIED'));
    assert.equal(K.sandbox.wrap(['true'], { kind: 'none' }).sandbox, 'none');
  });

  test('budget: exceeding max_commands refuses before spawning', async () => {
    const { run } = K.startTestRun(p, { over: { limits: { max_commands: 1 } } });
    const marker = join(p.dir, 'budget-marker');
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    await exec(node('0', { run }));
    await assert.rejects(exec(node(script, { run })), code('UK_BUDGET_EXCEEDED'));
    assert.equal(existsSync(marker), false);
    K.runs.endRun(p.ctx, run.id);
  });
});

describe('brokerExec: execution, verdicts and evidence', () => {
  test('pass: exit 0, evidence record fields, events and command log', async () => {
    const { run } = K.startTestRun(p);
    const r = await exec(node('console.log("hello"); console.error("warn")', { run, obligation: 'PO-1', sliceId: 'UK-1', diffHash: 'sha256:d' }));
    const rec = r.record;
    assert.equal(rec.verdict, 'pass');
    assert.equal(rec.exit_code, 0);
    assert.equal(rec.timed_out, false);
    assert.equal(rec.truncated, false);
    assert.equal(rec.error, null);
    assert.equal(rec.obligation, 'PO-1');
    assert.equal(rec.slice_id, 'UK-1');
    assert.equal(rec.run_id, run.id);
    assert.equal(rec.diff_hash, 'sha256:d');
    assert.equal(rec.working_directory, p.dir);
    assert.equal(rec.command[0], process.execPath);
    assert.match(rec.environment_digest, /^sha256:/);
    assert.equal(r.stdout.toString(), 'hello\n');
    assert.equal(r.stderr.toString(), 'warn\n');
    const evs = K.ledger.readEvents(p.ctx.store, { runId: run.id });
    assert.deepEqual(evs.filter((e) => e.type.startsWith('exec.')).map((e) => e.type), ['exec.started', 'exec.finished']);
    assert.equal(evs.find((e) => e.type === 'exec.finished').payload.verdict, 'pass');
    const log = readFileSync(join(p.ctx.paths.runs, run.id, 'command-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(log.at(-1)).id, rec.id);
    assert.equal(p.ctx.store.counters(run.id).commands, 1);
    K.runs.endRun(p.ctx, run.id);
  });

  test('fail: non-zero exit keeps the code', async () => {
    const r = await exec(node('process.exit(3)'));
    assert.equal(r.record.verdict, 'fail');
    assert.equal(r.record.exit_code, 3);
  });

  test('inconclusive: killed by a signal has no exit code', async () => {
    const r = await exec(node('process.kill(process.pid, "SIGKILL")'));
    assert.equal(r.record.exit_code, null);
    assert.equal(r.record.verdict, 'inconclusive');
  });

  test('inconclusive: timeout kills the command and flags timed_out', async () => {
    const t0 = Date.now();
    const r = await exec({ argv: ['sleep', '5'], cwd: p.dir, origin: 'configured', config, timeoutMs: 400 });
    assert.ok(Date.now() - t0 < 4000, 'did not wait for sleep to finish');
    assert.equal(r.record.timed_out, true);
    assert.equal(r.record.verdict, 'inconclusive');
  });

  test('timeout kills the whole process group, not just the leader', async () => {
    const r = await exec({ argv: ['sh', '-c', 'sleep 30 & echo $!; wait'], cwd: p.dir, origin: 'configured', config, timeoutMs: 600 });
    assert.equal(r.record.timed_out, true);
    const pid = Number(r.stdout.toString().trim());
    assert.ok(pid > 1);
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'grandchild survived the timeout');
  });

  test('a missing executable is inconclusive, not a plain failure',
    {},
    async () => {
      const r = await exec({ argv: ['definitely-not-installed-zzz'], cwd: p.dir, origin: 'configured', config });
      assert.equal(r.record.verdict, 'inconclusive');
    });

  test('adapterExec turns policy denials into UK_ADAPTER_UNSUPPORTED', async () => {
    const run = adapterExec(p.ctx, { run: null, config, cwd: p.dir });
    await assert.rejects(run(['git', 'push']), code('UK_ADAPTER_UNSUPPORTED'));
    const ok = await run(['git', 'rev-parse', 'HEAD']);
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout.trim(), p.commit);
  });

  test('stdin is delivered', async () => {
    const r = await exec(node('process.stdin.pipe(process.stdout)', { input: 'piped-in' }));
    assert.equal(r.stdout.toString(), 'piped-in');
  });

  test('digests are sha256 of the complete output, beyond the tail window', async () => {
    const r = await exec(node('const l = "line of output ".repeat(10) + "\\n"; for (let i = 0; i < 20000; i++) process.stdout.write(l); process.stderr.write("e".repeat(100000))'));
    const expected = ('line of output '.repeat(10) + '\n').repeat(20000);
    assert.equal(r.stdout.length, expected.length);
    assert.equal(r.record.stdout_digest, `sha256:${sha256(expected)}`);
    assert.equal(r.record.stderr_digest, `sha256:${sha256('e'.repeat(100000))}`);
    assert.ok(r.stdoutTail.length <= 64 * 1024 && r.stdoutTail.length > 0);
    assert.equal(r.record.truncated, false);
  });

  test('empty output has the empty-string digest', async () => {
    const r = await exec(node('0'));
    assert.equal(r.record.stdout_digest, `sha256:${sha256('')}`);
  });

  test('beyond the 16 MiB cap the buffer truncates but the digest still covers everything', async () => {
    const total = 17 * 1024 * 1024;
    const r = await exec(node(`const b = Buffer.alloc(1024 * 1024, 97); for (let i = 0; i < 17; i++) process.stdout.write(b)`, { timeoutMs: 60_000 }));
    assert.equal(r.record.truncated, true);
    assert.equal(r.stdout.length, 16 * 1024 * 1024);
    assert.equal(r.record.stdout_digest, `sha256:${sha256(Buffer.alloc(total, 97))}`);
  });

  test('outputs round-trip through the encrypted CAS', async () => {
    const r = await exec(node('process.stdout.write("round trip ✓\\n"); process.stderr.write("err side")'));
    const [outRef, errRef] = r.record.artifact_refs;
    assert.equal(outRef, r.record.stdout_digest);
    assert.equal(errRef, r.record.stderr_digest);
    assert.equal(casGet(p.ctx, outRef).toString(), 'round trip ✓\n');
    assert.equal(casGet(p.ctx, errRef).toString(), 'err side');
  });

  test('a tampered CAS blob is detected as UK_INTEGRITY', async () => {
    const r = await exec(node('process.stdout.write("integrity-protected output, long enough")'));
    const ref = r.record.artifact_refs[0];
    const hex = ref.slice(7);
    const file = join(p.ctx.paths.cas, 'sha256', hex.slice(0, 2), hex.slice(2));
    const blob = readFileSync(file);
    blob[blob.length - 1] ^= 1;
    writeFileSync(file, blob);
    assert.throws(() => casGet(p.ctx, ref), code('UK_INTEGRITY'));
  });

  test('tails are redacted but the evidence digest is of the raw bytes', async () => {
    const token = `ghp_${'aB3'.repeat(12)}`;
    const r = await exec(node(`process.stdout.write(${JSON.stringify(`token ${token}`)})`));
    assert.ok(!r.stdoutTail.includes(token));
    assert.match(r.stdoutTail, /REDACTED/);
    assert.equal(r.record.stdout_digest, `sha256:${sha256(`token ${token}`)}`);
  });

  test('configured redact_patterns apply to the tail', async () => {
    const cfg = K.cfg({ security: { redact_patterns: ['INTERNAL-\\d+'] } });
    const r = await exec(node('process.stdout.write("see INTERNAL-4242")', { config: cfg }));
    assert.equal(r.stdoutTail, 'see [REDACTED:custom]');
  });
});

describe('brokered environment', () => {
  test('credentials in the parent environment never reach the child', async () => {
    const planted = { GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'x', AWS_ACCESS_KEY_ID: 'x', NPM_TOKEN: 'x', DATABASE_URL: 'postgres://u:p@h/db', ANTHROPIC_API_KEY: 'x', SSH_AUTH_SOCK: '/tmp/agent', UNKNOT_HOME_LEAK: 'x', MY_PASSWORD: 'x', GOOGLE_APPLICATION_CREDENTIALS: '/x', KUBECONFIG: '/x', NODE_OPTIONS: '--require /x' };
    const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      const r = await exec(node('process.stdout.write(JSON.stringify(process.env))'));
      const env = JSON.parse(r.stdout.toString());
      for (const k of Object.keys(planted)) assert.ok(!(k in env), `${k} leaked`);
      assert.equal(env.CI, '1');
      assert.equal(env.UNKNOT_SANDBOXED, '1');
      assert.equal(env.TERM, 'dumb');
      assert.equal(env.NO_COLOR, '1');
      assert.ok(env.PATH);
      // A private temp dir outside the project (dogfood round 3: scratch git repos must not
      // nest inside the analysed repository).
      assert.ok(!env.TMPDIR.startsWith(p.dir) && /unknot-run-/.test(env.TMPDIR), 'TMPDIR is a private dir outside the project');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('minimalEnv rejects credential-like extra variables', () => {
    for (const k of ['GITHUB_TOKEN', 'MY_TOKEN', 'SECRET', 'DB_SECRET', 'PASSWORD', 'DB_PASSWORD', 'PASSWD', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AZURE_CLIENT_ID', 'GOOGLE_X', 'GCP_PROJECT', 'GH_TOKEN', 'GITHUB_X', 'NPM_CONFIG_X', 'DATABASE_URL', 'API_KEY', 'PRIVATE_KEY', 'SERVICE_CREDENTIAL', 'my_token', 'database_url']) {
      assert.throws(() => minimalEnv({ extra: { [k]: 'v' } }), code('UK_POLICY_DENIED'), k);
    }
    const env = minimalEnv({ tmp: '/tmp/x', extra: { FOO: 'bar', NODE_ENV: 'test', COUNT: 3 } });
    assert.equal(env.FOO, 'bar');
    assert.equal(env.COUNT, '3');
    assert.equal(env.TMPDIR, '/tmp/x');
    assert.equal(env.HOME, homedir());
    assert.equal(env.UNKNOT_SANDBOXED, '1');
  });

  test('minimalEnv only inherits the allowlisted variables', () => {
    const saved = process.env.UK_PROBE_VAR;
    process.env.UK_PROBE_VAR = 'secret-ish';
    try {
      const env = minimalEnv();
      assert.ok(!('UK_PROBE_VAR' in env));
      for (const k of Object.keys(env)) assert.ok(/^(PATH|LANG|LC_ALL|LC_CTYPE|SHELL|USER|LOGNAME|JAVA_HOME|GOPATH|GOROOT|CARGO_HOME|RUSTUP_HOME|PYENV_ROOT|NVM_DIR|VOLTA_HOME|PNPM_HOME|VIRTUAL_ENV|HOME|TERM|CI|NO_COLOR|FORCE_COLOR|UNKNOT_SANDBOXED)$/.test(k), k);
    } finally {
      if (saved === undefined) delete process.env.UK_PROBE_VAR;
      else process.env.UK_PROBE_VAR = saved;
    }
  });
});

describe('sandbox profile and wrappers (pure)', () => {
  test('macOS profile denies network unless asked, and hides credential directories and UNKNOT_HOME', () => {
    const off = K.sandbox.macosProfile({ writable: [p.dir], network: false });
    assert.match(off, /\(deny network\*\)/);
    assert.match(off, /\(deny file-write\*\)/);
    assert.ok(off.includes(`(subpath "${p.dir}")`));
    assert.ok(off.includes(`${homedir()}/.ssh`) || off.includes('/.ssh"'));
    assert.ok(off.includes('.aws') && off.includes('.netrc') && off.includes('.npmrc'));
    assert.ok(off.includes(p.home), 'UNKNOT_HOME is hidden');
    const on = K.sandbox.macosProfile({ writable: [p.dir], network: true });
    assert.ok(!/\(deny network\*\)/.test(on));
  });

  test('paths that cannot be quoted into a profile are refused', () => {
    for (const bad of ['/tmp/a"b', '/tmp/a\\b', '/tmp/a\nb']) {
      assert.throws(() => K.sandbox.macosProfile({ writable: [bad], network: false }), code('UK_SCOPE_VIOLATION'), JSON.stringify(bad));
    }
  });

  test('bubblewrap wrapper: read-only root, no network by default, argv after `--`', () => {
    const off = K.sandbox.wrap(['ls', '-l'], { kind: 'linux-bwrap', writable: [p.dir] });
    assert.equal(off.file, 'bwrap');
    assert.deepEqual(off.args.slice(0, 3), ['--ro-bind', '/', '/']);
    assert.ok(off.args.includes('--unshare-net'));
    assert.ok(off.args.includes('--die-with-parent') && off.args.includes('--new-session'));
    assert.deepEqual(off.args.slice(-3), ['--', 'ls', '-l']);
    const bindIdx = off.args.indexOf('--bind');
    assert.ok(bindIdx > 0);
    const on = K.sandbox.wrap(['ls'], { kind: 'linux-bwrap', network: true });
    assert.ok(!on.args.includes('--unshare-net'));
  });

  test('argv metacharacters survive wrapping untouched (no shell)', () => {
    const argv = ['echo', '$(rm -rf /)', '; reboot', '`id`'];
    const w = K.sandbox.wrap(argv, { kind: 'macos-sandbox-exec', writable: [p.dir] });
    assert.deepEqual(w.args.slice(-4), argv);
    assert.equal(w.file, '/usr/bin/sandbox-exec');
  });
});

describe('OS sandbox enforcement (macOS)', { skip: process.platform !== 'darwin' || K.sandbox.detectSandbox() !== 'macos-sandbox-exec' }, () => {
  test('the sandbox is active for brokered commands', async () => {
    const r = await exec(node('0'));
    assert.equal(r.record.sandbox, 'macos-sandbox-exec');
  });

  test('writing into $HOME is denied', async () => {
    const target = join(homedir(), `.uk-sandbox-probe-${process.pid}`);
    try {
      const r = await exec(node(`try { require('fs').writeFileSync(${JSON.stringify(target)}, 'x'); console.log('WROTE') } catch (e) { console.log(e.code) }`));
      assert.match(r.stdout.toString(), /EPERM|EACCES/);
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(target, { force: true });
    }
  });

  test('writing under the project run directory and the private TMPDIR is allowed', async () => {
    const { run } = K.startTestRun(p);
    const target = join(p.ctx.paths.runs, run.id, 'ok.txt');
    const r = await exec(node(`require('fs').writeFileSync(${JSON.stringify(target)}, 'x'); require('fs').writeFileSync(require('path').join(process.env.TMPDIR, 't.txt'), 'y'); console.log('ok')`, { run }));
    assert.equal(r.stdout.toString().trim(), 'ok');
    K.runs.endRun(p.ctx, run.id);
  });

  test('key material under UNKNOT_HOME is unreadable and unwritable', async () => {
    const key = join(p.home, 'projects', p.ctx.projectId, 'audit.pem');
    assert.ok(existsSync(key));
    const r = await exec(node(`const fs = require('fs'); try { fs.readFileSync(${JSON.stringify(key)}); console.log('READ') } catch (e) { console.log('read:' + e.code) }; try { fs.writeFileSync(${JSON.stringify(join(p.home, 'x'))}, 'x'); console.log('WROTE') } catch (e) { console.log('write:' + e.code) }`));
    assert.match(r.stdout.toString(), /read:(EPERM|EACCES)/);
    assert.match(r.stdout.toString(), /write:(EPERM|EACCES)/);
  });

  test('~/.ssh and ~/.aws are unreadable', async () => {
    const r = await exec(node(`const fs = require('fs'), os = require('os'), path = require('path'); for (const d of ['.ssh', '.aws']) { try { fs.readdirSync(path.join(os.homedir(), d)); console.log(d + ':LISTED') } catch (e) { console.log(d + ':' + e.code) } }`));
    const out = r.stdout.toString();
    assert.match(out, /\.ssh:(EPERM|EACCES)/);
    assert.match(out, /\.aws:(EPERM|EACCES)/);
  });

  test('outbound network is blocked by default and open when network:true', async () => {
    const server = createServer((req, res) => res.end('reachable'));
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const { port } = server.address();
    try {
      const url = `http://127.0.0.1:${port}/`;
      const blocked = await exec({ argv: ['/usr/bin/curl', '-sS', '--max-time', '5', url], cwd: p.dir, origin: 'configured', config: K.cfg({ limits: { max_network_requests: 5 } }) });
      assert.notEqual(blocked.record.exit_code, 0, `curl should fail: ${blocked.stdout}`);
      assert.ok(!blocked.stdout.toString().includes('reachable'));
      const open = await exec({ argv: ['/usr/bin/curl', '-sS', '--max-time', '5', url], cwd: p.dir, origin: 'configured', network: true, config: K.cfg({ limits: { max_network_requests: 5 } }) });
      assert.equal(open.stdout.toString(), 'reachable', open.stderr.toString());
    } finally {
      server.close();
    }
  });

  test('node-level network is blocked too', async () => {
    const server = createServer((req, res) => res.end('reachable'));
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const { port } = server.address();
    try {
      const r = await exec(node(`fetch('http://127.0.0.1:${port}/').then((r) => r.text()).then((t) => console.log('GOT ' + t), (e) => console.log('ERR'))`));
      assert.match(r.stdout.toString(), /ERR/);
    } finally {
      server.close();
    }
  });
});
