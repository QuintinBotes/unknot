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
  assert.match(checkoutNotice(s), /mapped feature at [0-9a-f]{10}, 1 commit behind origin\/feature and 2 commits behind origin\/main \(as of the last fetch, \d{4}-\d\d-\d\d\)/);
});

test('an up-to-date checkout, or a directory that is not a repository, gives no notice', () => {
  const repo = mkdtempSync(join(tmpdir(), 'uk-plain-'));
  g(repo, 'init', '-q');
  commit(repo, 1);
  assert.equal(checkoutNotice(checkoutState(repo)), null);
  assert.equal(checkoutState(mkdtempSync(join(tmpdir(), 'uk-norepo-'))), null);
});
