// Git history mining: parse `git log --numstat` output into commits, then derive change
// coupling (CodeScene-style degree of coupling), churn and ownership shares from them
// (spec §15A.3, research §2.2.2). Pure functions over text and commit objects: running git
// is the caller's job.
//
// Privacy (spec §21.3): author identity is reduced to a sha256 of the lowercased email at
// parse time. The email itself is never stored or returned, and nothing here ranks people;
// ownership shares exist only so a caller can map hashes to teams.

import { createHash } from 'node:crypto';

const RS = '\x1e';
const US = '\x1f';

/**
 * Arguments for `git` (without the leading "git"). `core.quotepath=false` keeps non-ASCII
 * paths unquoted; `-M` makes renames show as `a => b`; the record/unit separators cannot
 * appear in a hash, timestamp or email, so parsing is unambiguous.
 */
export const GIT_LOG_ARGS = Object.freeze([
  '-c', 'core.quotepath=false',
  'log', '--no-merges', '--numstat', '-M',
  `--format=%x1e%H%x1f%ct%x1f%ae`,
]);

/** The only form in which an author identity leaves this module. */
export function hashAuthor(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

/**
 * Resolve numstat rename notation to the new path: `a => b`, `dir/{a => b}/c`,
 * `{ => b}/c` and `{a => }/c` (an empty side collapses its slash).
 */
export function resolveRename(raw) {
  const brace = raw.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/');
  const plain = raw.indexOf(' => ');
  return plain === -1 ? raw : raw.slice(plain + 4);
}

/**
 * Parse the output of `git ${GIT_LOG_ARGS}`. Binary files report `-` counts and are kept
 * with 0/0 lines (they still count as a touched file). Malformed lines are skipped.
 * @returns {{ sha:string, time:number, author:string, files:{path:string, added:number, deleted:number}[] }[]}
 */
export function parseGitLog(text) {
  const commits = [];
  for (const chunk of String(text).split(RS)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const [sha, ct, email = ''] = lines[0].split(US);
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha.trim())) continue;
    const files = [];
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push({ path: resolveRename(m[3]), added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) });
    }
    commits.push({ sha: sha.trim(), time: Number(ct), author: hashAuthor(email), files });
  }
  return commits;
}

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** Unique paths of a commit that pass the filter, in sorted order. */
function touched(commit, pathFilter) {
  const set = new Set();
  for (const f of commit.files) if (!pathFilter || pathFilter(f.path)) set.add(f.path);
  return [...set].sort();
}

/**
 * Change coupling. Commits touching more than `maxChangeset` files (before path filtering:
 * a mass reformat is a mass reformat whatever you look at) are ignored and counted. For a
 * pair, degree = shared / ((rev_a + rev_b) / 2); pairs below `minSharedCommits` or
 * `minDegree` are dropped. Pairs sort by degree, shared, then path, so output is stable.
 * Cost is O(sum of k^2) over commits with k <= maxChangeset files.
 */
export function coChange(commits, { maxChangeset = 50, minSharedCommits = 10, minDegree = 0, pathFilter } = {}) {
  const revisions = new Map();
  const shared = new Map();
  let ignoredCommits = 0;
  let consideredCommits = 0;
  for (const c of commits) {
    if (new Set(c.files.map((f) => f.path)).size > maxChangeset) { ignoredCommits++; continue; }
    const paths = touched(c, pathFilter);
    if (!paths.length) continue;
    consideredCommits++;
    for (const p of paths) revisions.set(p, (revisions.get(p) ?? 0) + 1);
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = `${paths[i]}\0${paths[j]}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs = [];
  for (const [key, n] of shared) {
    if (n < minSharedCommits) continue;
    const [a, b] = key.split('\0');
    const degree = n / ((revisions.get(a) + revisions.get(b)) / 2);
    if (degree >= minDegree) pairs.push({ a, b, shared: n, degree });
  }
  pairs.sort((x, y) => y.degree - x.degree || y.shared - x.shared || cmp(x.a, y.a) || cmp(x.b, y.b));
  return { revisions, pairs, ignoredCommits, consideredCommits, options: { maxChangeset, minSharedCommits, minDegree } };
}

/** Per-path commit count, lines added/deleted and the latest commit time. */
export function churn(commits) {
  const out = new Map();
  for (const c of commits) {
    const seen = new Set();
    for (const f of c.files) {
      let e = out.get(f.path);
      if (!e) out.set(f.path, (e = { commits: 0, added: 0, deleted: 0, last_time: 0 }));
      if (!seen.has(f.path)) { e.commits++; seen.add(f.path); }
      e.added += f.added;
      e.deleted += f.deleted;
      if (c.time > e.last_time) e.last_time = c.time;
    }
  }
  return out;
}

/**
 * Share of each path's commits per author hash (shares sum to 1). For mapping hashes onto
 * teams to compute ownership alignment; never to rank individuals.
 */
export function ownershipShares(commits) {
  const counts = new Map();
  for (const c of commits) {
    for (const p of new Set(c.files.map((f) => f.path))) {
      if (!counts.has(p)) counts.set(p, new Map());
      const m = counts.get(p);
      m.set(c.author, (m.get(c.author) ?? 0) + 1);
    }
  }
  const out = new Map();
  for (const [p, m] of counts) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    out.set(p, new Map([...m].sort((x, y) => cmp(x[0], y[0])).map(([h, n]) => [h, n / total])));
  }
  return out;
}

/**
 * Co-change between groups (modules, packages, candidates). Without `commits` the result
 * is file-pair level: `weight` sums the shared counts of cross-group file pairs and
 * `maxDegree` is the strongest file pair. With the original `commits` it is commit level
 * and exact: `shared` is commits touching both groups (same changeset filter as the input
 * result), `degree` = shared / ((rev_a + rev_b) / 2). Group-internal co-change is tallied
 * in `internal`; groups mapping to null are dropped.
 */
export function aggregate(coChangeResult, groupFn, { commits } = {}) {
  const pairs = new Map();
  const internal = new Map();
  const groupRevisions = new Map();
  const bump = (map, key, by, init) => { const e = map.get(key) ?? init(); by(e); map.set(key, e); };
  const finish = () => [...pairs.values()].sort((x, y) => (y.degree ?? y.weight) - (x.degree ?? x.weight) || cmp(x.a, y.a) || cmp(x.b, y.b));

  if (commits) {
    const { maxChangeset } = coChangeResult.options;
    for (const c of commits) {
      if (new Set(c.files.map((f) => f.path)).size > maxChangeset) continue;
      const groups = [...new Set(c.files.map((f) => groupFn(f.path)).filter((g) => g != null))].sort();
      for (const g of groups) groupRevisions.set(g, (groupRevisions.get(g) ?? 0) + 1);
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          bump(pairs, `${groups[i]}\0${groups[j]}`, (e) => { e.shared++; }, () => ({ a: groups[i], b: groups[j], shared: 0 }));
        }
      }
    }
    for (const p of pairs.values()) p.degree = p.shared / ((groupRevisions.get(p.a) + groupRevisions.get(p.b)) / 2);
  }

  for (const { a, b, shared, degree } of coChangeResult.pairs) {
    const ga = groupFn(a);
    const gb = groupFn(b);
    if (ga == null || gb == null) continue;
    if (ga === gb) { internal.set(ga, (internal.get(ga) ?? 0) + shared); continue; }
    if (commits) continue;
    const [x, y] = ga < gb ? [ga, gb] : [gb, ga];
    bump(pairs, `${x}\0${y}`, (e) => { e.weight += shared; e.filePairs++; e.maxDegree = Math.max(e.maxDegree, degree); }, () => ({ a: x, b: y, weight: 0, filePairs: 0, maxDegree: 0 }));
  }
  return { pairs: finish(), internal, groupRevisions: commits ? groupRevisions : null };
}
