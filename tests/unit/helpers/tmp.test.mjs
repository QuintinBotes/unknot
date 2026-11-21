// The shared temp-dir helper removes what tests create, and no test bypasses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../helpers/kernel.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

const HELPER = resolve(REPO_ROOT, 'tests/helpers/tmp.mjs');
const SCRIPT = (body) => `import { mkTmp } from ${JSON.stringify(HELPER)};
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
${body}`;

function run(body, env = {}) {
  const T = mkTmp(join(tmpdir(), 'uk-helpertest-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT(body)], { encoding: 'utf8', env: { ...process.env, TMPDIR: T, ...env } });
  return { T, r, left: () => readdirSync(T).filter((n) => n.startsWith('uk-')) };
}

test('removes directories when the process ends normally', () => {
  const { T, r, left } = run(`mkTmp(join(tmpdir(), 'uk-a-')); mkTmp(join(tmpdir(), 'uk-b-'));`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(left(), []);
  rmSync(T, { recursive: true });
});

test('removes directories when the test run fails part way', () => {
  const { T, r, left } = run(`mkTmp(join(tmpdir(), 'uk-a-')); throw new Error('boom');`);
  assert.notEqual(r.status, 0);
  assert.deepEqual(left(), []);
  rmSync(T, { recursive: true });
});

test('removes a read-only tree, like git objects', () => {
  const { T, r, left } = run(`const d = mkTmp(join(tmpdir(), 'uk-ro-'));
mkdirSync(join(d, 'objects')); writeFileSync(join(d, 'objects', 'x'), 'x');
chmodSync(join(d, 'objects', 'x'), 0o444); chmodSync(join(d, 'objects'), 0o555);`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(left(), []);
  rmSync(T, { recursive: true });
});

test('UNKNOT_KEEP_TMP=1 keeps the directories and prints their paths', () => {
  const { T, r, left } = run(`mkTmp(join(tmpdir(), 'uk-keep-'));`, { UNKNOT_KEEP_TMP: '1' });
  assert.equal(left().length, 1);
  assert.ok(r.stderr.includes(join(T, left()[0])), r.stderr);
  rmSync(T, { recursive: true, force: true });
});

test('removal happens after a subprocess that still uses the directory has exited', () => {
  const { T, r, left } = run(`import { spawnSync } from 'node:child_process';
const d = mkTmp(join(tmpdir(), 'uk-sub-'));
spawnSync(process.execPath, ['-e', 'require("fs").writeFileSync("f", "1")'], { cwd: d });`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(left(), []);
  rmSync(T, { recursive: true });
});

test('no test file calls mkdtemp directly', () => {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'fixtures') walk(p); } else if (e.name.endsWith('.mjs')) files.push(p); } };
  walk(resolve(REPO_ROOT, 'tests'));
  const own = (f) => f.endsWith('tests/helpers/tmp.mjs') || f.endsWith('tests/unit/helpers/tmp.test.mjs');
  const bad = files.filter((f) => !own(f) && /\bmkdtemp(Sync)?\b/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(REPO_ROOT.length + 1));
  assert.deepEqual(bad, [], 'use mkTmp from tests/helpers/tmp.mjs');
});
