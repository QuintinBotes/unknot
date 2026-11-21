// /unknot:diagnose [scope] [--objective "..."|decompose|simplify|security] [--all] — rank simplification opportunities.
// [--baseline <ref> [--fail-on new:<severity>]] — only the findings the tree adds to that base (#101).

import { baselineFindings } from '../../diagnose/baseline.mjs';
import { diagnose, locationOf, SEVERITIES, severityOf } from '../../diagnose/engine.mjs';
import { analysisGapLines } from '../../diagnose/analysis-coverage.mjs';
import { UnknotError, toErrorJSON } from '../../core/errors.mjs';
import { mapRepository } from '../../graph/builder.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

/** Version of the `--json` document (docs/commands.md lists its fields). */
export const DIAGNOSE_JSON_VERSION = '1.0';

/** Exit code when the base cannot be mapped, so a gate tells it from new findings (1). */
const BASE_UNMAPPED = 5;

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const ref = flags.baseline === undefined ? null : String(flags.baseline);
  if (ref === 'true') throw new UnknotError('UK_SCHEMA_INVALID', '--baseline needs a ref: --baseline <branch|tag|commit>');
  const failOn = flags.fail_on === undefined ? null : String(flags.fail_on);
  const threshold = failOn && SEVERITIES.indexOf(/^new:(\w+)$/.exec(failOn)?.[1]);
  if (failOn && threshold < 0) throw new UnknotError('UK_SCHEMA_INVALID', `--fail-on takes new:${SEVERITIES.join('|')}, not ${failOn}`);
  if (failOn && !ref) throw new UnknotError('UK_SCHEMA_INVALID', '--fail-on judges only what a change adds: give the base with --baseline <ref>');
  const only = flags.only ? String(flags.only).split(',') : null;
  let base = null;
  if (ref) {
    try {
      base = await baselineFindings(ctx, { ref, config, configDigest: cfg.digest, only });
    } catch (err) {
      if (err?.code !== 'UK_BASELINE_INVALID') throw err;
      if (flags.json) output({ error: toErrorJSON(err) }, { json: true });
      else process.stderr.write(`unknot diagnose: ${err.code}: ${err.message}\n`);
      return BASE_UNMAPPED;
    }
  }
  const res = await withRun(ctx, cfg, 'diagnose', { actor, scope: positional }, async (r) => {
    // Judged against a base, the tree is mapped first: a graph of an older tree would hide what it adds.
    if (ref) await mapRepository(ctx, { config, configDigest: cfg.digest, run: r });
    return diagnose(ctx, { config, run: r, scope: positional, objective: flags.objective ?? null, only, all: Boolean(flags.all) });
  });
  const found = res.findings.filter((f) => !base?.fingerprints.has(f.fingerprint)).map((f) => ({ ...f, severity: severityOf(f, config), location: locationOf(f) }));
  const failed = failOn ? found.some((f) => SEVERITIES.indexOf(f.severity) >= threshold) : null;
  const code = failed ? 1 : 0;
  const limit = Number(flags.limit ?? 25);
  const named = res.objective ? { objective: res.objective, hidden: res.hidden, hidden_kinds: res.hidden_kinds } : {};
  if (flags.json) {
    const compared = base && { baseline: { ref, commit: base.commit, findings: base.findings, new: found.length } };
    output({ schema_version: DIAGNOSE_JSON_VERSION, ...compared, ...(failOn && { fail_on: failOn, failed }), stats: res.stats, errors: res.errors, analysis: res.analysis, ...named, findings: found.slice(0, limit) }, { json: true });
    return code;
  }
  const rows = found.slice(0, limit).map((f) => ({ id: f.id, priority: f.priority.score.toFixed(3), impact: f.impact ?? '', severity: f.severity, risk: f.risk, kind: f.kind, title: f.title }));
  const lines = [
    `${res.stats.open} open finding(s) from ${res.stats.detectors} detector(s)${res.stats.objective ? ` · objective: ${res.stats.objective}` : ''}; ${res.stats.suppressed} suppressed by decisions, ${res.stats.accepted} accepted.`,
  ];
  if (base) lines.push(`${found.length} new compared with ${ref} (${base.commit.slice(0, 12)}, which has ${base.findings}).`);
  if (failOn) lines.push(`--fail-on ${failOn}: ${failed ? 'FAILED' : 'passed'}.`);
  lines.push('', table(rows, ['id', 'priority', 'impact', 'severity', 'risk', 'kind']));
  if (res.hidden) lines.push('', `${res.hidden} code-style finding${res.hidden === 1 ? '' : 's'} hidden (--all to show)`);
  const gaps = analysisGapLines(res.analysis?.unavailable ?? []);
  if (gaps.length) lines.push('Analysis not run:', ...gaps);
  if (res.errors.length) lines.push('', `Detector problems (reported, not hidden): ${res.errors.map((e) => `${e.detector}: ${e.error}`).join('; ')}`);
  lines.push('', 'Next: unknot explain <F-id> for evidence, uncertainty, alternatives and pattern fit.');
  output(lines.join('\n'));
  return code;
}
