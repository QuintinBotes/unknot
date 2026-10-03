// The shared shape of the three read-only domain reports (database, infrastructure,
// security): run the matching detectors through the diagnostic engine inside a run, add the
// domain inventory read from the graph, then print it for a human or as JSON.

import { diagnose } from '../diagnose/engine.mjs';
import { Graph } from '../graph/graph.mjs';
import { open } from '../cli/commands/_shared.mjs';
import { output, withRun } from '../cli/util.mjs';
import { scopedGraph } from './model.mjs';

const brief = (f) => ({ id: f.id, priority: f.priority.score, risk: f.risk, kind: f.kind, title: f.title, scope: f.scope });

/**
 * @param {{command: string, domain: string, args: {positional: string[], flags: object},
 *   build: (x: {graph: object, ctx: object, config: object, positional: string[], flags: object}) => object,
 *   render: (inventory: object, findings: object[], meta: object) => string}} spec
 */
export async function runDomainReport({ command, domain, args: { positional, flags }, build, render }) {
  const { ctx, cfg, config, actor } = open(flags);
  const result = await withRun(ctx, cfg, command, { actor, scope: positional }, async (run) => {
    const diagnosis = await diagnose(ctx, { config, run, scope: positional, only: [domain] });
    const graph = scopedGraph(Graph.fromStore(ctx.store), positional);
    const inventory = build({ graph, ctx, config, positional, flags });
    const limit = Number(flags.limit ?? 25);
    return {
      command,
      scope: positional,
      inventory,
      findings: diagnosis.findings.filter((f) => f.status === 'open').slice(0, limit).map(brief),
      stats: diagnosis.stats,
      problems: diagnosis.errors,
    };
  });
  if (flags.json) return output(result, { json: true });
  const lines = [render(result.inventory, result.findings, result)];
  lines.push('', `Findings (${result.stats.open} open from ${result.stats.detectors} ${domain} detector(s)):`);
  lines.push(...(result.findings.length ? result.findings.map((f) => `  ${f.id}  ${f.priority.toFixed(3)}  ${f.risk.padEnd(8)}  ${f.title}`) : ['  (none)']));
  if (result.problems.length) lines.push('', `Detector problems (reported, not hidden): ${result.problems.map((e) => `${e.detector}: ${e.error}`).join('; ')}`);
  lines.push('', 'Next: unknot explain <F-id> for evidence, uncertainty, alternatives and pattern fit.');
  return output(lines.join('\n'));
}

/** Indented key/count list for the human renderers. */
export const kv = (obj, indent = '  ') => {
  const entries = Object.entries(obj ?? {});
  return entries.length ? entries.map(([k, v]) => `${indent}${k}: ${v}`).join('\n') : `${indent}(none)`;
};
