import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { releaseNotes } from '../../../scripts/release-notes.mjs';

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
