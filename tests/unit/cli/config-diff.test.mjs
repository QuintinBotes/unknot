import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { diffConfig, readSources, withoutGuidance } from '../../../runtime/policy/config-diff.mjs';
import { parseYAML } from '../../../runtime/core/yaml.mjs';

after(() => K.cleanup());

const bin = new URL('../../../bin/unknot', import.meta.url).pathname;
const AGENTS = '## Validating\n\nBuild with `dotnet build src/Shop.sln`. Do not use dotnet test to run all tests in the solution.\n\n## Files\n\nNever edit `legacy/**` by hand.\n';

function initProject() {
  const p = K.makeProject({ files: { 'src/Shop.sln': '', 'AGENTS.md': AGENTS, 'package.json': '{\n  "scripts": {\n    "lint": "eslint ."\n  }\n}\n' } });
  const env = { ...process.env, UNKNOT_HOME: process.env.UNKNOT_HOME };
  const init = spawnSync(process.execPath, [bin, 'init'], { cwd: p.dir, encoding: 'utf8', env });
  assert.equal(init.status, 0, init.stderr);
  const diff = spawnSync(process.execPath, [bin, 'config', 'diff'], { cwd: p.dir, encoding: 'utf8', env });
  assert.equal(diff.status, 0, diff.stderr);
  return { p, diff: diff.stdout };
}

test('every printed config diff line carries a source label', () => {
  const { diff } = initProject();
  const body = diff.split('\n').filter((l) => /^[+\-!] /.test(l));
  assert.ok(body.length > 5);
  for (const l of body) assert.match(l, /\[(detected: \S+:\d+|guidance: \S+:\d+ ".+"|default|current)\]$/, l);
  assert.match(diff, /commands\.build: dotnet build src\/Shop\.sln +\[detected: src\/Shop\.sln:1\]/);
  assert.match(diff, /commands\.lint: npm run lint +\[detected: package\.json:3\]/);
  assert.match(diff, /mode: "plan" +\[default\]/);
});

test('guidance-derived lines are grouped, flagged for judgement, and quote their sentence', () => {
  const { diff } = initProject();
  const [, group] = diff.split('These need your judgement');
  assert.ok(group, diff);
  assert.match(group, /! commands\.test_unit: dotnet test src\/Shop\.sln \(not proposed\) +\[guidance: AGENTS\.md:3 "Do not use dotnet test to run all tests in the solution\."\]/);
  assert.match(group, /\+ protected_paths: legacy\/\*\* +\[guidance: AGENTS\.md:7 "Never edit `?legacy\/\*\*`? by hand\."\]/);
  assert.match(group, /--detected-only/);
});

test('detected-only leaves guidance-derived lines out and keeps the rest valid', () => {
  const { p } = initProject();
  const text = readFileSync(p.ctx.paths.proposedConfig, 'utf8');
  const proposed = parseYAML(text);
  const sources = readSources(p.ctx.paths, text);
  assert.ok(proposed.protected_paths.includes('legacy/**'));
  const { proposed: kept, dropped } = withoutGuidance({}, proposed, sources);
  assert.ok(!kept.protected_paths.includes('legacy/**'));
  assert.deepEqual(dropped.map((d) => d.key), ['protected_paths[legacy/**]']);
  assert.deepEqual(kept.commands, proposed.commands);
  // A guidance line the current config already holds is not removed.
  const keep = withoutGuidance({ protected_paths: ['legacy/**'] }, proposed, sources);
  assert.ok(keep.proposed.protected_paths.includes('legacy/**'));
});

test('a proposal without a source record is labelled as such, not as detected', () => {
  const d = diffConfig({}, { mode: 'plan' }, null);
  assert.match(d.changes[0].label, /^unknown/);
});
