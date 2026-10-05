// Slice worktrees (spec §18). Each approved slice is patched in its own git worktree on
// its own branch, created from the approved baseline commit. The main checkout is never
// touched, so abandoning a slice is deleting a directory and a branch.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
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
  // A slice starts from its approved baseline. A branch or worktree of that name at another
  // commit would carry changes nobody approved into the staged patch, so it is refused.
  const stray = (at) => new UnknotError('UK_STATE_CONFLICT', `${branch} is at ${String(at).slice(0, 12)}, not the approved baseline ${String(baseCommit).slice(0, 12)}; a person removes it (git worktree remove ${path}; git branch -D ${branch}) or replans the slice`, { slice_id: sliceId, details: { policy: 'worktree.baseline' } });
  if (existsSync(path)) {
    const current = head(path);
    const onBranch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], { check: false }).stdout.trim();
    if (onBranch !== branch) throw new UnknotError('UK_STATE_CONFLICT', `${path} exists but is not on ${branch}`);
    if (current !== baseCommit) throw stray(current);
    return { path, branch, head: current, reused: true, linked: [] };
  }
  const exists = git(ctx.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { check: false }).status === 0;
  if (exists) {
    const at = git(ctx.root, ['rev-parse', `refs/heads/${branch}`]).stdout.trim();
    if (at !== baseCommit) throw stray(at);
    git(ctx.root, ['worktree', 'add', path, branch]);
  }
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

/**
 * Pathspecs that keep linked dependency directories out of every diff. Ones git already
 * ignores need none, and must not get one: `git add` refuses an exclude that names an ignored
 * path (a `.gitignore` with `node_modules` and no trailing slash matches the symlink).
 */
function excludes(path) {
  return linkedIn(path)
    .filter((rel) => git(path, ['check-ignore', '-q', '--', rel], { check: false }).status !== 0)
    .map((rel) => `:(exclude)${rel}`);
}

/**
 * Changed files and lines relative to the worktree's HEAD, counting untracked files as
 * added lines (a Write creates untracked files). Linked dependency dirs are excluded.
 */
export function diffStat(path) {
  const ex = excludes(path);
  const tracked = git(path, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...ex], { check: false }).stdout;
  const files = new Map();
  let added = 0;
  for (const line of tracked.split('\n').filter(Boolean)) {
    const [a, d, p] = line.split('\t');
    files.set(p, (a === '-' ? 0 : Number(a)) + (d === '-' ? 0 : Number(d)));
    // A binary change counts as an addition: it is not a deletion-only patch.
    added += a === '-' ? 1 : Number(a);
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
    added += Math.max(lines, 1);
  }
  let total = 0;
  for (const v of files.values()) total += v;
  return { files: files.size, lines: total, added, paths: [...files.keys()].sort() };
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

/**
 * Size and shape of the staged patch against the baseline: exactly what is hashed and approved.
 * Renames count as a deletion plus an addition; a mode change or a new file, symlink or
 * submodule counts as an addition even when it adds no line.
 */
export function stagedStat(path, baseCommit) {
  const num = git(path, ['diff', '--cached', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', baseCommit]).stdout;
  const summary = git(path, ['diff', '--cached', '--summary', '--no-renames', baseCommit]).stdout;
  let lines = 0;
  let added = 0;
  const paths = [];
  for (const line of num.split('\n').filter(Boolean)) {
    const [a, d, p] = line.split('\t');
    lines += (a === '-' ? 0 : Number(a)) + (d === '-' ? 0 : Number(d));
    added += a === '-' ? 1 : Number(a);
    paths.push(p);
  }
  added += (summary.match(/^ (create mode|mode change) /gm) ?? []).length;
  return { files: paths.length, lines, added, paths: paths.sort() };
}

export function relToWorktree(ctx, sliceId, abs) {
  return relative(worktreePath(ctx, sliceId), abs);
}

/**
 * Editable installs (uv workspaces, `pip install -e`) put absolute paths of the MAIN checkout
 * into the linked virtualenv's .pth files, so tests run in a slice worktree would import the
 * unchanged code (and, in the sandbox, code they cannot read). PYTHONPATH entries come before
 * site-packages, so pointing them at the worktree's copies makes the worktree's code win.
 * Found running the change workflow on a uv workspace.
 * @returns {string[]} worktree paths to prepend to PYTHONPATH
 */
export function editablePathsFor(root, worktree) {
  const out = [];
  const realRoot = realpathSync(root);
  for (const venv of ['.venv', 'venv']) {
    let lib;
    try {
      lib = readdirSync(join(root, venv, 'lib')).filter((d) => d.startsWith('python'));
    } catch {
      continue;
    }
    for (const py of lib) {
      const sp = join(root, venv, 'lib', py, 'site-packages');
      let files = [];
      try {
        files = readdirSync(sp).filter((f) => f.endsWith('.pth'));
      } catch {
        continue;
      }
      for (const f of files) {
        let text = '';
        try {
          text = readFileSync(join(sp, f), 'utf8');
        } catch {
          continue;
        }
        for (const line of text.split('\n').map((l) => l.trim())) {
          if (!line || line.startsWith('#') || line.startsWith('import ')) continue;
          const abs = line.startsWith('/') ? line : null;
          if (!abs) continue;
          for (const base of [root, realRoot]) {
            if (abs === base || abs.startsWith(`${base}/`)) {
              const rel = abs.slice(base.length + 1);
              if (!rel.startsWith('.unknot/')) out.push(rel ? join(worktree, rel) : worktree);
              break;
            }
          }
        }
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Tracked files at the top of the main checkout. Tools that search upward for a manifest
 * (cargo's workspace root, npm workspaces, pytest's rootdir) reach the main checkout from a
 * slice worktree; the sandbox hides it, and "not permitted" is an error where "not found" is
 * not (live suite: cargo failed in a crate without `[workspace]`). These are the committed
 * files the worktree already holds (apply requires a clean main checkout), so the sandbox may
 * show them; untracked files there (.env) stay hidden.
 */
export function trackedRootFiles(root) {
  const out = git(root, ['ls-tree', '-z', 'HEAD'], { check: false }).stdout ?? '';
  return out.split('\0').filter(Boolean).map((e) => /^\d+ (\w+) \w+\t(.*)$/s.exec(e)).filter((m) => m && m[1] === 'blob').map((m) => m[2]);
}
