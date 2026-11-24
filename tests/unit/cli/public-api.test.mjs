// COMPATIBILITY classifies every `unknot --help` command and every skill as public or internal (#97).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../../runtime/cli/main.mjs';

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const compat = readFileSync(root('COMPATIBILITY.md'), 'utf8');
// A line `**Label**: `a`, `b`, ...` lists names.
const names = (label) => {
  const line = compat.split('\n').find((l) => l.startsWith(`**${label}**:`));
  assert.ok(line, `COMPATIBILITY needs a "**${label}**:" line`);
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
};
const classified = (a, b, what, actual) => {
  const listed = [...names(a), ...(b ? names(b) : [])];
  const dup = listed.filter((n, i) => listed.indexOf(n) !== i);
  assert.deepEqual(dup, [], `${what} classified twice`);
  assert.deepEqual(actual.filter((n) => !listed.includes(n)), [], `${what} missing from COMPATIBILITY: classify as public or internal`);
  assert.deepEqual(listed.filter((n) => !actual.includes(n)), [], `${what} in COMPATIBILITY that no longer exist`);
};

test('every command in unknot --help is classified public or internal', () => {
  classified('Public commands', 'Internal commands', 'command', Object.keys(COMMANDS));
});

test('every skill is classified public', () => {
  const skills = readdirSync(root('skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  classified('Public skills', null, 'skill', skills);
});

test('exec, run and daemon are the internal commands', () => {
  assert.deepEqual(names('Internal commands').sort(), ['daemon', 'exec', 'run']);
});
