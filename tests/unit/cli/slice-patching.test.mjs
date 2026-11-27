// `unknot slice patching [path...]` (#166): the read-only query the guard mod asks before an Edit
// or Write. It names the slices in PATCHING with their scope and budget, and which paths their
// scope holds back, judged by the PDP's own scope rules.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanup, git, insertSlice, makeProject, pdp, startTestRun } from '../../helpers/kernel.mjs';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
after(cleanup);

const query = (p, ...args) => {
  const r = spawnSync(process.execPath, [BIN, 'slice', 'patching', '--cwd', p.dir, '--json', '--', ...args], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};

function patchingProject() {
  const p = makeProject({ files: { 'src/a/y.js': 'export const y = 1;\n', 'src/b/x.js': 'export const x = 1;\n' } });
  const wt = join(p.dir, '.unknot', 'worktrees', 'UK-1');
  git(p.dir, 'worktree', 'add', '-q', '-b', 'unknot/UK-1', wt);
  insertSlice(p.ctx, { id: 'UK-1', state: 'PATCHING', body: { scope: { include: ['src/a/**'], exclude: [] }, budgets: { max_changed_files: 3, max_diff_lines: 50 } }, worktree: wt, baseline: p.commit });
  return { p, wt };
}

test('with no slice in PATCHING nothing applies and nothing is held', () => {
  const p = makeProject();
  insertSlice(p.ctx, { id: 'UK-9', state: 'AWAITING_APPROVAL' });
  const r = query(p, join(p.dir, 'src/b.js'));
  assert.deepEqual(r, { patching: [], applies: false, held: [] });
});

test('a path outside the slice scope is held with the slice, its scope and the reason; one inside is not', () => {
  const { p, wt } = patchingProject();
  const r = query(p, join(wt, 'src/b/x.js'), join(wt, 'src/a/y.js'), join(p.dir, 'src/b/x.js'), join(p.dir, 'src/a/y.js'));
  assert.equal(r.applies, true);
  assert.equal(r.patching[0].id, 'UK-1');
  assert.deepEqual(r.patching[0].scope, { include: ['src/a/**'], exclude: [] });
  assert.equal(r.patching[0].budget.max_changed_files, 3);
  assert.equal(r.patching[0].budget.files_left, 3);
  assert.equal(r.patching[0].budget.lines_left, 50);
  assert.deepEqual(r.held.map((h) => [h.path, h.slice, h.rule]), [
    [join(wt, 'src/b/x.js'), 'UK-1', 'scope.slice'],
    [join(p.dir, 'src/b/x.js'), 'UK-1', 'scope.slice'],
  ]);
  assert.match(r.held[0].reason, /src\/b\/x\.js is outside slice UK-1 scope \(include: src\/a\/\*\*/);
});

test('Unknot state in the worktree and paths outside the project follow the PDP', () => {
  const { p, wt } = patchingProject();
  const r = query(p, join(wt, '.unknot/config.yaml'), '/etc/hosts');
  assert.deepEqual(r.held.map((h) => [h.path, h.rule]), [[join(wt, '.unknot/config.yaml'), 'state.protected']]);
});

test("another session's run is not this session's to hold; the owning session's is", () => {
  const { p, wt } = patchingProject();
  const { run } = startTestRun(p, { command: 'apply', mode: 'assist', slice_id: 'UK-1' });
  p.ctx.store.run('UPDATE runs SET session_id = ? WHERE id = ?', 'session-a', run.id);
  const target = join(wt, 'src/b/x.js');
  assert.deepEqual(JSON.parse(raw(p, 'slice', 'patching', '--session', 'session-b', '--', target).stdout).held, []);
  assert.equal(JSON.parse(raw(p, 'slice', 'patching', '--session', 'session-b', '--', target).stdout).applies, false);
  assert.equal(JSON.parse(raw(p, 'slice', 'patching', '--session', 'session-a', '--', target).stdout).held.length, 1);
});

// `--cwd` and `--json` go before any `--`, after which every word is a path.
const raw = (p, ...args) => {
  const at = args.includes('--') ? args.indexOf('--') : args.length;
  return spawnSync(process.execPath, [BIN, ...args.slice(0, at), '--cwd', p.dir, '--json', ...args.slice(at)], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: p.home } });
};
const breakConfig = (p) => writeFileSync(join(p.ctx.paths.base, 'config.yaml'), 'version: 1\nmode: [unclosed\n');

test('a configuration that fails to load does not matter with no slice in PATCHING', () => {
  const p = makeProject();
  breakConfig(p);
  const r = raw(p, 'slice', 'patching', '--', join(p.dir, 'src/b.js'));
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.deepEqual(JSON.parse(r.stdout), { patching: [], applies: false, held: [] });
});

test('a configuration that fails to load with a slice in PATCHING is an error naming the slice', () => {
  const { p, wt } = patchingProject();
  breakConfig(p);
  const r = raw(p, 'slice', 'patching', '--', join(wt, 'src/a/y.js'));
  assert.equal(r.status, 1);
  const { error } = JSON.parse(r.stdout);
  assert.equal(error.code, 'UK_CONFIG_INVALID');
  assert.deepEqual(error.details.patching, ['UK-1']);
});

test('paths after -- are paths, never flags', () => {
  const { p } = patchingProject();
  const r = raw(p, 'slice', 'patching', '--', '--cwd=/', 'src/b/x.js');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  // Both are judged as paths under --cwd; '--cwd=/' did not move the project to /.
  assert.deepEqual(JSON.parse(r.stdout).held.map((h) => [h.path, h.rule]), [['--cwd=/', 'scope.slice'], ['src/b/x.js', 'scope.slice']]);
});

test('the query and status --read-only write nothing to the project', () => {
  const p = makeProject();
  const ignore = join(p.ctx.paths.base, '.gitignore');
  rmSync(ignore);
  assert.equal(raw(p, 'slice', 'patching', '--', 'src/a.js').status, 0);
  assert.equal(raw(p, 'status', '--read-only').status, 0);
  assert.equal(existsSync(ignore), false);
});

test('the shared rule is the one the PDP applies', () => {
  const slice = { id: 'UK-1', risk: 'low', body: { scope: { include: ['src/a/**'] } } };
  assert.equal(pdp.sliceScopeDenial({ config: { protected_paths: [] }, slice, inner: 'src/a/y.js' }), null);
  assert.equal(pdp.sliceScopeDenial({ config: { protected_paths: [] }, slice, inner: 'src/b/x.js' }).rule, 'scope.slice');
});
