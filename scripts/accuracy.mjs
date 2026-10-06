#!/usr/bin/env node
// Accuracy harness: precision of findings against labelled samples, and recall of seeded
// defects, on a pinned corpus of public repositories (docs/accuracy.md). Repositories are
// fetched shallowly into --work and never into this checkout.
//
// Usage: node scripts/accuracy.mjs [--corpus FILE] [--work DIR] [--out DIR] [--labels DIR]
//          [--only name,name] [--quick] [--include-large] [--sample N] [--seed S] [--no-recall]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedsFor } from './lib/accuracy-seeds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const quick = bool('quick');
const includeLarge = bool('include-large');
const noRecall = bool('no-recall');
const corpusFile = resolve(flag('corpus', join(HERE, 'corpus.json')));
const work = resolve(flag('work', join(tmpdir(), 'unknot-corpus')));
const out = resolve(flag('out', join(tmpdir(), `unknot-accuracy-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const labelsDir = resolve(flag('labels', join(ROOT, 'corpus/labels')));
const only = flag('only', '')?.split(',').filter(Boolean);
const sampleSize = Number(flag('sample', 20));
const seed = flag('seed', 'unknot-1');
if (args.length) {
  process.stderr.write(`unknown arguments: ${args.join(' ')}\n`);
  process.exit(2);
}
if (resolve(work).startsWith(ROOT) || resolve(out).startsWith(ROOT)) {
  process.stderr.write('--work and --out must be outside this repository\n');
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
let repos = corpus.repositories;
if (quick) repos = repos.filter((r) => r.quick);
else if (only?.length) repos = repos.filter((r) => only.includes(r.name));
else if (!includeLarge) repos = repos.filter((r) => !r.large);
if (!repos.length) {
  process.stderr.write('no repositories selected\n');
  process.exit(2);
}

process.env.UNKNOT_HOME = mkdtempSync(join(tmpdir(), 'uk-accuracy-home-'));
delete process.env.CLAUDECODE;
mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'samples'), { recursive: true });
mkdirSync(work, { recursive: true });

const { openProject } = await import('../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../runtime/policy/config.mjs');
const { detect } = await import('../runtime/cli/commands/init.mjs');
const { stringifyYAML } = await import('../runtime/core/yaml.mjs');
const { mapRepository } = await import('../runtime/graph/builder.mjs');
const { diagnose } = await import('../runtime/diagnose/engine.mjs');
const { startRun, endRun } = await import('../runtime/state/runs.mjs');

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=accuracy@example.invalid', '-c', 'user.name=accuracy', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

const EXT = {
  '.cs': 'csharp', '.java': 'java', '.kt': 'kotlin', '.scala': 'scala', '.py': 'python', '.rb': 'ruby', '.php': 'php', '.go': 'go', '.rs': 'rust',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.vue': 'javascript',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.swift': 'swift', '.sql': 'sql', '.tf': 'terraform', '.yaml': 'yaml', '.yml': 'yaml',
};
const languageOf = (finding) => {
  for (const p of finding.scope ?? []) if (EXT[extname(p)]) return EXT[extname(p)];
  return 'other';
};
const hash = (s) => createHash('sha256').update(`${seed}:${s}`).digest('hex');

/** Shallow, pinned fetch into work/<name>/src; reuses an existing fetch of the same SHA. */
function fetchRepo(r) {
  const dir = join(work, `${r.name}@${r.sha.slice(0, 12)}`);
  const src = join(dir, 'src');
  if (existsSync(join(src, '.git'))) {
    try {
      if (git(src, 'rev-parse', 'HEAD').trim() === r.sha) return src;
    } catch { /* refetch */ }
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  git(src, 'init', '-q');
  git(src, 'remote', 'add', 'origin', r.url);
  git(src, 'fetch', '-q', '--depth', '1', 'origin', r.sha);
  git(src, 'checkout', '-q', 'FETCH_HEAD');
  return src;
}

async function analyse(dir, { diagnoseToo = true } = {}) {
  rmSync(join(dir, '.unknot'), { recursive: true, force: true }); // state from an earlier or interrupted run
  const ctx = openProject(dir, { create: true });
  const d = detect(dir);
  // The default read budget (50000 files) stops a map of a very large monorepo, so raise it here.
  const configText = stringifyYAML({ version: 1, mode: 'plan', commands: d.commands, limits: { max_files_read: 500000 } });
  writeFileSync(join(dir, '.unknot/config.yaml'), configText);
  recordAcceptedConfig(ctx, configText, 'human:accuracy');
  const cfg = loadConfig(ctx);
  const run = startRun(ctx, { command: 'map', actor: 'human:accuracy', config: cfg.config, configDigest: cfg.digest });
  const t0 = Date.now();
  const map = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, run });
  const mapMs = Date.now() - t0;
  let findings = [];
  let diagMs = 0;
  let detectorErrors = 0;
  if (diagnoseToo) {
    const t1 = Date.now();
    const diag = await diagnose(ctx, { config: cfg.config, run });
    diagMs = Date.now() - t1;
    findings = diag.findings;
    detectorErrors = diag.errors?.length ?? 0;
  }
  endRun(ctx, run.id);
  return { map, mapMs, findings, diagMs, detectorErrors };
}

/** Stratified sample: strata are (kind, language); strata and members are ordered by a seeded hash,
 * then taken round-robin, so the sample is reproducible and a prefix is itself stratified. */
export function stratifiedSample(findings, n) {
  const strata = new Map();
  for (const f of findings) {
    const key = `${f.kind}|${languageOf(f)}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(f);
  }
  const order = [...strata.keys()].sort((a, b) => (hash(a) < hash(b) ? -1 : 1));
  for (const list of strata.values()) list.sort((a, b) => (hash(a.fingerprint) < hash(b.fingerprint) ? -1 : 1));
  const picked = [];
  for (let round = 0; picked.length < n; round++) {
    let any = false;
    for (const k of order) {
      const f = strata.get(k)[round];
      if (!f) continue;
      any = true;
      picked.push(f);
      if (picked.length >= n) break;
    }
    if (!any) break;
  }
  return { picked, strata: Object.fromEntries([...strata].map(([k, v]) => [k, v.length])) };
}

function readLabels(r) {
  const file = join(labelsDir, `${r.name}@${r.sha}.json`);
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const labels = {};
  for (const [fp, v] of Object.entries(raw)) {
    const label = String(typeof v === 'object' && v ? v.label : v);
    if (['true', 'false', 'not-worth'].includes(label)) labels[fp] = label;
  }
  return labels;
}

const tally = () => ({ true: 0, false: 0, 'not-worth': 0, unlabelled: 0 });
function add(map, key, label) {
  if (!map[key]) map[key] = tally();
  map[key][label ?? 'unlabelled']++;
}
const rate = (t) => {
  const n = t.true + t.false + t['not-worth'];
  return { labelled: n, unlabelled: t.unlabelled, true: t.true, false: t.false, 'not-worth': t['not-worth'], precision: n ? t.true / n : null, factual: n ? (t.true + t['not-worth']) / n : null };
};

async function recall(r, src, base, language) {
  const spec = seedsFor(language, src);
  if (!spec) return { language, skipped: `no seed set for ${language}` };
  const copy = join(work, `${r.name}@${r.sha.slice(0, 12)}`, 'seeded');
  rmSync(copy, { recursive: true, force: true });
  cpSync(src, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
  for (const [p, text] of Object.entries(spec.files)) {
    mkdirSync(dirname(join(copy, p)), { recursive: true });
    writeFileSync(join(copy, p), text);
  }
  git(copy, 'add', '-A', '--', ...Object.keys(spec.files));
  git(copy, 'commit', '-qm', 'seed');
  const res = await analyse(copy);
  const results = spec.expect.map((e) => {
    const hit = res.findings.find((f) => f.kind === e.kind && f.scope.some((p) => e.paths.includes(p)));
    return { seed: e.seed, kind: e.kind, found: Boolean(hit), finding: hit?.fingerprint ?? null };
  });
  rmSync(copy, { recursive: true, force: true });
  return { language, results };
}

const report = { generated: new Date().toISOString(), unknot: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, seed, sample: sampleSize, quick, repositories: [] };
const byKind = {};
const byLanguage = {};
const overall = tally();
const recallBy = {};
const recallByLang = {};

for (const r of repos) {
  const entry = { name: r.name, sha: r.sha, language: r.language, style: r.style };
  report.repositories.push(entry);
  try {
    const t0 = Date.now();
    const src = fetchRepo(r);
    entry.fetch_ms = Date.now() - t0;
    const a = await analyse(src);
    entry.map_ms = a.mapMs;
    entry.diagnose_ms = a.diagMs;
    entry.files = a.map.files;
    entry.map_status = a.map.status;
    entry.findings = a.findings.length;
    entry.detector_errors = a.detectorErrors;
    const labels = readLabels(r);
    const { picked, strata } = stratifiedSample(a.findings, sampleSize);
    entry.strata = strata;
    entry.sample = picked.length;
    const t = tally();
    const sampleRows = [];
    for (const f of picked) {
      const label = labels[f.fingerprint];
      t[label ?? 'unlabelled']++;
      add(byKind, f.kind, label);
      add(byLanguage, languageOf(f), label);
      overall[label ?? 'unlabelled']++;
      sampleRows.push({ fingerprint: f.fingerprint, kind: f.kind, language: languageOf(f), label: label ?? null, title: f.title, scope: f.scope.slice(0, 4), evidence: f.evidence.slice(0, 3).map((e) => `${e.summary}${e.source_ref ? ` [${e.source_ref}]` : ''}`), measurements: f.measurements });
    }
    entry.precision = rate(t);
    writeFileSync(join(out, 'samples', `${r.name}@${r.sha}.json`), `${JSON.stringify(sampleRows, null, 2)}\n`);
    if (!noRecall) {
      const languages = r.seed_languages ?? [r.language];
      entry.recall = [];
      for (const language of languages) {
        const rec = await recall(r, src, a, language);
        entry.recall.push(rec);
        for (const x of rec.results ?? []) {
          for (const bucket of [recallBy[x.kind] ??= { found: 0, total: 0 }, recallByLang[language] ??= { found: 0, total: 0 }]) {
            bucket.total++;
            if (x.found) bucket.found++;
          }
        }
      }
    }
    process.stdout.write(`${r.name}: ${entry.files} files, ${entry.findings} findings, map ${(a.mapMs / 1000).toFixed(1)}s, sample ${picked.length} (${t.unlabelled} unlabelled)\n`);
  } catch (err) {
    entry.error = `${err.code ?? 'Error'}: ${String(err.message).slice(0, 300)}`;
    process.stdout.write(`${r.name}: FAILED ${entry.error}\n`);
  }
}

report.precision = { overall: rate(overall), by_detector: Object.fromEntries(Object.entries(byKind).sort().map(([k, v]) => [k, rate(v)])), by_language: Object.fromEntries(Object.entries(byLanguage).sort().map(([k, v]) => [k, rate(v)])) };
report.recall = { by_detector: recallBy, by_language: recallByLang };
writeFileSync(join(out, 'accuracy.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(out, 'accuracy.md'), markdown(report));
process.stdout.write(`\nReports in ${out}\n`);

function pct(x) {
  return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}
function markdown(rep) {
  const L = [`# Unknot accuracy, version ${rep.unknot}`, '', `Seed \`${rep.seed}\`, sample size ${rep.sample} per repository${rep.quick ? ', quick corpus' : ''}. Precision is the share of labelled sampled findings that are true; "factual" counts true plus true-but-not-worth-acting-on. Small samples are noisy: read the labelled column first.`, '', '## Repositories', '', '| Repository | Language | Files | Findings | Map | Diagnose | Sampled | Unlabelled |', '|---|---|---:|---:|---:|---:|---:|---:|'];
  for (const e of rep.repositories) {
    if (e.error) L.push(`| ${e.name} | ${e.language} | | | | | | failed: ${e.error} |`);
    else L.push(`| ${e.name} | ${e.language} | ${e.files} | ${e.findings} | ${(e.map_ms / 1000).toFixed(0)}s | ${(e.diagnose_ms / 1000).toFixed(0)}s | ${e.sample} | ${e.precision.unlabelled} |`);
  }
  const prec = (title, rows) => {
    L.push('', `## ${title}`, '', '| | Labelled | True | Wrong | Not worth | Unlabelled | Precision | Factual |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const [k, v] of rows) L.push(`| ${k} | ${v.labelled} | ${v.true} | ${v.false} | ${v['not-worth']} | ${v.unlabelled} | ${pct(v.precision)} | ${pct(v.factual)} |`);
  };
  prec('Precision overall', [['all', rep.precision.overall]]);
  prec('Precision by detector', Object.entries(rep.precision.by_detector));
  prec('Precision by language', Object.entries(rep.precision.by_language));
  const rec = (title, rows) => {
    L.push('', `## ${title}`, '', '| | Found | Seeded | Recall |', '|---|---:|---:|---:|');
    for (const [k, v] of rows) L.push(`| ${k} | ${v.found} | ${v.total} | ${pct(v.total ? v.found / v.total : null)} |`);
  };
  if (Object.keys(rep.recall.by_detector).length) {
    rec('Recall by detector (seeded defects)', Object.entries(rep.recall.by_detector).sort());
    rec('Recall by language (seeded defects)', Object.entries(rep.recall.by_language).sort());
    L.push('', '### Seeded results per repository', '', '| Repository | Language | Seed | Found |', '|---|---|---|---|');
    for (const e of rep.repositories) for (const x of e.recall ?? []) for (const y of x.results ?? []) L.push(`| ${e.name} | ${x.language} | ${y.seed} | ${y.found ? 'yes' : 'no'} |`);
  }
  return `${L.join('\n')}\n`;
}
