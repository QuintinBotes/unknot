// Shared fixtures for the safety-kernel tests. Importing this module pins
// CLAUDE_PLUGIN_ROOT and UNKNOT_HOME *before* any runtime module loads (keys are memoised
// and the hook handlers capture the plugin root at import time).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.CLAUDE_PLUGIN_ROOT = REPO_ROOT;
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'uk-home-')));
process.env.UNKNOT_HOME = HOME;

const m = async (p) => import(new URL(`../../runtime/${p}`, import.meta.url).href);

export const keys = await m('core/keys.mjs');
export const clock = await m('core/clock.mjs');
export const canonical = await m('core/canonical.mjs');
export const errors = await m('core/errors.mjs');
export const defaults = await m('policy/defaults.mjs');
export const store = await m('state/store.mjs');
export const ledger = await m('state/ledger.mjs');
export const machine = await m('state/machine.mjs');
export const runs = await m('state/runs.mjs');
export const configMod = await m('policy/config.mjs');
export const cas = await m('state/cas.mjs');
export const handoff = await m('state/handoff.mjs');
export const budget = await m('policy/budget.mjs');
export const approvals = await m('policy/approvals.mjs');
export const risk = await m('policy/risk.mjs');
export const capability = await m('policy/capability.mjs');
export const pdp = await m('policy/pdp.mjs');
export const commands = await m('policy/commands.mjs');
export const merge = await m('policy/merge.mjs');
export const policyConfig = await m('policy/config.mjs');
export const broker = await m('broker/broker.mjs');
export const sandbox = await m('broker/sandbox.mjs');
export const worktree = await m('apply/worktree.mjs');
export const context = await m('context.mjs');
export const handlers = await m('hooks/handlers.mjs');

export const { DEFAULT_CONFIG } = defaults;

/** structuredClone(DEFAULT_CONFIG) with shallow-per-section overrides. */
export const cfg = (over = {}) => {
  const c = structuredClone(DEFAULT_CONFIG);
  for (const [k, v] of Object.entries(over)) {
    c[k] = v && typeof v === 'object' && !Array.isArray(v) && c[k] && typeof c[k] === 'object' ? { ...c[k], ...v } : v;
  }
  return c;
};

const GIT_ID = ['-c', 'user.email=t@e', '-c', 'user.name=t'];
export function git(cwd, ...args) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const made = [];

/**
 * A fresh git project with its own UNKNOT_HOME, opened store and keys.
 * @param {{files?: Record<string,string>, config?: string|null}} [opts]
 */
export function makeProject({ files = {}, config = null } = {}) {
  // One UNKNOT_HOME per test process (project ids are unique, so keys never collide).
  process.env.UNKNOT_HOME = HOME;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uk-proj-')));
  git(dir, 'init', '-q', '-b', 'main');
  const all = { 'README.md': '# t\n', 'src/a.js': 'export const a = 1;\n', 'src/b.js': 'export const b = 2;\n', ...files };
  for (const [p, body] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const ctx = context.openProject(dir, { create: true });
  if (config !== null) {
    writeFileSync(join(ctx.paths.base, 'config.yaml'), config);
    // A person accepts the config at a terminal; tests record that acceptance directly.
    configMod.recordAcceptedConfig(ctx, config, 'human:test');
  }
  const home = HOME;
  keys.auditPrivateKey(ctx.projectId);
  keys.cacheKey(ctx.projectId);
  keys.capabilityKey(ctx.projectId);
  const p = { dir, home, ctx, commit: git(dir, 'rev-parse', 'HEAD') };
  made.push(p);
  return p;
}

export function startTestRun(p, { command = 'diagnose', mode = 'plan', over = {}, slice_id = null } = {}) {
  const config = cfg({ mode, ...over });
  const run = runs.startRun(p.ctx, { command, actor: 'human:test', config, configDigest: 'sha256:cfg', slice_id, supersede: true });
  return { run, config };
}

let sliceN = 0;
/** Insert a slice row directly. `body` is merged over a minimal body. */
export function insertSlice(ctx, { id, state = 'PATCHING', risk = 'low', body = {}, worktree = null, baseline = null } = {}) {
  id ??= `UK-${1000 + ++sliceN}`;
  const b = { id, version: 1, objective: 'test slice', scope: { include: ['src/**'], exclude: [] }, changes: [], ...body };
  const now = new Date().toISOString();
  ctx.store.insert('slices', {
    id, campaign_id: null, schema_version: '1.0', state, risk, body: b,
    slice_digest: canonical.digest(b), worktree, branch: worktree ? `unknot/${id}` : null,
    baseline_commit: baseline, diff_hash: null, created_at: now, updated_at: now,
  });
  return loadSlice(ctx, id);
}

/** Slice row as the PDP/approvals expect it (body parsed). */
export const parsed = (row) => ({ ...row, body: typeof row.body === 'string' ? JSON.parse(row.body) : row.body });
export const loadSlice = (ctx, id) => parsed(ctx.store.get('SELECT * FROM slices WHERE id = ?', id));

export function cleanup() {
  store.closeAllStores();
  clock.resetClock();
  for (const p of made.splice(0)) {
    rmSync(p.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  rmSync(HOME, { recursive: true, force: true });
}
