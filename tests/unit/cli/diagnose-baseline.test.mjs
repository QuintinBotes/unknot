// `diagnose --baseline <ref> --json --fail-on new:<severity>` (#101): only the findings the tree adds
// to its base, matched by fingerprint, each with id, kind, severity, location and evidence; a gate
// exit code; the base mapped in its own worktree and store, leaving the project's findings alone.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-base-home-'));
process.env.UNKNOT_HOME = home;
const { openProject } = await import('../../../runtime/context.mjs');
const { recordAcceptedConfig } = await import('../../../runtime/policy/config.mjs');
const { closeAllStores } = await import('../../../runtime/state/store.mjs');
const { standsFor } = await import('../../../runtime/diagnose/baseline.mjs');
const { digest } = await import('../../../runtime/core/canonical.mjs');
const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
const cyclePair = (dir, a, b) => {
  writeFileSync(join(dir, `src/${a}.js`), `import { ${b} } from './${b}.js';\nexport const ${a} = () => ${b};\n`);
  writeFileSync(join(dir, `src/${b}.js`), `import { ${a} } from './${a}.js';\nexport const ${b} = () => ${a};\n`);
};

/** A repository whose `main` holds one import cycle (a ↔ b), checked out on a branch that `change`s it. */
function fixture(change) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uk-base-proj-')));
  gitIn(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  cyclePair(dir, 'a', 'b');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'base');
  gitIn(dir, 'checkout', '-qb', 'change');
  change(dir);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'change');
  mkdirSync(join(dir, '.unknot'));
  return dir;
}
const addsCycle = () => fixture((dir) => cyclePair(dir, 'c', 'd'));
const addsNothing = () => fixture((dir) => writeFileSync(join(dir, 'NOTES.md'), '# notes\n'));

const unknot = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args, '--cwd', dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } });
const cycles = (findings) => findings.filter((f) => f.kind === 'module.dependency-cycle').map((f) => f.scope.join(','));

test('--baseline --json lists only the findings new in the tree, each with id, kind, severity, location and evidence', () => {
  const dir = addsCycle();
  const r = unknot(dir, 'diagnose', '--baseline', 'main', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schema_version, '1.0');
  assert.equal(out.baseline.ref, 'main');
  assert.equal(out.baseline.commit, gitIn(dir, 'rev-parse', 'main'));
  assert.deepEqual(cycles(out.findings), ['src/c.js,src/d.js']);
  const [f] = out.findings;
  assert.match(f.id, /^F-\d{4}$/);
  assert.equal(f.severity, 'high');
  assert.match(f.location, /^src\/[cd]\.js/);
  assert.ok(f.evidence.length > 0);
  // The project's own findings still hold the base cycle: the base map went to its own store.
  const all = JSON.parse(unknot(dir, 'diagnose', '--json').stdout);
  assert.deepEqual(cycles(all.findings).sort(), ['src/a.js,src/b.js', 'src/c.js,src/d.js']);
  // The base worktree is gone again.
  assert.equal(gitIn(dir, 'worktree', 'list').split('\n').length, 1);
});

test('--fail-on new:high exits non-zero when the tree adds a high-severity finding', () => {
  const r = unknot(addsCycle(), 'diagnose', '--baseline', 'main', '--fail-on', 'new:high', '--json');
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.fail_on, 'new:high');
  assert.equal(out.failed, true);
  assert.deepEqual(cycles(out.findings), ['src/c.js,src/d.js']);
});

test('--fail-on new:high exits zero for a change that adds no finding, though the base has one', () => {
  const r = unknot(addsNothing(), 'diagnose', '--baseline', 'main', '--fail-on', 'new:high', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.failed, false);
  assert.deepEqual(out.findings, []);
  assert.ok(out.baseline.findings >= 1);
});

test('without --baseline, --json prints every finding of the scope, with severity and location', () => {
  const dir = addsCycle();
  assert.equal(unknot(dir, 'map').status, 0);
  const r = unknot(dir, 'diagnose', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schema_version, '1.0');
  assert.deepEqual(cycles(out.findings).sort(), ['src/a.js,src/b.js', 'src/c.js,src/d.js']);
  assert.ok(out.findings.every((f) => ['low', 'medium', 'high'].includes(f.severity) && typeof f.location === 'string'));
});

test('severity follows the accepted config: a cycle configured low does not fail new:high', () => {
  const dir = addsCycle();
  const text = 'version: 1\nmode: plan\ndiagnose:\n  severity:\n    module.dependency-cycle: low\n';
  writeFileSync(join(dir, '.unknot/config.yaml'), text);
  const ctx = openProject(dir);
  recordAcceptedConfig(ctx, text, 'human:test');
  closeAllStores();
  const r = unknot(dir, 'diagnose', '--baseline', 'main', '--fail-on', 'new:high', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(cycles(out.findings), ['src/c.js,src/d.js']);
  assert.equal(out.findings[0].severity, 'low');
  assert.equal(unknot(dir, 'diagnose', '--baseline', 'main', '--fail-on', 'new:low', '--json').status, 1);
});

test('a base that cannot be mapped exits with its own code and says why', () => {
  const dir = addsCycle();
  const r = unknot(dir, 'diagnose', '--baseline', 'no-such-ref', '--json');
  assert.equal(r.status, 5);
  const out = JSON.parse(r.stdout);
  assert.equal(out.error.code, 'UK_BASELINE_INVALID');
  assert.match(out.error.message, /no-such-ref/);
  const text = unknot(dir, 'diagnose', '--baseline', 'no-such-ref');
  assert.equal(text.status, 5);
  assert.match(text.stderr, /no-such-ref/);
});

test('--fail-on needs --baseline and a known severity', () => {
  const dir = addsCycle();
  assert.equal(unknot(dir, 'map').status, 0);
  for (const args of [['--fail-on', 'new:high'], ['--baseline', 'main', '--fail-on', 'new:severe'], ['--baseline', 'main', '--fail-on=']]) {
    const r = unknot(dir, 'diagnose', ...args, '--json');
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(JSON.parse(r.stdout).error.code, 'UK_SCHEMA_INVALID', args.join(' '));
  }
});

test('the base checkout runs no Git LFS filter, which would need the network', () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, '.gitattributes'), '*.bin filter=lfs\n');
    writeFileSync(join(d, 'x.bin'), 'data\n');
  });
  // A git-lfs that cannot reach its server: a required smudge filter that fails.
  const gitHome = mkdtempSync(join(tmpdir(), 'uk-base-githome-'));
  writeFileSync(join(gitHome, '.gitconfig'), '[filter "lfs"]\n\tsmudge = false\n\tprocess = false\n\trequired = true\n');
  const r = spawnSync(process.execPath, [BIN, 'diagnose', '--baseline', 'HEAD', '--json', '--cwd', dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home, HOME: gitHome } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).findings, []);
});

test('a gate sees new findings a named objective folds out of view; local findings are low by default', () => {
  const dir = fixture((d) => writeFileSync(join(d, 'src/e.js'), 'export const e = 1;\n'));
  const plain = JSON.parse(unknot(dir, 'diagnose', '--baseline', 'main', '--json').stdout);
  const dead = plain.findings.find((f) => f.kind === 'code.dead-code');
  assert.equal(dead.category, 'local');
  assert.equal(dead.severity, 'low');
  const text = 'version: 1\nmode: plan\ndiagnose:\n  severity:\n    local: high\n';
  writeFileSync(join(dir, '.unknot/config.yaml'), text);
  recordAcceptedConfig(openProject(dir), text, 'human:test');
  closeAllStores();
  const r = unknot(dir, 'diagnose', '--baseline', 'main', '--objective', 'decompose', '--fail-on', 'new:high', '--json');
  assert.equal(r.status, 1, r.stdout);
  assert.ok(JSON.parse(r.stdout).findings.some((f) => f.kind === 'code.dead-code'));
});

test('an empty first commit is a base with no findings, not one that cannot be mapped', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uk-base-proj-')));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
  mkdirSync(join(dir, 'src'));
  cyclePair(dir, 'a', 'b');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'first code');
  mkdirSync(join(dir, '.unknot'));
  const r = unknot(dir, 'diagnose', '--baseline', 'HEAD~1', '--fail-on', 'new:high', '--json');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.baseline.findings, 0);
  assert.deepEqual(cycles(out.findings), ['src/a.js,src/b.js']);
});

test('a file that could not be read is reported, as a finding there may be missing', { skip: process.getuid?.() === 0 && 'root reads any file' }, () => {
  const dir = addsCycle();
  chmodSync(join(dir, 'src/c.js'), 0o000);
  const r = unknot(dir, 'diagnose', '--baseline', 'main', '--json');
  chmodSync(join(dir, 'src/c.js'), 0o644);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.baseline.extraction_failures.tree >= 1);
  assert.equal(out.baseline.extraction_failures.base, 0);
});

test('--baseline with an empty value is refused, not ignored', () => {
  const dir = addsCycle();
  const r = unknot(dir, 'diagnose', '--baseline=', '--json');
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error.message, /--baseline needs a ref/);
});

test('a base finding stands for the findings it folded in and its related kinds', () => {
  const fp = (kind, key) => digest({ kind, key });
  const set = standsFor([
    { fingerprint: fp('module.dependency-cycle', 'cycle:a'), key: 'cycle:a', replaces: [fp('module.package-cycle', 'package-cycle:p')] },
    { fingerprint: fp('code.long-function', 'function:f'), key: 'function:f', related_kinds: ['code.complex-function'] },
  ]);
  // A package cycle no longer folded, and a function whose leading aspect changed, are not new.
  assert.ok(set.has(fp('module.package-cycle', 'package-cycle:p')));
  assert.ok(set.has(fp('code.complex-function', 'function:f')));
  assert.equal(set.size, 4);
});

test('a base checkout that fails exits 5 with the reason', () => {
  const dir = fixture((d) => {
    writeFileSync(join(d, '.gitattributes'), '*.bin filter=vault\n');
    writeFileSync(join(d, 'x.bin'), 'data\n');
  });
  const gitHome = mkdtempSync(join(tmpdir(), 'uk-base-githome-'));
  writeFileSync(join(gitHome, '.gitconfig'), '[filter "vault"]\n\tsmudge = false\n\trequired = true\n');
  const r = spawnSync(process.execPath, [BIN, 'diagnose', '--baseline', 'HEAD', '--json', '--cwd', dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home, HOME: gitHome } });
  assert.equal(r.status, 5, r.stdout + r.stderr);
  const { error } = JSON.parse(r.stdout);
  assert.equal(error.code, 'UK_BASELINE_INVALID');
  assert.match(error.message, /could not be mapped/);
});

test('a project below the repository root is compared at the same directory; a base without it has no findings', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uk-base-proj-')));
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# mono\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'base');
  mkdirSync(join(dir, 'svc/src'), { recursive: true });
  cyclePair(join(dir, 'svc'), 'a', 'b');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'service');
  mkdirSync(join(dir, 'svc/.unknot'));
  const svc = join(dir, 'svc');
  const before = unknot(svc, 'diagnose', '--baseline', 'HEAD~1', '--json');
  assert.equal(before.status, 0, before.stdout + before.stderr);
  assert.equal(JSON.parse(before.stdout).baseline.findings, 0);
  assert.deepEqual(cycles(JSON.parse(before.stdout).findings), ['src/a.js,src/b.js']);
  const same = JSON.parse(unknot(svc, 'diagnose', '--baseline', 'HEAD', '--json').stdout);
  assert.deepEqual(cycles(same.findings), []);
});
