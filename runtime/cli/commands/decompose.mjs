// /unknot:decompose [scope] [--target backend|frontend|auto] [--driver id]... (spec §15A.11)

import { decompose } from '../../decompose/index.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const drivers = flags['driver[]'] ?? [];
  const res = await withRun(ctx, cfg, 'decompose', { actor, scope: positional }, (r) =>
    decompose(ctx, { config, run: r, scope: positional, target: flags.target ?? 'auto', drivers }),
  );
  if (flags.json) return output(flags.full ? res : { ...res, details: undefined }, { json: true });
  const lines = [`Targets: ${res.targets.join(', ') || 'none'} · drivers: ${res.drivers.join(', ') || 'none recorded (service extraction and micro-frontends will not be offered)'}`];
  for (const [t, a] of Object.entries(res.analyses)) {
    lines.push(`${t}: ${a.modules} modules, modularity Q=${a.modularity}, ${a.robustness.robust}/${a.robustness.communities} candidates robust (weights are heuristics)`);
  }
  lines.push('', table(res.recommendations.map((r) => ({ ...r, sequence: r.sequence.join('→') })), ['id', 'target', 'candidate', 'size', 'treatment', 'sequence', 'confidence']));
  lines.push('', 'Details: .unknot/decompositions/<DEC-id>.json · Next: /unknot:plan "<objective>" to turn a recommendation into a campaign.');
  output(lines.join('\n'));
}
