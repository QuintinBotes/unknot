import { mapRepository } from '../../graph/builder.mjs';
import { impossibleWarning } from '../../graph/derived.mjs';
import { output, withRun } from '../util.mjs';
import { open } from './_shared.mjs';
import { constantsLine } from './status.mjs';

const coverLine = (s) => (s.whole ? 'the whole repository' : s.covered.join(', '));

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  // `--replace B` parses as a flag value: it is the first scope.
  const replace = flags.replace !== undefined && flags.replace !== 'false';
  const scope = typeof flags.replace === 'string' && replace ? [flags.replace, ...positional] : positional;
  const summary = await withRun(ctx, cfg, 'map', { actor, scope }, (r) =>
    mapRepository(ctx, { config, configDigest: cfg.digest, run: r, scope, replace, only: flags.adapter ? String(flags.adapter).split(',') : null, history: !flags.no_history, branchOk: typeof flags.branch_ok === 'string' ? flags.branch_ok : null }),
  );
  // A cycle the build forbids is an analysis artifact: say so where it is seen first (#72).
  // Read straight from the stored components: mapRepository has written them for this generation.
  for (const r of ctx.store.all("SELECT body FROM derived WHERE kind = 'scc' AND generation = ?", summary.generation)) {
    const body = JSON.parse(r.body);
    if (body.impossible_by_build) process.stderr.write(`unknot: warning: ${impossibleWarning(body)}\n`);
  }
  if (summary.history?.unmeasured) process.stderr.write(`unknot: notice: ${summary.history.unmeasured}\n`);
  if (flags.json) return output(summary, { json: true });
  const lines = [
    `Mapped ${summary.files} files at ${summary.commit?.slice(0, 12) ?? 'working tree'} → ${summary.nodes} nodes, ${summary.edges} edges (generation ${summary.generation}, ${summary.duration_ms} ms).`,
    `Covers: ${coverLine(summary.scope)}.`,
    `Cache: ${summary.cache.hits} reused, ${summary.cache.extracted} extracted.`,
    `Files by kind: ${Object.entries(summary.by_kind).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  ];
  if (summary.coverage?.length) lines.push(`Language coverage: ${summary.coverage.map((c) => `${c.language} ${c.files} files, ${c.adapter}, ${c.qualities ? Object.entries(c.qualities).map(([q, n]) => `${q} ${n}`).join(' + ') : c.quality}`).join('; ')}.`);
  if (summary.constants) lines.push(`${constantsLine(summary.constants)}.`);
  if (summary.history) lines.push(`History: ${summary.history.commits} commits, ${summary.history.co_change_pairs} co-change pairs (${summary.history.ignored_large_commits} oversized commits ignored).`);
  if (summary.status === 'partial' && !summary.failure_count && summary.unavailable.every((u) => String(u.id ?? u.adapter).startsWith('language:'))) lines.push('Status partial: the dominant language was read lexically (see below); the graph is usable, but its dependency and call edges for that language are approximate.');
  if (summary.unavailable.length) lines.push(`Adapters unavailable: ${summary.unavailable.map((u) => `${u.id ?? u.adapter} (${u.reason})`).join(', ')}.`);
  if (summary.build_graph?.rejected) lines.push(`Build graph: ${summary.build_graph.rejected} name-matched edge(s) between files of projects that cannot see each other were not drawn.`);
  for (const n of summary.notices ?? []) lines.push(`Note: ${n}.`);
  if (summary.failure_count) lines.push(`PARTIAL: ${summary.failure_count} extraction failure(s), e.g. ${summary.failures.slice(0, 3).map((f) => `${f.path} [${f.adapter}]: ${f.error}`).join('; ')}.`);
  output(lines.join('\n'));
}
