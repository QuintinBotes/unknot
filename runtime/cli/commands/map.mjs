import { mapRepository } from '../../graph/builder.mjs';
import { output, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const scope = positional;
  const summary = await withRun(ctx, cfg, 'map', { actor, scope }, (r) =>
    mapRepository(ctx, { config, configDigest: cfg.digest, run: r, scope, only: flags.adapter ? String(flags.adapter).split(',') : null, history: !flags.no_history, branchOk: typeof flags.branch_ok === 'string' ? flags.branch_ok : null }),
  );
  if (flags.json) return output(summary, { json: true });
  const lines = [
    `Mapped ${summary.files} files at ${summary.commit?.slice(0, 12) ?? 'working tree'} → ${summary.nodes} nodes, ${summary.edges} edges (generation ${summary.generation}, ${summary.duration_ms} ms).`,
    `Cache: ${summary.cache.hits} reused, ${summary.cache.extracted} extracted.`,
    `Files by kind: ${Object.entries(summary.by_kind).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  ];
  if (summary.coverage?.length) lines.push(`Language coverage: ${summary.coverage.map((c) => `${c.language} ${c.files} files, ${c.adapter}, ${c.quality}`).join('; ')}.`);
  if (summary.history) lines.push(`History: ${summary.history.commits} commits, ${summary.history.co_change_pairs} co-change pairs (${summary.history.ignored_large_commits} oversized commits ignored).`);
  if (summary.status === 'partial' && !summary.failure_count && summary.unavailable.every((u) => String(u.id ?? u.adapter).startsWith('language:'))) lines.push('Status partial: the dominant language was read lexically (see below); the graph is usable, but its dependency and call edges for that language are approximate.');
  if (summary.unavailable.length) lines.push(`Adapters unavailable: ${summary.unavailable.map((u) => `${u.id ?? u.adapter} (${u.reason})`).join(', ')}.`);
  for (const n of summary.notices ?? []) lines.push(`Note: ${n}.`);
  if (summary.failure_count) lines.push(`PARTIAL: ${summary.failure_count} extraction failure(s), e.g. ${summary.failures.slice(0, 3).map((f) => `${f.path} [${f.adapter}]: ${f.error}`).join('; ')}.`);
  output(lines.join('\n'));
}
