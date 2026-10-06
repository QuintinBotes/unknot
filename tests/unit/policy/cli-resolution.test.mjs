// Which `unknot` on PATH counts as this plugin's CLI: its own bin, another installed version of
// it (PATH after an update in a running session), or the `unknot cli install` shim outside the
// project. A look-alike inside the project under analysis never does.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { shimSource } from '../../../runtime/cli/commands/cli.mjs';
import { judgeShell } from '../../../runtime/policy/commands.mjs';

const base = mkdtempSync(join(tmpdir(), 'uk-cli-res-'));
after(() => rmSync(base, { recursive: true, force: true }));

const exe = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
};
const versions = join(base, 'cache/market/unknot');
const pluginRoot = join(versions, '0.1.14');
exe(join(pluginRoot, 'bin/unknot'), '#!/usr/bin/env node\n');
exe(join(versions, '0.1.13/bin/unknot'), '#!/usr/bin/env node\n');
const project = join(base, 'project');
mkdirSync(project, { recursive: true });

function judged(pathDirs) {
  const saved = process.env.PATH;
  process.env.PATH = pathDirs.join(':');
  try {
    return judgeShell('unknot status', { pluginRoot, projectRoot: project });
  } finally {
    process.env.PATH = saved;
  }
}

test('the previous installed version on PATH (after an update in a running session) is the same plugin', () => {
  assert.equal(judged([join(versions, '0.1.13/bin')]).allow, true);
});

test('the cli shim outside the project counts; a copy of it inside the project, or a stranger, does not', () => {
  const home = join(base, 'home/.local/bin');
  exe(join(home, 'unknot'), shimSource(join(pluginRoot, 'bin/unknot')));
  assert.equal(judged([home]).allow, true);
  const planted = join(project, 'bin');
  exe(join(planted, 'unknot'), shimSource(join(pluginRoot, 'bin/unknot')));
  const r = judged([planted]);
  assert.equal(r.allow, false);
  assert.match(r.reasons.join(' '), /does not resolve to this plugin's CLI \(.*project\/bin\/unknot comes first on PATH\)/);
  const other = join(base, 'other/bin');
  exe(join(other, 'unknot'), shimSource(join(base, 'elsewhere/0.9.0/bin/unknot')));
  assert.equal(judged([other]).allow, false, 'a shim for a different installation');
  const stranger = join(base, 'stranger/bin');
  exe(join(stranger, 'unknot'), '#!/bin/sh\necho hi\n');
  assert.equal(judged([stranger]).allow, false);
});
