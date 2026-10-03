// OS sandboxing for brokered commands (spec §16.3: read-only filesystem outside the
// worktree and artifact area, network disabled by default). Hooks are defense in depth;
// this is the layer that holds when a test suite itself is hostile.
//
// macOS: sandbox-exec with a generated SBPL profile. Linux: bubblewrap when installed.
// Elsewhere: no sandbox, which `doctor` reports and `security.require_os_sandbox` refuses.

import { accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnknotError } from '../core/errors.mjs';
import { realpathLenient } from '../core/paths.mjs';
import { unknotHome } from '../core/project.mjs';

const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gcloud', '.config/gh', '.password-store', '.vault-token'];
const SECRET_HOME_FILES = ['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.my.cnf'];

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

/** The SBPL profile for one command. Exported for tests and `doctor --show-sandbox`. */
export function macosProfile({ writable, network }) {
  const home = realpathLenient(homedir());
  const lines = ['(version 1)', '(allow default)'];
  if (!network) {
    lines.push('(deny network*)');
    // Local IPC (test runners talking to their own workers) stays available.
    lines.push('(allow network* (local unix-socket))');
  }
  lines.push('(deny file-write*)');
  const w = [...writable, '/dev'].map((p) => `(subpath ${sbplString(realpathLenient(p))})`);
  lines.push(`(allow file-write* ${w.join(' ')})`);
  const hidden = [
    ...SECRET_HOME_DIRS.map((d) => `(subpath ${sbplString(join(home, d))})`),
    ...SECRET_HOME_FILES.map((f) => `(literal ${sbplString(join(home, f))})`),
    `(subpath ${sbplString(realpathLenient(unknotHome()))})`,
  ];
  lines.push(`(deny file-read* file-write* ${hidden.join(' ')})`);
  return lines.join('\n');
}

/**
 * Wrap an argv for the sandbox.
 * @returns {{file: string, args: string[], sandbox: string}}
 */
export function wrap(argv, { kind = detectSandbox(), writable = [], network = false, requireSandbox = false } = {}) {
  const tmp = realpathLenient(tmpdir());
  const allWritable = [...new Set([...writable, tmp, '/private/tmp', '/tmp'].map((p) => realpathLenient(p)))];
  if (kind === 'macos-sandbox-exec') {
    return { file: '/usr/bin/sandbox-exec', args: ['-p', macosProfile({ writable: allWritable, network }), ...argv], sandbox: kind };
  }
  if (kind === 'linux-bwrap') {
    const home = realpathLenient(homedir());
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--new-session'];
    for (const p of allWritable) if (p !== '/tmp') args.push('--bind', p, p);
    for (const d of [...SECRET_HOME_DIRS, ...SECRET_HOME_FILES.map(() => null)].filter(Boolean)) args.push('--tmpfs', join(home, d));
    for (const f of SECRET_HOME_FILES) args.push('--ro-bind-try', '/dev/null', join(home, f));
    args.push('--tmpfs', realpathLenient(unknotHome()));
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
