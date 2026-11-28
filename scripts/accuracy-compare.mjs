#!/usr/bin/env node
// Prints the change between two accuracy reports as Markdown: precision, factual accuracy and
// seeded recall, overall and per detector. A missing or unreadable previous report is not an
// error; the output says there is nothing to compare with and the exit status is 0.
//
// With --gate (the release gate, #247) it also judges each detector against GATE in
// scripts/lib/accuracy-compare.mjs and exits 1 on a precision or seeded-recall drop that the
// explanations file (default corpus/accuracy-explained.json) does not explain for this release.
//
// Usage: node scripts/accuracy-compare.mjs <previous accuracy.json> <current accuracy.json>
//          [--gate [--explained FILE]]

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkExplanations, compareReports, gateReports, renderComparison, renderGate } from './lib/accuracy-compare.mjs';

const args = process.argv.slice(2);
const gi = args.indexOf('--gate');
const gate = gi >= 0;
if (gate) args.splice(gi, 1);
const ei = args.indexOf('--explained');
const explainedPath = ei < 0 ? fileURLToPath(new URL('../corpus/accuracy-explained.json', import.meta.url)) : args.splice(ei, 2)[1];
const [prevPath, curPath] = args;
if (!prevPath || !curPath || args.length > 2 || !explainedPath) {
  process.stderr.write('usage: node scripts/accuracy-compare.mjs <previous accuracy.json> <current accuracy.json> [--gate [--explained FILE]]\n');
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
if (gate) {
  let explanations = [];
  try {
    if (existsSync(explainedPath)) explanations = checkExplanations(JSON.parse(readFileSync(explainedPath, 'utf8')));
  } catch (err) {
    process.stderr.write(`cannot read the explanations ${explainedPath}: ${err.message}\n`);
    process.exit(2);
  }
  const result = gateReports(previous, current, explanations);
  process.stdout.write(`\n${renderGate(result)}`);
  if (!result.ok) process.exitCode = 1;
}
