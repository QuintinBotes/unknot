import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { HUMAN_BLOCK_HEADING, humanSteps, loginShellHasUnknot } from '../../../runtime/policy/human-steps.mjs';
import { explainDenial } from '../../../runtime/policy/next-steps.mjs';

after(() => K.cleanup());

const CONFIG = 'version: 1\nmode: plan\n';

function pending() {
  const p = K.makeProject({ config: CONFIG });
  writeFileSync(p.ctx.paths.proposedConfig, 'version: 1\nmode: plan\nlimits:\n  max_changed_files: 5\n');
  K.insertSlice(p.ctx, { id: 'UK-9001', state: 'AWAITING_APPROVAL', body: { approvals: ['code-owner'] } });
  return { p, cfg: K.configMod.loadConfig(p.ctx) };
}

test('a waiting proposal, no approver and a slice awaiting approval list their commands in order', () => {
  const { p, cfg } = pending();
  const r = humanSteps(p.ctx, cfg, { unknotOnPath: true });
  assert.deepEqual(r.steps.map((s) => s.step), ['accept_config', 'register_approver', 'approve_slice']);
  const cmds = r.steps.flatMap((s) => s.commands);
  assert.equal(cmds[0], 'unknot config diff');
  assert.equal(cmds[1], 'unknot config accept');
  assert.match(cmds[2], /^unknot keys generate \S+$/);
  assert.match(cmds[3], /^unknot approve UK-9001 --role code-owner --as \S+$/);
  assert.ok(r.text.startsWith(HUMAN_BLOCK_HEADING));
});

test('an active run ends last, by id', () => {
  const { p, cfg } = pending();
  const { run } = K.startTestRun(p);
  const r = humanSteps(p.ctx, cfg, { unknotOnPath: true });
  assert.deepEqual(r.steps.at(-1).commands, [`unknot run end ${run.id}`]);
});

test('the CLI missing from the login PATH puts the install step first; unknown does not', () => {
  const { p, cfg } = pending();
  const missing = humanSteps(p.ctx, cfg, { unknotOnPath: false });
  assert.equal(missing.steps[0].step, 'install_cli');
  assert.match(missing.steps[0].commands[0], /cli install$/);
  assert.equal(humanSteps(p.ctx, cfg, { unknotOnPath: null }).steps[0].step, 'accept_config');
});

test('nothing pending gives no block', () => {
  const pub = K.keys.generateApproverKey(`hs-${Date.now()}`, 'correct horse battery');
  const key = pub.trim().split('\n').map((l) => `      ${l}`).join('\n');
  const p = K.makeProject({ config: `version: 1\nmode: plan\napprovers:\n  a:\n    roles: [code-owner]\n    public_key: |\n${key}\n` });
  assert.equal(humanSteps(p.ctx, K.configMod.loadConfig(p.ctx), { unknotOnPath: true }).text, null);
});

test('the login-shell check treats failure and timeout as unknown, not missing', () => {
  const run = (r) => loginShellHasUnknot({ shell: '/bin/sh', spawn: () => r });
  assert.equal(run({ status: 0, stdout: '/usr/bin/unknot\n' }), true);
  assert.equal(run({ status: 1, stdout: '' }), false);
  assert.equal(run({ status: null, signal: 'SIGTERM', stdout: '' }), null);
  assert.equal(run({ status: 127, stdout: '' }), null);
  assert.equal(run({ error: new Error('x') }), null);
  assert.equal(loginShellHasUnknot({ shell: '' }), null);
});

test('the human-only refusal points to the status block', () => {
  const text = explainDenial({ reasons: ['x'], policy_ids: ['approval.human_only'] });
  assert.match(text, /unknot status/);
  assert.ok(text.includes(HUMAN_BLOCK_HEADING));
});
