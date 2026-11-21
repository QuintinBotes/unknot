// README documents how to upgrade and uninstall Unknot (issue #96).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const readme = read('README.md');
const section = (heading) => {
  const m = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(readme);
  return m?.[1] ?? '';
};
const upgrade = section('Upgrade and uninstall');

test('4. README has an "Upgrade and uninstall" section that names `unknot cli uninstall`', () => {
  assert.ok(upgrade, 'missing "## Upgrade and uninstall"');
  assert.match(upgrade, /unknot cli uninstall/);
});

test('1. upgrading: the plugin update command, store migration, restart after upgrade', () => {
  assert.match(upgrade, /claude plugin update unknot@quintinbotes/);
  assert.match(upgrade, /claude plugin update unknot@unknot/);
  assert.match(upgrade, /migrat/i);
  assert.match(upgrade, /restart/i);
  assert.match(upgrade, /Claude Code \d+\.\d+\.\d+/, 'names the Claude Code version it was checked with');
});

test('2. uninstalling: plugin removal, launcher, every directory Unknot writes and what it holds', () => {
  assert.match(upgrade, /claude plugin uninstall unknot@quintinbotes/);
  assert.match(upgrade, /claude plugin marketplace remove/);
  for (const path of ['~/.config/unknot', 'approvers', 'projects', 'policy-keys', 'daemon', '.unknot/state', '.unknot/cas', '.unknot/runs', '.unknot/worktrees', '.unknot/telemetry', '~/.local/bin/unknot']) {
    assert.ok(upgrade.includes(path), `the section must name ${path}`);
  }
  for (const holds of [/keys/i, /ledger/i, /cache/i]) assert.match(upgrade, holds);
});

test('edge: a user who wants the audit ledger is told to back up first', () => {
  assert.match(upgrade, /unknot backup create/);
  assert.ok(upgrade.indexOf('unknot backup create') < upgrade.indexOf('unknot cli uninstall'), 'the backup comes before the removal steps');
});

test('docs/README.md points at the section', () => {
  assert.match(read('docs/README.md'), /README\.md#upgrade-and-uninstall/);
});
