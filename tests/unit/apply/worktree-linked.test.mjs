import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

after(() => K.cleanup());

test('a linked node_modules is never staged into the slice patch (write-path regression)', () => {
  const p = K.makeProject({ files: { 'package.json': '{"name":"x"}', 'src/a.js': 'export const a = 1;\n', '.gitignore': 'node_modules/\n' } });
  mkdirSync(join(p.dir, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(p.dir, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  const wt = K.worktree.createWorktree(p.ctx, 'UK-9001', p.commit);
  writeFileSync(join(wt.path, 'src/a.js'), 'export const a = 2;\n');
  K.worktree.stagePatch(wt.path, p.commit);
  const staged = K.git(wt.path, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  assert.deepEqual(staged, ['src/a.js']);
});
