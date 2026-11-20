#!/usr/bin/env node
// Prints the change between two accuracy reports as Markdown: precision, factual accuracy and
// seeded recall, overall and per detector. A missing or unreadable previous report is not an
// error; the output says there is nothing to compare with and the exit status is 0.
//
// Usage: node scripts/accuracy-compare.mjs <previous accuracy.json> <current accuracy.json>

import { readFileSync } from 'node:fs';
import { compareReports, renderComparison } from './lib/accuracy-compare.mjs';

const [prevPath, curPath] = process.argv.slice(2);
if (!prevPath || !curPath) {
  process.stderr.write('usage: node scripts/accuracy-compare.mjs <previous accuracy.json> <current accuracy.json>\n');
  process.exit(2);
}

let current;
try {
  current = JSON.parse(readFileSync(curPath, 'utf8'));
} catch (err) {
  process.stderr.write(`cannot read the current report ${curPath}: ${err.message}\n`);
  process.exit(2);
}
let previous = null;
try {
  previous = JSON.parse(readFileSync(prevPath, 'utf8'));
} catch { /* first run, expired artifact or unreadable file */ }
process.stdout.write(renderComparison(compareReports(previous, current)));
