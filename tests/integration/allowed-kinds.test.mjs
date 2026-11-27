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
import { accept, approveLaneSlices } from '../../runtime/cli/commands/approve.mjs';
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

async function project(allowed, extra = {}, drafts = SLICES) {
  const p = K.makeProject({ files: FILES });
  const text = stringifyYAML({ ...BASE, ...extra, ...(allowed && { apply: { allowed_kinds: allowed } }) });
  writeFileSync(join(p.ctx.paths.base, 'config.yaml'), text);
  K.git(p.dir, 'add', '-A');
  K.git(p.dir, 'commit', '-qm', 'unknot config');
  K.configMod.recordAcceptedConfig(p.ctx, text, 'human:test');
  const cfg = K.configMod.loadConfig(p.ctx);
  await mapRepository(p.ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  const { slices } = createCampaign(p.ctx, { config: cfg.config, actor: 'model:main', objective: 'Pilot', proposal: { slices: drafts } });
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

function setConfig(p, allowed) {
  const text = stringifyYAML({ ...BASE, ...(allowed && { apply: { allowed_kinds: allowed } }) });
  writeFileSync(join(p.ctx.paths.base, 'config.yaml'), text);
  K.configMod.recordAcceptedConfig(p.ctx, text, 'human:test');
  return K.configMod.loadConfig(p.ctx);
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

test('a glob ending in .md* gets the code checks; docs/**/*.md keeps the documentation ones (#173)', { timeout: 120_000 }, async () => {
  const slices = [
    { objective: 'Tidy markdown-ish files', kind: 'documentation', scope: { include: ['src/**/*.md*'] }, preconditions: [] },
    { objective: 'Tidy the docs', kind: 'documentation', scope: { include: ['docs/**/*.md'] }, preconditions: [] },
  ];
  const { p, ids } = await project(null, {}, slices);
  const kinds = (id) => p.ctx.store.all('SELECT kind FROM proof_obligations WHERE slice_id = ?', id).map((o) => o.kind);
  for (const k of ['unit', 'architecture-fitness']) assert.ok(kinds(ids[0]).includes(k), `${k} applies to src/**/*.md*, which also matches src/net.md.js`);
  assert.ok(!kinds(ids[1]).includes('architecture-fitness'), 'docs/**/*.md is still documentation-only');
});

test('a "documentation" label does not let a code change through, and does not skip the code checks', { timeout: 120_000 }, async () => {
  const slices = [
    { objective: 'Document price', kind: 'documentation', scope: { include: ['src/**'] }, preconditions: [] },
    { objective: 'Fix the README', kind: 'documentation', scope: { include: ['README.md'] }, changes: [{ path: 'README.md', operation: 'modify', description: 'typo' }], preconditions: [] },
  ];
  const { p, cfg, ids } = await project(['tests', 'deletion', 'documentation'], {}, slices);
  const [labelled, readme] = ids;
  const kinds = (id) => p.ctx.store.all('SELECT kind FROM proof_obligations WHERE slice_id = ?', id).map((o) => o.kind);
  for (const k of ['unit', 'architecture-fitness', 'api-compatibility']) assert.ok(kinds(labelled).includes(k), `${k} applies to a documentation-labelled slice reaching src/**`);
  assert.ok(!kinds(readme).includes('architecture-fitness'), 'a README-only slice keeps the documentation obligations');
  assert.match(sliceStanding(K.loadSlice(p.ctx, labelled), cfg.config, p.ctx).plan_only, /excludes refactor/);
  approve(p, cfg, labelled);
  await assert.rejects(start(p, cfg, labelled), (e) => e.code === 'UK_KIND_NOT_ALLOWED' && e.details.refused.includes('refactor'));
  // Even if the plan named only a Markdown file, the patch is judged by what it changes.
  const { diffKinds } = await import('../../runtime/policy/kinds.mjs');
  assert.deepEqual(diffKinds({ kind: 'documentation' }, { paths: ['src/price.js'], added: 1 }).shape, ['refactor']);
  approve(p, cfg, readme);
  const s = (await start(p, cfg, readme)).slice;
  writeFileSync(join(s.worktree, 'README.md'), '# fixed\n');
  await finish(p, cfg, readme);
  assert.equal(K.loadSlice(p.ctx, readme).state, 'VERIFYING');
});

test('the reviewer case: a documentation-labelled slice that adds a fetch to src/price.js is refused at finish', { timeout: 120_000 }, async () => {
  // Planned when no list was set, so it gets past start; the list is narrowed before the patch is finished.
  const slices = [{ objective: 'Document price', kind: 'documentation', scope: { include: ['src/**'] }, preconditions: [] }];
  const { p, cfg, ids } = await project(null, {}, slices);
  approve(p, cfg, ids[0]);
  const s = (await start(p, cfg, ids[0])).slice;
  writeFileSync(join(s.worktree, 'src/price.js'), `${FILES['src/price.js']}fetch('https://example.invalid');\n`);
  const narrowed = setConfig(p, ['tests', 'deletion', 'documentation']);
  await assert.rejects(finish(p, narrowed, ids[0]), (e) => e.code === 'UK_KIND_NOT_ALLOWED' && e.details.refused.includes('refactor'));
  assert.equal(K.loadSlice(p.ctx, ids[0]).state, 'PATCHING');
});

test('a slice patched before the list was narrowed cannot be accepted after it', { timeout: 120_000 }, async () => {
  const { p, cfg, ids } = await project(null);
  const id = ids[2];
  approve(p, cfg, id);
  const s = (await start(p, cfg, id)).slice;
  writeFileSync(join(s.worktree, 'src/price.js'), 'export function price(items) {\n  let s = 0;\n  for (const i of items) s += i.p;\n  return s;\n}\n');
  await finish(p, cfg, id);
  K.machine.transitionSlice(p.ctx, { slice: K.loadSlice(p.ctx, id), to: 'REVIEW_READY', actor: 'runtime:verifier', reason: 'test: proven' });
  const satisfied = { satisfied: true, valid: [] };
  // The single-slice and the lane change approval both end in accept().
  const narrowed = setConfig(p, ['tests', 'deletion']);
  await assert.rejects(accept(p.ctx, narrowed, K.loadSlice(p.ctx, id), satisfied, 'alice'), (e) => e.code === 'UK_KIND_NOT_ALLOWED' && e.details.refused.includes('refactor'));
  assert.equal(K.loadSlice(p.ctx, id).state, 'REVIEW_READY', 'nothing accepted or committed');
  const widened = setConfig(p, ['refactor']);
  assert.match(await accept(p.ctx, widened, K.loadSlice(p.ctx, id), satisfied, 'alice'), /ACCEPTED/);
  assert.equal(K.loadSlice(p.ctx, id).state, 'ACCEPTED');
});

test('a test slice planned after a refactor does not wait on it when the refactor is plan-only (#217)', { timeout: 120_000 }, async () => {
  const { selectNext } = await import('../../runtime/plan/next.mjs');
  // The proposal leaves the order implicit: refactor first, then the characterization test.
  const drafts = [SLICES[2], SLICES[0]].map(({ preconditions, ...d }) => d);
  const pre = (p, id) => K.loadSlice(p.ctx, id).body.preconditions;

  // No restriction: the order is as before, the test slice follows the refactor.
  const open = await project(null, {}, drafts);
  assert.deepEqual(pre(open.p, open.ids[1]), [open.ids[0]]);

  // Restricted: the test slice stands on its own, and next offers it.
  const { p, cfg, ids } = await project(['tests', 'deletion'], {}, drafts);
  const [refactor, tests] = ids;
  assert.deepEqual(pre(p, tests), []);
  const res = selectNext(p.ctx, { config: cfg.config });
  assert.equal(res.next?.id, tests);
  assert.deepEqual(res.plan_only.map((x) => x.id), [refactor]);

  // A dependency the proposal states is kept, and next says which slice holds it and why.
  const stated = await project(['tests', 'deletion'], {}, drafts);
  const [r2, t2] = stated.ids;
  stated.p.ctx.store.run('UPDATE slices SET body = json_set(body, \'$.preconditions\', json_array(?)) WHERE id = ?', r2, t2);
  const held = selectNext(stated.p.ctx, { config: stated.cfg.config });
  assert.equal(held.next, null);
  assert.deepEqual(held.blocked, [{ id: t2, waiting_for: [r2], held_by: [{ id: r2, reason: 'plan-only: apply.allowed_kinds [tests, deletion] excludes refactor' }] }]);
});

test('a lane approval that stops at a refused slice reports the slices it accepted, and records nothing for the refused one (#173)', { timeout: 120_000 }, async () => {
  const { p, ids } = await project(null);
  let cfg = K.configMod.loadConfig(p.ctx);
  const [tests, deletion, refactor] = ids;
  const patches = {
    [tests]: (wt) => writeFileSync(join(wt, 'test/price.test.js'), "import { price } from '../src/price.js';\nprice([]);\nprice([{ p: 1 }]);\n"),
    [refactor]: (wt) => writeFileSync(join(wt, 'src/price.js'), 'export function price(items) {\n  let s = 0;\n  for (const i of items) s += i.p;\n  return s;\n}\n'),
    [deletion]: (wt) => rmSync(join(wt, 'src/old.js')),
  };
  for (const id of [tests, refactor, deletion]) {
    approve(p, cfg, id);
    patches[id]((await start(p, cfg, id)).slice.worktree);
    await finish(p, cfg, id);
    K.machine.transitionSlice(p.ctx, { slice: K.loadSlice(p.ctx, id), to: 'REVIEW_READY', actor: 'runtime:verifier', reason: 'test: proven' });
  }
  cfg = setConfig(p, ['tests', 'deletion']);
  const ready = [tests, refactor, deletion].map((id) => K.loadSlice(p.ctx, id));
  await assert.rejects(approveLaneSlices(p.ctx, cfg, { ready, role: 'code-owner', approver: 'alice', key }), (e) => {
    assert.equal(e.code, 'UK_KIND_NOT_ALLOWED');
    assert.ok(e.message.startsWith(`${tests} ACCEPTED`), e.message);
    assert.ok(e.message.includes(`${refactor} refused, so the lane approval stopped there (accepted before it: ${tests}): slice ${refactor} is a change of kind refactor`), e.message);
    assert.deepEqual(e.details.accepted, [tests]);
    assert.equal(e.details.refused, refactor);
    return true;
  });
  assert.equal(K.loadSlice(p.ctx, tests).state, 'ACCEPTED');
  assert.equal(K.loadSlice(p.ctx, refactor).state, 'REVIEW_READY');
  assert.equal(K.loadSlice(p.ctx, deletion).state, 'REVIEW_READY', 'the run stopped before it');
  assert.equal(p.ctx.store.all("SELECT id FROM approvals WHERE slice_id = ? AND stage = 'change'", refactor).length, 0, 'no change approval for the refused slice');
});
