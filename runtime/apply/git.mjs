// Git as the runtime drives it. Every invocation disables the repository-controlled ways
// git can run code: hooks, fsmonitor, external diff and textconv drivers, pagers, and
// network transports. A repository under analysis must not get execution from `git status`.

import { spawnSync } from 'node:child_process';
import { UnknotError } from '../core/errors.mjs';

export const SAFE_GIT = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'core.sshCommand=false',
  '-c', 'protocol.allow=never',
  '-c', 'diff.external=',
  '-c', 'credential.helper=',
  '-c', 'core.quotepath=false',
  '--no-pager',
]);

const ENV_KEEP = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'];

function gitEnv() {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ENV_KEEP) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/**
 * Run git in `cwd`. With `check` (default) a non-zero exit throws UK_TOOL_FAILED.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function git(cwd, args, { check = true, input, maxBuffer = 256 * 1024 * 1024, timeout = 120_000 } = {}) {
  const r = spawnSync('git', [...SAFE_GIT, ...args], { cwd, input, encoding: 'utf8', shell: false, env: gitEnv(), maxBuffer, timeout });
  if (r.error) throw new UnknotError('UK_TOOL_FAILED', `git ${args[0]}: ${r.error.message}`);
  if (check && r.status !== 0) {
    throw new UnknotError('UK_TOOL_FAILED', `git ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`, {
      details: { args, status: r.status },
    });
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const head = (cwd) => git(cwd, ['rev-parse', 'HEAD'], { check: false }).stdout.trim() || null;

export function isRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree'], { check: false }).stdout.trim() === 'true';
}

/** Tracked changes in the working tree, ignoring Unknot's and Claude's own directories. */
export function dirtyPaths(cwd) {
  const out = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).stdout;
  return out
    .split('\0')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((p) => !p.startsWith('.unknot/') && !p.startsWith('.claude/'));
}

/** `git ls-files` (tracked + untracked-not-ignored) as repo-relative paths. */
export function listFiles(cwd, { untracked = true } = {}) {
  const args = ['ls-files', '-z', '--cached'];
  if (untracked) args.push('--others', '--exclude-standard');
  return [...new Set(git(cwd, args).stdout.split('\0').filter(Boolean))].sort();
}

/** Blob ids for tracked files at HEAD-or-index: path → sha1, used as cache keys. */
export function blobIds(cwd) {
  const map = new Map();
  const out = git(cwd, ['ls-files', '-s', '-z']).stdout;
  for (const rec of out.split('\0')) {
    const m = /^\d+ ([0-9a-f]{40,64}) \d+\t(.+)$/.exec(rec);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}
