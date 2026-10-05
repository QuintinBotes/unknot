#!/usr/bin/env node
// End-to-end change workflow on a disposable clone of a real repository:
// configure → map → diagnose → plan a slice from a real finding → (human) approve the plan →
// live Claude Code session `/unknot:apply` → live session `/unknot:verify` → (human) approve
// the change → ACCEPTED. The script plays only the human: it accepts the config and signs
// approvals with a test approver key in a throwaway UNKNOT_HOME. The patch is written by the
// plugin's own agents under its hooks, with whatever plugin the current Claude config has
// installed. Nothing touches the original repository.
//
// Usage: node scripts/writepath-e2e.mjs --repo <path> --test '<json argv>' [--setup '<shell>']
//   [--typecheck '<json argv>'] [--lang js|ts|py|rs|go] [--within <dir>] [--loopback] [--model sonnet]
//   [--out <file.json>]

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const flag = (k) => args.includes(k);
const repo = opt('--repo');
if (!repo || !opt('--test')) {
  process.stderr.write('usage: node scripts/writepath-e2e.mjs --repo <path> --test \'<json argv>\' [--setup <shell>] [--typecheck <json argv>] [--lang ext] [--loopback] [--model sonnet] [--out file]\n');
  process.exit(2);
}
const model = opt('--model', 'sonnet');
const lang = opt('--lang');
const T = realpathSync(tmpdir());
const dir = mkdtempSync(join(T, `uk-e2e-${basename(repo)}-`));
process.env.UNKNOT_HOME = mkdtempSync(join(T, 'uk-e2e-home-'));
const U = new URL('../runtime/', import.meta.url).pathname;
const report = { repo: basename(repo), clone: dir, steps: {} };
const step = (name, data) => {
  report.steps[name] = data;
  process.stderr.write(`${name}: ${JSON.stringify(data).slice(0, 300)}\n`);
};

execFileSync('git', ['clone', '-q', '--no-hardlinks', repo, dir]);
if (opt('--setup')) {
  const r = spawnSync('/bin/sh', ['-c', opt('--setup')], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
  step('setup', { exit: r.status, tail: (r.stderr || r.stdout).slice(-300) });
  if (r.status !== 0) finish(1);
}

const { openProject } = await import(`${U}context.mjs`);
const { loadConfig, recordAcceptedConfig } = await import(`${U}policy/config.mjs`);
const { stringifyYAML } = await import(`${U}core/yaml.mjs`);
const { generateApproverKey, loadApproverKey } = await import(`${U}core/keys.mjs`);
const { mapRepository } = await import(`${U}graph/builder.mjs`);
const { diagnose } = await import(`${U}diagnose/engine.mjs`);
const { createCampaign } = await import(`${U}plan/campaign.mjs`);
const { recordApproval } = await import(`${U}policy/approvals.mjs`);
const { loadSlice, currentBinding, approvalStatus } = await import(`${U}apply/apply.mjs`);
const { startRun, endRun } = await import(`${U}state/runs.mjs`);
const { transitionSlice } = await import(`${U}state/machine.mjs`);
const { head } = await import(`${U}apply/git.mjs`);

const ctx = openProject(dir, { create: true });
const pub = generateApproverKey('tester', 'test passphrase');
const commands = { test_unit: JSON.parse(opt('--test')), ...(opt('--typecheck') && { typecheck: JSON.parse(opt('--typecheck')) }) };
const cfgText = stringifyYAML({
  version: 1, mode: 'assist', commands,
  ...(flag('--loopback') && { security: { sandbox_loopback: true } }),
  approvers: { tester: { roles: ['code-owner', 'affected-owner'], public_key: pub } },
});
writeFileSync(join(dir, '.unknot/config.yaml'), cfgText);
recordAcceptedConfig(ctx, cfgText, 'human:tester');
const cfg = loadConfig(ctx);

const run = startRun(ctx, { command: 'plan', actor: 'human:tester', config: cfg.config, configDigest: cfg.digest });
const m = await mapRepository(ctx, { config: cfg.config, configDigest: cfg.digest, run });
step('map', { status: m.status, files: m.files, failures: m.failure_count, notices: m.notices ?? [] });
const d = await diagnose(ctx, { config: cfg.config, run });
// A tractable, real refactoring target: a long or complex function in a source file of the
// requested language, the smallest one over its threshold.
const within = opt('--within');
const inLang = (p) => (!within || p.startsWith(`${within.replace(/\/$/, '')}/`)) && (!lang || p.endsWith(`.${lang}`) || (lang === 'ts' && /\.tsx?$/.test(p)) || (lang === 'js' && /\.[cm]?jsx?$/.test(p)));
const candidates = d.findings
  .filter((f) => ['code.long-function', 'code.complex-function'].includes(f.kind) && inLang(f.scope[0] ?? '') && !/(^|\/)(tests?|__tests__|e2e|scripts)\//.test(f.scope[0]))
  .sort((a, b) => (a.measurements?.['function.lines'] ?? 1e9) - (b.measurements?.['function.lines'] ?? 1e9));
const pick = candidates[0];
if (!pick) {
  step('finding', { error: 'no suitable function-level finding' });
  endRun(ctx, run.id);
  finish(1);
}
step('finding', { id: pick.id, kind: pick.kind, title: pick.title });
const file = pick.scope[0];
const { slices } = createCampaign(ctx, {
  config: cfg.config, actor: 'human:tester', objective: pick.smallest_simplification.slice(0, 160),
  proposal: { rationale: `From ${pick.id}`, slices: [{ objective: pick.smallest_simplification.slice(0, 200), kind: 'code', scope: { include: [file], exclude: [] }, invariants: ['Observable behaviour is unchanged'], sources: [pick.id], changes: [{ path: file, operation: 'modify', description: 'Extract one self-contained block into a named function' }] }] },
});
let s = loadSlice(ctx, slices[0].id);
const key = loadApproverKey('tester', 'test passphrase');
for (const role of s.body.approvals) recordApproval(ctx, { config: cfg.config, slice: s, binding: currentBinding(ctx, s, 'plan', { cfg, commit: head(dir) }), role, approver: 'tester', privateKey: key });
endRun(ctx, run.id);
step('plan', { slice: s.id, risk: s.risk, approvals: s.body.approvals });

// Live Claude Code sessions with the installed plugin.
const session = (prompt) => {
  const r = spawnSync('claude', ['-p', prompt, '--model', model, '--allowedTools', 'Bash(unknot *)', 'Bash(unknot:*)', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'mcp__plugin_unknot_unknot', '--output-format', 'stream-json', '--verbose'], { cwd: dir, encoding: 'utf8', input: '', maxBuffer: 256 << 20, env: process.env, timeout: 30 * 60_000 });
  const errors = [];
  let cost = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'user') for (const c of e.message?.content ?? []) if (c?.is_error) errors.push(String(typeof c.content === 'string' ? c.content : c.content?.map?.((x) => x.text).join(' ')).slice(0, 160));
    if (e.type === 'result' && !cost) cost = e.total_cost_usd ?? 0;
  }
  return { exit: r.status, cost: +cost.toFixed(3), errors };
};
step('apply', session(`/unknot:apply ${s.id}`));
step('verify', session(`/unknot:verify ${s.id}`));
s = loadSlice(ctx, s.id);
const obligations = ctx.store.all('SELECT kind, status FROM proof_obligations WHERE slice_id = ?', s.id);
step('verified', { state: s.state, obligations });
if (s.state === 'REVIEW_READY') {
  for (const role of s.body.approvals) recordApproval(ctx, { config: cfg.config, slice: s, binding: currentBinding(ctx, s, 'change', { cfg, commit: s.baseline_commit, diffHash: s.diff_hash }), role, approver: 'tester', privateKey: key });
  const ap = approvalStatus(ctx, s, 'change', { cfg, commit: s.baseline_commit, diffHash: s.diff_hash });
  transitionSlice(ctx, { slice: s, to: 'ACCEPTED', actor: 'human:tester', reason: 'e2e', guards: [() => ({ ok: ap.satisfied, id: 'approval.change' })] });
  s = loadSlice(ctx, s.id);
}
const staged = s.worktree && existsSync(s.worktree) ? execFileSync('git', ['-C', s.worktree, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).split('\n').filter(Boolean) : [];
const mainClean = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }) === '';
const ledger = spawnSync(process.execPath, [new URL('../bin/unknot', import.meta.url).pathname, 'audit', 'verify'], { cwd: dir, encoding: 'utf8', env: process.env });
step('result', { state: s.state, staged, scope_respected: staged.every((p) => p === file), main_checkout_clean: mainClean, ledger: ledger.stdout.trim().slice(0, 80) });
finish(s.state === 'ACCEPTED' && mainClean && staged.length > 0 && staged.every((p) => p === file) ? 0 : 1);

function finish(code) {
  report.ok = code === 0;
  if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ repo: report.repo, ok: report.ok, state: report.steps.result?.state ?? null })}\n`);
  process.exit(code);
}
