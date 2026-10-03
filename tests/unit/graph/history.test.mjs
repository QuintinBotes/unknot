import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  GIT_LOG_ARGS, parseGitLog, resolveRename, coChange, churn, ownershipShares, aggregate, hashAuthor,
} from '../../../runtime/graph/history.mjs';

const RS = '\x1e';
const US = '\x1f';
const sha = (n) => String(n).padStart(40, 'a');
const header = (n, ct, email) => `${RS}${sha(n)}${US}${ct}${US}${email}\n`;

const LOG = [
  `${header(1, 1700000300, 'Alice@Example.com')}\n3\t1\tsrc/a.mjs\n-\t-\tassets/logo.png\n0\t5\tsrc/{old => new}/b.mjs\n2\t0\t{ => lib}/c.mjs\n1\t1\tsrc/{x => }/d.mjs\n4\t4\tdocs/x.md => docs/y.md\n`,
  `${header(2, 1700000200, 'bob@example.com')}\n10\t0\tsrc/a.mjs\n`,
  `${header(3, 1700000100, 'alice@example.com')}\n`,
].join('');

test('GIT_LOG_ARGS is a no-merges numstat log with a parseable format', () => {
  assert.ok(GIT_LOG_ARGS.includes('log') && GIT_LOG_ARGS.includes('--no-merges') && GIT_LOG_ARGS.includes('--numstat'));
  const fmt = GIT_LOG_ARGS.find((a) => a.startsWith('--format='));
  assert.ok(fmt.includes('%H') && fmt.includes('%ct') && fmt.includes('%ae'));
  assert.ok(Object.isFrozen(GIT_LOG_ARGS));
});

test('resolveRename: all numstat rename notations', () => {
  assert.equal(resolveRename('a/b.mjs'), 'a/b.mjs');
  assert.equal(resolveRename('old.mjs => new.mjs'), 'new.mjs');
  assert.equal(resolveRename('src/{old => new}/b.mjs'), 'src/new/b.mjs');
  assert.equal(resolveRename('{ => lib}/c.mjs'), 'lib/c.mjs');
  assert.equal(resolveRename('src/{x => }/d.mjs'), 'src/d.mjs');
  assert.equal(resolveRename('{a => b}'), 'b');
});

test('parseGitLog: commits, binary files, renames, empty commit', () => {
  const commits = parseGitLog(LOG);
  assert.equal(commits.length, 3);
  assert.equal(commits[0].sha, sha(1));
  assert.equal(commits[0].time, 1700000300);
  assert.deepEqual(commits[0].files, [
    { path: 'src/a.mjs', added: 3, deleted: 1 },
    { path: 'assets/logo.png', added: 0, deleted: 0 },
    { path: 'src/new/b.mjs', added: 0, deleted: 5 },
    { path: 'lib/c.mjs', added: 2, deleted: 0 },
    { path: 'src/d.mjs', added: 1, deleted: 1 },
    { path: 'docs/y.md', added: 4, deleted: 4 },
  ]);
  assert.deepEqual(commits[2].files, []);
  assert.deepEqual(parseGitLog(''), []);
});

test('author identity is hashed, case-insensitive, and the email never appears', () => {
  const commits = parseGitLog(LOG);
  assert.equal(commits[0].author, createHash('sha256').update('alice@example.com').digest('hex'));
  assert.equal(commits[0].author, commits[2].author);
  assert.notEqual(commits[0].author, commits[1].author);
  assert.equal(hashAuthor(' Bob@Example.com '), commits[1].author);
  const everything = JSON.stringify([commits, churn(commits), [...ownershipShares(commits)], coChange(commits, { minSharedCommits: 1 })]);
  assert.ok(!/example\.com/i.test(everything));
  assert.ok(!/alice|bob/i.test(everything));
});

/** n commits touching the given file lists, authored by `author`. */
function synth(lists, author = 'h1', t0 = 1000) {
  return lists.map((files, i) => ({ sha: `s${i}`, time: t0 + i, author, files: files.map((path) => ({ path, added: 1, deleted: 0 })) }));
}

test('coChange: degree math, thresholds and ordering', () => {
  // a: 10 revisions, b: 5 revisions, 5 shared => degree 5 / 7.5.
  const lists = [
    ...Array.from({ length: 5 }, () => ['a', 'b']),
    ...Array.from({ length: 5 }, () => ['a']),
    ...Array.from({ length: 4 }, () => ['c', 'd']),
  ];
  const res = coChange(synth(lists), { minSharedCommits: 4 });
  assert.equal(res.revisions.get('a'), 10);
  assert.equal(res.revisions.get('b'), 5);
  assert.deepEqual(res.pairs, [
    { a: 'c', b: 'd', shared: 4, degree: 1 },
    { a: 'a', b: 'b', shared: 5, degree: 5 / 7.5 },
  ]);
  assert.deepEqual(coChange(synth(lists), { minSharedCommits: 5 }).pairs.map((p) => p.a), ['a']);
  assert.deepEqual(coChange(synth(lists), { minSharedCommits: 4, minDegree: 0.9 }).pairs.map((p) => p.a), ['c']);
  assert.equal(coChange(synth(lists)).pairs.length, 0); // default min 10 shared
});

test('coChange: huge commits are ignored and counted; pathFilter applies', () => {
  const huge = Array.from({ length: 51 }, (_, i) => `gen/f${i}`).concat(['a', 'b']);
  const lists = [huge, huge, ['a', 'b'], ['a', 'b'], ['a', 'b', 'skip.lock']];
  const res = coChange(synth(lists), { minSharedCommits: 1, pathFilter: (p) => !p.endsWith('.lock') });
  assert.equal(res.ignoredCommits, 2);
  assert.equal(res.consideredCommits, 3);
  assert.equal(res.revisions.get('a'), 3);
  assert.equal(res.revisions.has('skip.lock'), false);
  assert.equal(res.revisions.has('gen/f0'), false);
  assert.deepEqual(res.pairs, [{ a: 'a', b: 'b', shared: 3, degree: 1 }]);
  const exactly50 = coChange(synth([Array.from({ length: 50 }, (_, i) => `f${i}`)]), { minSharedCommits: 1 });
  assert.equal(exactly50.ignoredCommits, 0);
});

test('coChange: deterministic regardless of commit order', () => {
  const lists = Array.from({ length: 24 }, (_, i) => (i % 2 ? ['x', 'y', 'z'] : ['x', 'y']));
  const a = coChange(synth(lists));
  const b = coChange(synth(lists).reverse());
  assert.deepEqual(a.pairs, b.pairs);
  assert.deepEqual(a.pairs.map((p) => `${p.a}-${p.b}`), ['x-y', 'x-z', 'y-z']);
});

test('churn: commits, lines, last_time', () => {
  const c = churn(parseGitLog(LOG));
  assert.deepEqual(c.get('src/a.mjs'), { commits: 2, added: 13, deleted: 1, last_time: 1700000300 });
  assert.deepEqual(c.get('assets/logo.png'), { commits: 1, added: 0, deleted: 0, last_time: 1700000300 });
});

test('ownershipShares: shares per path sum to 1', () => {
  const commits = synth([['f'], ['f'], ['f', 'g']], 'h1').concat(synth([['f']], 'h2'));
  const shares = ownershipShares(commits);
  assert.deepEqual([...shares.get('f')], [['h1', 0.75], ['h2', 0.25]]);
  assert.deepEqual([...shares.get('g')], [['h1', 1]]);
});

test('aggregate: file-pair level and exact commit level', () => {
  const lists = [
    ...Array.from({ length: 4 }, () => ['p/a', 'p/b', 'q/x']),
    ...Array.from({ length: 2 }, () => ['p/a', 'p/b']),
    ...Array.from({ length: 2 }, () => ['q/x', 'r/z']),
  ];
  const commits = synth(lists);
  const res = coChange(commits, { minSharedCommits: 1 });
  const group = (p) => p.split('/')[0];

  const approx = aggregate(res, group);
  assert.equal(approx.internal.get('p'), 6);
  const pq = approx.pairs.find((x) => x.a === 'p' && x.b === 'q');
  // p/a-q/x and p/b-q/x each shared 4 commits; p/a-q/x degree = 4 / ((6 + 6) / 2).
  assert.deepEqual([pq.weight, pq.filePairs, pq.maxDegree], [8, 2, 4 / 6]);

  const exact = aggregate(res, group, { commits });
  const pqe = exact.pairs.find((x) => x.a === 'p' && x.b === 'q');
  // p: 6 commits, q: 6 commits, shared 4 => 4 / 6.
  assert.deepEqual([pqe.shared, pqe.degree], [4, 4 / 6]);
  assert.deepEqual(exact.pairs.map((x) => `${x.a}-${x.b}`), ['p-q', 'q-r']);
  assert.equal(exact.groupRevisions.get('r'), 2);
});
