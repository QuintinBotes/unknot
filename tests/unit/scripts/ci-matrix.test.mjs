// CI tests every Node.js line COMPATIBILITY promises, and the exact engines floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseYAML } from '../../../runtime/core/yaml.mjs';

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const ci = parseYAML(readFileSync(root('.github/workflows/ci.yml'), 'utf8'), { filename: 'ci.yml' });
const matrix = ci.jobs.test.strategy.matrix;
const compat = readFileSync(root('COMPATIBILITY.md'), 'utf8');
const floor = JSON.parse(readFileSync(root('package.json'), 'utf8')).engines.node.replace(/^>=/, '');

// COMPATIBILITY rows: | 22 | 2027-04-30 |  (line, end of its support window)
const lines = [...compat.matchAll(/^\s*\|\s*(\d+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map((m) => ({ line: m[1], ends: m[2] }));
const today = new Date().toISOString().slice(0, 10);
const supported = lines.filter((l) => l.ends >= today).map((l) => l.line);

test('COMPATIBILITY lists the Node.js lines with their window', () => {
  assert.ok(lines.length >= 1, 'COMPATIBILITY needs a Node.js lines table');
});

test('a Node line whose window has ended is named for removal', () => {
  const ended = lines.filter((l) => l.ends < today).map((l) => `Node ${l.line} (ended ${l.ends})`);
  assert.deepEqual(ended, [], 'remove from the CI matrix and COMPATIBILITY');
});

test('the test job runs every supported line on ubuntu and macOS', () => {
  assert.deepEqual([...matrix.os].sort(), ['macos-latest', 'ubuntu-latest']);
  assert.deepEqual([...matrix.node].map(String).sort(), [...supported].sort());
});

test('a test job runs the engines floor exactly, on ubuntu', () => {
  assert.match(floor, /^\d+\.\d+$/, 'engines.node is >=MAJOR.MINOR');
  const exact = `${floor}.0`;
  assert.ok(
    (matrix.include ?? []).some((i) => String(i.node) === exact && i.os === 'ubuntu-latest'),
    `matrix.include needs node ${exact} on ubuntu-latest`,
  );
});
