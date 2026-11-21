// A shallow, too short or missing history is reported as unmeasured, never as no coupling (#78).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as K from '../../helpers/kernel.mjs';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
after(() => K.cleanup());

const CONFIG = 'version: 1\nmode: plan\ndecomposition:\n  min_shared_commits: 3\n';
const file = (group, i) => `src/${group}/f${i}.js`;
const body = (group, i, rev) => `${i ? `import { f${i - 1} } from './f${i - 1}.js';\n` : ''}export const f${i} = () => ${rev};\n`;
const FILES = Object.fromEntries(['orders', 'stock'].flatMap((g) => [0, 1, 2, 3].map((i) => [file(g, i), body(g, i, 0)])));

const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args, '--cwd', dir], { encoding: 'utf8', env: { ...process.env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const git = (dir, ...args) => spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();

/** A project whose files of each group changed together in `commits` further commits. */
function project(commits, { oldFirst = false } = {}) {
  const p = K.makeProject({ files: FILES, config: CONFIG });
  for (let c = 1; c <= commits; c++) {
    for (const g of ['orders', 'stock']) for (const i of [0, 1, 2, 3]) writeFileSync(join(p.dir, file(g, i)), body(g, i, c));
    const date = oldFirst && c === 1 ? { GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' } : {};
    spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qam', `change ${c}`], { cwd: p.dir, env: { ...process.env, ...date } });
  }
  return p;
}
const churnOf = (p, path) => JSON.parse(p.ctx.store.get('SELECT attrs FROM nodes WHERE id = ?', `module:${path}`).attrs).churn_commits;
const decompose = (dir) => JSON.parse(cli(dir, 'decompose', '--json', '--full', '--dry-run').out);

test('scenario 4 and SC-002: enough history gives no notice, and decompose measures co-change', () => {
  const p = project(4);
  const m = cli(p.dir, 'map');
  assert.equal(m.code, 0, m.err);
  assert.doesNotMatch(m.err, /history/i);
  const d = decompose(p.dir);
  assert.ok(d.details.length, 'the fixture has candidates');
  assert.ok(Object.values(d.analyses).every((a) => typeof a.components.evolutionary === 'number' && a.components.evolutionary > 0));
  for (const r of d.details) assert.equal(r.unmeasured, undefined);
});

test('scenarios 1 and 2: a shallow clone is named with the fix, and every record shows co-change as unmeasured', () => {
  const p = project(4);
  writeFileSync(join(p.dir, '.git/shallow'), `${git(p.dir, 'rev-parse', 'HEAD')}\n`);
  assert.equal(git(p.dir, 'rev-parse', '--is-shallow-repository'), 'true');
  const m = cli(p.dir, 'map');
  assert.equal(m.code, 0, m.err);
  assert.match(m.out, /co-change unmeasured/);
  assert.equal(churnOf(p, file('orders', 0)), undefined, 'the boundary commit, which lists every file as added, is no churn');
  assert.equal(JSON.parse(cli(p.dir, 'map', '--json').out).history.co_change_pairs, null);
  assert.match(m.err, /history is shallow/);
  assert.match(m.err, /git fetch --shallow-since=\d{4}-\d{2}-\d{2}/);
  assert.match(m.err, /git fetch --unshallow/);
  const d = decompose(p.dir);
  assert.ok(d.details.length);
  assert.ok(Object.values(d.analyses).every((a) => a.components.evolutionary === 'unmeasured'));
  for (const r of d.details) {
    assert.deepEqual(r.unmeasured, ['evolutionary']);
    assert.ok(r.evidence_gaps.some((g) => /co-change history unmeasured: .*shallow/.test(g)), JSON.stringify(r.evidence_gaps));
    assert.equal(r.candidate.metrics['module.co_change_leak'], undefined, 'never a measured 0');
  }

  // Deepened: the next map measures history and the notice is gone.
  rmSync(join(p.dir, '.git/shallow'));
  const again = cli(p.dir, 'map');
  assert.doesNotMatch(again.err, /history/i);
  assert.ok(decompose(p.dir).details.every((r) => r.unmeasured === undefined));
});

test('scenario 3: a full clone with fewer commits than co-change needs is too short, and unmeasured', () => {
  const p = project(1);
  const m = cli(p.dir, 'map');
  assert.match(m.err, /history is too short: 2 commits touch mapped source files, fewer than the 3 .*min_shared_commits/);
  for (const r of decompose(p.dir).details) assert.deepEqual(r.unmeasured, ['evolutionary']);
});

test('scenario 5: a directory that is not a git repository has no history', () => {
  const p = project(0);
  rmSync(join(p.dir, '.git'), { recursive: true, force: true });
  const m = cli(p.dir, 'map');
  assert.equal(m.code, 0, m.err);
  assert.match(m.err, /no history/);
  for (const r of decompose(p.dir).details) assert.deepEqual(r.unmeasured, ['evolutionary']);
});

test('a clone fetched with --shallow-since before the window start measures the window', () => {
  const p = project(4, { oldFirst: true });
  writeFileSync(join(p.dir, '.git/shallow'), `${git(p.dir, 'rev-list', '--max-parents=1', '--min-parents=1', '--reverse', 'HEAD').split('\n')[0]}\n`);
  assert.equal(git(p.dir, 'rev-parse', '--is-shallow-repository'), 'true');
  const m = cli(p.dir, 'map');
  assert.doesNotMatch(m.err, /history/i);
  assert.ok(decompose(p.dir).details.every((r) => r.unmeasured === undefined));
});

test('commits that touch no mapped source file do not make a history long enough', () => {
  const p = project(0);
  for (let c = 1; c <= 4; c++) {
    writeFileSync(join(p.dir, 'README.md'), `# t ${c}\n`);
    git(p.dir, 'commit', '-qam', `docs ${c}`);
  }
  assert.match(cli(p.dir, 'map').err, /history is too short: 1 commits touch mapped source files, fewer than the 3/);
});
