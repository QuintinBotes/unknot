// With history unmeasured, co-change findings stay open and every re-map path says so (#124, follow-up of #78).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as K from '../../helpers/kernel.mjs';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
after(() => K.cleanup());

const CONFIG = 'version: 1\nmode: plan\ndecomposition:\n  min_shared_commits: 3\n';
const file = (i) => `src/f${i}.js`;
const body = (i, rev) => `${i ? `import { f${i - 1} } from './f${i - 1}.js';\n` : ''}export const f${i} = () => ${rev};\n`;
const FILES = Object.fromEntries([0, 1, 2].map((i) => [file(i), body(i, 0)]));
const NOTICE = /unknot: notice: .*history is shallow/g;

const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args, '--cwd', dir], { encoding: 'utf8', env: { ...process.env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

/** A project with `commits` further commits, shallow (cut at HEAD) or not. */
function project({ shallow }) {
  const p = K.makeProject({ files: FILES, config: CONFIG });
  for (let c = 1; c <= 4; c++) {
    for (const i of [0, 1, 2]) writeFileSync(join(p.dir, file(i)), body(i, c));
    spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qam', `change ${c}`], { cwd: p.dir });
  }
  if (shallow) writeFileSync(join(p.dir, '.git/shallow'), `${K.git(p.dir, 'rev-parse', 'HEAD')}\n`);
  return p;
}

/** An open finding row, as an earlier diagnose left it. */
function seed(p, kind, n) {
  const at = new Date().toISOString();
  const fingerprint = `fp-${kind}-${n}`;
  const id = `F-90${n}`;
  const b = { id, fingerprint, kind, category: 'module', status: 'open', scope: ['src/f0.js'] };
  p.ctx.store.insert('findings', { id, fingerprint, schema_version: '1.0', kind, category: 'module', status: 'open', priority: 0.5, body: b, first_seen_commit: null, last_seen_commit: null, last_run_id: null, created_at: at, updated_at: at });
  return id;
}
const status = (p, id) => p.ctx.store.get('SELECT status FROM findings WHERE id = ?', id).status;
const KINDS = ['decomposition.co-change-leak', 'module.shotgun-surgery'];

test('shallow history: co-change findings stay open with the reason, other findings still resolve', () => {
  const p = project({ shallow: true });
  assert.equal(cli(p.dir, 'map').code, 0);
  const held = KINDS.map((k, n) => seed(p, k, n));
  const other = seed(p, 'module.hub-module', 5);
  const d = cli(p.dir, 'diagnose', '--json');
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(held.map((id) => status(p, id)), ['open', 'open']);
  assert.equal(status(p, other), 'resolved');
  const analysis = JSON.parse(d.out).analysis;
  assert.deepEqual(analysis.held_open.findings.sort(), held.sort());
  assert.match(analysis.held_open.reason, /^history unmeasured: .*shallow/);
  assert.match(cli(p.dir, 'diagnose').out, /left open \(history unmeasured/);
});

test('measured history: a co-change finding that is no longer detected still resolves', () => {
  const p = project({ shallow: false });
  assert.equal(cli(p.dir, 'map').code, 0);
  const id = seed(p, KINDS[0], 0);
  const d = cli(p.dir, 'diagnose', '--json');
  assert.equal(status(p, id), 'resolved');
  assert.equal(JSON.parse(d.out).analysis.held_open, undefined);
});

test('map, workspace map and import each print the shallow-history notice once', () => {
  const p = project({ shallow: true });
  const count = (r) => (r.err.match(NOTICE) ?? []).length;
  assert.equal(count(cli(p.dir, 'map')), 1);

  const root = K.makeProject({ config: `version: 1\nmode: plan\nworkspace:\n  repositories:\n    - name: app\n      path: ${p.dir}\n` });
  const ws = cli(root.dir, 'workspace', 'map');
  assert.equal(ws.code, 0, ws.err);
  assert.equal(count(ws), 1);
  assert.match(ws.err, /notice: app: /);

  writeFileSync(join(p.dir, 'calls.csv'), 'caller,callee,count,window\nsrc/f0.js,src/f1.js,5,P7D\n');
  const im = cli(p.dir, 'import', 'runtime', 'calls.csv');
  assert.equal(im.code, 0, im.err);
  assert.equal(count(im), 1);
});
