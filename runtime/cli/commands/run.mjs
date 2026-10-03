import { UnknotError } from '../../core/errors.mjs';
import { activeRun, endRun, getRun, startRun } from '../../state/runs.mjs';
import { output, requireHumanTTY } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const [sub, arg] = positional;
  const { ctx, cfg, config, actor } = open(flags);
  if (sub === 'show' || !sub) {
    const r = arg ? getRun(ctx.store, arg) : activeRun(ctx.store);
    return output(r ?? 'no active run', { json: flags.json });
  }
  if (sub === 'start') {
    const r = startRun(ctx, { command: arg, actor, config, configDigest: cfg.digest, scope: positional.slice(2), slice_id: flags.slice ?? null, supersede: Boolean(flags.supersede) });
    return output(flags.json ? r : `started ${r.id} (${r.command}, mode ${r.mode})`, { json: flags.json });
  }
  if (sub === 'end') {
    // Ending a run lifts enforcement, so only a human (or the Stop hook) may do it.
    requireHumanTTY('ending a run');
    const id = arg ?? activeRun(ctx.store)?.id;
    if (!id) throw new UnknotError('UK_NOT_FOUND', 'no active run');
    const r = endRun(ctx, id, { outcome: flags.outcome ?? 'ended_by_human', actor });
    return output(flags.json ? r : `ended ${r.id}`, { json: flags.json });
  }
  throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot run start <command>|end [id]|show [id]');
}
