// What was mapped: the branch and commit, and how far they are behind their upstream and the
// remote's default branch, from the refs git already has (Unknot never fetches). A map of a
// stale branch is a map of old code; it should say so.

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git } from '../apply/git.mjs';

const out = (root, args) => {
  const r = git(root, args, { check: false });
  return r.status === 0 ? r.stdout.trim() : null;
};
const count = (root, range) => {
  const n = Number(out(root, ['rev-list', '--count', range]));
  return Number.isFinite(n) ? n : null;
};

/** @returns {object|null} null outside a git repository */
export function checkoutState(root) {
  const commit = out(root, ['rev-parse', 'HEAD']);
  if (!commit) return null;
  const branch = out(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = out(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let ahead = null;
  let behind = null;
  if (upstream) {
    const lr = out(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])?.split(/\s+/).map(Number);
    if (lr?.length === 2) [ahead, behind] = lr;
  }
  const remote = upstream?.split('/')[0] ?? 'origin';
  const defaultBranch = out(root, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
  const behindDefault = defaultBranch && defaultBranch !== upstream ? count(root, `HEAD..${defaultBranch}`) : null;
  let fetchedAt = null;
  const gitDir = out(root, ['rev-parse', '--git-common-dir']);
  if (gitDir) {
    try {
      fetchedAt = statSync(join(isAbsolute(gitDir) ? gitDir : join(root, gitDir), 'FETCH_HEAD')).mtime.toISOString();
    } catch {
      // never fetched
    }
  }
  const local = branch && branch !== 'HEAD' ? branch : null;
  const dirty = (out(root, ['status', '--porcelain', '--untracked-files=no']) ?? '').split('\n').filter(Boolean).length;
  return {
    branch: local,
    detached: !local,
    commit,
    upstream,
    ahead,
    behind,
    default_branch: defaultBranch,
    on_default: Boolean(local && defaultBranch && defaultBranch.split('/').slice(1).join('/') === local),
    behind_default: behindDefault,
    dirty_files: dirty,
    fetched_at: fetchedAt,
  };
}

/**
 * A notice when what was mapped may not be what the team works on: a branch other than the
 * default, one behind its upstream or the default, a detached HEAD, uncommitted changes. Null
 * when on the default branch and up to date, or when `expected` names the branch mapped
 * (`unknot map --branch-ok <name>`). A repository with nothing to compare with gets no notice;
 * `checkoutNote` explains that instead.
 */
export function checkoutNotice(s, { expected = null } = {}) {
  if (!s) return null;
  const where = `${s.branch ?? 'a detached HEAD'} at ${s.commit.slice(0, 10)}`;
  const since = s.fetched_at ? ` (as of the last fetch, ${s.fetched_at.slice(0, 10)})` : ' (never fetched, so it may be further behind)';
  const parts = [];
  if (s.detached) parts.push('a detached HEAD, not a branch');
  else if (s.default_branch && !s.on_default && expected !== s.branch) parts.push(`not the default branch (${s.default_branch})`);
  if (s.behind > 0) parts.push(`${s.behind} commit${s.behind === 1 ? '' : 's'} behind ${s.upstream}`);
  if (s.behind_default > 0 && expected !== s.branch) parts.push(`${s.behind_default} commit${s.behind_default === 1 ? '' : 's'} behind ${s.default_branch}`);
  if (s.dirty_files > 0) parts.push(`${s.dirty_files} file${s.dirty_files === 1 ? '' : 's'} with uncommitted changes`);
  if (!parts.length) return null;
  const quiet = s.branch && !s.on_default ? ` If mapping ${s.branch} is intended: unknot map --branch-ok ${s.branch}.` : '';
  return `mapped ${where}: ${parts.join('; ')}${s.behind > 0 || s.behind_default > 0 ? since : ''}. Findings describe that code.${quiet}`;
}

/** Why nothing could be compared, for status, or null. */
export function checkoutNote(s) {
  if (!s) return 'not a git repository: the branch and how current it is are unknown';
  if (s.detached) return null;
  if (!s.upstream && !s.default_branch) return `${s.branch} has no upstream and the remote has no default branch recorded, so whether it is current is unknown`;
  return null;
}
