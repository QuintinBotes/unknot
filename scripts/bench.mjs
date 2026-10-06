#!/usr/bin/env node
// Published benchmark (spec §28): deterministic fixture repositories, cold and incremental
// `unknot map` timed in-process, with peak RSS, store size and time per phase. Numbers come from
// running this script on a stated machine; docs/benchmarks.md records one such run and how to
// reproduce it.
//
//   node scripts/bench.mjs [--quick] [--large] [--sizes 1k,50k,250k,1m] [--out <dir>] [--work <dir>] [--keep]
//
// Each size runs in its own child process so `maxRSS` (a process-lifetime high-water mark)
// is attributable to that size alone. Fixtures are generated under --work (default: the system
// temp directory), never inside this repository, and removed afterwards unless --keep is given.
// 1m (a million files) runs only when named in --sizes.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const EXT = { ts: 'ts', py: 'py', go: 'go', cs: 'cs', java: 'java' };

/** Where file `f` lives and what it is called; every tenth file of a module is a test. */
function layout(f) {
  const isTest = f.idx % 10 === 9;
  const dir = `mod${pad(f.m)}/sub${f.sub}`;
  const stem = `f${pad(f.idx)}`;
  const cls = `C${pad(f.m)}x${f.sub}x${pad(f.idx)}`;
  const file = { ts: isTest ? `${stem}.test` : stem, py: isTest ? `test_${stem}` : stem, go: isTest ? `${stem}_test` : stem, cs: isTest ? `${cls}Tests` : cls, java: isTest ? `${cls}Test` : cls }[f.lang];
  return { isTest, dir, stem, cls, rel: `${dir}/${file}.${EXT[f.lang]}`, ns: { cs: `Bench.Mod${pad(f.m)}.Sub${f.sub}`, java: `bench.mod${pad(f.m)}.sub${f.sub}` }[f.lang] };
}

function body(f, rnd, deps) {
  const branches = 1 + Math.floor(rnd() * 4);
  const name = `run${pad(f.m)}x${f.sub}x${pad(f.idx)}`;
  const Name = `${name[0].toUpperCase()}${name.slice(1)}`;
  if (f.lang === 'ts') {
    const imports = deps.map((d, i) => `import { fn${i} as dep${i} } from '${d.spec}';`).join('\n');
    const calls = deps.map((_, i) => `  total += dep${i}(input + ${i});`).join('\n');
    const ifs = Array.from({ length: branches }, (_, i) => `  if (input % ${i + 2} === 0) total += ${i};`).join('\n');
    return `${imports}\n\nexport function ${name}(input: number): number {\n  let total = 0;\n${calls}\n${ifs}\n  return total;\n}\n\nexport function fn0(input: number): number {\n  return ${name}(input) + 1;\n}\n\nexport function fn1(input: number): number {\n  return ${name}(input) * 2;\n}\n`;
  }
  if (f.lang === 'py') {
    const imports = deps.map((d, i) => `from ${d.spec} import fn${i} as dep${i}`).join('\n');
    const calls = deps.map((_, i) => `    total += dep${i}(value + ${i})`).join('\n');
    const ifs = Array.from({ length: branches }, (_, i) => `    if value % ${i + 2} == 0:\n        total += ${i}`).join('\n');
    return `${imports}\n\n\ndef ${name}(value):\n    total = 0\n${calls}\n${ifs}\n    return total\n\n\ndef fn0(value):\n    return ${name}(value) + 1\n\n\ndef fn1(value):\n    return ${name}(value) * 2\n`;
  }
  if (f.lang === 'go') {
    const imports = deps.length ? `import (\n${deps.map((d) => `\t"${d.spec}"`).join('\n')}\n)\n\n` : '';
    const calls = deps.map((d) => `\ttotal += ${d.pkg}.Fn0(input)`).join('\n');
    const ifs = Array.from({ length: branches }, (_, i) => `\tif input%${i + 2} == 0 {\n\t\ttotal += ${i}\n\t}`).join('\n');
    return `package sub${f.sub}\n\n${imports}func ${Name}(input int) int {\n\ttotal := 0\n${calls}\n${ifs}\n\treturn total\n}\n\nfunc Fn0(input int) int { return ${Name}(input) + 1 }\n`;
  }
  const ifs = Array.from({ length: branches }, (_, i) => `        if (input % ${i + 2} == 0) total += ${i};`).join('\n');
  const self = layout(f);
  if (f.lang === 'cs') {
    const usings = [...new Set(deps.map((d) => d.ns))].map((n) => `using ${n};`).join('\n');
    const calls = deps.map((d) => `        total += ${d.cls}.Fn0(input);`).join('\n');
    const test = self.isTest ? '\n    [Fact]\n    public void Runs() { Assert.True(Fn0(1) >= 0); }\n' : '';
    return `${usings}${usings ? '\n\n' : ''}namespace ${self.ns};\n\npublic static class ${self.cls}${self.isTest ? 'Tests' : ''}\n{\n    public static int ${Name}(int input)\n    {\n        var total = 0;\n${calls}\n${ifs}\n        return total;\n    }\n\n    public static int Fn0(int input) { return ${Name}(input) + 1; }\n${test}}\n`;
  }
  const imports = [...new Set(deps.map((d) => `import ${d.ns}.${d.cls};`))].join('\n');
  const calls = deps.map((d) => `        total += ${d.cls}.fn0(input);`).join('\n');
  const test = self.isTest ? '\n    @Test\n    public void runs() { assert fn0(1) >= 0; }\n' : '';
  return `package ${self.ns};\n\n${imports}${imports ? '\n\n' : ''}public class ${self.cls}${self.isTest ? 'Test' : ''} {\n    public static int ${name}(int input) {\n        int total = 0;\n${calls}\n${ifs}\n        return total;\n    }\n\n    public static int fn0(int input) { return ${name}(input) + 1; }\n${test}}\n`;
}

/** Append a small function to a generated file, in the file's own language. */
export function touch(rel, text) {
  const ext = rel.slice(rel.lastIndexOf('.') + 1);
  const add = {
    py: '\n\ndef touched(value):\n    return value\n',
    go: '\nfunc Touched(input int) int { return input }\n',
    ts: '\nexport function touched(input: number): number {\n  return input;\n}\n',
  };
  if (add[ext]) return text + add[ext];
  const at = text.lastIndexOf('}');
  const method = ext === 'cs' ? '\n    public static int Touched(int input) { return input; }\n' : '\n    public static int touched(int input) { return input; }\n';
  return text.slice(0, at) + method + text.slice(at);
}

/**
 * Generate a repository of about `count` files at `dir`; returns the list of relative paths.
 * Modules are single-language (a seeded mix of TypeScript, Python, C#, Java and Go), each with
 * tests, mostly in-module imports, some cross-module ones, and a three-file import cycle
 * (not in Go, where import cycles do not compile).
 */
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
  const meta = [];
  for (let i = 0; i < count; i++) {
    const m = Math.floor(i / shape.filesPerModule);
    const f = { lang: langs[m], m, sub: i % shape.subdirsPerModule, idx: i % shape.filesPerModule };
    f.lay = layout(f);
    f.rel = f.lay.rel;
    meta.push(f);
  }
  const byModule = new Map();
  const pool = new Map(); // module → importable (non-test) files
  for (const f of meta) {
    if (!byModule.has(f.m)) byModule.set(f.m, []);
    byModule.get(f.m).push(f);
    if (!f.lay.isTest) {
      if (!pool.has(f.m)) pool.set(f.m, []);
      pool.get(f.m).push(f);
    }
  }
  const [lo, hi] = shape.importsPerFile;
  const dirs = new Set();
  const dep = (f, target) => {
    const t = target.lay;
    if (f.lang === 'ts') return { spec: relativeSpec(f.rel, `${t.dir}/${t.stem}`) };
    if (f.lang === 'py') return { spec: `${t.dir}/${t.stem}`.replace(/\//g, '.') };
    if (f.lang === 'go') return { spec: `example.com/bench/${t.dir}`, pkg: `sub${target.sub}` };
    return { ns: t.ns, cls: t.cls };
  };
  for (const f of meta) {
    const peers = pool.get(f.m);
    const n = lo + Math.floor(rnd() * (hi - lo + 1));
    const targets = [];
    for (let k = 0; k < n; k++) {
      const cross = rnd() < 0.15 && modules > 1;
      const from = cross ? pool.get(Math.floor(rnd() * modules)) : peers;
      const target = from?.[Math.floor(rnd() * from.length)];
      if (target && target !== f && target.lang === f.lang) targets.push(target);
    }
    // A test imports the code under test; files 0 to 2 of a module import each other in a ring.
    if (f.lay.isTest) targets.push(peers[f.idx % peers.length]);
    if (f.idx < 3 && f.lang !== 'go' && byModule.get(f.m).length > 3) targets.push(byModule.get(f.m)[(f.idx + 1) % 3]);
    const seen = new Set();
    const deps = [];
    for (const t of targets) {
      const d = dep(f, t);
      const key = d.cls ? `${d.ns}.${d.cls}` : d.spec;
      if (t === f || seen.has(key) || (f.lang === 'go' && t.m === f.m && t.sub === f.sub)) continue;
      seen.add(key);
      deps.push(d);
    }
    const abs = join(dir, f.rel);
    const d = dirname(abs);
    if (!dirs.has(d)) {
      mkdirSync(d, { recursive: true });
      dirs.add(d);
    }
    writeFileSync(abs, body(f, rnd, deps));
  }
  writeFileSync(join(dir, 'go.mod'), 'module example.com/bench\n\ngo 1.22\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bench-fixture', type: 'module' }));
  return meta.map((f) => f.rel);
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

function dirSize(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return n;
}

const log = (msg) => process.stderr.write(`  ${new Date().toISOString().slice(11, 19)} ${msg}\n`);

/** Child mode: build one fixture, time cold, unchanged and changed maps, print JSON on stdout. */
async function runOne(label, count, work) {
  const home = mkdtempSync(join(work, 'uk-bench-home-'));
  process.env.UNKNOT_HOME = home;
  delete process.env.CLAUDECODE;
  const dir = mkdtempSync(join(work, 'uk-bench-repo-'));
  try {
    const t0 = Date.now();
    const paths = generateFixture(dir, count);
    const generateMs = Date.now() - t0;
    log(`generated ${count} files in ${(generateMs / 1000).toFixed(0)} s`);
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
    log(`setup (generate, git) ${(setupMs / 1000).toFixed(0)} s`);

    const rss = () => Math.round(process.resourceUsage().maxRSS / 1024); // KB → MB
    const stage = async (name) => {
      const s0 = Date.now();
      const r = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
      const wall = Date.now() - s0;
      log(`${name}: ${(wall / 1000).toFixed(1)} s, peak RSS ${rss()} MB`);
      return { wall_ms: wall, peak_rss_mb: rss(), nodes: r.nodes, edges: r.edges, extracted: r.cache?.extracted, reused: r.cache?.hits, phases: r.phases, status: r.status, failures: r.failure_count };
    };
    const cold = await stage('cold map');
    const unchanged = await stage('re-map, no change');

    // A small commit: append a function to files spread across the repository.
    const rnd = prng(SHAPE.seed + 1);
    for (let i = 0; i < SHAPE.incrementalTouchedFiles; i++) {
      const rel = paths[Math.floor(rnd() * paths.length)];
      const abs = join(dir, rel);
      writeFileSync(abs, touch(rel, readFileSync(abs, 'utf8')));
    }
    g(dir, 'add', '-A');
    g(dir, 'commit', '-qm', 'small change');
    const changed = await stage(`re-map, ${SHAPE.incrementalTouchedFiles} files changed`);
    return {
      label,
      files: count,
      setup_ms: setupMs,
      store_mb: Math.round(dirSize(join(dir, '.unknot')) / 2 ** 20),
      cold,
      unchanged,
      incremental: { ...changed, touched_files: SHAPE.incrementalTouchedFiles },
    };
  } finally {
    if (!process.env.UNKNOT_BENCH_KEEP) {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
}

export function machineDescription() {
  return { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, ram_gb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.arch()}`, node: process.version };
}

const PHASES = ['census_ms', 'extraction_ms', 'link_ms', 'discovery_ms', 'history_ms', 'coverage_ms', 'projection_ms'];

export function toMarkdown(machine, results) {
  const sec = (ms) => (ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
  const rows = results.map((r) => `| ${r.label} | ${r.files.toLocaleString('en-US')} | ${sec(r.cold.wall_ms)} | ${sec(r.unchanged?.wall_ms)} | ${sec(r.incremental.wall_ms)} | ${r.incremental.peak_rss_mb} MB | ${r.store_mb ?? 'n/a'} MB |`);
  const phaseRows = [];
  for (const r of results) {
    for (const [name, run] of [['cold', r.cold], ['no change', r.unchanged], [`${r.incremental.touched_files} changed`, r.incremental]]) {
      if (run?.phases) phaseRows.push(`| ${r.label} ${name} | ${PHASES.map((p) => sec(run.phases[p])).join(' | ')} |`);
    }
  }
  return [
    `Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.ram_gb} GB RAM, ${machine.platform}, Node ${machine.node}.`,
    '',
    '| Fixture | Files | Cold map | Re-map, no change | Re-map, files changed | Peak RSS (whole run) | Store size |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    '| Run | Census | Extraction | Link | Discovery | History | Coverage | Projection |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...phaseRows,
    '',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => args.includes(k);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const work = opt('--work') ?? os.tmpdir();
  if (flag('--keep')) process.env.UNKNOT_BENCH_KEEP = '1';
  if (flag('--child')) {
    const label = opt('--child');
    process.stdout.write(`${JSON.stringify(await runOne(label, SHAPE.sizes[label], work))}\n`);
    return;
  }
  let labels = opt('--sizes') ? opt('--sizes').split(',') : ['1k', '10k'];
  if (flag('--quick')) labels = ['quick'];
  else if (flag('--large') && !labels.includes('100k')) labels.push('100k');
  const out = opt('--out') ?? join(os.tmpdir(), 'unknot-bench');
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const results = [];
  for (const label of labels) {
    if (!SHAPE.sizes[label]) throw new Error(`unknown size ${label}`);
    process.stderr.write(`bench ${label} (${SHAPE.sizes[label]} files)...\n`);
    // Large graphs are held in memory while linking: raise the heap limit above Node's default.
    const heap = `--max-old-space-size=${Number(opt('--heap-mb') ?? 16384)}`;
    const child = spawnSync(process.execPath, [heap, fileURLToPath(import.meta.url), '--child', label, '--work', work, ...(flag('--keep') ? ['--keep'] : [])], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
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
