import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { detect } from '../../../runtime/cli/commands/init.mjs';
import { discover, forbiddenCommand, guidanceFor, parseGuidance } from '../../../runtime/core/guidance.mjs';

function repo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uk-guid-'));
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CI_EXCEPTION = [
  '# Rules',
  '',
  '## Validating changes',
  '',
  '- Validate with `make build`.',
  '',
  '## Exception: ci-bot',
  '',
  'In the sandbox a local `make build` will only fail there.',
  '',
  '## Hygiene',
  '',
  '- Do not use `make test-all`.',
  '',
].join('\n');

test('a consequence in a scoped section is not a prohibition: the required command stays a command', () => {
  repo({ 'AGENTS.md': CI_EXCEPTION }, (dir) => {
    const g = guidanceFor(dir, 'src/x.ts');
    assert.deepEqual(g.commands.map((c) => c.command), ['make build']);
    assert.ok(!g.forbidden_commands.some((f) => f.prefix === 'make build'));
    assert.equal(forbiddenCommand(g, ['make', 'build']), null);
    assert.deepEqual(g.forbidden_commands.map((f) => f.prefix), ['make test-all']);
    assert.equal(forbiddenCommand(g, ['make', 'test-all']).prefix, 'make test-all');
  });
});

test('a prohibition under a heading or in a sentence scoped to an actor is recorded with its scope and not enforced', () => {
  const doc = parseGuidance([
    '## Exception: ci-bot sandbox',
    '',
    'Do not run `make lint` here.',
    '',
    '## Other',
    '',
    'If you are the release bot, never run `make docs`.',
    'Never run `make seed` in CI.',
    'Never run `make wipe`.',
    '',
  ].join('\n'), 'AGENTS.md');
  const by = Object.fromEntries(doc.forbiddenCommands.map((f) => [f.prefix, f]));
  assert.deepEqual(by['make lint'].scope, { actor: 'ci-bot sandbox' });
  assert.equal(by['make lint'].enforced, false);
  assert.ok(by['make docs'].scope.actor);
  // A scope is read from the start of a sentence only: "never run X in CI" may mean anywhere, so it is enforced.
  assert.equal(by['make seed'].enforced, true);
  assert.equal(by['make wipe'].enforced, true);
  assert.equal(by['make wipe'].scope, undefined);
  const g = { forbidden_commands: doc.forbiddenCommands };
  assert.equal(forbiddenCommand(g, ['make', 'lint']), null);
  assert.ok(forbiddenCommand(g, ['make', 'wipe']));
});

test('prohibition phrasing: imperatives and stated bans count, descriptions and purposes do not', () => {
  const doc = parseGuidance([
    '- Do not run `make a`.',
    "- Don't use `make b`.",
    '- Never `make c`.',
    '- `make d` is forbidden.',
    '- `make e` is not allowed.',
    '- Avoid `make f`.',
    '- `make g` will only fail on the build agent.',
    '- The sandbox cannot run `make h`.',
    '- Use the cache to avoid `make i` runs.',
    '- `make j` will never finish quickly.',
    '',
  ].join('\n'), 'AGENTS.md');
  assert.deepEqual(doc.forbiddenCommands.map((f) => f.prefix), ['make a', 'make b', 'make c', 'make d', 'make e', 'make f']);
});

test('a genuine "never run" stays forbidden, repository-wide', () => {
  const doc = parseGuidance('# Hygiene\n\nNever run `make clean`.\n\n- Never run `rm -rf build`.\n', 'AGENTS.md');
  assert.equal(doc.forbiddenCommands[0].enforced, true);
  assert.ok(forbiddenCommand({ forbidden_commands: doc.forbiddenCommands }, ['make', 'clean']));
  // A destructive command shape is dropped and reported, as before: guidance text that runs one is not trusted.
  assert.ok(doc.flagged.some((f) => /rm -rf build/.test(f.excerpt)) || doc.conventions.some((c) => /rm -rf build/.test(c.text)));
});

test('a command the guidance requires and forbids repository-wide is flagged with both sources, not enforced', () => {
  repo({ 'AGENTS.md': '## Validating changes\n\n- Run `make build`.\n\n## Rules\n\n- Never run `make build` on the whole tree.\n- Do not use `make test-all`.\n' }, (dir) => {
    const g = guidanceFor(dir, 'a.ts');
    const rule = g.forbidden_commands.find((f) => f.prefix === 'make build');
    assert.equal(rule.enforced, false);
    assert.equal(rule.conflict.required_by.command, 'make build');
    const flag = g.flagged.find((f) => f.kind === 'conflict');
    assert.equal(flag.required.line, 3);
    assert.equal(flag.forbidden.line, 7);
    assert.equal(forbiddenCommand(g, ['make', 'build']), null);
    assert.ok(forbiddenCommand(g, ['make', 'test-all']));
  });
});

test('init keeps a command the same file requires, drops one it only forbids, and says what is not enforced', () => {
  repo({
    Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n',
    'AGENTS.md': '## Validating changes\n\n- Run `make build`.\n\n## Rules\n\n- Never run `make build` locally.\n- Do not use `make test`.\n',
  }, (dir) => {
    const { commands, notes } = detect(dir);
    assert.deepEqual(commands.build, ['make', 'build']);
    assert.equal(commands.test_unit, undefined);
    assert.ok(notes.some((n) => /not enforced.*make build/.test(n) && /requires/.test(n)));
  });
  repo({ Makefile: 'build:\n\ttrue\n', 'AGENTS.md': CI_EXCEPTION }, (dir) => {
    assert.deepEqual(detect(dir).commands.build, ['make', 'build']);
  });
});

test('path-triggered rule files apply only to paths their globs match', () => {
  repo({
    '.cursor/rules/api.mdc': '---\ndescription: API\nglobs: src/api/**\nalwaysApply: false\n---\n- Always validate input.\n',
    '.cursor/rules/list.mdc': '---\nglobs:\n  - "src/web/**"\n  - docs/*.md\n---\n- Prefer hooks.\n',
    '.cursor/rules/all.mdc': '---\nalwaysApply: true\n---\n- Keep it small.\n',
    '.github/instructions/py.instructions.md': '---\napplyTo: "**/*.py"\n---\n- Use type hints.\n',
  }, (dir) => {
    const files = (p) => guidanceFor(dir, p).files.map((f) => f.file).sort();
    assert.deepEqual(files('src/api/x.ts'), ['.cursor/rules/all.mdc', '.cursor/rules/api.mdc']);
    assert.deepEqual(files('src/web/y.ts'), ['.cursor/rules/all.mdc', '.cursor/rules/list.mdc']);
    assert.deepEqual(files('tools/a.py'), ['.cursor/rules/all.mdc', '.github/instructions/py.instructions.md']);
    assert.ok(!guidanceFor(dir, 'src/web/y.ts').conventions.some((c) => /validate input/.test(c.text)));
    assert.ok(guidanceFor(dir, 'src/api/x.ts').conventions.some((c) => c.line === 6), 'line numbers count the frontmatter');
  });
});

test('guidanceFor finds guidance by name along the path without walking; the full listing matches', () => {
  repo({
    'AGENTS.md': '- Root rule.\n',
    'a/b/CLAUDE.md': '- Deep rule.\n',
    'a/c/AGENTS.md': '- Sibling rule.\n',
    'node_modules/x/AGENTS.md': '- Vendored.\n',
  }, (dir) => {
    assert.deepEqual(guidanceFor(dir, 'a/b/f.ts').files.map((f) => f.file), ['a/b/CLAUDE.md', 'AGENTS.md']);
    assert.deepEqual(discover(dir, { ancestors: 'a/b/f.ts' }), ['AGENTS.md', 'a/b/CLAUDE.md']);
    assert.deepEqual(discover(dir), ['AGENTS.md', 'a/b/CLAUDE.md', 'a/c/AGENTS.md']);
  });
});

test('a prohibition that mentions CI inside the sentence, or sits under a heading about exception handling, still applies everywhere', () => {
  const g = parseGuidance(['# Rules', '', 'Do not run `make deploy` in CI or locally.', '', '## Exceptions', '', 'Never run `make purge`.', ''].join('\n'), 'AGENTS.md');
  const forbidden = g.forbiddenCommands.filter((c) => c.enforced !== false).map((c) => c.prefix);
  assert.ok(forbidden.includes('make deploy'), JSON.stringify(g.forbiddenCommands));
  assert.ok(forbidden.includes('make purge'), JSON.stringify(g.forbiddenCommands));
});
