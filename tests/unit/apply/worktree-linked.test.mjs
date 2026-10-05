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
