// A repository limited to tests and deletions (#149): of a test slice, a deletion slice, a refactor
// slice and a Dockerfile slice, only the first two can be applied; the others are plans. A slice
// labelled a refactor that removes public surface is refused at finish: the API check decides.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../helpers/kernel.mjs';
import { mapRepository } from '../../runtime/graph/builder.mjs';
import { createCampaign } from '../../runtime/plan/campaign.mjs';
import { currentBinding, finishApply, startApply } from '../../runtime/apply/apply.mjs';
import { sliceStanding } from '../../runtime/policy/lanes.mjs';
import { stringifyYAML } from '../../runtime/core/yaml.mjs';

after(() => K.cleanup());

const pub = K.keys.generateApproverKey('alice', 'correct horse battery');
const key = K.keys.loadApproverKey('alice', 'correct horse battery');
const BASE = { version: 1, mode: 'assist', repository: { publishes_api: false }, approvers: { alice: { roles: ['code-owner', 'affected-owner', 'platform-owner'], public_key: pub } } };
const FILES = {
  'src/price.js': 'export function price(items) {\n  return items.reduce((s, i) => s + i.p, 0);\n}\n',
  'src/old.js': 'export function old() {\n  return 1;\n}\n',
  'test/price.test.js': "import { price } from '../src/price.js';\nprice([]);\n",
  Dockerfile: 'FROM node:22\nCOPY . .\n',
};
const SLICES = [
  { objective: 'Pin price behaviour', kind: 'code', scope: { include: ['test/price.test.js'] }, changes: [{ path: 'test/price.test.js', operation: 'modify', description: 'add a case' }], preconditions: [] },
  { objective: 'Delete the dead old module', kind: 'code', scope: { include: ['src/old.js'] }, changes: [{ path: 'src/old.js', operation: 'delete', description: 'unused' }], preconditions: [] },
  { objective: 'Simplify price', kind: 'code', scope: { include: ['src/price.js'] }, changes: [{ path: 'src/price.js', operation: 'modify', description: 'loop' }], preconditions: [] },
  { objective: 'Slim the image', kind: 'code', scope: { include: ['Dockerfile'] }, changes: [{ path: 'Dockerfile', operation: 'modify', description: 'smaller base' }], preconditions: [] },
];

async function project(allowed, extra = {}) {
  const p = K.makeProject({ files: FILES });
  const text = stringifyYAML({ ...BASE, ...extra, ...(allowed && { apply: { allowed_kinds: allowed } }) });
  writeFileSync(join(p.ctx.paths.base, 'config.yaml'), text);
  K.git(p.dir, 'add', '-A');
  K.git(p.dir, 'commit', '-qm', 'unknot config');
  K.configMod.recordAcceptedConfig(p.ctx, text, 'human:test');
  const cfg = K.configMod.loadConfig(p.ctx);
  await mapRepository(p.ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  const { slices } = createCampaign(p.ctx, { config: cfg.config, actor: 'model:main', objective: 'Pilot', proposal: { slices: SLICES } });
  return { p, cfg, ids: slices.map((s) => s.id) };
}

async function step(p, cfg, id, fn) {
  const run = K.runs.startRun(p.ctx, { command: 'apply', actor: 'model:main', slice_id: id, config: cfg.config, configDigest: cfg.digest, supersede: true });
  try {
    return await fn(run);
  } finally {
    K.runs.endRun(p.ctx, run.id);
  }
}

function approve(p, cfg, id) {
  const slice = K.loadSlice(p.ctx, id);
  const binding = currentBinding(p.ctx, slice, 'plan', { cfg, commit: K.git(p.dir, 'rev-parse', 'HEAD') });
  for (const role of slice.body.approvals) K.approvals.recordApproval(p.ctx, { config: cfg.config, slice, binding, role, approver: 'alice', privateKey: key });
}

const start = (p, cfg, id) => step(p, cfg, id, (run) => startApply(p.ctx, { cfg, run, sliceId: id, actor: 'model:main' }));
const finish = (p, cfg, id) => step(p, cfg, id, (run) => finishApply(p.ctx, { cfg, run, sliceId: id, actor: 'model:main' }));

test('with allowed_kinds [tests, deletion] only the test and deletion slices can be applied', { timeout: 120_000 }, async () => {
  const { p, cfg, ids } = await project(['tests', 'deletion']);
  const [tests, deletion, refactor, docker] = ids;
  const standing = (id) => sliceStanding(K.loadSlice(p.ctx, id), cfg.config, p.ctx);
  assert.equal(standing(tests).plan_only, undefined);
  assert.equal(standing(deletion).plan_only, undefined);
  assert.match(standing(refactor).plan_only, /^plan-only: apply\.allowed_kinds \[tests, deletion\] excludes refactor$/);
  assert.match(standing(docker).plan_only, /excludes infrastructure/);
  assert.ok(standing(refactor).lane.problems.some((x) => /^plan-only/.test(x)), 'a lane cannot cover a plan-only slice');

  for (const id of [refactor, docker]) {
    approve(p, cfg, id);
    await assert.rejects(start(p, cfg, id), (e) => {
      assert.equal(e.code, 'UK_KIND_NOT_ALLOWED');
      assert.match(e.message, /apply\.allowed_kinds \[tests, deletion\]/);
      assert.equal(e.details.policy, 'apply.allowed_kinds');
      return true;
    });
    assert.equal(K.loadSlice(p.ctx, id).state, 'AWAITING_APPROVAL');
  }

  approve(p, cfg, tests);
  let s = (await start(p, cfg, tests)).slice;
  writeFileSync(join(s.worktree, 'test/price.test.js'), `${FILES['test/price.test.js']}price([{ p: 1 }]);\n`);
  assert.equal((await finish(p, cfg, tests)).files.length, 1);
  assert.equal(K.loadSlice(p.ctx, tests).state, 'VERIFYING');

  approve(p, cfg, deletion);
  s = (await start(p, cfg, deletion)).slice;
  rmSync(join(s.worktree, 'src/old.js'));
  await finish(p, cfg, deletion);
  assert.equal(K.loadSlice(p.ctx, deletion).state, 'VERIFYING');
});

test('a slice planned as a deletion whose patch adds code is refused at finish', { timeout: 120_000 }, async () => {
  const { p, cfg, ids } = await project(['tests', 'deletion']);
  approve(p, cfg, ids[1]);
  const s = (await start(p, cfg, ids[1])).slice;
  writeFileSync(join(s.worktree, 'src/old.js'), 'export function old() {\n  return 2;\n}\n');
  await assert.rejects(finish(p, cfg, ids[1]), (e) => e.code === 'UK_KIND_NOT_ALLOWED' && /staged diff/.test(e.message) && e.details.refused.includes('refactor'));
  assert.equal(K.loadSlice(p.ctx, ids[1]).state, 'PATCHING', 'it can be shrunk to fit');
});

test('without allowed_kinds the refactor slice applies as before', { timeout: 120_000 }, async () => {
  const { p, cfg, ids } = await project(null);
  approve(p, cfg, ids[2]);
  const s = (await start(p, cfg, ids[2])).slice;
  writeFileSync(join(s.worktree, 'src/price.js'), 'export function price(items) {\n  let s = 0;\n  for (const i of items) s += i.p;\n  return s;\n}\n');
  await finish(p, cfg, ids[2]);
  assert.equal(K.loadSlice(p.ctx, ids[2]).state, 'VERIFYING');
});

test('a "refactor" that removes a public export is refused when public-interface is not allowed', { timeout: 120_000 }, async () => {
  // repository.publishes_api: true (the default) declares exports a public interface.
  const { p, cfg, ids } = await project(['tests', 'deletion', 'refactor'], { repository: { publishes_api: true } });
  const id = ids[2];
  approve(p, cfg, id);
  let s = (await start(p, cfg, id)).slice;
  assert.equal(s.state, 'PATCHING', 'the plan is a refactor, which is allowed');
  // Renaming the export keeps it a refactor in name; the API check sees public surface removed.
  writeFileSync(join(s.worktree, 'src/price.js'), readFileSync(join(s.worktree, 'src/price.js'), 'utf8').replace('function price', 'function total'));
  await assert.rejects(finish(p, cfg, id), (e) => {
    assert.equal(e.code, 'UK_KIND_NOT_ALLOWED');
    assert.deepEqual(e.details.refused, ['public-interface']);
    return true;
  });
  // The same change keeping the export is accepted.
  writeFileSync(join(s.worktree, 'src/price.js'), 'export function price(items) {\n  let s = 0;\n  for (const i of items) s += i.p;\n  return s;\n}\n');
  await finish(p, cfg, id);
  s = K.loadSlice(p.ctx, id);
  assert.equal(s.state, 'VERIFYING');
});
