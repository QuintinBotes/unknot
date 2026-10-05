// Shared harness for golden-repository and acceptance-scenario tests. Importing this
// module pins UNKNOT_HOME to a temp dir BEFORE any runtime module loads.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.UNKNOT_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'uk-golden-home-')));
delete process.env.CLAUDECODE;

export const FIXTURES = fileURLToPath(new URL('../fixtures/golden/', import.meta.url));

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { diagnose } = await import('../../runtime/diagnose/engine.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');

export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

/** Copy a golden fixture into a fresh git repo; `extra` maps relative paths to contents. */
export function materialize(name, extra = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `uk-golden-${name}-`)));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  for (const [p, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'golden');
  return dir;
}

/**
 * Open the project, accept a config like a human would, map and diagnose.
 * `config` is the repository config (mode stays plan unless given).
 */
export async function analyse(name, { config = {}, extra = {}, only = null, skipDiagnose = false } = {}) {
  const dir = materialize(name, extra);
  const ctx = openProject(dir, { create: true });
  const text = stringifyYAML({ version: 1, mode: 'plan', protected_paths: [], ...config });
  writeFileSync(join(dir, '.unknot/config.yaml'), text);
  recordAcceptedConfig(ctx, text, 'human:golden');
  const cfg = loadConfig(ctx);
  const mapped = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
  const diag = skipDiagnose ? { findings: [], errors: [] } : await diagnose(ctx, { config: cfg.config, only });
  return { dir, ctx, cfg, config: cfg.config, mapped, diag, findings: diag.findings, errors: diag.errors.filter((e) => !/not installed/.test(e.error)) };
}

export const kinds = (findings) => [...new Set(findings.map((f) => f.kind))].sort();
export const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

const LABELS = new Set(['observed', 'corroborated', 'inferred', 'unknown', 'contradicted']);

/** Every finding: evidence with a provenance label, and `retain` among the alternatives. */
export function assertWellFormed(findings) {
  assert.ok(findings.length > 0, 'expected at least one finding');
  for (const f of findings) {
    assert.ok(f.evidence.length > 0, `${f.kind} has evidence`);
    for (const e of f.evidence) assert.ok(LABELS.has(e.label), `${f.kind} evidence label ${e.label}`);
    assert.ok(f.alternatives.some((a) => a.id === 'retain'), `${f.kind} offers retain`);
    assert.ok(f.detector?.id, `${f.kind} names its detector`);
  }
}

export function assertKinds(findings, expected) {
  const have = new Set(kinds(findings));
  for (const k of expected) assert.ok(have.has(k), `expected finding kind ${k}; got ${[...have].join(', ')}`);
}

export function assertAbsent(findings, absent) {
  const have = new Set(kinds(findings));
  for (const k of absent) assert.ok(!have.has(k), `unexpected finding kind ${k}`);
}

export const read = (dir, p) => readFileSync(join(dir, p), 'utf8');
export { loadConfig, recordAcceptedConfig, openProject, mapRepository, diagnose, stringifyYAML };
