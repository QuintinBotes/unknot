#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version: node scripts/release-notes.mjs <version> [changelog] [--accuracy DIR]
// Exits 1 with a message when the section is missing or empty, so a release never ships empty notes.
// With --accuracy, appends the tables scripts/accuracy.mjs wrote to DIR (accuracy.json and
// accuracy.md); a DIR without them exits 1, so a release never claims a table it does not have.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// The accuracy.md sections the notes carry, by their headings in scripts/accuracy.mjs; recall is
// absent from a --no-recall run.
const REQUIRED = ['Precision overall', 'Precision by detector'];
const SECTIONS = [...REQUIRED, 'Recall by detector (seeded defects)'];

/** The "Accuracy" section: the corpus it was measured on, then the accuracy.md tables as written. */
export function accuracySection(report, md) {
  const blocks = new Map();
  for (const part of md.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    blocks.set(part.slice(0, nl).trim(), part.slice(nl + 1).trim());
  }
  const missing = REQUIRED.filter((s) => !blocks.has(s));
  if (missing.length) throw new Error(`accuracy.md has no ${missing.map((s) => `"${s}"`).join(', ')} section`);
  const repos = report.repositories ?? [];
  if (!repos.length) throw new Error('accuracy.json lists no repositories');
  const L = [
    '## Accuracy',
    '',
    `Measured by \`scripts/accuracy.mjs\` on this release's commit: the ${report.quick ? 'quick ' : ''}corpus below, seed \`${report.seed}\`, up to ${report.sample} findings sampled per repository. The sample is small and covers only these repositories, so a rate can move by many points between runs; precision counts labelled samples only (see docs/accuracy.md).`,
    '',
    '| Repository | Language | Commit |',
    '|---|---|---|',
    ...repos.map((r) => `| ${r.name} | ${r.language} | \`${r.sha}\` |`),
  ];
  for (const s of SECTIONS) if (blocks.has(s)) L.push('', `### ${s}`, '', blocks.get(s));
  return L.join('\n');
}

export function readAccuracy(dir) {
  const json = join(dir, 'accuracy.json');
  const md = join(dir, 'accuracy.md');
  if (!existsSync(json) || !existsSync(md)) throw new Error(`no accuracy report in ${dir} (needs accuracy.json and accuracy.md)`);
  return accuracySection(JSON.parse(readFileSync(json, 'utf8')), readFileSync(md, 'utf8'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = process.argv.slice(2);
    const i = args.indexOf('--accuracy');
    const dir = i < 0 ? null : args.splice(i, 2)[1];
    if (i >= 0 && !dir) throw new Error('--accuracy needs a directory');
    const [version, file = 'CHANGELOG.md'] = args;
    if (!version) throw new Error('usage: release-notes.mjs <version> [changelog] [--accuracy DIR]');
    const notes = releaseNotes(readFileSync(file, 'utf8'), version);
    process.stdout.write(`${dir ? `${notes}\n\n${readAccuracy(dir)}` : notes}\n`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
