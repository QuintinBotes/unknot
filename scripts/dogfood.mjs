#!/usr/bin/env node
// Dogfooding harness: run Unknot's read-only pipeline over real repositories and record
// what happened, so the feedback loop has data. Each repository is cloned to a temporary
// directory first; the original checkout is never opened for writing.
//
// Usage: node scripts/dogfood.mjs [--out DIR] [--top N] <repo-path>...

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const out = resolve(flag('out', join(tmpdir(), `unknot-dogfood-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const top = Number(flag('top', 25));
const repos = args.map((p) => resolve(p));
if (!repos.length) {
  process.stderr.write('usage: node scripts/dogfood.mjs [--out DIR] [--top N] <repo-path>...\n');
  process.exit(2);
}
process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-dogfood-home-'));
mkdirSync(out, { recursive: true });

const { openProject } = await import('../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../runtime/policy/config.mjs');
const { detect } = await import('../runtime/cli/commands/init.mjs');
const { stringifyYAML } = await import('../runtime/core/yaml.mjs');
const { mapRepository } = await import('../runtime/graph/builder.mjs');
const { diagnose } = await import('../runtime/diagnose/engine.mjs');
const { decompose } = await import('../runtime/decompose/index.mjs');
const { architectureViews } = await import('../runtime/artifacts/architecture.mjs');
const { Graph } = await import('../runtime/graph/graph.mjs');
const { startRun, endRun } = await import('../runtime/state/runs.mjs');

const time = async (fn) => {
  const t0 = process.hrtime.bigint();
  const r0 = process.memoryUsage().rss;
  try {
    const value = await fn();
    return { value, ms: Number((process.hrtime.bigint() - t0) / 1_000_000n), rss_mb: Math.round(Math.max(r0, process.memoryUsage().rss) / 1048576) };
  } catch (err) {
    return { error: `${err.code ?? 'Error'}: ${err.message}`, stack: err.stack?.split('\n').slice(0, 6).join('\n'), ms: Number((process.hrtime.bigint() - t0) / 1_000_000n) };
  }
};

const summary = [];
for (const repo of repos) {
  const name = basename(repo);
  const dir = mkdtempSync(join(tmpdir(), `uk-df-${name}-`));
  execFileSync('git', ['clone', '-q', '--no-hardlinks', repo, dir], { stdio: 'ignore' });
  const report = { repo: name, clone: dir, steps: {} };
  const ctx = openProject(dir, { create: true });
  const d = detect(dir);
  const configText = stringifyYAML({ version: 1, mode: 'plan', commands: d.commands });
  writeFileSync(join(dir, '.unknot/config.yaml'), configText);
  recordAcceptedConfig(ctx, configText, 'human:dogfood');
  const cfg = loadConfig(ctx);
  const run = startRun(ctx, { command: 'map', actor: 'human:dogfood', config: cfg.config, configDigest: cfg.digest });
  const map = await time(() => mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, run }));
  report.steps.map = map.error ? map : { ms: map.ms, rss_mb: map.rss_mb, files: map.value.files, by_kind: map.value.by_kind, nodes: map.value.nodes, edges: map.value.edges, status: map.value.status, failures: map.value.failures.slice(0, 20), failure_count: map.value.failure_count, unavailable: map.value.unavailable, history: map.value.history };
  const remap = await time(() => mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, run }));
  report.steps.remap = remap.error ? remap : { ms: remap.ms, cache: remap.value.cache };
  const diag = await time(() => diagnose(ctx, { config: cfg.config, run }));
  if (diag.error) report.steps.diagnose = diag;
  else {
    const f = diag.value.findings;
    const byKind = {};
    for (const x of f) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
    report.steps.diagnose = { ms: diag.ms, open: f.length, errors: diag.value.errors, by_kind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1])), top: f.slice(0, top).map((x) => ({ id: x.id, kind: x.kind, risk: x.risk, priority: x.priority.score, title: x.title, scope: x.scope.slice(0, 3), evidence: x.evidence.slice(0, 2).map((e) => `${e.label}: ${e.summary}`), uncertainties: x.uncertainties.slice(0, 2) })) };
  }
  const dec = await time(() => decompose(ctx, { config: cfg.config, run }));
  report.steps.decompose = dec.error ? dec : { ms: dec.ms, targets: dec.value.targets, analyses: dec.value.analyses, recommendations: dec.value.recommendations, rejected_sample: dec.value.details.slice(0, 3).map((r) => ({ id: r.id, rejected: r.rejected_treatments.map((x) => `${x.treatment}: ${x.reason.slice(0, 120)}`), gaps: r.evidence_gaps.slice(0, 4) })) };
  const arch = await time(() => architectureViews(Graph.fromStore(ctx.store), {}));
  report.steps.architecture = arch.error ? arch : { ms: arch.ms, styles: arch.value.styles };
  endRun(ctx, run.id);
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  summary.push({
    repo: name,
    files: report.steps.map.files,
    map_ms: report.steps.map.ms,
    remap_ms: report.steps.remap.ms,
    nodes: report.steps.map.nodes,
    edges: report.steps.map.edges,
    map_status: report.steps.map.status ?? report.steps.map.error,
    findings: report.steps.diagnose.open ?? report.steps.diagnose.error,
    detector_errors: report.steps.diagnose.errors?.length ?? null,
    decompose: report.steps.decompose.recommendations?.map((r) => `${r.candidate}:${r.treatment}`).join(', ') ?? report.steps.decompose.error,
    styles: report.steps.architecture.styles?.map?.((s) => `${s.style ?? s.name}(${s.label})`).join(', ') ?? report.steps.architecture.error,
  });
  process.stdout.write(`${name}: ${JSON.stringify(summary.at(-1))}\n`);
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`\nReports in ${out}\n`);
