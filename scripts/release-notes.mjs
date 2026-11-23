#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version: node scripts/release-notes.mjs <version> [changelog]
// Exits 1 with a message when the section is missing or empty, so a release never ships empty notes.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseNotes(changelog, version) {
  const v = version.replace(/^v/, '');
  const lines = changelog.split('\n');
  const isHead = (l) => /^## /.test(l);
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${v}`);
  const end = lines.findIndex((l, i) => i > start && isHead(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md section for ${v} is empty`);
  return body;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
    if (!version) throw new Error('usage: release-notes.mjs <version> [changelog]');
    process.stdout.write(releaseNotes(readFileSync(file, 'utf8'), version) + '\n');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
