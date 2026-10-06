// A map of a branch that is behind says so: against its upstream and the remote's default
// branch, from the refs git already has.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkoutNotice, checkoutState } from '../../../runtime/graph/checkout.mjs';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
const commit = (dir, n) => {
  writeFileSync(join(dir, `f${n}.txt`), `${n}\n`);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', `c${n}`);
};

test('a branch behind its upstream and behind the default branch is reported with both counts', () => {
  const origin = mkdtempSync(join(tmpdir(), 'uk-origin-'));
  g(origin, 'init', '-q');
  commit(origin, 1);
  g(origin, 'switch', '-q', '-c', 'feature');
  commit(origin, 2);
  g(origin, 'switch', '-q', 'main');
  const clone = mkdtempSync(join(tmpdir(), 'uk-clone-'));
  g(clone, 'clone', '-q', origin, '.');
  g(clone, 'switch', '-q', 'feature');
  // The remote moves on; the clone fetches but does not update its branches.
  commit(origin, 3);
  commit(origin, 4);
  g(origin, 'switch', '-q', 'feature');
  commit(origin, 5);
  g(origin, 'switch', '-q', 'main');
  g(clone, 'fetch', '-q');
  const s = checkoutState(clone);
  assert.equal(s.branch, 'feature');
  assert.equal(s.upstream, 'origin/feature');
  assert.equal(s.behind, 1);
  assert.equal(s.default_branch, 'origin/main');
  assert.equal(s.behind_default, 2);
  assert.ok(s.fetched_at);
  assert.match(checkoutNotice(s), /mapped feature at [0-9a-f]{10}: not the default branch \(origin\/main\); 1 commit behind origin\/feature; 2 commits behind origin\/main \(as of the last fetch, \d{4}-\d\d-\d\d\)/);
});

test('an up-to-date checkout, or a directory that is not a repository, gives no notice', () => {
  const repo = mkdtempSync(join(tmpdir(), 'uk-plain-'));
  g(repo, 'init', '-q');
  commit(repo, 1);
  assert.equal(checkoutNotice(checkoutState(repo)), null);
  assert.equal(checkoutState(mkdtempSync(join(tmpdir(), 'uk-norepo-'))), null);
});

test('a feature branch that is not behind still gets a notice, which --branch-ok silences; detached and dirty are reported', () => {
  const origin = mkdtempSync(join(tmpdir(), 'uk-origin2-'));
  g(origin, 'init', '-q');
  commit(origin, 1);
  const clone = mkdtempSync(join(tmpdir(), 'uk-clone2-'));
  g(clone, 'clone', '-q', origin, '.');
  g(clone, 'switch', '-q', '-c', 'topic');
  const s = checkoutState(clone);
  assert.equal(s.on_default, false);
  assert.match(checkoutNotice(s), /mapped topic at [0-9a-f]{10}: not the default branch \(origin\/main\)\. Findings describe that code\. If mapping topic is intended: unknot map --branch-ok topic\./);
  assert.equal(checkoutNotice(s, { expected: 'topic' }), null);
  g(clone, 'switch', '-q', 'main');
  assert.equal(checkoutNotice(checkoutState(clone)), null, 'the default branch, up to date');
  writeFileSync(join(clone, 'f1.txt'), 'changed\n');
  assert.match(checkoutNotice(checkoutState(clone)), /1 file with uncommitted changes/);
  g(clone, 'checkout', '-q', '--', 'f1.txt');
  g(clone, 'checkout', '-q', '--detach');
  const d = checkoutState(clone);
  assert.equal(d.detached, true);
  assert.match(checkoutNotice(d), /a detached HEAD, not a branch/);
});

test('a repository with nothing to compare with gets an explanatory note, not a warning', async () => {
  const { checkoutNote } = await import('../../../runtime/graph/checkout.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'uk-lone-'));
  g(repo, 'init', '-q');
  commit(repo, 1);
  const s = checkoutState(repo);
  assert.equal(checkoutNotice(s), null);
  assert.match(checkoutNote(s), /main has no upstream and the remote has no default branch recorded/);
});
