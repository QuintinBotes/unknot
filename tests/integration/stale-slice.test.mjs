// A slice planned from a finding keeps its state and approvals when a re-map no longer produces
// that finding, and says its evidence is stale: in `status`, in `slice` and in the MCP tools.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'uk-home-'));
process.env.UNKNOT_HOME = home;
delete process.env.CLAUDECODE;

const BIN = fileURLToPath(new URL('../../bin/unknot', import.meta.url));
const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { diagnose } = await import('../../runtime/diagnose/engine.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { loadSlice } = await import('../../runtime/apply/apply.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');
const { TOOLS } = await import('../../runtime/mcp/tools.mjs');

const BRANCHY = `export function classify(order) {
  let label = 'unknown';
  if (order) {
    if (order.total > 1000) {
      if (order.vip) {
        label = 'priority-vip';
      } else {
        label = 'priority';
      }
    } else if (order.total > 100) {
      label = order.vip ? 'standard-vip' : 'standard';
    }
  }
  return label;
}
`;

const FLAT = `export function classify(order) {
  return order ? 'standard' : 'unknown';
}
`;

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
const cli = (dir, ...args) => JSON.parse(spawnSync(process.execPath, [BIN, ...args, '--json', '--cwd', dir], { encoding: 'utf8', env: { ...process.env, UNKNOT_HOME: home } }).stdout);

test('a slice whose finding disappears after a re-map is flagged stale, and nothing else changes', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-proj-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/classify.mjs'), BRANCHY);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  const ctx = openProject(dir, { create: true });
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({ version: 1, mode: 'assist', protected_paths: [], detectors: { 'local.complex-function': { cyclomatic: 5, cognitive: 5 }, 'local.deep-nesting': { max_nesting: 2 } } }));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'unknot config');
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  const cfg = loadConfig(ctx);

  await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
  const diag = await diagnose(ctx, { config: cfg.config, only: ['local'] });
  const finding = diag.findings.find((f) => f.scope.includes('src/classify.mjs'));
  assert.ok(finding, 'a finding on classify');
  const { slices } = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Flatten classify', findings: [finding.id] });
  const sliceId = slices[0].id;

  assert.equal(cli(dir, 'status').stale_evidence.slices.length, 0);
  assert.equal(cli(dir, 'slice', sliceId).stale_evidence, undefined);

  writeFileSync(join(dir, 'src/classify.mjs'), FLAT);
  g(dir, 'commit', '-qam', 'flatten');
  await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
  await diagnose(ctx, { config: cfg.config });

  const status = cli(dir, 'status');
  assert.equal(status.stale_evidence.slices[0].slice_id, sliceId);
  assert.equal(status.stale_evidence.slices[0].findings[0].finding_id, finding.id);
  const slice = cli(dir, 'slice', sliceId);
  assert.equal(slice.state, 'AWAITING_APPROVAL', 'state is untouched');
  assert.match(slice.stale_evidence[0].message, new RegExp(`${finding.id} is no longer reported`));
  const tool = TOOLS.slice_get.run(ctx, { id: sliceId });
  assert.equal(tool.stale_evidence[0].finding_id, finding.id);
  assert.equal(TOOLS.status.run(ctx).stale_slices[0].slice_id, sliceId);
  assert.equal(loadSlice(ctx, sliceId).state, 'AWAITING_APPROVAL');
});
