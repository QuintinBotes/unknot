// Hook checks run on the slice's changed files, not the whole tree, so a violation the slice
// did not make does not block it (#137). Plan, apply and verify with a fake pre-commit.

import '../helpers/git-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { mkTmp } from '../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;

// A fake pre-commit that covers *.mjs files and fails on any it is given that contains VIOLATION;
// `--all-files` checks every *.mjs in the tree, like the real tool.
const bin = mkTmp(join(tmpdir(), 'uk-hookscope-bin-'));
writeFileSync(join(bin, 'pre-commit'), `#!/bin/sh
shift
if [ "$1" = "--all-files" ]; then set -- $(find . -name '*.mjs' -not -path './.git/*'); else shift; fi
status=0
for f in "$@"; do
  case "$f" in *.mjs) if grep -q VIOLATION "$f"; then echo "fake-lint: $f has a violation" >&2; status=1; fi ;; esac
done
exit $status
`);
chmodSync(join(bin, 'pre-commit'), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { generateApproverKey, loadApproverKey } = await import('../../runtime/core/keys.mjs');
const { recordApproval } = await import('../../runtime/policy/approvals.mjs');
const { currentBinding, finishApply, loadSlice, startApply } = await import('../../runtime/apply/apply.mjs');
const { verifySlice } = await import('../../runtime/verify/verify.mjs');
const { startRun } = await import('../../runtime/state/runs.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');
const { head } = await import('../../runtime/apply/git.mjs');

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
const PASS = 'correct horse battery';
const PUB = generateApproverKey('alice', PASS);

// A repository whose pre-commit already fails on the whole tree: src/legacy.mjs has a violation.
async function project() {
  const dir = mkTmp(join(tmpdir(), 'uk-hookscope-proj-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/legacy.mjs'), 'export const old = 1; // VIOLATION\n');
  writeFileSync(join(dir, 'src/ledger.mjs'), 'export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n');
  writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src/gone.mjs'), 'export const gone = 1;\n');
  writeFileSync(join(dir, 'src/notes.md'), '# Notes\n');
  writeFileSync(join(dir, '.pre-commit-config.yaml'), 'repos: []\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  const ctx = openProject(dir, { create: true });
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({ version: 1, mode: 'assist', protected_paths: [], approvers: { alice: { roles: ['code-owner', 'affected-owner', 'security-owner', 'data-owner'], public_key: PUB } } }));
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'unknot config');
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  return { dir, ctx, cfg: loadConfig(ctx) };
}

/** Plan a slice over src/**, let `edit` change its worktree, and return the hook obligation's result. */
async function verifyHook(changes, edit) {
  const { dir, ctx, cfg } = await project();
  const [planned] = createCampaign(ctx, { config: cfg.config, actor: 'model:main', objective: 'Tidy the ledger code', proposal: { slices: [{ objective: 'Tidy', scope: { include: ['src/**'], exclude: [] }, changes: changes.map((path) => ({ path, operation: 'modify', description: 'edit' })), invariants: ['Behaviour is unchanged'] }] } }).slices;
  const hook = ctx.store.all('SELECT * FROM proof_obligations WHERE slice_id = ?', planned.id).map((o) => JSON.parse(o.body)).find((o) => o.hook === 'pre-commit');
  assert.equal(hook.requires_human, false);
  const s0 = loadSlice(ctx, planned.id);
  const key = loadApproverKey('alice', PASS);
  for (const role of s0.body.approvals) recordApproval(ctx, { config: cfg.config, slice: s0, binding: currentBinding(ctx, s0, 'plan', { cfg, commit: head(dir) }), role, approver: 'alice', privateKey: key });
  await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest });
  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: planned.id, config: cfg.config, configDigest: cfg.digest });
  await startApply(ctx, { cfg, run, sliceId: planned.id, actor: 'model:main' });
  edit(loadSlice(ctx, planned.id).worktree);
  await finishApply(ctx, { cfg, run, sliceId: planned.id, actor: 'model:main' });
  const v = await verifySlice(ctx, { cfg, run, sliceId: planned.id, actor: 'model:main' });
  return v.results.find((r) => r.id === hook.id);
}

test('scenario 1: a violation in a file the slice does not touch does not fail the hook check', async () => {
  const r = await verifyHook(['src/ledger.mjs'], (wt) => writeFileSync(join(wt, 'src/ledger.mjs'), 'export const total = (xs) => xs.reduce((a, b) => a + b, 0); // sum\n'));
  assert.equal(r.verdict, 'pass');
  assert.equal(r.detail, 'pre-commit run --files src/ledger.mjs → exit 0');
});

test('scenario 2: a violation in a file the slice changes fails the check, and the output names the file', async () => {
  const r = await verifyHook(['src/ledger.mjs'], (wt) => writeFileSync(join(wt, 'src/ledger.mjs'), 'export const total = 0; // VIOLATION\n'));
  assert.equal(r.verdict, 'fail');
  assert.match(r.stderr, /fake-lint: src\/ledger\.mjs has a violation/);
});

test('scenario 3: a slice that changes no file the hook covers passes without a whole-tree run', async () => {
  const r = await verifyHook(['src/notes.md'], (wt) => writeFileSync(join(wt, 'src/notes.md'), '# Notes\n\nMore.\n'));
  assert.equal(r.verdict, 'pass');
  assert.equal(r.detail, 'pre-commit run --files src/notes.md → exit 0');
  // A slice that only deletes leaves nothing to check, and the tool is not run at all.
  const d = await verifyHook(['src/gone.mjs'], (wt) => rmSync(join(wt, 'src/gone.mjs')));
  assert.equal(d.verdict, 'pass');
  assert.equal(d.detail, 'no changed files for pre-commit to check');
});

test('scenario 4: deleted paths are not passed, and a renamed path is passed under its new name', async () => {
  const r = await verifyHook(['src/a.mjs', 'src/b.mjs', 'src/gone.mjs', 'src/ledger.mjs'], (wt) => {
    renameSync(join(wt, 'src/a.mjs'), join(wt, 'src/b.mjs'));
    rmSync(join(wt, 'src/gone.mjs'));
    writeFileSync(join(wt, 'src/ledger.mjs'), 'export const total = 0;\n');
  });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.detail, 'pre-commit run --files src/b.mjs src/ledger.mjs → exit 0');
});
