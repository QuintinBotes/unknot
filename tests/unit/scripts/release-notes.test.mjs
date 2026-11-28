import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accuracySection, releaseNotes } from '../../../scripts/release-notes.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/release-notes.mjs', import.meta.url));

const LOG = `# Changelog

## [Unreleased]

### Added

- next

## [0.2.0] - 2026-01-02

### Fixed

- two

## [0.1.0] - 2026-01-01

- one
`;

test('release notes: returns exactly the section of the version, with or without v', () => {
  assert.equal(releaseNotes(LOG, '0.2.0'), '### Fixed\n\n- two');
  assert.equal(releaseNotes(LOG, 'v0.1.0'), '- one');
});

test('release notes: a version with no section fails', () => {
  assert.throws(() => releaseNotes(LOG, '0.3.0'), /no section for 0\.3\.0/);
  assert.throws(() => releaseNotes(LOG, '0.2'), /no section/);
});

test('release notes: an empty section fails', () => {
  assert.throws(() => releaseNotes('## [1.0.0] - x\n\n## [0.9.0]\n- a\n', '1.0.0'), /empty/);
});

test('changelog: every version that was never tagged says so', () => {
  const log = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
  const sections = new Map([...log.split(/^## \[/m).slice(1)].map((s) => [s.slice(0, s.indexOf(']')), s]));
  const untagged = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.9'];
  for (const v of untagged) {
    assert.ok(sections.has(v), `no section for ${v}`);
    assert.match(sections.get(v), /_Never tagged:/, `${v} is not marked never tagged`);
  }
});

// Shaped as scripts/accuracy.mjs writes them.
const ACC_JSON = { unknot: '0.2.0', seed: 'unknot-1', sample: 20, quick: true, repositories: [
  { name: 'spring-petclinic', sha: '500158f732419217507c7656904b8e6aa1bcc0d6', language: 'java' },
  { name: 'pocketbase', sha: '5cec579da984436a258602a46a96302fbd31f77c', language: 'go' },
] };
const ACC_MD = `# Unknot accuracy, version 0.2.0

Seed \`unknot-1\`, sample size 20 per repository, quick corpus.

## Repositories

| Repository | Language | Files |
|---|---|---:|
| spring-petclinic | java | 132 |

## Precision overall

| | Labelled | True | Wrong | Not worth | Unlabelled | Precision | Factual |
|---|---:|---:|---:|---:|---:|---:|---:|
| all | 30 | 12 | 9 | 9 | 10 | 40% | 70% |

## Precision by detector

| | Labelled | True | Wrong | Not worth | Unlabelled | Precision | Factual |
|---|---:|---:|---:|---:|---:|---:|---:|
| dead-code | 12 | 6 | 3 | 3 | 2 | 50% | 75% |

## Precision by language

| | Labelled | True | Wrong | Not worth | Unlabelled | Precision | Factual |
|---|---:|---:|---:|---:|---:|---:|---:|
| go | 15 | 6 | 5 | 4 | 5 | 40% | 67% |

## Recall by detector (seeded defects)

| | Found | Seeded | Recall |
|---|---:|---:|---:|
| cycle | 2 | 2 | 100% |
`;

test('release notes: the accuracy section carries the corpus, seed and the report tables as written', () => {
  const s = accuracySection(ACC_JSON, ACC_MD);
  assert.match(s, /^## Accuracy\n/);
  assert.match(s, /quick corpus below, seed `unknot-1`, up to 20 findings sampled per repository\. The sample is small and covers only these repositories/);
  assert.match(s, /\| spring-petclinic \| java \| `500158f732419217507c7656904b8e6aa1bcc0d6` \|/);
  assert.match(s, /\| pocketbase \| go \| `5cec579da984436a258602a46a96302fbd31f77c` \|/);
  assert.ok(s.includes('### Precision overall\n\n| | Labelled |'));
  assert.ok(s.includes('| all | 30 | 12 | 9 | 9 | 10 | 40% | 70% |'));
  assert.ok(s.includes('### Precision by detector\n\n| | Labelled |'));
  assert.ok(s.includes('| dead-code | 12 | 6 | 3 | 3 | 2 | 50% | 75% |'));
  assert.ok(s.includes('### Recall by detector (seeded defects)\n\n| | Found |'));
  assert.ok(s.includes('| cycle | 2 | 2 | 100% |'));
  assert.doesNotMatch(s, /Precision by language|## Repositories/, 'only the overall, detector and recall tables');
});

test('release notes: a report without the precision tables fails', () => {
  assert.throws(() => accuracySection(ACC_JSON, '# x\n\n## Precision overall\n\n| a |\n'), /no "Precision by detector" section/);
  assert.throws(() => accuracySection({ ...ACC_JSON, repositories: [] }, ACC_MD), /no repositories/);
});

test('command line: --accuracy appends the section; omitted prints the CHANGELOG only; a directory without a report exits 1', () => {
  const dir = mkTmp(join(tmpdir(), 'uk-notes-'));
  const log = join(dir, 'CHANGELOG.md');
  writeFileSync(log, LOG);
  const run = (...a) => execFileSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(run('v0.2.0', log), '### Fixed\n\n- two\n');
  const empty = mkTmp(join(tmpdir(), 'uk-notes-empty-'));
  assert.throws(() => run('v0.2.0', log, '--accuracy', empty), (e) => e.status === 1 && /no accuracy report in/.test(e.stderr) && e.stdout === '');
  writeFileSync(join(dir, 'accuracy.json'), JSON.stringify(ACC_JSON));
  assert.throws(() => run('v0.2.0', log, '--accuracy', dir), (e) => e.status === 1, 'accuracy.md missing');
  writeFileSync(join(dir, 'accuracy.md'), ACC_MD);
  const out = run('v0.2.0', log, '--accuracy', dir);
  assert.ok(out.startsWith('### Fixed\n\n- two\n\n## Accuracy\n'));
  assert.ok(out.includes('| dead-code | 12 |'));
});
