// Runs: one invocation of an Unknot command, with its mode, scope, budget and policy
// digest fixed at start. Hooks enforce only while a run is active, so installing the
// plugin never changes sessions that are not using it.

import { spawnSync } from 'node:child_process';
import { randomId } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { UnknotError } from '../core/errors.mjs';
import { appendEvent } from './ledger.mjs';
import { parseJSONColumns } from './store.mjs';

export const RUN_SCHEMA_VERSION = '1.0';

const JSON_COLS = ['scope', 'budget', 'usage'];

// Commands and what they may do. `writes` is the run-level ceiling; mode can only narrow it.
export const COMMANDS = Object.freeze({
  init: { min_mode: 'observe', writes: 'config' },
  map: { min_mode: 'observe', writes: 'none' },
  diagnose: { min_mode: 'observe', writes: 'none' },
  explain: { min_mode: 'observe', writes: 'none' },
  decompose: { min_mode: 'observe', writes: 'none' },
  database: { min_mode: 'observe', writes: 'none' },
  infrastructure: { min_mode: 'observe', writes: 'none' },
  security: { min_mode: 'observe', writes: 'none' },
  status: { min_mode: 'observe', writes: 'none' },
  next: { min_mode: 'observe', writes: 'none' },
  doctor: { min_mode: 'observe', writes: 'none' },
  plan: { min_mode: 'plan', writes: 'artifacts' },
  architecture: { min_mode: 'plan', writes: 'docs' },
  accept: { min_mode: 'observe', writes: 'metadata' },
  reject: { min_mode: 'observe', writes: 'metadata' },
  apply: { min_mode: 'assist', writes: 'worktree' },
  verify: { min_mode: 'assist', writes: 'none' },
  rollback: { min_mode: 'assist', writes: 'worktree' },
});

export function gitHead(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false, timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function getRun(store, id) {
  return parseJSONColumns(store.get('SELECT * FROM runs WHERE id = ?', id), JSON_COLS);
}

/** The run hooks should enforce, or null. Interrupted runs stay active until ended. */
export function activeRun(store) {
  return parseJSONColumns(store.get('SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'), JSON_COLS);
}

/**
 * Start a run. Only one run may be active per project; a second start fails with
 * UK_STATE_CONFLICT unless `supersede` is set, in which case the old one ends as
 * `superseded` (its evidence stays attributed to it).
 */
export function startRun(ctx, { command, scope = [], actor, session_id = null, campaign_id = null, slice_id = null, config, configDigest, supersede = false, parent_run_id = null }) {
  if (!COMMANDS[command]) throw new UnknotError('UK_CONFIG_INVALID', `unknown command ${command}`);
  return ctx.store.tx(() => {
    const current = activeRun(ctx.store);
    if (current) {
      if (!supersede) {
        throw new UnknotError('UK_STATE_CONFLICT', `run ${current.id} (${current.command}) is still active; end it or resume it`, {
          run_id: current.id,
          details: { active: current.id, command: current.command },
        });
      }
      endRun(ctx, current.id, { outcome: 'superseded', actor });
    }
    const id = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomId(4)}`;
    const budget = { ...config.limits };
    const row = {
      id,
      schema_version: RUN_SCHEMA_VERSION,
      command,
      mode: config.mode,
      state: 'ACTIVE',
      scope,
      commit_sha: gitHead(ctx.root),
      campaign_id,
      slice_id,
      actor,
      session_id,
      budget,
      usage: {},
      policy_digest: configDigest,
      config_digest: configDigest,
      started_at: nowISO(),
      parent_run_id,
    };
    ctx.store.insert('runs', row);
    appendEvent(ctx, { type: 'run.started', run_id: id, campaign_id, slice_id, actor, scope, budget, payload: { command, mode: config.mode, commit: row.commit_sha } });
    return getRun(ctx.store, id);
  });
}

export function endRun(ctx, runId, { outcome = 'completed', actor = 'runtime:unknot' } = {}) {
  return ctx.store.tx(() => {
    const run = getRun(ctx.store, runId);
    if (!run) throw new UnknotError('UK_NOT_FOUND', `no run ${runId}`);
    if (run.ended_at) return run;
    const usage = ctx.store.counters(runId);
    ctx.store.update('runs', runId, run.version, { ended_at: nowISO(), outcome, state: 'ENDED', usage });
    appendEvent(ctx, { type: 'run.ended', run_id: runId, actor, payload: { outcome, usage } });
    return getRun(ctx.store, runId);
  });
}

export function setRunState(ctx, runId, state, reason, actor = 'runtime:unknot') {
  const run = getRun(ctx.store, runId);
  ctx.store.update('runs', runId, run.version, { state });
  appendEvent(ctx, { type: 'state.transition', run_id: runId, actor, payload: { entity: 'run', from: run.state, to: state, reason } });
}
