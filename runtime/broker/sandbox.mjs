// OS sandboxing for brokered commands (spec §16.3: read-only filesystem outside the
// worktree and artifact area, network disabled by default). Hooks are defense in depth;
// this is the layer that holds when a test suite itself is hostile.
//
// macOS: sandbox-exec with a generated SBPL profile. Linux: bubblewrap when installed.
// Elsewhere: no sandbox, which `doctor` reports and `security.require_os_sandbox` refuses.

import { accessSync, constants, existsSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnknotError } from '../core/errors.mjs';
import { realpathLenient } from '../core/paths.mjs';
import { unknotHome } from '../core/project.mjs';

const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gcloud', '.config/gh', '.password-store', '.vault-token',
  // Agent and tool credentials and session data (security review: ~/.claude.json was readable).
  '.claude', '.codex', '.config/claude', '.terraform.d', '.orbstack', '.config/op', '.local/share/keyrings', 'Library/Keychains', '.m2', '.gradle/gradle.properties', '.cargo/credentials', '.config/hub', '.config/doctl', '.oci'];
const SECRET_HOME_FILES = ['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.my.cnf', '.claude.json', '.cargo/credentials.toml', '.boto', '.s3cfg'];

// What a command running in a slice worktree may still read from the main checkout: git's
// object store (the worktree's .git points there) and the dependency directories the
// worktree links to. Everything else there (.env files, untracked notes) stays hidden.
export const MAIN_CHECKOUT_READABLE = ['.git', 'node_modules', '.venv', 'venv', 'vendor/bundle'];

/** Extra secret directories named by the environment (a relocated Claude config). */
function envSecretDirs() {
  return [process.env.CLAUDE_CONFIG_DIR].filter((p) => typeof p === 'string' && p.startsWith('/'));
}

// The plugin's own directory (runtime/broker/ -> repository root), never secret.
const PLUGIN_ROOT = realpathLenient(fileURLToPath(new URL('../../', import.meta.url))).replace(/\/$/, '');

/**
 * A project inside a hidden directory (a Claude Code background job clones into scratch space
 * inside the Claude config directory) must stay usable: its working set is put back after the
 * secret-directory rules, the directories leading to it become listable, and secrets nested
 * inside it are hidden again. A project that merely contains a hidden directory (one at
 * $HOME) gets nothing back. Found when the Python extractor and the tests of a clone in a
 * job's scratch directory could not read the project.
 */
function reexposed(hiddenDirs, read, write) {
  const inside = (p, h) => p.startsWith(`${h}/`);
  const pick = (list) => [...new Set(list.filter(Boolean).map((p) => realpathLenient(p)))].filter((p) => hiddenDirs.some((h) => inside(p, h)));
  const r = pick(read);
  const w = pick(write);
  const all = [...new Set([...r, ...w])];
  const ancestors = new Set();
  for (const p of all) {
    const h = hiddenDirs.find((x) => inside(p, x));
    for (let d = dirname(p); d.startsWith(h); d = dirname(d)) {
      ancestors.add(d);
      if (d === h) break;
    }
  }
  const nested = hiddenDirs.filter((h) => all.some((p) => inside(h, p)));
  return { read: r, write: w, ancestors: [...ancestors], nested };
}

const hiddenHomeDirs = (home) => [...SECRET_HOME_DIRS.map((d) => join(home, d)), ...envSecretDirs(), unknotHome()].map((p) => realpathLenient(p));

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function detectSandbox() {
  if (process.platform === 'darwin' && executable('/usr/bin/sandbox-exec')) return 'macos-sandbox-exec';
  if (process.platform === 'linux') {
    for (const p of ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) if (executable(p)) return 'linux-bwrap';
  }
  return 'none';
}

function sbplString(p) {
  if (/["\\\n\r\0]/.test(p)) throw new UnknotError('UK_SCOPE_VIOLATION', `path cannot be expressed in a sandbox profile: ${p}`);
  return `"${p}"`;
}

/**
 * The SBPL profile for one command. Exported for tests and `doctor --show-sandbox`.
 * Unix sockets may be used only inside `sockets` (the run's private directories), so a
 * sandboxed test cannot reach the Docker API, tmux, or any other local control socket.
 * With `hideRoot` (the main checkout, when the command runs in a slice worktree) only the
 * working directory and MAIN_CHECKOUT_READABLE stay readable there.
 */
export function macosProfile({ writable, network, sockets = [], hideRoot = null, cwd = null, loopback = false }) {
  const home = realpathLenient(homedir());
  const lines = ['(version 1)', '(allow default)'];
  if (!network) {
    lines.push('(deny network*)');
    if (loopback) {
      // Opt-in (security.sandbox_loopback): test suites that start servers on 127.0.0.1.
      // macOS cannot isolate loopback per process, so this also reaches any local TCP
      // service; the internet stays blocked. Not `network* (local ip ...)`: the local end of
      // every socket is on this host, so that form allows every outbound connection.
      lines.push('(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))');
    }
    if (sockets.length) {
      const sp = sockets.map((p) => `(subpath ${sbplString(realpathLenient(p))})`).join(' ');
      lines.push(`(allow network* (local unix-socket ${sp}))`, `(allow network* (remote unix-socket ${sp}))`);
    }
  }
  lines.push('(deny file-write*)');
  const w = [...writable, '/dev'].map((p) => `(subpath ${sbplString(realpathLenient(p))})`);
  lines.push(`(allow file-write* ${w.join(' ')})`);
  let readSet = [cwd];
  if (hideRoot && cwd) {
    const root = realpathLenient(hideRoot);
    lines.push(`(deny file-read* (subpath ${sbplString(root)}))`);
    const keep = [realpathLenient(cwd), ...writable.map((p) => realpathLenient(p)).filter((p) => p.startsWith(`${root}/`)), ...MAIN_CHECKOUT_READABLE.map((d) => join(root, d))];
    readSet = [...new Set(keep)];
    lines.push(`(allow file-read* ${readSet.map((p) => `(subpath ${sbplString(p)})`).join(' ')})`);
    // getcwd and path resolution list the directories between the root and the working
    // directory: those directories themselves (names, never file contents) stay readable.
    const ancestors = [];
    for (let d = dirname(realpathLenient(cwd)); d.startsWith(root); d = dirname(d)) {
      ancestors.push(d);
      if (d === root) break;
    }
    lines.push(`(allow file-read-metadata (subpath ${sbplString(root)}))`);
    if (ancestors.length) lines.push(`(allow file-read* ${ancestors.map((d) => `(literal ${sbplString(d)})`).join(' ')})`);
  }
  const hidden = [
    ...[...SECRET_HOME_DIRS.map((d) => join(home, d)), ...envSecretDirs()].map((d) => `(subpath ${sbplString(d)})`),
    ...SECRET_HOME_FILES.map((f) => `(literal ${sbplString(join(home, f))})`),
    `(subpath ${sbplString(realpathLenient(unknotHome()))})`,
  ];
  lines.push(`(deny file-read* file-write* ${hidden.join(' ')})`);
  const back = reexposed(hiddenHomeDirs(home), readSet, writable);
  const sub = (list) => list.map((p) => `(subpath ${sbplString(p)})`).join(' ');
  if (back.read.length || back.write.length) {
    lines.push(`(allow file-read* ${sub([...new Set([...back.read, ...back.write])])})`);
    if (back.write.length) lines.push(`(allow file-write* ${sub(back.write)})`);
    lines.push(`(allow file-read* ${back.ancestors.map((d) => `(literal ${sbplString(d)})`).join(' ')})`);
    if (back.nested.length) lines.push(`(deny file-read* file-write* ${sub(back.nested)})`);
  }
  // Unknot's own files stay readable: an installed plugin lives inside the Claude config
  // directory hidden above, and its extractors (extract.py) run in this sandbox. Without
  // this, every Python file in a live session fell back to lexical reading.
  lines.push(`(allow file-read* (subpath ${sbplString(PLUGIN_ROOT)}))`);
  return lines.join('\n');
}

const isRealDir = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Wrap an argv for the sandbox.
 * @returns {{file: string, args: string[], sandbox: string}}
 */
export function wrap(argv, { kind = detectSandbox(), writable = [], network = false, requireSandbox = false, sockets = writable, hideRoot = null, cwd = null, loopback = false } = {}) {
  const tmp = realpathLenient(tmpdir());
  // System temp locations exist per platform (/private/tmp only on macOS); binding a path
  // that does not exist makes bubblewrap refuse to start (caught by the Linux CI job).
  const system = [tmp, '/private/tmp', '/tmp'].filter((p) => existsSync(p));
  const allWritable = [...new Set([...writable, ...system].map((p) => realpathLenient(p)))];
  const hide = hideRoot && cwd && realpathLenient(cwd) !== realpathLenient(hideRoot) ? hideRoot : null;
  if (kind === 'macos-sandbox-exec') {
    return { file: '/usr/bin/sandbox-exec', args: ['-p', macosProfile({ writable: allWritable, network, sockets, hideRoot: hide, cwd, loopback }), ...argv], sandbox: kind };
  }
  if (kind === 'linux-bwrap') {
    const home = realpathLenient(homedir());
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--new-session', '--unshare-ipc', '--unshare-pid', '--unshare-uts'];
    // A project that lives under /tmp (temporary clones, test fixtures) would vanish under the
    // fresh /tmp: put it back read-only before the narrower mounts below.
    for (const p of [hideRoot, cwd].filter(Boolean).map((x) => realpathLenient(x))) {
      if (p.startsWith('/tmp/')) args.push('--ro-bind', p, p);
    }
    // Control sockets (Docker, D-Bus, systemd) live under /run.
    for (const d of ['/run', '/var/run']) if (isRealDir(d)) args.push('--tmpfs', d);
    if (hide) {
      const root = realpathLenient(hide);
      args.push('--tmpfs', root);
      for (const d of MAIN_CHECKOUT_READABLE) args.push('--ro-bind-try', join(root, d), join(root, d));
      args.push('--ro-bind', realpathLenient(cwd), realpathLenient(cwd));
    }
    for (const p of allWritable) if (p !== '/tmp') args.push('--bind', p, p);
    // bwrap creates mount points on demand, which fails (EROFS) inside the read-only root:
    // only paths that exist can be hidden. A path that does not exist cannot be read anyway.
    // Resolved first, so a symlinked secret directory is hidden at its real location.
    const present = (p) => (existsSync(p) ? realpathLenient(p) : null);
    const hiddenDirs = [...SECRET_HOME_DIRS.map((x) => join(home, x)), ...envSecretDirs(), unknotHome()].map(present).filter((p) => p && isRealDir(p));
    for (const d of new Set(hiddenDirs)) args.push('--tmpfs', d);
    // Mount points inside a tmpfs are created on demand, so a project inside a hidden
    // directory can be put back on top of it.
    const readSet = hide ? [realpathLenient(cwd), ...MAIN_CHECKOUT_READABLE.map((d) => join(realpathLenient(hide), d)).filter((p) => existsSync(p))] : [cwd];
    const back = reexposed(hiddenDirs, readSet, allWritable);
    for (const p of back.read) if (!back.write.includes(p)) args.push('--ro-bind', p, p);
    for (const p of back.write) args.push('--bind', p, p);
    for (const d of back.nested) args.push('--tmpfs', d);
    for (const f of SECRET_HOME_FILES) {
      const real = present(join(home, f));
      if (real && !isRealDir(real)) args.push('--ro-bind', '/dev/null', real);
    }
    args.push('--ro-bind', PLUGIN_ROOT, PLUGIN_ROOT); // after the tmpfs mounts: see macosProfile
    if (!network) args.push('--unshare-net');
    return { file: 'bwrap', args: [...args, '--', ...argv], sandbox: kind };
  }
  if (requireSandbox) {
    throw new UnknotError('UK_POLICY_DENIED', 'security.require_os_sandbox is set but no OS sandbox is available (need sandbox-exec or bubblewrap)', {
      details: { policy: 'security.require_os_sandbox' },
    });
  }
  return { file: argv[0], args: argv.slice(1), sandbox: 'none' };
}
