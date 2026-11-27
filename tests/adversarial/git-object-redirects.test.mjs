// Unknot's git reads only the repository's own objects (#221, hardening #152). A repository can
// redirect what an object id reads as without touching the object: a grafts file rewrites a
// commit's parents, and an alternates file borrows objects from a store an attacker controls.
// Unknot's git ignores grafts and refuses a repository with alternates.

import '../helpers/git-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkTmp } from '../helpers/tmp.mjs';

const { git } = await import('../../runtime/apply/git.mjs');
const { gitHead } = await import('../../runtime/state/runs.mjs');

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function repo(commits) {
  const dir = mkTmp(join(tmpdir(), 'uk-redirect-'));
  g(dir, 'init', '-q');
  for (let i = 0; i < commits; i++) g(dir, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
  return dir;
}

test('a grafts file cannot rewrite a parent for Unknot\'s git', () => {
  const dir = repo(3);
  const [h, real, root] = [g(dir, 'rev-parse', 'HEAD'), g(dir, 'rev-parse', 'HEAD~1'), g(dir, 'rev-parse', 'HEAD~2')];
  writeFileSync(join(dir, '.git/info/grafts'), `${h} ${root}\n`);
  assert.equal(g(dir, 'rev-parse', 'HEAD^'), root, 'plain git follows the graft');
  assert.equal(git(dir, ['rev-parse', 'HEAD^']).stdout.trim(), real);
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).stdout.trim(), '3');
});

test('a repository that borrows objects through alternates is refused, with a way out', () => {
  const evil = repo(1);
  const planted = g(evil, 'rev-parse', 'HEAD');
  const dir = repo(1);
  const alternates = join(dir, '.git/objects/info/alternates');
  writeFileSync(alternates, `${join(evil, '.git/objects')}\n`);
  g(dir, 'cat-file', '-e', planted); // plain git reads the attacker's object
  const refused = (fn) => assert.throws(fn, (e) => e.code === 'UK_INTEGRITY' && e.message.includes(alternates) && /git repack -a -d/.test(e.message));
  refused(() => git(dir, ['cat-file', '-e', planted], { check: false }));
  refused(() => git(dir, ['rev-parse', 'HEAD'], { check: false }));
  // From a subdirectory and from a linked worktree, the store is the same one.
  mkdirSync(join(dir, 'sub'));
  refused(() => git(join(dir, 'sub'), ['status']));
  const wt = join(mkTmp(join(tmpdir(), 'uk-redirect-wt-')), 'wt');
  g(dir, 'worktree', 'add', '-q', '--detach', wt);
  refused(() => git(wt, ['status']));
  // A call site that used to run git directly refuses too.
  refused(() => gitHead(dir));
});
