// Terminal messages name CLI commands, agent messages may name skills, and an unknown command
// suggests the nearest one (issue #93).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import '../../helpers/git-env.mjs';
import { mkTmp } from '../../helpers/tmp.mjs';

const { main } = await import('../../../runtime/cli/main.mjs');

async function runMain(argv, { tty }) {
  const env = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
  const tt = { in: process.stdin.isTTY, out: process.stdout.isTTY };
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  process.stdin.isTTY = tty;
  process.stdout.isTTY = tty;
  let err = '';
  const w = process.stderr.write;
  process.stderr.write = (c) => { err += c; return true; };
  let code;
  try {
    code = await main(argv);
  } finally {
    process.stderr.write = w;
    process.stdin.isTTY = tt.in;
    process.stdout.isTTY = tt.out;
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  }
  return { code, err };
}

const bare = () => {
  const dir = mkTmp(join(tmpdir(), 'uk-term-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};

test('4. in a terminal, map without .unknot names `unknot init`', async () => {
  const r = await runMain(['map', '--cwd', bare()], { tty: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /run unknot init\b/);
  assert.doesNotMatch(r.err, /\/unknot:init/);
});

test('4b. an agent session still sees the skill form', async () => {
  const r = await runMain(['map', '--cwd', bare()], { tty: false });
  assert.match(r.err, /run \/unknot:init/);
});

test('5. a mistyped command exits 2 and suggests the nearest one', async () => {
  const r = await runMain(['mpa'], { tty: false });
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command mpa.*Did you mean map\?/);
});

test('5b. a command nothing resembles gets no suggestion', async () => {
  const r = await runMain(['zzzzzzzz'], { tty: false });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.err, /Did you mean/);
});
