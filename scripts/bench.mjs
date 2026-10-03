#!/usr/bin/env node
// Published benchmark (spec §28): deterministic fixture repositories, cold and incremental
// `unknot map` timed in-process, with peak RSS. Numbers come from running this script on a
// stated machine; docs/benchmarks.md records one such run and how to reproduce it.
//
//   node scripts/bench.mjs [--quick] [--large] [--sizes 1k,10k] [--out <dir>]
//
// Each size runs in its own child process so `maxRSS` (a process-lifetime high-water mark)
// is attributable to that size alone.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SHAPE = JSON.parse(readFileSync(join(here, '..', 'tests', 'fixtures', 'bench', 'shape.json'), 'utf8'));

/** mulberry32: a small seeded PRNG so every machine generates identical repositories. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w = 3) => String(n).padStart(w, '0');

function body(lang, rnd, name, deps) {
  const branches = 1 + Math.floor(rnd() * 4);
  if (lang === 'ts') {
    const imports = deps.map((d, i) => `import { fn${i} as dep${i} } from '${d.spec}';`).join('\n');
    const calls = deps.map((_, i) => `  total += dep${i}(input + ${i});`).join('\n');
    const ifs = Array.from({ length: branches }, (_, i) => `  if (input % ${i + 2} === 0) total += ${i};`).join('\n');
    return `${imports}\n\nexport function ${name}(input: number): number {\n  let total = 0;\n${calls}\n${ifs}\n  return total;\n}\n\nexport function fn0(input: number): number {\n  return ${name}(input) + 1;\n}\n\nexport function fn1(input: number): number {\n  return ${name}(input) * 2;\n}\n`;
  }
  if (lang === 'py') {
    const imports = deps.map((d, i) => `from ${d.spec} import fn${i} as dep${i}`).join('\n');
    const calls = deps.map((_, i) => `    total += dep${i}(value + ${i})`).join('\n');
    const ifs = Array.from({ length: branches }, (_, i) => `    if value % ${i + 2} == 0:\n        total += ${i}`).join('\n');
    return `${imports}\n\n\ndef ${name}(value):\n    total = 0\n${calls}\n${ifs}\n    return total\n\n\ndef fn0(value):\n    return ${name}(value) + 1\n\n\ndef fn1(value):\n    return ${name}(value) * 2\n`;
  }
  const imports = deps.length ? `import (\n${deps.map((d) => `\t"${d.spec}"`).join('\n')}\n)\n\n` : '';
  const calls = deps.map((d) => `\ttotal += ${d.pkg}.Fn0(input)`).join('\n');
  const ifs = Array.from({ length: branches }, (_, i) => `\tif input%${i + 2} == 0 {\n\t\ttotal += ${i}\n\t}`).join('\n');
  return `${imports}func ${name[0].toUpperCase()}${name.slice(1)}(input int) int {\n\ttotal := 0\n${calls}\n${ifs}\n\treturn total\n}\n\nfunc Fn0(input int) int { return ${name[0].toUpperCase()}${name.slice(1)}(input) + 1 }\n`;
}

/** Generate a repository of about `count` files at `dir`; returns the list of relative paths. */
export function generateFixture(dir, count, shape = SHAPE) {
  const rnd = prng(shape.seed);
  const modules = Math.max(1, Math.ceil(count / shape.filesPerModule));
  const langs = Array.from({ length: modules }, () => {
    const r = rnd();
    let acc = 0;
    for (const [lang, p] of Object.entries(shape.languageMix)) {
      acc += p;
      if (r < acc) return lang;
    }
    return 'ts';
  });
  const ext = { ts: 'ts', py: 'py', go: 'go' };
  const paths = [];
  const meta = []; // per file: {lang, module, sub, idx, path}
  for (let i = 0; i < count; i++) {
    const m = Math.floor(i / shape.filesPerModule);
    const lang = langs[m];
    const sub = i % shape.subdirsPerModule;
    const idx = i % shape.filesPerModule;
    const rel = `mod${pad(m)}/sub${sub}/f${pad(idx)}.${ext[lang]}`;
    meta.push({ lang, m, sub, idx, rel });
    paths.push(rel);
  }
  const byModule = new Map();
  for (const f of meta) {
    if (!byModule.has(f.m)) byModule.set(f.m, []);
    byModule.get(f.m).push(f);
  }
  const [lo, hi] = shape.importsPerFile;
  const dirs = new Set();
  for (const f of meta) {
    const peers = byModule.get(f.m);
    const n = lo + Math.floor(rnd() * (hi - lo + 1));
    const deps = [];
    for (let k = 0; k < n; k++) {
      // Mostly in-module imports; some cross-module ones of the same language, as real repos have.
      const cross = rnd() < 0.15 && modules > 1;
      let target;
      if (cross) {
        const om = Math.floor(rnd() * modules);
        const pool = byModule.get(om);
        target = pool[Math.floor(rnd() * pool.length)];
      } else {
        target = peers[Math.floor(rnd() * peers.length)];
      }
      if (target === f || target.lang !== f.lang) continue;
      const stem = target.rel.replace(/\.[a-z]+$/, '');
      if (f.lang === 'ts') {
        const rel = relativeSpec(f.rel, stem);
        deps.push({ spec: rel });
      } else if (f.lang === 'py') {
        deps.push({ spec: stem.replace(/\//g, '.') });
      } else {
        const pkgDir = target.rel.slice(0, target.rel.lastIndexOf('/'));
        deps.push({ spec: `example.com/bench/${pkgDir}`, pkg: `sub${target.sub}` });
      }
    }
    const uniq = [...new Map(deps.map((d) => [d.spec, d])).values()].filter((d) => !(f.lang === 'go' && d.spec.endsWith(`/sub${f.sub}`) && d.spec.includes(`mod${pad(f.m)}/`)));
    const name = `run${pad(f.m)}x${f.sub}x${pad(f.idx)}`;
    let src = body(f.lang, rnd, name, uniq);
    if (f.lang === 'go') src = `package sub${f.sub}\n\n${src}`;
    const abs = join(dir, f.rel);
    const d = dirname(abs);
    if (!dirs.has(d)) {
      mkdirSync(d, { recursive: true });
      dirs.add(d);
    }
    writeFileSync(abs, src);
  }
  writeFileSync(join(dir, 'go.mod'), 'module example.com/bench\n\ngo 1.22\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bench-fixture', type: 'module' }));
  return paths;
}

function relativeSpec(fromRel, toStem) {
  const from = dirname(fromRel).split('/');
  const to = toStem.split('/');
  while (from.length && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const up = from.map(() => '..');
  return (up.length ? up : ['.']).concat(to).join('/');
}

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=bench@example.com', '-c', 'user.name=bench', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Child mode: build one fixture, time cold + incremental map, print JSON on stdout. */
async function runOne(label, count) {
  const home = mkdtempSync(join(os.tmpdir(), 'uk-bench-home-'));
  process.env.UNKNOT_HOME = home;
  delete process.env.CLAUDECODE;
  const dir = mkdtempSync(join(os.tmpdir(), 'uk-bench-repo-'));
  try {
    const t0 = Date.now();
    const paths = generateFixture(dir, count);
    g(dir, 'init', '-q');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-qm', 'fixture');
    const { openProject } = await import('../runtime/context.mjs');
    const { loadConfig } = await import('../runtime/policy/config.mjs');
    const { mapRepository } = await import('../runtime/graph/builder.mjs');
    const ctx = openProject(dir, { create: true });
    writeFileSync(join(dir, '.unknot', 'config.yaml'), 'version: 1\nmode: assist\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-qm', 'config');
    const cfg = loadConfig(ctx);
    const setupMs = Date.now() - t0;

    const rss = () => Math.round(process.resourceUsage().maxRSS / 1024); // KB → MB
    const c0 = Date.now();
    const cold = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
    const coldMs = Date.now() - c0;
    const coldRss = rss();

    // A small commit: append a function to a few files spread across the repository.
    const rnd = prng(SHAPE.seed + 1);
    for (let i = 0; i < SHAPE.incrementalTouchedFiles; i++) {
      const rel = paths[Math.floor(rnd() * paths.length)];
      const abs = join(dir, rel);
      const cur = readFileSync(abs, 'utf8');
      const add = rel.endsWith('.py') ? '\n\ndef touched(value):\n    return value\n' : rel.endsWith('.go') ? '\nfunc Touched(input int) int { return input }\n' : '\nexport function touched(input: number): number {\n  return input;\n}\n';
      writeFileSync(abs, cur + add);
    }
    g(dir, 'add', '-A');
    g(dir, 'commit', '-qm', 'small change');
    const i0 = Date.now();
    const inc = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
    const incMs = Date.now() - i0;
    return {
      label,
      files: count,
      setup_ms: setupMs,
      cold: { wall_ms: coldMs, peak_rss_mb: coldRss, nodes: cold.nodes, edges: cold.edges, extracted: cold.cache?.extracted, reused: cold.cache?.hits },
      incremental: { wall_ms: incMs, peak_rss_mb: rss(), touched_files: SHAPE.incrementalTouchedFiles, extracted: inc.cache?.extracted, reused: inc.cache?.hits },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

export function machineDescription() {
  return { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, ram_gb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.arch()}`, node: process.version };
}

export function toMarkdown(machine, results) {
  const sec = (ms) => (ms / 1000).toFixed(1);
  const rows = results.map((r) => `| ${r.label} | ${r.files.toLocaleString('en-US')} | ${sec(r.cold.wall_ms)} s | ${r.cold.peak_rss_mb} MB | ${sec(r.incremental.wall_ms)} s | ${r.incremental.peak_rss_mb} MB |`);
  return [
    `Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.ram_gb} GB RAM, ${machine.platform}, Node ${machine.node}.`,
    '',
    '| Fixture | Files | Cold map | Peak RSS (cold) | Incremental map (5 files changed) | Peak RSS (after incremental) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => args.includes(k);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (flag('--child')) {
    const label = opt('--child');
    process.stdout.write(`${JSON.stringify(await runOne(label, SHAPE.sizes[label]))}\n`);
    return;
  }
  let labels = opt('--sizes') ? opt('--sizes').split(',') : ['1k', '10k'];
  if (flag('--quick')) labels = ['quick'];
  else if (flag('--large') && !labels.includes('100k')) labels.push('100k');
  const out = opt('--out') ?? join(os.tmpdir(), 'unknot-bench');
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const label of labels) {
    if (!SHAPE.sizes[label]) throw new Error(`unknown size ${label}`);
    process.stderr.write(`bench ${label} (${SHAPE.sizes[label]} files)...\n`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', label], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
    if (child.status !== 0) throw new Error(`bench ${label} failed`);
    results.push(JSON.parse(child.stdout.trim().split('\n').at(-1)));
  }
  const machine = machineDescription();
  writeFileSync(join(out, 'results.json'), `${JSON.stringify({ machine, shape: SHAPE, results }, null, 2)}\n`);
  const md = toMarkdown(machine, results);
  writeFileSync(join(out, 'results.md'), md);
  process.stdout.write(`${md}\nresults written to ${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`bench: ${err.message}\n`);
    process.exit(1);
  });
}
