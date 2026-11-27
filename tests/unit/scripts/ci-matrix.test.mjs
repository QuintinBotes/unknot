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

// COMPATIBILITY "Tested profile": each row says what CI exercises, checked against its source (#154).
const profile = Object.fromEntries(
  [...(compat.split('## Tested profile')[1] ?? '').split('\n## ')[0].matchAll(/^\| ([^|]+?) \| ([^|]+?) \| [^|]+ \|$/gm)].map((m) => [m[1], m[2]]),
);
const listed = (cell) => cell.split(/,| and /).map((s) => s.trim()).filter(Boolean);

test('the tested profile names exactly the OS and Node.js versions the CI matrix runs', () => {
  assert.deepEqual(listed(profile.OS).sort(), [...matrix.os].sort());
  const ran = [...matrix.node, ...(matrix.include ?? []).map((i) => i.node)].map(String);
  assert.deepEqual(listed(profile['Node.js']).map((s) => s.replace(/ on .*/, '')).sort(), [...new Set(ran)].sort());
  for (const i of matrix.include ?? []) assert.ok(profile['Node.js'].includes(`${i.node} on ${i.os}`), `Node.js row names ${i.node} on ${i.os}`);
});

test('the tested profile names the pinned Claude Code version', () => {
  const pin = readFileSync(root('.github/workflows/ci.yml'), 'utf8').match(/claude-code@(\d+\.\d+\.\d+) plugin validate/)[1];
  assert.equal(profile['Claude Code'], `\`@anthropic-ai/claude-code@${pin}\``);
});

test('the tested profile names the benchmark languages, the release benchmark tier and every mode', () => {
  const shape = JSON.parse(readFileSync(root('tests/fixtures/bench/shape.json'), 'utf8'));
  const names = { ts: 'TypeScript', py: 'Python', cs: 'C#', java: 'Java', go: 'Go' };
  assert.deepEqual(listed(profile['Languages and analysis depth'].split(';')[0]).sort(), Object.keys(shape.languageMix).map((k) => names[k]).sort());
  const tier = readFileSync(root('.github/workflows/release.yml'), 'utf8').match(/scripts\/bench\.mjs --sizes (\w+) --release-gate/)[1];
  assert.equal(profile['Largest repository measured'], `${shape.sizes[tier].toLocaleString('en-US')} files`);
  const modes = JSON.parse(readFileSync(root('schemas/config.schema.json'), 'utf8')).properties.mode.enum;
  assert.deepEqual(listed(profile.Modes), modes);
});
