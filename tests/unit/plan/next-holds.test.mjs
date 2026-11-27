// next and status offer only what apply can take (#178): a slice whose kinds apply.allowed_kinds
// refuses, or whose scope rests on lexical reads without evidence.allow_weak for its campaign, is
// listed with the reason, never picked and never put up for approval.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';
import { diagnose } from '../../../runtime/diagnose/engine.mjs';
import { createCampaign } from '../../../runtime/plan/campaign.mjs';
import { selectNext } from '../../../runtime/plan/next.mjs';
import { humanSteps } from '../../../runtime/policy/human-steps.mjs';
import { stringifyYAML } from '../../../runtime/core/yaml.mjs';

after(() => K.cleanup());

const CSHARP = {
  'Shop/Mailer.cs': 'namespace Shop\n{\n    public class Mailer\n    {\n        public void Send() { }\n    }\n}\n',
  'Shop/Legacy.cs': 'namespace Shop\n{\n    public class Legacy\n    {\n        [Inject] private Mailer _mailer;\n        public void Run() { }\n    }\n}\n',
};

function accept(p, extra = {}) {
  const text = stringifyYAML({ version: 1, mode: 'assist', apply: { allowed_kinds: ['tests', 'deletion'] }, ...extra });
  writeFileSync(join(p.ctx.paths.base, 'config.yaml'), text);
  K.configMod.recordAcceptedConfig(p.ctx, text, 'human:test');
  return K.configMod.loadConfig(p.ctx);
}

async function fixture() {
  const p = K.makeProject({ files: CSHARP });
  const cfg = accept(p);
  await mapRepository(p.ctx, { config: cfg.config, configDigest: cfg.digest, history: false });
  const { run } = K.startTestRun(p, { command: 'diagnose' });
  await diagnose(p.ctx, { config: cfg.config, run, scope: [] });
  K.runs.endRun(p.ctx, run.id);
  const f = p.ctx.store.get("SELECT id FROM findings WHERE kind = 'code.unused-injected-member'").id;
  const { campaign, slices } = createCampaign(p.ctx, { config: cfg.config, actor: 'model:main', objective: 'Remove the unused member', findings: [f] });
  p.ctx.store.run("UPDATE slices SET state = 'AWAITING_APPROVAL' WHERE id = ?", slices[0].id);
  const refactor = K.insertSlice(p.ctx, { id: 'UK-0901', state: 'AWAITING_APPROVAL', body: { approvals: ['code-owner'], scope: { include: ['src/a.js'], exclude: [] }, changes: [{ path: 'src/a.js', operation: 'modify' }], preconditions: [] } });
  const tests = K.insertSlice(p.ctx, { id: 'UK-0902', state: 'AWAITING_APPROVAL', body: { approvals: ['code-owner'], scope: { include: ['tests/a.test.js'], exclude: [] }, changes: [{ path: 'tests/a.test.js', operation: 'modify' }], preconditions: [] } });
  return { p, campaign, csharp: slices[0].id, refactor: refactor.id, tests: tests.id };
}

test('next skips plan-only and weak-evidence slices, with the reason, and still picks a test-only one', async () => {
  const { p, campaign, csharp, refactor, tests } = await fixture();
  const cfg = K.configMod.loadConfig(p.ctx);
  const res = selectNext(p.ctx, { config: cfg.config });
  assert.equal(res.next?.id, tests);
  assert.deepEqual(res.alternatives.map((a) => a.id), []);
  assert.deepEqual(res.plan_only.map((x) => x.id), [refactor]);
  assert.match(res.plan_only[0].reason, /^plan-only: apply\.allowed_kinds \[tests, deletion\] excludes refactor$/);
  assert.deepEqual(res.waits_on_evidence.map((x) => x.id), [csharp]);
  assert.match(res.waits_on_evidence[0].reason, /read lexically \(csharp\)/);
  assert.equal(res.waits_on_evidence[0].ways_forward.length, 2);
  assert.ok(res.waits_on_evidence[0].ways_forward[1].includes(`allow_weak: [${campaign.id}]`));

  const steps = humanSteps(p.ctx, cfg, { unknotOnPath: true });
  const asked = steps.steps.filter((s) => s.step === 'approve_slice').map((s) => s.slice);
  assert.deepEqual(asked, [tests]);
  assert.deepEqual(steps.held.map((h) => h.slice), [csharp, refactor]);
  assert.ok(![refactor, csharp].some((id) => steps.text.includes(`unknot approve ${id} `)));

  // Opting the campaign in makes the C# slice ready and offered for approval.
  const weak = accept(p, { evidence: { allow_weak: [campaign.id] } });
  const after = selectNext(p.ctx, { config: weak.config });
  assert.deepEqual([after.next.id, ...after.alternatives.map((a) => a.id)].sort(), [csharp, tests].sort());
  assert.deepEqual(after.waits_on_evidence, []);
  assert.ok(humanSteps(p.ctx, weak, { unknotOnPath: true }).steps.some((s) => s.slice === csharp));
});
