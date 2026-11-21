// /unknot:diagnose [scope] [--objective "..."|decompose|simplify|security] [--all] — rank simplification opportunities.
// [--baseline <ref> [--fail-on new:<severity>]] — only the findings the tree adds to that base (#101).

import { baseCommit, baselineFindings } from '../../diagnose/baseline.mjs';
import { diagnose, locationOf, SEVERITIES, severityOf } from '../../diagnose/engine.mjs';
import { analysisGapLines } from '../../diagnose/analysis-coverage.mjs';
import { UnknotError, toErrorJSON } from '../../core/errors.mjs';
import { mapRepository } from '../../graph/builder.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

/** Version of the `--json` document (docs/commands.md lists its fields). */
const DIAGNOSE_JSON_VERSION = '1.0';

/** Exit code when the base cannot be mapped, so a gate tells it from new findings (1). */
const BASE_UNMAPPED = 5;

export async function run({ positional, flags }) {
  const { ctx, cfg, config, actor } = open(flags);
  const ref = flags.baseline === undefined ? null : String(flags.baseline);
  if (flags.baseline === true || ref === '') throw new UnknotError('UK_SCHEMA_INVALID', '--baseline needs a ref: --baseline <branch|tag|commit>');
  const failOn = flags.fail_on === undefined ? null : String(flags.fail_on);
  const threshold = failOn === null ? null : SEVERITIES.indexOf(/^new:(\w+)$/.exec(failOn)?.[1]);
  if (threshold < 0) throw new UnknotError('UK_SCHEMA_INVALID', `--fail-on takes new:${SEVERITIES.join('|')}, not ${failOn}`);
  if (failOn !== null && !ref) throw new UnknotError('UK_SCHEMA_INVALID', '--fail-on judges only what a change adds: give the base with --baseline <ref>');
  const only = flags.only ? String(flags.only).split(',') : null;
  const unmapped = (err) => {
    if (err?.code !== 'UK_BASELINE_INVALID') throw err;
    if (flags.json) output({ error: toErrorJSON(err) }, { json: true });
    else process.stderr.write(`unknot diagnose: ${err.code}: ${err.message}\n`);
    return BASE_UNMAPPED;
  };
  let commit = null;
  try {
    commit = ref && baseCommit(ctx, ref);
  } catch (err) {
    return unmapped(err);
  }
  let tree = null;
  const res = await withRun(ctx, cfg, 'diagnose', { actor, scope: positional }, async (r) => {
    // Judged against a base, the tree is mapped first: a graph of an older tree would hide what it adds.
    if (ref) tree = await mapRepository(ctx, { config, configDigest: cfg.digest, run: r });
    // A gate judges every new finding, including those a named objective folds out of view.
    return diagnose(ctx, { config, run: r, scope: positional, objective: flags.objective ?? null, only, all: Boolean(flags.all || ref) });
  });
  let base = null;
  try {
    base = ref && (await baselineFindings(ctx, { ref, commit, config, configDigest: cfg.digest, only }));
  } catch (err) {
    return unmapped(err);
  }
  const found = res.findings.filter((f) => !base?.fingerprints.has(f.fingerprint)).map((f) => ({ ...f, severity: severityOf(f, config), location: locationOf(f) }));
  const failed = failOn !== null ? found.some((f) => SEVERITIES.indexOf(f.severity) >= threshold) : null;
  const code = failed ? 1 : 0;
  const limit = Number(flags.limit ?? 25);
  const named = res.objective ? { objective: res.objective, hidden: res.hidden, hidden_kinds: res.hidden_kinds } : {};
  if (flags.json) {
    const failures = base && { tree: tree.failure_count ?? 0, base: base.failures };
    const compared = base && { baseline: { ref, commit, findings: base.findings, new: found.length, extraction_failures: failures } };
    output({ schema_version: DIAGNOSE_JSON_VERSION, ...compared, ...(failOn !== null && { fail_on: failOn, failed }), stats: res.stats, errors: res.errors, analysis: res.analysis, ...named, findings: found.slice(0, limit) }, { json: true });
    return code;
  }
  const rows = found.slice(0, limit).map((f) => ({ id: f.id, priority: f.priority.score.toFixed(3), impact: f.impact ?? '', severity: f.severity, risk: f.risk, kind: f.kind, title: f.title }));
  const lines = [
    `${res.stats.open} open finding(s) from ${res.stats.detectors} detector(s)${res.stats.objective ? ` · objective: ${res.stats.objective}` : ''}; ${res.stats.suppressed} suppressed by decisions, ${res.stats.accepted} accepted.`,
  ];
  if (base) lines.push(`${found.length} new compared with ${ref} (${commit.slice(0, 12)}, which has ${base.findings}).`);
  if (base && (tree.failure_count || base.failures)) lines.push(`Not every file could be read (${tree.failure_count ?? 0} in the tree, ${base.failures} in the base): a finding there may be missing or reported as new.`);
  if (failOn !== null) lines.push(`--fail-on ${failOn}: ${failed ? 'FAILED' : 'passed'}.`);
  lines.push('', table(rows, ['id', 'priority', 'impact', 'severity', 'risk', 'kind', 'title']));
  if (res.hidden) lines.push('', `${res.hidden} code-style finding${res.hidden === 1 ? '' : 's'} hidden (--all to show)`);
  const gaps = analysisGapLines(res.analysis?.unavailable ?? []);
  if (gaps.length) lines.push('', 'Analysis not run:', ...gaps);
  if (res.errors.length) lines.push('', `Detector problems (reported, not hidden): ${res.errors.map((e) => `${e.detector}: ${e.error}`).join('; ')}`);
  lines.push('', 'Next: unknot explain <F-id> for evidence, uncertainty, alternatives and pattern fit.');
  output(lines.join('\n'));
  return code;
}
