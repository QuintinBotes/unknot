#!/usr/bin/env node
// Opt-in SCIP benchmark for #29. It deliberately does not install a tool or use the network:
// the result is either measured on a local scip-typescript installation or an exact skip reason.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableOnPath } from '../adapters/semantic/scip/indexers.mjs';

const FILES = 3_000;
const here = fileURLToPath(import.meta.url);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture(root) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"scip-bench","private":true}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}\n');
  for (let i = 0; i < FILES; i++) {
    const importLine = i ? `import { value${i - 1} } from './f${i - 1}.js';\n` : '';
    const body = `${importLine}export const value${i} = ${i}${i ? ` + value${i - 1}` : ''};\nexport function fn${i}(n: number) { return n + value${i}; }\n`;
    writeFileSync(join(root, 'src', `f${i}.ts`), body);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
}

async function child(run) {
  const base = mkdtempSync(join(tmpdir(), 'uk-scip-bench-'));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root);
  mkdirSync(home);
  process.env.UNKNOT_HOME = home;
  try {
    fixture(root);
    const { openProject } = await import('../runtime/context.mjs');
    const { DEFAULT_CONFIG } = await import('../runtime/policy/defaults.mjs');
    const { mapRepository } = await import('../runtime/graph/builder.mjs');
    const ctx = openProject(root, { create: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.scip = { run, languages: ['typescript'] };
    const started = Date.now();
    const result = await mapRepository(ctx, { config, configDigest: `scip-bench-${run ? 'on' : 'off'}`, history: false });
    const coverage = result.scip?.coverage?.typescript;
    return {
      run,
      files: FILES,
      wall_ms: Date.now() - started,
      peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
      status: result.status,
      scip: result.scip ?? null,
      coverage: coverage ?? null,
      ...(run && coverage?.quality !== 'semantic' && { reason: coverage?.reason ?? 'the indexer produced no semantic TypeScript coverage' }),
    };
  } catch (err) {
    return { run, files: FILES, skipped: true, reason: `${err.code ?? 'error'}: ${err.message}` };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--child')) {
    process.stdout.write(`${JSON.stringify(await child(process.argv.includes('--run')))}\n`);
    return;
  }
  if (!executableOnPath('scip-typescript')) {
    process.stdout.write(`${JSON.stringify({ files: FILES, skipped: true, reason: 'scip-typescript is not on PATH; no supported SCIP indexer was available' })}\n`);
    return;
  }
  const one = (run) => {
    const result = spawnSync(process.execPath, [here, '--child', ...(run ? ['--run'] : [])], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) return { run, files: FILES, skipped: true, reason: `benchmark child exited ${result.status}: ${result.stderr.trim()}` };
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const off = one(false);
  const on = one(true);
  if (on.reason) {
    process.stdout.write(`${JSON.stringify({ files: FILES, skipped: true, reason: `scip-typescript did not produce semantic coverage: ${on.reason}`, off, on })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ files: FILES, off, on })}\n`);
}

await main();
