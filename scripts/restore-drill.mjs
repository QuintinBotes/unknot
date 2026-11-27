#!/usr/bin/env node
// Restore drill (docs/operations.md §4), run on every release tag: map and plan a fixture,
// approve the plan with a test approver key, export an audit checkpoint, back up, wipe the
// project state, restore with the checkpoint as the anchor, and verify the restored ledger
// against it through the real CLI. It also checks that the anchor bites: a restore against
// a checkpoint the backup does not extend must be refused. Exit 1 on any failure.
//
// Usage: node scripts/restore-drill.mjs [--keep]

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keep = process.argv.includes('--keep');
const T = mkdtempSync(join(realpathSync(tmpdir()), 'uk-drill-'));
process.env.UNKNOT_HOME = join(T, 'home');
const dir = join(T, 'project');
const U = new URL('../runtime/', import.meta.url).pathname;
const BIN = new URL('../bin/unknot', import.meta.url).pathname;

const failures = [];
const step = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}\n`);
  if (!ok) failures.push(name);
  return ok;
};
const cli = (cwd, ...argv) => spawnSync(process.execPath, [BIN, ...argv], { cwd, encoding: 'utf8', env: process.env });
const said = (r) => (r.stdout + r.stderr).trim().split('\n').slice(-1)[0];

try {
  // ---- a fixture project, mapped and planned, with the plan approved ----
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/orders.js'), "import { price } from './price.js';\nexport function total(items) {\n  let t = 0;\n  for (const i of items) t += price(i);\n  return t;\n}\n");
  writeFileSync(join(dir, 'src/price.js'), 'export function price(i) {\n  return i.qty * i.unit;\n}\n');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.email=drill@example.invalid', '-c', 'user.name=drill', 'commit', '-qm', 'fixture');

  const { openProject } = await import(`${U}context.mjs`);
  const { loadConfig, recordAcceptedConfig } = await import(`${U}policy/config.mjs`);
  const { stringifyYAML } = await import(`${U}core/yaml.mjs`);
  const { generateApproverKey, loadApproverKey } = await import(`${U}core/keys.mjs`);
  const { mapRepository } = await import(`${U}graph/builder.mjs`);
  const { createCampaign } = await import(`${U}plan/campaign.mjs`);
  const { recordApproval } = await import(`${U}policy/approvals.mjs`);
  const { loadSlice, currentBinding, approvalStatus } = await import(`${U}apply/apply.mjs`);
  const { startRun, endRun } = await import(`${U}state/runs.mjs`);
  const { readEvents } = await import(`${U}state/ledger.mjs`);

  const ctx = openProject(dir, { create: true });
  const pub = generateApproverKey('tester', 'drill passphrase');
  const cfgText = stringifyYAML({ version: 1, mode: 'assist', approvers: { tester: { roles: ['code-owner', 'affected-owner'], public_key: pub } } });
  writeFileSync(join(dir, '.unknot/config.yaml'), cfgText);
  recordAcceptedConfig(ctx, cfgText, 'human:tester');
  const cfg = loadConfig(ctx);
  const run = startRun(ctx, { command: 'plan', actor: 'human:tester', config: cfg.config, configDigest: cfg.digest });
  const m = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, run });
  step('map', m.status !== 'failed', `${m.files} files`);
  const { slices } = createCampaign(ctx, {
    config: cfg.config, actor: 'human:tester', objective: 'Inline the price helper into orders',
    proposal: { rationale: 'drill', slices: [{ objective: 'Inline price into total', kind: 'code', scope: { include: ['src/orders.js'], exclude: [] }, invariants: ['Observable behaviour is unchanged'], sources: [], changes: [{ path: 'src/orders.js', operation: 'modify', description: 'Inline price' }] }] },
  });
  const s = loadSlice(ctx, slices[0].id);
  const key = loadApproverKey('tester', 'drill passphrase');
  const commit = git('rev-parse', 'HEAD').trim();
  for (const role of s.body.approvals) recordApproval(ctx, { config: cfg.config, slice: s, binding: currentBinding(ctx, s, 'plan', { cfg, commit }), role, approver: 'tester', privateKey: key });
  endRun(ctx, run.id);
  step('plan approved', approvalStatus(ctx, s, 'plan', { cfg, commit }).satisfied, s.id);
  ctx.store.close();

  // ---- checkpoint, back up, wipe, restore with the anchor, verify ----
  const anchor = join(T, 'anchor.json');
  const passFile = join(T, 'pass');
  writeFileSync(passFile, 'a drill backup passphrase\n', { mode: 0o600 });
  const backup = join(T, 'drill.ukb');
  let r = cli(dir, 'audit', 'checkpoint', '--out', anchor);
  step('audit checkpoint', r.status === 0 && existsSync(anchor), said(r));
  r = cli(dir, 'backup', 'create', backup, '--passphrase-file', passFile);
  step('backup create', r.status === 0, said(r));
  rmSync(join(dir, '.unknot'), { recursive: true, force: true });
  step('wipe', !existsSync(join(dir, '.unknot')));

  const restored = join(T, 'restored');
  r = cli(T, 'backup', 'restore', backup, '--to', restored, '--anchor', anchor, '--passphrase-file', passFile);
  step('backup restore --anchor', r.status === 0 && /checked against the anchor/.test(r.stdout), said(r));
  r = cli(restored, 'audit', 'verify', '--anchor', anchor);
  step('audit verify --anchor', r.status === 0, said(r));
  const back = openProject(restored, { readOnly: true });
  step('slice and approval restored', existsSync(join(restored, '.unknot/slices', `${s.id}.yaml`)) && readEvents(back.store, { sliceId: s.id, type: 'approval.recorded' }).length === s.body.approvals.length);
  back.store.close();

  // ---- the anchor must bite: a checkpoint ahead of the backup is a truncated ledger ----
  const ahead = JSON.parse(readFileSync(anchor, 'utf8'));
  ahead.count += 1;
  const aheadFile = join(T, 'ahead.json');
  writeFileSync(aheadFile, JSON.stringify(ahead));
  r = cli(T, 'backup', 'restore', backup, '--to', join(T, 'refused'), '--anchor', aheadFile, '--passphrase-file', passFile);
  step('restore against a later anchor is refused', r.status !== 0 && /truncated/.test(r.stdout + r.stderr) && !existsSync(join(T, 'refused')), said(r));
} catch (err) {
  step('drill', false, err.stack ?? String(err));
} finally {
  if (keep) process.stdout.write(`kept ${T}\n`);
  else rmSync(T, { recursive: true, force: true });
}
process.stdout.write(failures.length ? `restore drill FAILED: ${failures.join(', ')}\n` : 'restore drill passed\n');
process.exit(failures.length ? 1 : 0);
