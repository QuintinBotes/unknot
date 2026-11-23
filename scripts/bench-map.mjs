#!/usr/bin/env node
// Map benchmark on a real public repository: a cold map (no store), then a warm map (unchanged
// tree, store kept), each in its own process so peak RSS is that map's own. Writes wall time,
// peak RSS and file counts to a JSON file. The repository is fetched shallowly at its pinned
// commit from scripts/corpus.json into --work, never into this checkout. See docs/benchmarks.md.
//
// Usage: node scripts/bench-map.mjs [--repo nopcommerce] [--corpus FILE] [--work DIR] [--out FILE]

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);

if (argv[0] === '--child') {
  // One map of `dir`; prints one JSON line. Peak RSS is Node's resourceUsage().maxRSS (kilobytes).
  const dir = argv[1];
  process.env.UNKNOT_HOME = argv[2];
  delete process.env.CLAUDECODE;
  const { openProject } = await import('../runtime/context.mjs');
  const { loadConfig, recordAcceptedConfig } = await import('../runtime/policy/config.mjs');
  const { detect } = await import('../runtime/cli/commands/init.mjs');
  const { stringifyYAML } = await import('../runtime/core/yaml.mjs');
  const { mapRepository } = await import('../runtime/graph/builder.mjs');
  const { startRun, endRun } = await import('../runtime/state/runs.mjs');
  const ctx = openProject(dir, { create: true });
  // The default read budget (50000 files) can stop a map of a very large repository, so raise it.
  const configText = stringifyYAML({ version: 1, mode: 'plan', commands: detect(dir).commands, limits: { max_files_read: 500000 } });
  writeFileSync(join(dir, '.unknot/config.yaml'), configText);
  recordAcceptedConfig(ctx, configText, 'human:bench');
  const cfg = loadConfig(ctx);
  const run = startRun(ctx, { command: 'map', actor: 'human:bench', config: cfg.config, configDigest: cfg.digest });
  const t0 = Date.now();
  const map = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, run });
  const wall_ms = Date.now() - t0;
  endRun(ctx, run.id);
  process.stdout.write(`${JSON.stringify({ wall_ms, peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024), files: map.files, nodes: map.nodes, edges: map.edges, cache: map.cache })}\n`);
  process.exit(0);
}

const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const name = flag('repo', 'nopcommerce');
const work = resolve(flag('work', join(tmpdir(), 'unknot-corpus')));
const out = resolve(flag('out', join(tmpdir(), `unknot-bench-map-${name}.json`)));
if (work.startsWith(ROOT) || out.startsWith(ROOT)) {
  process.stderr.write('--work and --out must be outside this repository\n');
  process.exit(2);
}
const repo = JSON.parse(readFileSync(resolve(flag('corpus', join(HERE, 'corpus.json'))), 'utf8')).repositories.find((r) => r.name === name);
if (!repo) {
  process.stderr.write(`${name} is not in the corpus\n`);
  process.exit(2);
}

const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

/** Shallow, pinned fetch into work/<name>@<sha>/src; reuses an existing fetch of the same SHA. */
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

const src = fetchRepo(repo);
const home = mkdtempSync(join(tmpdir(), 'uk-bench-home-'));
const state = join(src, '.unknot');
rmSync(state, { recursive: true, force: true }); // cold: no store from an earlier run
const child = () => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', src, home], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`map failed: ${r.stderr.slice(-2000)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};
const cold = child();
const warm = child();
const store_mb = Math.round(Number(execFileSync('du', ['-sk', state], { encoding: 'utf8' }).split('\t')[0]) / 1024);
const result = { repository: repo.url, commit: repo.sha, node: process.version, platform: `${process.platform} ${process.arch}`, cold, warm, store_mb };
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
rmSync(home, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(result)}\nwrote ${out}\n`);
