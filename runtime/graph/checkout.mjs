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
  return { branch: branch === 'HEAD' ? null : branch, commit, upstream, ahead, behind, default_branch: defaultBranch, behind_default: behindDefault, fetched_at: fetchedAt };
}

/** A notice when the checkout is behind its upstream or the default branch, or null. */
export function checkoutNotice(s) {
  if (!s) return null;
  const where = `${s.branch ?? 'a detached HEAD'} at ${s.commit.slice(0, 10)}`;
  const since = s.fetched_at ? ` (as of the last fetch, ${s.fetched_at.slice(0, 10)})` : ' (never fetched, so it may be further behind)';
  const parts = [];
  if (s.behind > 0) parts.push(`${s.behind} commit${s.behind === 1 ? '' : 's'} behind ${s.upstream}`);
  if (s.behind_default > 0) parts.push(`${s.behind_default} commit${s.behind_default === 1 ? '' : 's'} behind ${s.default_branch}`);
  if (!parts.length) return null;
  return `mapped ${where}, ${parts.join(' and ')}${since}: findings describe that code. Check out and fetch the branch you mean to analyse if this is not it.`;
}
