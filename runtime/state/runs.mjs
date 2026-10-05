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
  lane: { min_mode: 'assist', writes: 'worktree' },
});

export function gitHead(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false, timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function getRun(store, id) {
  return parseJSONColumns(store.get('SELECT * FROM runs WHERE id = ?', id), JSON_COLS);
}

/** A run whose command writes nothing (map, diagnose, decompose, ...). */
export const isReadOnlyRun = (run) => COMMANDS[run?.command]?.writes === 'none';

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

/** Bind a slice to an active run (hooks read the slice through the run). */
const SLICE_COMMANDS = new Set(['apply', 'verify', 'rollback', 'lane']);

// A slice is out of flight when it can no longer be patched in this run.
const SETTLED = new Set(['REVIEW_READY', 'ACCEPTED', 'ABANDONED', 'ROLLED_BACK']);

/** A slice the person named, or (for a lane run) one in the campaign of a lane or campaign they named. */
function inRunScope(ctx, run, sliceId) {
  if (run.scope.includes(sliceId)) return true;
  if (run.command !== 'lane') return false;
  const campaign = ctx.store.get('SELECT campaign_id FROM slices WHERE id = ?', sliceId)?.campaign_id;
  return Boolean(campaign) && run.scope.some((id) => id === campaign || (id.startsWith('LN-') && ctx.store.get('SELECT campaign_id FROM lanes WHERE id = ?', id)?.campaign_id === campaign));
}

/**
 * Bind a slice to an active run (hooks read the slice through the run). Outside campaign
 * mode a run handles one slice. In campaign mode (spec §4.2: repeated, separately approved
 * slices) a run may move on to the next slice of the same campaign once the current one is
 * settled; each slice still needs its own approved plan to start patching.
 */
export function setRunSlice(ctx, runId, sliceId, actor = 'runtime:unknot', { mode = null } = {}) {
  const run = getRun(ctx.store, runId);
  if (run.slice_id === sliceId) return run;
  if (!run.slice_id) {
    // A run takes on a slice only when it was started for slice work, and only a slice the
    // person named when they named any (security review: during /unknot:map the model
    // could otherwise bind any slice to the run and start patching it).
    if (!SLICE_COMMANDS.has(run.command)) throw new UnknotError('UK_POLICY_DENIED', `a ${run.command} run cannot take on slice ${sliceId}; the person starts /unknot:apply ${sliceId}`, { details: { policy: 'run.slice_binding' } });
    if ((run.scope ?? []).length && !inRunScope(ctx, run, sliceId)) throw new UnknotError('UK_POLICY_DENIED', `this run is scoped to ${run.scope.join(', ')}, not ${sliceId}`, { details: { policy: 'run.slice_binding' } });
  }
  if (run.slice_id) {
    // A lane run works through the slices of its lane one after another, like a campaign run.
    const lane = run.command === 'lane';
    if (mode !== 'campaign' && !lane) throw new UnknotError('UK_STATE_CONFLICT', `run ${runId} is already bound to ${run.slice_id}; outside campaign mode a run handles one slice`);
    if (lane && (run.scope ?? []).length && !inRunScope(ctx, run, sliceId)) throw new UnknotError('UK_POLICY_DENIED', `this run is scoped to ${run.scope.join(', ')}, not ${sliceId}`, { details: { policy: 'run.slice_binding' } });
    const prev = ctx.store.get('SELECT state, campaign_id FROM slices WHERE id = ?', run.slice_id);
    const next = ctx.store.get('SELECT campaign_id FROM slices WHERE id = ?', sliceId);
    if (prev && !SETTLED.has(prev.state) && !(lane && prev.state === 'NEEDS_REPLAN')) throw new UnknotError('UK_STATE_CONFLICT', `finish ${run.slice_id} (${prev.state}) before moving to ${sliceId}`);
    if (prev && next && prev.campaign_id !== next.campaign_id) throw new UnknotError('UK_POLICY_DENIED', `a campaign run stays within campaign ${prev.campaign_id}`);
  }
  ctx.store.update('runs', runId, run.version, { slice_id: sliceId });
  appendEvent(ctx, { type: 'run.bound', run_id: runId, slice_id: sliceId, actor, payload: { slice: sliceId } });
  return getRun(ctx.store, runId);
}
