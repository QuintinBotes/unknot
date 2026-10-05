// Slice worktrees (spec §18). Each approved slice is patched in its own git worktree on
// its own branch, created from the approved baseline commit. The main checkout is never
// touched, so abandoning a slice is deleting a directory and a branch.

import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { dirtyPaths, git, head } from './git.mjs';

// Dependency directories shared read-only from the main checkout so tests can run in a
// fresh worktree without a network install. They are never part of the diff.
const LINKED = ['node_modules', '.venv', 'venv', 'vendor/bundle'];
const MAX_LINK_DEPTH = 3;

export function worktreePath(ctx, sliceId) {
  return join(ctx.paths.worktrees, sliceId);
}

export const branchName = (sliceId) => `unknot/${sliceId}`;

/** Fail unless the main checkout has no tracked modifications (spec §18 step 1). */
export function assertCleanBaseline(root) {
  const dirty = dirtyPaths(root);
  if (dirty.length) {
    throw new UnknotError('UK_BASELINE_INVALID', `the working tree has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}); commit or stash them first`, {
      details: { dirty },
    });
  }
}

function findDependencyDirs(root, dir = '', depth = 0, out = []) {
  if (depth > MAX_LINK_DEPTH) return out;
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.git') || e.name === '.unknot' || e.name === '.claude') continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    const linkedName = LINKED.includes(e.name) || LINKED.includes(rel);
    // In a slice worktree the dependency directories are symlinks to the main checkout's;
    // missing them here staged `node_modules` into the patch (write-path test on a real repo).
    if (linkedName && (e.isDirectory() || e.isSymbolicLink())) out.push(rel);
    else if (e.isDirectory() && !['dist', 'build', 'target', 'coverage'].includes(e.name)) findDependencyDirs(root, rel, depth + 1, out);
  }
  return out;
}

/** Create (or reuse) the slice worktree at `baseCommit`. Returns its path and branch. */
export function createWorktree(ctx, sliceId, baseCommit) {
  const path = worktreePath(ctx, sliceId);
  const branch = branchName(sliceId);
  if (existsSync(path)) {
    const current = head(path);
    const onBranch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], { check: false }).stdout.trim();
    if (onBranch !== branch) throw new UnknotError('UK_STATE_CONFLICT', `${path} exists but is not on ${branch}`);
    return { path, branch, head: current, reused: true, linked: [] };
  }
  const exists = git(ctx.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { check: false }).status === 0;
  if (exists) git(ctx.root, ['worktree', 'add', path, branch]);
  else git(ctx.root, ['worktree', 'add', '-b', branch, path, baseCommit]);
  const linked = [];
  for (const rel of findDependencyDirs(ctx.root)) {
    const target = join(path, rel);
    if (!existsSync(target) && existsSync(join(path, rel, '..'))) {
      symlinkSync(join(ctx.root, rel), target, 'dir');
      linked.push(rel);
    }
  }
  return { path, branch, head: head(path), reused: false, linked };
}

export function removeWorktree(ctx, sliceId, { deleteBranch = false } = {}) {
  const path = worktreePath(ctx, sliceId);
  if (existsSync(path)) git(ctx.root, ['worktree', 'remove', '--force', path]);
  git(ctx.root, ['worktree', 'prune'], { check: false });
  if (deleteBranch) git(ctx.root, ['branch', '-D', branchName(sliceId)], { check: false });
}

function linkedIn(path) {
  return findDependencyDirs(path).filter((rel) => {
    try {
      return lstatSync(join(path, rel)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

/** Pathspecs that keep linked dependency directories out of every diff. */
function excludes(path) {
  return linkedIn(path).map((rel) => `:(exclude)${rel}`);
}

/**
 * Changed files and lines relative to the worktree's HEAD, counting untracked files as
 * added lines (a Write creates untracked files). Linked dependency dirs are excluded.
 */
export function diffStat(path) {
  const ex = excludes(path);
  const tracked = git(path, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...ex], { check: false }).stdout;
  const files = new Map();
  for (const line of tracked.split('\n').filter(Boolean)) {
    const [a, d, p] = line.split('\t');
    files.set(p, (a === '-' ? 0 : Number(a)) + (d === '-' ? 0 : Number(d)));
  }
  const untracked = git(path, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...ex], { check: false }).stdout.split('\0').filter(Boolean);
  for (const p of untracked) {
    let lines = 0;
    try {
      lines = readFileSync(join(path, p), 'utf8').split('\n').length;
    } catch {
      lines = 0;
    }
    files.set(p, lines);
  }
  let total = 0;
  for (const v of files.values()) total += v;
  return { files: files.size, lines: total, paths: [...files.keys()].sort() };
}

/**
 * Stage everything in the worktree (except linked deps) and return the full binary patch
 * against the baseline with its hash. The hash is what change approvals bind to.
 */
export function stagePatch(path, baseCommit) {
  git(path, ['add', '-A', '--', '.', ...excludes(path)]);
  const patch = git(path, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--full-index', baseCommit]).stdout;
  return { patch, diff_hash: `sha256:${sha256(patch)}`, files: git(path, ['diff', '--cached', '--name-only', baseCommit]).stdout.split('\n').filter(Boolean) };
}

export function relToWorktree(ctx, sliceId, abs) {
  return relative(worktreePath(ctx, sliceId), abs);
}
