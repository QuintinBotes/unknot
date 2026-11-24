// Slice commits skip the repository's git hooks, so its hook checks run as proof obligations
// through the broker sandbox instead (#98).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';
import { generateObligations } from '../../../runtime/plan/obligations.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';
import { tmpdir } from 'node:os';

after(() => K.cleanup());

const config = K.cfg();
const slice = { kind: 'refactor', budgets: { max_changed_files: 5, max_diff_lines: 100 }, scope: { include: ['src/**'] }, changes: [] };
const risk = { risk: 'low', specialists: [] };
const repo = (files) => {
  const root = mkTmp(join(tmpdir(), 'uk-hooks-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  return root;
};
// A PATH holding fake hook tools, or none, so the tests do not depend on what is installed.
const withPath = (tools, fn) => {
  const bin = mkTmp(join(tmpdir(), 'uk-hookbin-'));
  for (const [name, script] of Object.entries(tools)) { writeFileSync(join(bin, name), script); chmodSync(join(bin, name), 0o755); }
  const saved = process.env.PATH;
  process.env.PATH = [bin, ...(Object.keys(tools).length ? [saved] : [])].join(delimiter);
  try { return fn(bin); } finally { process.env.PATH = saved; }
};
const hookObs = (root) => generateObligations(slice, { config, risk, root }).filter((o) => o.description.startsWith('Repository hook checks'));

describe('hook systems become proof obligations', () => {
  const cases = [
    ['pre-commit', { '.pre-commit-config.yaml': 'repos: []\n' }, ['pre-commit', 'run', '--all-files']],
    ['husky', { '.husky/pre-commit': 'exit 0\n' }, ['sh', '.husky/pre-commit']],
    ['lefthook', { 'lefthook.yml': 'pre-commit:\n  commands: {}\n' }, ['lefthook', 'run', 'pre-commit']],
    ['lefthook', { '.lefthook.yaml': 'pre-commit:\n  commands: {}\n' }, ['lefthook', 'run', 'pre-commit']],
  ];
  for (const [system, files, argv] of cases) {
    test(`${system} (${Object.keys(files)[0]}) adds one command obligation naming it`, () => {
      const obs = withPath({ 'pre-commit': '#!/bin/sh\n', lefthook: '#!/bin/sh\n' }, () => hookObs(repo(files)));
      assert.equal(obs.length, 1);
      assert.deepEqual(obs[0].command, argv);
      assert.match(obs[0].description, new RegExp(system));
      assert.equal(obs[0].requires_human, false);
    });
  }

  test('a repository with all three gets three obligations', () => {
    const obs = hookObs(repo({ '.pre-commit-config.yaml': 'repos: []\n', '.husky/pre-commit': 'exit 0\n', 'lefthook.yml': 'x: 1\n' }));
    assert.equal(obs.length, 3);
  });

  test('a missing tool makes the obligation a person\'s to confirm, and husky is unaffected', () => {
    const obs = withPath({}, () => hookObs(repo({ '.pre-commit-config.yaml': 'repos: []\n', 'lefthook.yml': 'x: 1\n', '.husky/pre-commit': 'exit 0\n' })));
    const by = (sys) => obs.find((o) => o.description.includes(`(${sys})`));
    for (const sys of ['pre-commit', 'lefthook']) {
      assert.equal(by(sys).requires_human, true);
      assert.equal(by(sys).command, null);
      assert.match(by(sys).description, /not installed; a person confirms/);
    }
    assert.equal(by('husky').requires_human, false);
    assert.deepEqual(by('husky').command, ['sh', '.husky/pre-commit']);
  });

  test('a repository without a hook configuration adds none', () => {
    assert.equal(hookObs(repo({ 'README.md': 'x' })).length, 0);
    assert.equal(generateObligations(slice, { config, risk }).filter((o) => o.description.startsWith('Repository hook checks')).length, 0);
  });
});

describe('a hook check runs in the broker sandbox', () => {
  const run = (script) => {
    const p = K.makeProject();
    const root = p.dir;
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, '.husky/pre-commit'), script);
    const [o] = hookObs(root);
    return K.broker.brokerExec(p.ctx, { argv: o.command, cwd: root, origin: 'configured', config, writable: [root] });
  };
  test('a passing hook passes the obligation', async () => {
    assert.equal((await run('exit 0\n')).record.verdict, 'pass');
  });
  test('a failing hook fails the obligation and its output names the check', async () => {
    const r = await run('echo "secret-scan: found a key" >&2\nexit 1\n');
    assert.equal(r.record.verdict, 'fail');
    assert.match(r.stderrTail, /secret-scan/);
  });
});

describe('an installed hook tool runs and its failure fails the obligation', () => {
  const run = (script) => withPath({ 'pre-commit': script }, async () => {
    const p = K.makeProject();
    writeFileSync(join(p.dir, '.pre-commit-config.yaml'), 'repos: []\n');
    const [o] = hookObs(p.dir);
    assert.equal(o.requires_human, false);
    return K.broker.brokerExec(p.ctx, { argv: o.command, cwd: p.dir, origin: 'configured', config, writable: [p.dir] });
  });
  test('a failing fake pre-commit fails', async () => {
    const r = await run('#!/bin/sh\necho "ruff: bad" >&2\nexit 1\n');
    assert.equal(r.record.verdict, 'fail');
    assert.match(r.stderrTail, /ruff/);
  });
  test('a passing fake pre-commit passes', async () => {
    assert.equal((await run('#!/bin/sh\nexit 0\n')).record.verdict, 'pass');
  });
});
