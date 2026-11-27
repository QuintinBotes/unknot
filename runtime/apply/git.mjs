// Git as the runtime drives it. Every invocation disables the repository-controlled ways
// git can run code: hooks, fsmonitor, external diff and textconv drivers, pagers, and
// network transports. A repository under analysis must not get execution from `git status`.
// It also ignores the two ways a repository can redirect what an object id reads as: replace refs
// (refs/replace/*) and the grafts file (.git/info/grafts); git has no config key for grafts, only
// GIT_GRAFT_FILE. A repository that borrows objects through .git/objects/info/alternates is refused,
// since git cannot be told to ignore it. Not guaranteed: the object store itself is not re-hashed,
// so whoever can write .git/objects (or its commit-graph) can still make an id read wrongly, and a
// shallow clone's .git/shallow still cuts history at its boundary.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
  // Replace refs and grafts would let a local file swap one commit's content or parents for another's.
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
  for (const k of ENV_KEEP) if (process.env[k]) env[k] = process.env[k];
  return env;
}

const run = (cwd, args, opts) => spawnSync('git', [...SAFE_GIT, ...args], { cwd, encoding: 'utf8', shell: false, env: gitEnv(), ...opts });

const noAlternates = new Set();

/** Refuse a repository whose object store borrows from another (alternates); checked once per directory. */
function refuseAlternates(cwd) {
  const key = resolve(cwd ?? '.');
  if (noAlternates.has(key)) return;
  const r = run(key, ['rev-parse', '--git-path', 'objects/info/alternates'], { timeout: 10_000 });
  const file = r.status === 0 ? resolve(key, r.stdout.trim()) : null;
  if (file && existsSync(file)) {
    throw new UnknotError('UK_INTEGRITY', `this repository reads objects from another store (${file}), so a commit id here may not mean this repository's own content. Copy the borrowed objects in and stop borrowing: git repack -a -d && rm ${file}`);
  }
  if (file) noAlternates.add(key);
}

/**
 * Run git in `cwd`. With `check` (default) a non-zero exit throws UK_TOOL_FAILED.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
export function git(cwd, args, { check = true, input, maxBuffer = 256 * 1024 * 1024, timeout = 120_000 } = {}) {
  refuseAlternates(cwd);
  const r = run(cwd, args, { input, maxBuffer, timeout });
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
