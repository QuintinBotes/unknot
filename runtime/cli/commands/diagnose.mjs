// /unknot:diagnose [scope] [--objective "..."] — rank simplification opportunities.

import { diagnose } from '../../diagnose/engine.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const res = await withRun(ctx, cfg, 'diagnose', { actor, scope: positional }, (r) =>
    diagnose(ctx, { config, run: r, scope: positional, objective: flags.objective ?? null, only: flags.only ? String(flags.only).split(',') : null }),
  );
  const limit = Number(flags.limit ?? 25);
  if (flags.json) return output({ stats: res.stats, errors: res.errors, findings: res.findings.slice(0, limit) }, { json: true });
  const rows = res.findings.slice(0, limit).map((f) => ({ id: f.id, priority: f.priority.score.toFixed(3), risk: f.risk, kind: f.kind, title: f.title }));
  const lines = [
    `${res.stats.open} open finding(s) from ${res.stats.detectors} detector(s)${res.stats.objective ? ` · objective: ${res.stats.objective}` : ''}; ${res.stats.suppressed} suppressed by decisions, ${res.stats.accepted} accepted.`,
    '',
    table(rows, ['id', 'priority', 'risk', 'kind', 'title']),
  ];
  if (res.errors.length) lines.push('', `Detector problems (reported, not hidden): ${res.errors.map((e) => `${e.detector}: ${e.error}`).join('; ')}`);
  lines.push('', 'Next: unknot explain <F-id> for evidence, uncertainty, alternatives and pattern fit.');
  output(lines.join('\n'));
}
