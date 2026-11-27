// Runs the mod's tests (hooks/*.test.tsx) with `claude plugin test`. That command runs every
// *.test.ts under the folder it is given, and tests/fixtures holds sample projects with node:test
// files of their own, so the mod's parts are copied to a temporary folder and tested there.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'unknot-mod-'));
try {
  for (const part of ['.claude-plugin', 'hooks', 'types']) cpSync(join(root, part), join(dir, part), { recursive: true });
  const r = spawnSync(process.env.CLAUDE_BIN ?? 'claude', ['plugin', 'test', dir], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
