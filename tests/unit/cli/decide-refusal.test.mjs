// An agent's accept or reject is refused, and the suggested command keeps the reason and days
// it was given, in both the /unknot: and the terminal form (#181).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

after(() => K.cleanup());

const p = K.makeProject({ files: { 'src/a.js': 'export const a = 1;\n' } });
const now = '2026-01-01T00:00:00Z';
p.ctx.store.insert('findings', {
  id: 'F-0001', fingerprint: 'fp-1', schema_version: '1.0', kind: 'cycle', category: 'architecture', status: 'open', priority: 0.8,
  body: { id: 'F-0001', title: 'a imports b imports c' }, created_at: now, updated_at: now,
});

// No terminal and CLAUDECODE set: the actor is an agent.
const refusal = (...args) => {
  const r = spawnSync(process.execPath, [join(K.REPO_ROOT, 'bin', 'unknot'), ...args, '--rationale', 'r', '--cwd', p.dir], { encoding: 'utf8', input: '', env: { ...process.env, CLAUDECODE: '1', UNKNOT_HOME: p.home } });
  assert.equal(r.status, 3, r.stderr);
  return r.stderr;
};

test('a refused reject keeps --reason and --days, and names the terminal command', () => {
  const msg = refusal('reject', 'F-0001', '--reason', 'not-worth', '--days', '30');
  assert.ok(msg.includes('type /unknot:reject F-0001 --reason not-worth --days 30 --rationale "..."'), msg);
  assert.ok(msg.includes('`unknot reject F-0001 --reason not-worth --days 30 --rationale "..."` in your own terminal'), msg);
});

test('a refused reject without a valid reason offers the choice instead of echoing it', () => {
  for (const extra of [[], ['--reason', 'bogus;rm']]) {
    const msg = refusal('reject', 'F-0001', ...extra);
    assert.ok(msg.includes('/unknot:reject F-0001 [--reason wrong|not-worth|other] --rationale "..."'), msg);
    assert.doesNotMatch(msg, /bogus/);
  }
});

test('a refused accept names both forms and no reason', () => {
  const msg = refusal('accept', 'F-0001');
  assert.ok(msg.includes('type /unknot:accept F-0001 --rationale "...", or run `unknot accept F-0001 --rationale "..."`'), msg);
});
