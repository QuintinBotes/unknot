import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { chargeModelUsage, costOf, readUsage } from '../../../runtime/policy/usage.mjs';

const entry = (id, ts, usage, block = 'text') => `${JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `req_${id}`, message: { id, role: 'assistant', content: [{ type: block }], usage } })}\n`;
const U = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };

test('readUsage counts one turn per request, skips earlier requests and incomplete lines', () => {
  const p = K.makeProject();
  const file = join(p.dir, 't.jsonl');
  writeFileSync(file, entry('m0', '2026-01-01T00:00:00Z', U) + entry('m1', '2026-02-01T00:00:00Z', U) + entry('m1', '2026-02-01T00:00:00Z', U, 'tool_use') + '{"type":"user"}\n' + entry('m2', '2026-02-02T00:00:00Z', U).slice(0, 40));
  const r = readUsage(file, { since: '2026-01-15T00:00:00Z' });
  assert.equal(r.turns, 1);
  assert.equal(r.tokens, 1115);
  appendFileSync(file, entry('m2', '2026-02-02T00:00:00Z', U).slice(40));
  const r2 = readUsage(file, { offset: r.offset, since: '2026-01-15T00:00:00Z', lastId: r.lastId });
  assert.equal(r2.turns, 1);
  assert.equal(costOf(r2.usage, { input_per_mtok: 1, output_per_mtok: 10, cache_write_per_mtok: 2, cache_read_per_mtok: 0.1 }), (10 + 50 + 200 + 100) / 1e6);
  assert.equal(costOf(r2.usage, null), null);
});

test('chargeModelUsage enforces max_turns and max_tokens from the transcript, and records unmeasurable budgets once', () => {
  const p = K.makeProject();
  const { run } = K.startTestRun(p, { command: 'apply' });
  const file = join(p.dir, 's.jsonl');
  writeFileSync(file, '');
  const r = { ...run, started_at: '2026-01-01T00:00:00Z', budget: { ...run.budget, max_turns: 2, max_tokens: null } };
  assert.equal(chargeModelUsage(p.ctx, { ...r, budget: { ...r.budget, max_turns: null } }, file), null, 'no usage limit: nothing read');
  appendFileSync(file, entry('a', '2026-02-01T00:00:00Z', U) + entry('b', '2026-02-01T00:00:01Z', U));
  assert.equal(chargeModelUsage(p.ctx, r, file).turns, 2);
  assert.equal(chargeModelUsage(p.ctx, r, file).turns, 0, 'already charged lines are not charged again');
  appendFileSync(file, entry('c', '2026-02-01T00:00:02Z', U));
  assert.throws(() => chargeModelUsage(p.ctx, r, file), (e) => e.code === 'UK_BUDGET_EXCEEDED');
  const t = { ...r, id: `${r.id}`, budget: { ...r.budget, max_turns: null, max_tokens: 10 } };
  chargeModelUsage(p.ctx, t, 'relative.jsonl');
  chargeModelUsage(p.ctx, t, 'relative.jsonl');
  const events = p.ctx.store.all("SELECT * FROM events WHERE type = 'budget.unmeasured'");
  assert.equal(events.length, 1);
});
