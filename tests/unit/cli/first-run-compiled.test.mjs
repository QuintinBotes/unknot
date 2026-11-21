// First run on a compiled-language repository (issue #91): init respects guidance and layout,
// doctor checks the toolchain behind the configured commands, status names the CLI install step.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detect } from '../../../runtime/cli/commands/init.mjs';
import { matchAny } from '../../../runtime/core/glob.mjs';
import * as K from '../../helpers/kernel.mjs';

after(() => K.cleanup());

// A committed git repository with these files (the kernel fixture cleans it up).
const repo = (files) => K.makeProject({ files }).dir;

const NET = { 'src/Shop.sln': '', 'src/Orders/Orders.csproj': '<Project/>', 'src/Orders/Order.cs': 'class Order {}' };

test('1. a command the guidance forbids is not proposed, and the proposal says why', () => {
  const d = detect(repo({ ...NET, 'CLAUDE.md': '## Tests\n\nDo not run `dotnet test` on the whole solution.\n' }));
  assert.equal(d.commands.test_unit, undefined);
  assert.ok(d.notes.some((n) => /test_unit not proposed: CLAUDE\.md/.test(n)));
});

test('1b. guidance that forbids a command only for a named bot does not remove it for everyone', () => {
  const d = detect(repo({ ...NET, 'CLAUDE.md': '## Tests\n\nFor the release bot, do not run `dotnet test`.\n' }));
  assert.deepEqual(d.commands.test_unit, ['dotnet', 'test', 'src/Shop.sln']);
});

test('2. a .NET repository excludes bin/ and obj/', () => {
  const d = detect(repo(NET));
  assert.ok(matchAny('src/Orders/bin/Debug/x.dll', d.excludes));
  assert.ok(matchAny('src/Orders/obj/project.assets.json', d.excludes));
  assert.ok(matchAny('bin/x.dll', d.excludes) && matchAny('obj/y', d.excludes));
});

test('3. a tracked build/ folder holding source is not excluded', () => {
  const d = detect(repo({ ...NET, 'build/Build.cs': 'class Build {}' }));
  assert.ok(!matchAny('build/Build.cs', d.excludes));
  assert.ok(d.notes.some((n) => /build\/\*\* is not excluded/.test(n)));
  assert.ok(matchAny('dist/x.js', d.excludes), 'other defaults stay');
});

test('3b. a git-ignored build/ is still excluded', () => {
  const dir = repo({ ...NET, '.gitignore': 'build/\n' });
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build', 'Out.cs'), 'class Out {}');
  assert.ok(matchAny('build/Out.cs', detect(dir).excludes));
});

test('4. a protected path two directories would add is listed once', () => {
  const PIPE = 'trigger:\n  - main\npool:\n  vmImage: ubuntu-latest\nsteps:\n  - script: echo hi\n';
  const d = detect(repo({ ...NET, 'ci/pipelines/a/one.yml': PIPE, 'ci/pipelines/b/two.yml': PIPE }));
  assert.equal(d.protectedPaths.length, new Set(d.protectedPaths).size, d.protectedPaths.join(' '));
});

function cli(p, ...args) {
  return spawnSync(process.execPath, [join(K.REPO_ROOT, 'bin', 'unknot'), ...args, '--json', '--cwd', p.dir], {
    encoding: 'utf8',
    env: { ...process.env, UNKNOT_HOME: p.home },
  });
}

test('5. doctor reports a configured command whose tool is not installed, with the fix', () => {
  const p = K.makeProject({ config: 'version: 1\nmode: plan\ncommands:\n  build: [uk-no-such-tool, build, x.sln]\n  lint: [node, --version]\n' });
  const checks = JSON.parse(cli(p, 'doctor').stdout).checks;
  const c = checks.find((x) => x.name === 'command build');
  assert.equal(c?.level, 'warn');
  assert.match(c.detail, /uk-no-such-tool is not on PATH/);
  assert.match(c.detail, /install/);
  assert.equal(checks.find((x) => x.name === 'command lint'), undefined, 'an installed tool adds no noise');
});

test('6. status includes the CLI install step when the shim is missing, even with nothing else pending', async () => {
  const pub = K.keys.generateApproverKey(`first-${Date.now()}`, 'correct horse battery');
  const key = pub.trim().split('\n').map((l) => `      ${l}`).join('\n');
  const p = K.makeProject({ config: `version: 1\nmode: plan\napprovers:\n  a:\n    roles: [code-owner]\n    public_key: |\n${key}\n` });
  const { run } = await import('../../../runtime/cli/commands/status.mjs');
  const out = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    await run({ flags: { json: true, cwd: p.dir } }, { unknotOnPath: false });
  } finally {
    process.stdout.write = write;
  }
  const status = JSON.parse(out.join(''));
  assert.ok(status.for_you.steps.some((s) => s.step === 'install_cli'), JSON.stringify(status.for_you));
});
