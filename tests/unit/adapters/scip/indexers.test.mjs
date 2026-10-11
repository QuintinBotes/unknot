import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInternalArgv } from '../../../../runtime/broker/broker.mjs';
import { DEFAULT_MEMORY_MB, DEFAULT_TIMEOUT_MS, INDEXERS, indexerArgv, indexersForPaths, indexersForSourcePaths, pinnedIndexerInvocation, presentLanguages, projectMarker, runBudgets } from '../../../../adapters/semantic/scip/indexers.mjs';

const row = (language) => INDEXERS.find((entry) => entry.language === language);

test('the table maps each maintained indexer marker to its language row', () => {
  const cases = [
    ['app.sln', 'csharp'], ['web/tsconfig.json', 'typescript'], ['pom.xml', 'java'],
    ['pyproject.toml', 'python'], ['go.mod', 'go'], ['Cargo.toml', 'rust'],
    ['Gemfile', 'ruby'], ['compile_commands.json', 'cpp'], ['pubspec.yaml', 'dart'],
    ['composer.json', 'php'],
  ];
  for (const [marker, language] of cases) {
    const rows = indexersForPaths([marker]);
    assert.ok(rows.some((entry) => entry.language === language), `${marker} → ${language}`);
  }
  assert.deepEqual(indexersForPaths(['package.json'], { languages: ['javascript'] }).map((entry) => entry.language), ['typescript']);
  assert.deepEqual(indexersForPaths(['package.json'], { languages: ['python'] }), []);
  assert.deepEqual(indexersForSourcePaths(['src/a.py', 'src/B.cs']).map((entry) => entry.language), ['csharp', 'python']);
  assert.equal(projectMarker(row('python'), ['src/a.py']), null);
  const files = new Map([['src/a.ts', { language: 'typescript' }], ['src/a.js', { language: 'javascript' }]]);
  assert.deepEqual(presentLanguages(row('typescript'), files), ['typescript', 'javascript']);
});

test('the broker accepts only a complete pinned registry argv', () => {
  for (const entry of INDEXERS) {
    const argv = indexerArgv(entry, `/private/tmp/${entry.language}.scip`);
    assert.equal(checkInternalArgv(argv), null, argv.join(' '));
    assert.deepEqual(pinnedIndexerInvocation(argv), { entry, output: `/private/tmp/${entry.language}.scip` });
    for (const extra of ['--exec=sh', '--post-renderer=./tool', '--unexpected']) {
      assert.equal(typeof checkInternalArgv([...argv, extra]), 'string', `${entry.executable} ${extra}`);
    }
  }
  assert.equal(pinnedIndexerInvocation(['scip-typescript', 'index', '--output', 'index.txt']), null);
});

test('per-indexer time and memory budgets default and clamp', () => {
  assert.deepEqual(runBudgets({}), { timeoutMs: DEFAULT_TIMEOUT_MS, memoryMb: DEFAULT_MEMORY_MB });
  assert.deepEqual(runBudgets({ timeout_ms: 1, memory_mb: 1 }), { timeoutMs: 1000, memoryMb: 128 });
  assert.deepEqual(runBudgets({ timeout_ms: 99_999_999, memory_mb: 99_999 }), { timeoutMs: 1_800_000, memoryMb: 16_384 });
});

test('a document with an empty language takes it from its extension in the table', async () => {
  const { documentLanguage } = await import('../../../../adapters/semantic/scip/indexers.mjs');
  // scip-typescript 0.4 writes every document with language "".
  assert.equal(documentLanguage({ relative_path: 'src/x.ts', language: '' }), 'typescript');
  assert.equal(documentLanguage({ relative_path: 'lib/a.mjs', language: '' }), 'javascript');
  assert.equal(documentLanguage({ relative_path: 'App.kt', language: '' }), 'kotlin');
  assert.equal(documentLanguage({ relative_path: 'a.cs', language: 'CSharp' }), 'csharp');
  assert.equal(documentLanguage({ relative_path: 'README', language: '' }), '');
  for (const entry of INDEXERS) {
    for (const language of Object.values(entry.extensions)) assert.ok(entry.languages.includes(language), `${entry.language} row maps an extension to ${language}`);
  }
});
