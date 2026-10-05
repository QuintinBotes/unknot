import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

after(() => K.cleanup());

// `node_modules/` does not match the worktree's symlink; `node_modules` does, and then
// git refuses an exclude pathspec naming it (live-suite regression on a public repository).
for (const [i, ignore] of ['node_modules/\n', 'node_modules\n', ''].entries()) {
  test(`a linked node_modules is never staged into the slice patch (.gitignore ${JSON.stringify(ignore.trim())})`, () => {
    const p = K.makeProject({ files: { 'package.json': '{"name":"x"}', 'src/a.js': 'export const a = 1;\n', ...(ignore && { '.gitignore': ignore }) } });
    mkdirSync(join(p.dir, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(p.dir, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
    const wt = K.worktree.createWorktree(p.ctx, `UK-900${i}`, p.commit);
    writeFileSync(join(wt.path, 'src/a.js'), 'export const a = 2;\n');
    K.worktree.stagePatch(wt.path, p.commit);
    const staged = K.git(wt.path, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
    assert.deepEqual(staged, ['src/a.js']);
  });
}

test('editable Python installs resolve to the worktree, not the main checkout (uv workspace regression)', async () => {
  const { editablePathsFor } = await import('../../../runtime/apply/worktree.mjs');
  const p = K.makeProject();
  const sp = join(p.dir, '.venv/lib/python3.14/site-packages');
  mkdirSync(sp, { recursive: true });
  writeFileSync(join(sp, '_editable_impl_pkg.pth'), `${p.dir}/packages/pkg\n`);
  writeFileSync(join(sp, 'distutils-precedence.pth'), "import os; var = 'x'\n");
  const wt = join(p.dir, '.unknot/worktrees/UK-1');
  assert.deepEqual(editablePathsFor(p.dir, wt), [join(wt, 'packages/pkg')]);
});

test('a slice branch that already exists at another commit is refused, not reused (lane review)', () => {
  const p = K.makeProject({ files: { 'src/a.js': 'export const a = 1;\n' } });
  K.git(p.dir, 'branch', 'unknot/UK-9100');
  K.git(p.dir, 'checkout', '-q', 'unknot/UK-9100');
  writeFileSync(join(p.dir, 'src/a.js'), 'export const a = 1;\nexport const smuggled = 2;\n');
  K.git(p.dir, 'commit', '-qam', 'unapproved');
  K.git(p.dir, 'checkout', '-q', '-');
  assert.throws(() => K.worktree.createWorktree(p.ctx, 'UK-9100', p.commit), (e) => e.code === 'UK_STATE_CONFLICT' && /not the approved baseline/.test(e.message));
  K.git(p.dir, 'branch', 'unknot/UK-9101', p.commit);
  assert.equal(K.worktree.createWorktree(p.ctx, 'UK-9101', p.commit).head, p.commit, 'a branch at the baseline is reused');
});

test('the staged stat measures the patch against the baseline, counting mode changes and renames as additions', () => {
  const p = K.makeProject({ files: { 'src/a.js': 'a\nb\nc\n', 'src/b.sh': 'echo b\n' } });
  const wt = K.worktree.createWorktree(p.ctx, 'UK-9102', p.commit);
  writeFileSync(join(wt.path, 'src/a.js'), 'a\n');
  let s = (K.worktree.stagePatch(wt.path, p.commit), K.worktree.stagedStat(wt.path, p.commit));
  assert.deepEqual([s.files, s.lines, s.added], [1, 2, 0], 'pure deletion');
  K.git(wt.path, 'update-index', '--chmod=+x', 'src/b.sh');
  s = K.worktree.stagedStat(wt.path, p.commit);
  assert.equal(s.added, 1, 'a mode change is not a deletion');
  K.git(wt.path, 'update-index', '--chmod=-x', 'src/b.sh');
  K.git(wt.path, 'mv', 'src/b.sh', 'src/c.sh');
  s = K.worktree.stagedStat(wt.path, p.commit);
  assert.ok(s.added >= 1 && s.paths.includes('src/c.sh'), 'a rename adds the new path');
});
