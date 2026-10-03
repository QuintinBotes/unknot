// Budgets (spec §7.2). Counters live in the store per run and per agent; a breach blocks
// the operation and the run. It never widens authority: there is no "ask for more".

import { UnknotError } from '../core/errors.mjs';
import { appendEvent } from '../state/ledger.mjs';

// counter name → limit key in config.limits
export const LIMIT_FOR = Object.freeze({
  tool_calls: 'max_tool_calls',
  files_read: 'max_files_read',
  bytes_read: 'max_bytes_read',
  commands: 'max_commands',
  network_requests: 'max_network_requests',
  delegations: 'max_delegation_depth',
  turns: 'max_turns',
  tokens: 'max_tokens',
  cost_usd: 'max_cost_usd',
});

/**
 * Charge `amount` of `counter` to the run (and agent, when given). Returns the new totals
 * or throws UK_BUDGET_EXCEEDED after recording the breach.
 */
export function charge(ctx, run, counter, amount = 1, { agentId = null, actor = 'runtime:unknot' } = {}) {
  const limitKey = LIMIT_FOR[counter];
  const limit = limitKey ? run.budget?.[limitKey] : null;
  const total = ctx.store.bump(run.id, counter, amount);
  if (agentId) ctx.store.bump(`${run.id}:${agentId}`, counter, amount);
  if (limit != null && total > limit) {
    appendEvent(ctx, {
      type: 'budget.breach',
      run_id: run.id,
      slice_id: run.slice_id,
      actor,
      budget: { [limitKey]: limit },
      payload: { counter, total, limit, agent_id: agentId },
    });
    throw new UnknotError('UK_BUDGET_EXCEEDED', `budget ${limitKey}=${limit} exceeded (${counter} would be ${total})`, {
      run_id: run.id,
      details: { counter, total, limit },
    });
  }
  return total;
}

/** Wall-clock budget: a run older than max_runtime_minutes is over budget. */
export function checkWallClock(run, nowDate = new Date()) {
  const limit = run.budget?.max_runtime_minutes;
  if (limit == null) return { ok: true };
  const elapsed = (nowDate - new Date(run.started_at)) / 60000;
  return elapsed > limit ? { ok: false, elapsed, limit } : { ok: true, elapsed, limit };
}

/** Diff budget against config limits; `stat` from git diff --numstat. */
export function checkDiffBudget(limits, stat) {
  const problems = [];
  if (limits.max_changed_files != null && stat.files > limits.max_changed_files) {
    problems.push(`changed files ${stat.files} > max_changed_files ${limits.max_changed_files}`);
  }
  if (limits.max_diff_lines != null && stat.lines > limits.max_diff_lines) {
    problems.push(`diff lines ${stat.lines} > max_diff_lines ${limits.max_diff_lines}`);
  }
  return { ok: problems.length === 0, problems };
}
