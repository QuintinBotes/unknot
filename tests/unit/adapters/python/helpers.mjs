// Shared test plumbing: load a fixture tree, run the adapter through either parser, and
// link the result the way the runtime would.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import adapter from '../../../../adapters/language/python/index.mjs';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'python');
export const EXTRACT_PY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'adapters', 'language', 'python', 'extract.py');

export const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

/** Read every file under fixtures/python/<name> as { file, text } with root-relative paths. */
export function loadFixture(name) {
  const root = join(FIXTURES, name);
  const items = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else items.push({ file: { path: relative(root, full).split('\\').join('/') }, text: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return items;
}

/** A ctx.exec stand-in: no shell, argv only, like the broker. */
export function realExec(argv, { input, timeoutMs } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { input, encoding: 'utf8', timeout: timeoutMs, shell: false });
  return Promise.resolve({ exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
}

export function unsupportedExec() {
  const err = new Error('python3 is not permitted');
  err.code = 'UK_ADAPTER_UNSUPPORTED';
  return Promise.reject(err);
}

/** Extract a fixture through extractBatch with the given exec; returns Map<path, facts>. */
export async function extractFixture(name, exec = realExec) {
  return adapter.extractBatch(loadFixture(name), { exec, options: {} });
}

export function linkFacts(factsByFile, options = {}) {
  const files = new Map([...factsByFile.keys()].map((p) => [p, { path: p }]));
  return adapter.link({ files, factsByFile, options });
}

export const nodes = (facts, type) => facts.filter((f) => f.kind === 'node' && (!type || f.type === type));
export const edges = (facts, type) => facts.filter((f) => f.kind === 'edge' && (!type || f.type === type));
export const find = (facts, id) => facts.find((f) => f.kind === 'node' && f.id === id);
export const all = (map) => [...map.values()].flat();
