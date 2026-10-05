import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectSandbox, macosProfile, wrap } from '../../../runtime/broker/sandbox.mjs';

test('unix sockets are allowed only inside the run directories, never globally (security review)', () => {
  const prof = macosProfile({ writable: ['/w'], network: false, sockets: ['/w/run'] });
  assert.ok(!/\(allow network\* \(local unix-socket\)\)/.test(prof));
  assert.match(prof, /\(allow network\* \(local unix-socket \(subpath "\/w\/run"\)\)\)/);
  assert.ok(!/unix-socket/.test(macosProfile({ writable: ['/w'], network: false, sockets: [] })));
});

test('agent and tool credentials are hidden; the main checkout is hidden except the worktree, .git and dependency directories', () => {
  const prof = macosProfile({ writable: ['/p/.unknot/worktrees/UK-1'], network: false, hideRoot: '/p', cwd: '/p/.unknot/worktrees/UK-1' });
  for (const s of ['.claude.json', '/.claude"', '.codex', '.terraform.d', 'credentials.toml']) assert.ok(prof.includes(s), s);
  assert.match(prof, /\(deny file-read\* \(subpath "\/p"\)\)/);
  for (const s of ['/p/.unknot/worktrees/UK-1', '/p/.git', '/p/node_modules']) assert.ok(prof.includes(`(subpath "${s}")`), s);
  assert.ok(prof.includes('(literal "/p/.unknot/worktrees")'));
});

test('bubblewrap hides /run control sockets and the main checkout outside the worktree', () => {
  const w = wrap(['true'], { kind: 'linux-bwrap', writable: ['/p/.unknot/worktrees/UK-1'], hideRoot: '/p', cwd: '/p/.unknot/worktrees/UK-1' });
  const a = w.args.join(' ');
  assert.ok(a.includes('--tmpfs /p') && a.includes('--ro-bind-try /p/.git /p/.git') && a.includes('--unshare-ipc') && a.includes('--unshare-net'));
  const inRoot = wrap(['true'], { kind: 'linux-bwrap', writable: [], hideRoot: '/p', cwd: '/p' }).args.join(' ');
  assert.ok(!inRoot.includes('--tmpfs /p '), 'a command in the main checkout itself keeps it readable');
});

test('macOS: in a worktree, main-checkout files and the Docker socket are out of reach, tests still run', { skip: detectSandbox() !== 'macos-sandbox-exec' }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'uk-sbx-')));
  try {
    const root = join(base, 'proj');
    const wt = join(root, '.unknot/worktrees/UK-1');
    mkdirSync(join(wt, 'test'), { recursive: true });
    writeFileSync(join(root, '.env'), 'TOKEN=main-checkout-secret\n');
    writeFileSync(join(wt, 'test/a.test.mjs'), "import { test } from 'node:test'; test('x', () => {});\n");
    const run = (argv) => {
      const w = wrap(argv, { writable: [wt, join(base, 'tmp')], sockets: [join(base, 'tmp')], hideRoot: root, cwd: wt });
      return spawnSync(w.file, w.args, { cwd: wt, encoding: 'utf8' });
    };
    assert.equal(run([process.execPath, '--test']).status, 0);
    const env = run(['/bin/cat', join(root, '.env')]);
    assert.notEqual(env.status, 0);
    assert.ok(!env.stdout.includes('main-checkout-secret'));
    if (existsSync('/var/run/docker.sock')) {
      const s = run([process.execPath, '-e', "require('net').connect('/var/run/docker.sock').on('error', (e) => console.log(e.code)).on('connect', () => console.log('CONNECTED'))"]);
      assert.ok(!s.stdout.includes('CONNECTED'), s.stdout);
    }
    if (existsSync(join(homedir(), '.claude.json'))) assert.notEqual(run(['/bin/cat', join(homedir(), '.claude.json')]).status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loopback is opt-in; when on, only loopback is opened', () => {
  assert.ok(!/localhost/.test(macosProfile({ writable: ['/w'], network: false })));
  const on = macosProfile({ writable: ['/w'], network: false, loopback: true });
  assert.match(on, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.ok(!/network\* \(local ip/.test(on), 'network* with a local-ip filter opens every outbound connection');
});

test('macOS: with loopback on, a test can serve and reach 127.0.0.1 but not the internet', { skip: detectSandbox() !== 'macos-sandbox-exec' }, () => {
  const run = (code, loopback) => { const w = wrap([process.execPath, '-e', code], { writable: [], loopback }); return spawnSync(w.file, w.args, { encoding: 'utf8', timeout: 15000 }).stdout; };
  const own = "const s=require('net').createServer(c=>c.end()).listen(0,'127.0.0.1',()=>require('net').connect(s.address().port,'127.0.0.1').on('connect',()=>{console.log('ok');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(0)})).on('error',e=>{console.log(e.code);process.exit(0)})";
  const remote = "const s=require('net').connect({host:'192.0.2.1',port:80});s.setTimeout(1500,()=>{console.log('TIMEOUT');process.exit(0)});s.on('error',(e)=>{console.log(e.code);process.exit(0)})";
  assert.match(run(own, true), /ok/);
  assert.match(run(own, false), /EPERM|EACCES/);
  assert.match(run(remote, true), /EPERM|EACCES/);
});
