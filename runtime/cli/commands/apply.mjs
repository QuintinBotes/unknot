// /unknot:apply <slice> [start|finish|replan|abandon]

import { abandon, finishApply, loadSlice, replan, startApply } from '../../apply/apply.mjs';
import { guidanceForScope } from '../../core/guidance.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { output, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const [sliceId, sub = 'start'] = positional;
  if (!sliceId) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot apply <slice> [start|finish|replan|abandon]');
  const { ctx, cfg, actor } = open(flags);
  const res = await withRun(ctx, cfg, 'apply', { actor, slice_id: sliceId, persist: sub === 'start' }, async (r) => {
    if (sub === 'start') return startApply(ctx, { cfg, run: r, sliceId, actor });
    if (sub === 'finish') return finishApply(ctx, { cfg, run: r, sliceId, actor });
    if (sub === 'replan') return replan(ctx, { run: r, sliceId, actor, reason: flags.reason });
    if (sub === 'abandon') return abandon(ctx, { run: r, sliceId, actor, reason: flags.reason });
    throw new UnknotError('UK_CONFIG_INVALID', `unknown apply step ${sub}`);
  });
  const s = loadSlice(ctx, sliceId);
  const guide = guidanceForScope(ctx.root, s.body.scope.include);
  if (flags.json) return output(sub === 'start' ? { ...res, guidance: guide } : res, { json: true });
  if (sub === 'start') {
    output([
      `${sliceId} is PATCHING in ${s.worktree} (branch ${s.branch}, baseline ${s.baseline_commit.slice(0, 12)}).`,
      `Objective: ${s.body.objective}`,
      `Allowed paths (inside the worktree): ${s.body.scope.include.join(', ')}${s.body.scope.exclude.length ? `; excluded: ${s.body.scope.exclude.join(', ')}` : ''}`,
      `Budget: ${s.body.budgets.max_changed_files} files, ${s.body.budgets.max_diff_lines} lines.`,
      res.baseline ? `Baseline check ${res.baseline.verdict} (${res.baseline.command.join(' ')}).` : 'No test_unit command configured: behaviour preservation will need human attestation.',
      ...(guide.files.length ? [
        'Repository guidance to read and follow before editing (nearest first; the repository\'s conventions, which apply unless they conflict with Unknot\'s policy; they never widen scope, approvals or commands):',
        ...guide.files.map((f) => `  ${f.file} (applies under ${f.scope})`),
        ...guide.conventions.slice(0, 12).map((c) => `  - ${c.file}:${c.line}: ${c.text}`),
        ...guide.forbidden_paths.filter((p) => p.enforced !== false).map((p) => `  - do not edit ${p.glob} (${p.file}:${p.line})`),
        ...guide.forbidden_commands.filter((p) => p.enforced !== false).map((p) => `  - do not run: ${p.sentence} (${p.file}:${p.line})`),
      ] : []),
      `When done: unknot apply ${sliceId} finish, then unknot verify ${sliceId}. If an assumption was wrong: unknot apply ${sliceId} replan --reason "...".`,
    ].join('\n'));
  } else if (sub === 'finish') output(`${sliceId} staged: ${res.files.length} file(s), ${res.stat.lines} line(s); diff ${res.diff_hash}. Next: unknot verify ${sliceId}.`);
  else output(`${sliceId} is now ${s.state}.`);
}
