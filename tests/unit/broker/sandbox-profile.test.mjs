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

test('the plugin directory stays readable even when it sits inside a hidden directory (live-session regression)', { skip: detectSandbox() !== 'macos-sandbox-exec' }, () => {
  const plugin = realpathSync(new URL('../../../', import.meta.url).pathname).replace(/\/$/, '');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(plugin, '..'); // hide the plugin's parent, as an installed plugin's is
  try {
    const w = wrap(['/bin/cat', join(plugin, 'package.json')], { writable: [] });
    const r = spawnSync(w.file, w.args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"name": "unknot"/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// Linux (bubblewrap). Fixtures live under the real home directory, not /tmp: the sandbox
// mounts a fresh tmpfs over /tmp, which would make every "unreadable" assertion pass trivially.
const bwrapSkip = { skip: detectSandbox() !== 'linux-bwrap' };
const bwrapRun = (argv, opts, spawn = {}) => {
  const w = wrap(argv, opts);
  return spawnSync(w.file, w.args, { encoding: 'utf8', timeout: 30000, ...spawn });
};
const withHomeDir = (fn) => {
  const base = realpathSync(mkdtempSync(join(homedir(), '.uk-bwrap-')));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

test('Linux: in a worktree, main-checkout files are hidden, the worktree is usable and tests run', bwrapSkip, () => {
  withHomeDir((base) => {
    const root = join(base, 'proj');
    const wt = join(root, '.unknot/worktrees/UK-1');
    mkdirSync(join(wt, 'test'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.env'), 'TOKEN=main-checkout-secret\n');
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(wt, 'note.txt'), 'worktree-ok\n');
    writeFileSync(join(wt, 'test/a.test.mjs'), "import { test } from 'node:test'; test('x', () => {});\n");
    const opts = { writable: [wt], hideRoot: root, cwd: wt };
    const env = bwrapRun(['/bin/cat', join(root, '.env')], opts, { cwd: wt });
    assert.notEqual(env.status, 0);
    assert.ok(!env.stdout.includes('main-checkout-secret'));
    assert.match(bwrapRun(['/bin/cat', join(wt, 'note.txt')], opts, { cwd: wt }).stdout, /worktree-ok/);
    assert.match(bwrapRun(['/bin/cat', join(root, '.git/HEAD')], opts, { cwd: wt }).stdout, /refs\/heads\/main/);
    const t = bwrapRun([process.execPath, '--test'], opts, { cwd: wt });
    assert.equal(t.status, 0, t.stdout + t.stderr);
  });
});

test('Linux: writes succeed only inside writable paths', bwrapSkip, () => {
  withHomeDir((base) => {
    const ok = join(base, 'ok');
    mkdirSync(ok);
    const opts = { writable: [ok] };
    assert.equal(bwrapRun(['/bin/sh', '-c', `echo x > '${ok}/f'`], opts).status, 0);
    assert.ok(existsSync(join(ok, 'f')));
    const outside = join(base, 'outside.txt');
    assert.notEqual(bwrapRun(['/bin/sh', '-c', `echo x > '${outside}'`], opts).status, 0);
    assert.ok(!existsSync(outside));
  });
});

test('Linux: secret home files and directories, and the Unknot home, are unreadable; missing ones do not break the sandbox', bwrapSkip, () => {
  withHomeDir((base) => {
    const prev = { HOME: process.env.HOME, UNKNOT_HOME: process.env.UNKNOT_HOME };
    const uh = join(base, 'unknot-home');
    process.env.HOME = base; // os.homedir() reads HOME
    process.env.UNKNOT_HOME = uh;
    try {
      mkdirSync(join(base, '.ssh'));
      mkdirSync(uh);
      writeFileSync(join(base, '.ssh/id'), 'ssh-secret\n');
      writeFileSync(join(base, '.netrc'), 'netrc-secret\n');
      writeFileSync(join(uh, 'state'), 'unknot-secret\n');
      writeFileSync(join(base, 'plain.txt'), 'plain-ok\n'); // no .aws, .claude, ... exist here
      for (const f of ['.ssh/id', '.netrc', 'unknot-home/state']) {
        const r = bwrapRun(['/bin/cat', join(base, f)], { writable: [] });
        assert.ok(!/secret/.test(r.stdout), `${f} leaked: ${r.stdout}`);
      }
      const ok = bwrapRun(['/bin/cat', join(base, 'plain.txt')], { writable: [] });
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /plain-ok/);
    } finally {
      for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});

test('Linux: the network is cut but loopback works inside the private namespace', bwrapSkip, () => {
  const own = "const s=require('net').createServer(c=>c.end()).listen(0,'127.0.0.1',()=>require('net').connect(s.address().port,'127.0.0.1').on('connect',()=>{console.log('ok');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(0)})).on('error',e=>{console.log(e.code);process.exit(0)})";
  const remote = "const s=require('net').connect({host:'192.0.2.1',port:80});s.setTimeout(3000,()=>{console.log('TIMEOUT');process.exit(0)});s.on('error',(e)=>{console.log(e.code);process.exit(0)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)})";
  assert.match(bwrapRun([process.execPath, '-e', own], { writable: [] }).stdout, /ok/);
  const t0 = Date.now();
  const r = bwrapRun([process.execPath, '-e', remote], { writable: [] }).stdout;
  assert.match(r, /ENETUNREACH|EADDRNOTAVAIL|EHOSTUNREACH|TIMEOUT/);
  assert.ok(!r.includes('CONNECTED'));
  assert.ok(Date.now() - t0 < 10000, 'fails fast');
});

test('Linux: the plugin directory stays readable even when it sits inside a hidden directory', bwrapSkip, () => {
  const plugin = realpathSync(new URL('../../../', import.meta.url).pathname).replace(/\/$/, '');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(plugin, '..');
  try {
    const r = bwrapRun(['/bin/cat', join(plugin, 'package.json')], { writable: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"name": "unknot"/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('bubblewrap only hides paths that exist (a tmpfs on a missing path fails inside the read-only root)', () => {
  const prev = process.env.UNKNOT_HOME;
  process.env.UNKNOT_HOME = '/nonexistent-unknot-home';
  try {
    const a = wrap(['true'], { kind: 'linux-bwrap', writable: [] }).args.join(' ');
    assert.ok(!a.includes('/nonexistent-unknot-home'));
    assert.ok(!a.includes('--ro-bind /dev/null /nonexistent'));
  } finally {
    if (prev === undefined) delete process.env.UNKNOT_HOME; else process.env.UNKNOT_HOME = prev;
  }
});

// A project inside a hidden directory: Claude Code background jobs clone into scratch space
// inside the Claude config directory. Found when a clone there lost its Python extraction.
const withConfigDir = (dir, fn) => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
};

test('a project inside a hidden directory is put back after the secret rules; one that contains a hidden directory is not', () => {
  withConfigDir('/cfg', () => {
    const prof = macosProfile({ writable: ['/cfg/jobs/p'], network: false, cwd: '/cfg/jobs/p' });
    const deny = prof.indexOf('(subpath "/cfg")');
    assert.ok(deny > 0);
    assert.ok(prof.indexOf('(allow file-read* (subpath "/cfg/jobs/p"))') > deny);
    assert.ok(prof.indexOf('(allow file-write* (subpath "/cfg/jobs/p"))') > deny);
    assert.ok(prof.includes('(literal "/cfg/jobs")') && prof.includes('(literal "/cfg")'));
    const atHome = macosProfile({ writable: [homedir()], network: false, cwd: homedir() });
    assert.ok(!atHome.includes(`(allow file-read* (subpath "${realpathSync(homedir())}"))`), 'a project at $HOME does not re-expose ~/.ssh');
  });
});

test('secrets nested inside a re-exposed project stay hidden', () => {
  const prev = process.env.UNKNOT_HOME;
  process.env.UNKNOT_HOME = '/cfg/jobs/p/.uk-home';
  try {
    withConfigDir('/cfg', () => {
      const prof = macosProfile({ writable: ['/cfg/jobs/p'], network: false, cwd: '/cfg/jobs/p' });
      assert.ok(prof.lastIndexOf('(deny file-read* file-write* (subpath "/cfg/jobs/p/.uk-home"))') > prof.indexOf('(allow file-read* (subpath "/cfg/jobs/p"))'));
    });
  } finally {
    if (prev === undefined) delete process.env.UNKNOT_HOME; else process.env.UNKNOT_HOME = prev;
  }
});

test('bubblewrap mounts a project inside a hidden directory back on top of the tmpfs', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'uk-cfg-')));
  try {
    const p = join(base, 'jobs/p');
    mkdirSync(p, { recursive: true });
    withConfigDir(base, () => {
      const a = wrap(['true'], { kind: 'linux-bwrap', writable: [p], cwd: p }).args;
      const hidden = a.findIndex((x, i) => x === base && a[i - 1] === '--tmpfs');
      const back = a.findIndex((x, i) => x === p && a[i - 1] === '--bind' && i > hidden);
      assert.ok(hidden > 0 && back > hidden, a.join(' '));
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const projectInHiddenDir = (base, run) => {
  const cfg = join(base, 'cfg');
  const p = join(cfg, 'jobs/p');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(cfg, 'secret.txt'), 'config secret');
  writeFileSync(join(p, 'file.txt'), 'project file');
  return withConfigDir(cfg, () => run(['/bin/sh', '-c', 'cat file.txt; echo; /bin/pwd; echo out > out.txt; cat ../../secret.txt'], { writable: [p], cwd: p }, { cwd: p }));
};

test('macOS: a project inside a hidden directory is readable and writable; the rest of that directory is not', { skip: detectSandbox() !== 'macos-sandbox-exec' }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'uk-cfg-')));
  try {
    const r = projectInHiddenDir(base, (argv, opts, spawn) => {
      const w = wrap(argv, opts);
      return spawnSync(w.file, w.args, { encoding: 'utf8', ...spawn });
    });
    assert.match(r.stdout, /project file/);
    assert.match(r.stdout, /cfg\/jobs\/p/);
    assert.ok(existsSync(join(base, 'cfg/jobs/p/out.txt')));
    assert.ok(!r.stdout.includes('config secret'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Linux: a project inside a hidden directory is readable and writable; the rest of that directory is not', bwrapSkip, () => {
  withHomeDir((base) => {
    const r = projectInHiddenDir(base, bwrapRun);
    assert.match(r.stdout, /project file/, r.stderr);
    assert.match(r.stdout, /cfg\/jobs\/p/);
    assert.ok(existsSync(join(base, 'cfg/jobs/p/out.txt')));
    assert.ok(!r.stdout.includes('config secret'));
  });
});
