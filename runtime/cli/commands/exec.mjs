// `unknot exec <name> [args]` — run a configured project command through the broker as
// recorded evidence. The model cannot supply an executable: only names from
// config.commands, with extra arguments restricted to inert tokens.

import { brokerExec } from '../../broker/broker.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { output, withRun } from '../util.mjs';
import { open, sliceRow } from './_shared.mjs';

const SAFE_ARG = /^(?:[A-Za-z0-9_./:@,+=-]+)$/;

export async function run({ positional, flags }) {
  const [name, ...extra] = positional;
  const { ctx, cfg, config, actor } = open(flags);
  const base = config.commands?.[name];
  if (!base) throw new UnknotError('UK_POLICY_DENIED', `no command named ${name} in config.commands (have: ${Object.keys(config.commands ?? {}).join(', ') || 'none'})`);
  for (const a of extra) if (!SAFE_ARG.test(a) || a.startsWith('--require') || a.startsWith('--loader') || a.startsWith('--import')) throw new UnknotError('UK_POLICY_DENIED', `argument ${JSON.stringify(a)} is not allowed`);
  const slice = flags.slice ? sliceRow(ctx, flags.slice) : null;
  const cwd = slice?.worktree ?? ctx.root;
  const result = await withRun(ctx, cfg, 'verify', { actor, slice_id: slice?.id ?? null }, (r) =>
    brokerExec(ctx, { argv: [...base, ...extra], cwd, origin: 'configured', run: r, config, writable: slice?.worktree ? [slice.worktree] : [], timeoutMs: (config.limits.max_runtime_minutes ?? 30) * 60_000, sliceId: slice?.id ?? null }),
  );
  const r = result.record;
  if (flags.json) return output({ record: r, stdout_tail: result.stdoutTail, stderr_tail: result.stderrTail }, { json: true });
  output(`${r.verdict.toUpperCase()} ${name}: exit ${r.exit_code} in ${r.duration_ms} ms (sandbox ${r.sandbox}; evidence ${r.id})\n--- stdout (tail) ---\n${result.stdoutTail.slice(-4000)}\n--- stderr (tail) ---\n${result.stderrTail.slice(-2000)}`);
  return r.verdict === 'pass' ? 0 : 1;
}
