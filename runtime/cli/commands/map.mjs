import { mapRepository } from '../../graph/builder.mjs';
import { output, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const scope = positional;
  const summary = await withRun(ctx, cfg, 'map', { actor, scope }, (r) =>
    mapRepository(ctx, { config, configDigest: cfg.digest, run: r, scope, only: flags.adapter ? String(flags.adapter).split(',') : null, history: !flags.no_history }),
  );
  if (flags.json) return output(summary, { json: true });
  const lines = [
    `Mapped ${summary.files} files at ${summary.commit?.slice(0, 12) ?? 'working tree'} → ${summary.nodes} nodes, ${summary.edges} edges (generation ${summary.generation}, ${summary.duration_ms} ms).`,
    `Cache: ${summary.cache.hits} reused, ${summary.cache.extracted} extracted.`,
    `Files by kind: ${Object.entries(summary.by_kind).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  ];
  if (summary.history) lines.push(`History: ${summary.history.commits} commits, ${summary.history.co_change_pairs} co-change pairs (${summary.history.ignored_large_commits} oversized commits ignored).`);
  if (summary.unavailable.length) lines.push(`Adapters unavailable: ${summary.unavailable.map((u) => `${u.id} (${u.reason})`).join(', ')}.`);
  if (summary.failure_count) lines.push(`PARTIAL: ${summary.failure_count} extraction failure(s), e.g. ${summary.failures.slice(0, 3).map((f) => `${f.path} [${f.adapter}]: ${f.error}`).join('; ')}.`);
  output(lines.join('\n'));
}
