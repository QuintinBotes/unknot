import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('a reader that closes stdout early does not crash the CLI (live-session regression: map was lost)', async () => {
  const child = spawn(process.execPath, [new URL('../../../bin/unknot', import.meta.url).pathname, 'help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.ok(!/EPIPE|Unhandled 'error'/.test(err), err);
  assert.notEqual(code, null);
});
