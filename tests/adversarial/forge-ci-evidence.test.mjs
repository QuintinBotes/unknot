// Attested CI evidence (#153, docs/forge-approvals.md control 5). `unknot pr` puts the CI plan in
// the pushed commit; the CI side (`unknot verify --in-ci`) really runs it here on a clone of that
// commit; `unknot verify --from-ci <pr>` counts the result only with a verified attestation from
// the pinned workflow at its pinned commit, on the bound head, from a push in the pinned
// repository, and only from the latest run. The gh the accepted config names is a fake: GitHub API
// responses are in tests/fixtures/github/api.json and `gh attestation verify` output is a recorded
// real one (tests/fixtures/github/attestation-verify.json) with its certificate fields replaced.
// No test makes a network call. Each attempt below must count nothing: another repository,
// workflow, ref or head; a forged or unsigned bundle; another file's attestation; a replay of an
// older run or attempt; a changed workflow; a fork or pull_request_target run; a self-hosted
// runner; evidence for another slice; a human obligation; a command other than the planned one.

import '../helpers/git-env.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attested, fixture, installFakeGh } from '../helpers/fake-gh.mjs';
import { mkTmp } from '../helpers/tmp.mjs';

process.env.UNKNOT_HOME = mkTmp(join(tmpdir(), 'uk-home-'));
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
const gh = installFakeGh(mkTmp(join(tmpdir(), 'uk-gh-')));

const { openProject } = await import('../../runtime/context.mjs');
const { loadConfig, recordAcceptedConfig } = await import('../../runtime/policy/config.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { diagnose } = await import('../../runtime/diagnose/engine.mjs');
const { createCampaign } = await import('../../runtime/plan/campaign.mjs');
const { generateApproverKey, loadApproverKey } = await import('../../runtime/core/keys.mjs');
const { recordApproval } = await import('../../runtime/policy/approvals.mjs');
const { currentBinding, finishApply, loadSlice, startApply } = await import('../../runtime/apply/apply.mjs');
const { verifySlice } = await import('../../runtime/verify/verify.mjs');
const { runInCi } = await import('../../runtime/verify/ci.mjs');
const { startRun, endRun } = await import('../../runtime/state/runs.mjs');
const { stringifyYAML } = await import('../../runtime/core/yaml.mjs');
const { head: headOf } = await import('../../runtime/apply/git.mjs');
const { forgeChecks } = await import('../../runtime/policy/forge.mjs');
const prCmd = await import('../../runtime/cli/commands/pr.mjs');
const verifyCmd = await import('../../runtime/cli/commands/verify.mjs');

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
      if (order.vip) {
        label = 'standard-vip';
      } else {
        label = 'standard';
      }
    } else {
      if (order.vip) {
        label = 'small-vip';
      } else {
        label = 'small';
      }
    }
  }
  return label;
}
`;
const FLAT = `export function classify(order) {
  if (!order) return 'unknown';
  const tier = order.total > 1000 ? 'priority' : order.total > 100 ? 'standard' : 'small';
  return order.vip ? \`\${tier}-vip\` : tier;
}
`;
const TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.mjs';
test('classify', () => {
  assert.equal(classify(null), 'unknown');
  assert.equal(classify({ total: 5000, vip: true }), 'priority-vip');
  assert.equal(classify({ total: 50 }), 'small');
});
`;
// The caller workflow a repository adds (docs/forge-approvals.md); it is on the base branch.
const CALLER = 'name: unknot\non:\n  push:\n    branches: [\'unknot/**\']\npermissions: {}\njobs:\n  unknot:\n    uses: acme/unknot/.github/workflows/unknot-verify.yml@' + 'a'.repeat(40) + '\n';
const WF_SHA = 'a'.repeat(40);
const WF = `acme/unknot/.github/workflows/unknot-verify.yml@${WF_SHA}`;

const g = (cwd, args) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

/** Run a CLI command module in-process as a person at a terminal; returns stdout and the exit code. */
async function cli(mod, dir, positional, flags = {}) {
  const saved = { cwd: process.cwd(), in: process.stdin.isTTY, out: process.stdout.isTTY, write: process.stdout.write };
  let out = '';
  process.chdir(dir);
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  process.stdout.write = (s) => { out += s; return true; };
  try {
    const code = await mod.run({ positional, flags }, { ask: () => 'y' });
    return { out, code };
  } finally {
    process.stdout.write = saved.write;
    process.chdir(saved.cwd);
    process.stdin.isTTY = saved.in;
    process.stdout.isTTY = saved.out;
  }
}

test('CI evidence counts only with an attestation from the pinned workflow on the bound head', { timeout: 240_000 }, async () => {
  const dir = mkTmp(join(tmpdir(), 'uk-proj-'));
  for (const d of ['src', 'test', '.github/workflows']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'src/classify.mjs'), BRANCHY);
  writeFileSync(join(dir, 'test/classify.test.mjs'), TEST);
  writeFileSync(join(dir, '.github/workflows/unknot.yml'), CALLER);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-qm', 'init']);

  const pub = generateApproverKey('alice', 'correct horse battery');
  const ctx = openProject(dir, { create: true });
  writeFileSync(join(dir, '.unknot/config.yaml'), stringifyYAML({
    version: 1,
    mode: 'assist',
    protected_paths: [],
    commands: { test_unit: ['node', '--test'] },
    detectors: { 'local.complex-function': { cyclomatic: 5, cognitive: 5 }, 'local.deep-nesting': { max_nesting: 2 } },
    approvals: { via: 'forge', forge: { gh: gh.bin, repository: 'acme/demo', agent_accounts: [], roles: { 'code-owner': { codeowners: true } }, ci_workflow: WF } },
    approvers: { alice: { roles: ['code-owner', 'affected-owner'], public_key: pub } },
  }));
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-qm', 'unknot config']);
  recordAcceptedConfig(ctx, readFileSync(join(dir, '.unknot/config.yaml'), 'utf8'), 'human:test');
  const cfg = loadConfig(ctx);
  const config = cfg.config;
  assert.equal(config.approvals.forge.ci_workflow, WF);
  await mapRepository(ctx, { config, configDigest: cfg.digest });
  const finding = (await diagnose(ctx, { config, only: ['local'] })).findings.find((f) => f.scope.includes('src/classify.mjs'));
  const sliceId = createCampaign(ctx, { config, actor: 'model:main', objective: 'Flatten classify', findings: [finding.id] }).slices[0].id;
  let slice = loadSlice(ctx, sliceId);
  const run = startRun(ctx, { command: 'apply', actor: 'model:main', slice_id: sliceId, config, configDigest: cfg.digest });
  const key = loadApproverKey('alice', 'correct horse battery');
  for (const role of slice.body.approvals) recordApproval(ctx, { config, slice, binding: currentBinding(ctx, slice, 'plan', { cfg, commit: headOf(dir) }), role, approver: 'alice', privateKey: key });
  await startApply(ctx, { cfg, run, sliceId, actor: 'model:main' });
  slice = loadSlice(ctx, sliceId);
  writeFileSync(join(slice.worktree, 'src/classify.mjs'), FLAT);
  await finishApply(ctx, { cfg, run, sliceId, actor: 'model:main' });
  const v = await verifySlice(ctx, { cfg, run, sliceId, actor: 'model:main' });
  assert.equal(v.state, 'REVIEW_READY', JSON.stringify(v.results));
  endRun(ctx, run.id);
  slice = loadSlice(ctx, sliceId);
  const obligations = ctx.store.all('SELECT id, body FROM proof_obligations WHERE slice_id = ?', sliceId).map((o) => ({ id: o.id, ...JSON.parse(o.body) }));
  const commands = obligations.filter((o) => o.command?.[0] === 'node').map((o) => o.id);
  const unit = obligations.find((o) => o.id === commands[0]);
  assert.ok(unit, 'the slice has the unit command obligation');

  // unknot pr pushes the head with the CI plan in its message, and posts the binding.
  const remote = mkTmp(join(tmpdir(), 'uk-remote-'));
  g(remote, ['init', '-q', '--bare']);
  g(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git']);
  g(dir, ['remote', 'set-url', '--push', 'origin', remote]);
  gh.routes({ 'POST repos/acme/demo/issues/7/comments': fixture('comment') });
  await cli(prCmd, dir, [sliceId]);
  const head = g(dir, ['rev-parse', `refs/unknot/pr/${sliceId}`]);
  assert.match(g(dir, ['log', '-1', '--format=%B', head]), /^Unknot-CI: \{.*"run":\["node","--test"\]/m);

  // FR-001 / SC-002: CI verifies from the pushed commit alone, in a fresh clone with no Unknot state or key.
  const ci = mkTmp(join(tmpdir(), 'uk-ci-'));
  g(ci, ['clone', '-q', '--branch', slice.branch, remote, 'head']);
  const evidenceFile = join(ci, 'unknot-evidence.json');
  // The CI job's `node --test` must run the tests, not see this test runner's context and skip them.
  const testContext = process.env.NODE_TEST_CONTEXT;
  const write = process.stdout.write;
  let log = '';
  delete process.env.NODE_TEST_CONTEXT;
  process.stdout.write = (s) => { log += s; return true; };
  let ev;
  try {
    ev = runInCi({ root: join(ci, 'head'), out: evidenceFile, env: { GITHUB_REPOSITORY: 'acme/demo', GITHUB_RUN_ID: '901', GITHUB_RUN_ATTEMPT: '1' } });
  } finally {
    process.stdout.write = write;
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }
  assert.match(log, /(?:✔|ok \d+ -) classify/, 'the slice head\'s tests really ran in the CI job');
  assert.equal(ev.head, head);
  assert.equal(ev.results.find((r) => r.id === unit.id).exit_code, 0, 'the unit tests ran and passed on the pushed head');
  assert.ok(ev.results.filter((r) => r.not_run).every((r) => /built-in|person/.test(r.not_run)));
  const evidence = readFileSync(evidenceFile, 'utf8');

  const baseSha = '1111111111111111111111111111111111111111';
  const workflowsTree = g(dir, ['rev-parse', `${head}:.github/workflows`]);
  const sha256 = (s) => createHash('sha256').update(s).digest('hex');
  const cert = (over = {}) => ({
    issuer: 'https://token.actions.githubusercontent.com',
    subjectAlternativeName: `https://github.com/${WF}`,
    buildSignerURI: `https://github.com/${WF}`,
    buildSignerDigest: WF_SHA,
    githubWorkflowTrigger: 'push',
    buildTrigger: 'push',
    githubWorkflowRepository: 'acme/demo',
    githubWorkflowRef: `refs/heads/${slice.branch}`,
    githubWorkflowSHA: head,
    runnerEnvironment: 'github-hosted',
    sourceRepositoryURI: 'https://github.com/acme/demo',
    sourceRepositoryDigest: head,
    sourceRepositoryRef: `refs/heads/${slice.branch}`,
    sourceRepositoryOwnerURI: 'https://github.com/acme',
    buildConfigURI: `https://github.com/acme/demo/.github/workflows/unknot.yml@refs/heads/${slice.branch}`,
    buildConfigDigest: head,
    runInvocationURI: 'https://github.com/acme/demo/actions/runs/901/attempts/1',
    ...over,
  });
  const wfRun = (over = {}) => fixture('workflow_run', { head_sha: head, head_branch: slice.branch, ...over });
  const serve = ({ file = evidence, att, runs = [wfRun()], artifacts = { 901: [fixture('artifact')] }, tree = workflowsTree, extra = {} } = {}) => {
    const subject = [{ name: 'unknot-evidence.json', digest: { sha256: sha256(file) } }];
    gh.routes({
      'GET repos/acme/demo': fixture('repo'),
      'GET repos/acme/demo/pulls/7': fixture('pull', { head: { ...fixture('pull').head, sha: head, ref: slice.branch } }),
      [`GET repos/acme/demo/contents/.github?ref=${baseSha}`]: [fixture('contents_dir_entry', { sha: tree })],
      [`GET repos/acme/demo/actions/runs?head_sha=${head}&event=push&per_page=100`]: { total_count: runs.length, workflow_runs: runs },
      ...Object.fromEntries(Object.entries(artifacts).map(([rid, list]) => [`GET repos/acme/demo/actions/runs/${rid}/artifacts?name=unknot-evidence`, { total_count: list.length, artifacts: list }])),
      [`DOWNLOAD ${runs[0]?.id ?? 901} unknot-evidence`]: file,
      ...(att === null ? {} : { [`ATTEST sha256:${sha256(file)}`]: att ?? [attested(cert(), subject)] }),
      ...extra,
    });
    return subject;
  };
  const ciRecorded = () => ctx.store.all("SELECT actor, payload FROM events WHERE type = 'evidence.recorded' AND slice_id = ? AND actor LIKE 'ci:%'", sliceId);
  const fromCi = () => cli(verifyCmd, dir, [], { from_ci: '7' });
  const refused = async (re, why) => {
    const before = ciRecorded().length;
    await assert.rejects(fromCi(), (err) => { assert.match(err.message, re, why); return true; }, why);
    assert.equal(ciRecorded().length, before, `${why}: nothing recorded`);
  };

  // Each certificate field Unknot checks itself, behind gh's own identity flags.
  const subject = serve();
  serve({ att: [attested(cert({ sourceRepositoryURI: 'https://github.com/mallory/demo' }), subject)] });
  await refused(/made in https:\/\/github.com\/mallory\/demo, not acme\/demo/, 'another repository');
  serve({ att: [attested(cert({ subjectAlternativeName: `https://github.com/acme/unknot/.github/workflows/other.yml@${WF_SHA}`, buildSignerURI: `https://github.com/acme/unknot/.github/workflows/other.yml@${WF_SHA}` }), subject)] });
  await refused(/signed by .*other\.yml.*not the pinned workflow/, 'another workflow');
  serve({ att: [attested(cert({ subjectAlternativeName: 'https://github.com/acme/unknot/.github/workflows/unknot-verify.yml@refs/heads/main', buildSignerURI: 'https://github.com/acme/unknot/.github/workflows/unknot-verify.yml@refs/heads/main', buildSignerDigest: 'b'.repeat(40) }), subject)] });
  await refused(/signed by .*@refs\/heads\/main, not the pinned workflow/, 'the pinned workflow at another ref');
  serve({ att: [attested(cert({ buildSignerDigest: 'b'.repeat(40) }), subject)] });
  await refused(/not the pinned workflow/, 'the pinned ref naming a different signer commit');
  serve({ att: [attested(cert({ sourceRepositoryDigest: 'c'.repeat(40), buildConfigDigest: 'c'.repeat(40) }), subject)] });
  await refused(/made on commit cccccccccccc, not the bound head/, 'another head');
  serve({ att: [attested(cert({ sourceRepositoryRef: 'refs/heads/main' }), subject)] });
  await refused(/made on refs\/heads\/main, not refs\/heads\/unknot\//, 'another branch at the same head');

  // Forged, unsigned or missing bundle: gh verifies nothing (as the real gh does), so nothing counts.
  serve({ att: null });
  await refused(/has no valid attestation from acme\/unknot\/\.github\/workflows\/unknot-verify\.yml@aaaaaaaaaaaa on head .*no attestations found/, 'a forged or unsigned bundle');
  // A valid attestation of some other file.
  serve({ att: [attested(cert(), [{ name: 'unknot-evidence.json', digest: { sha256: 'd'.repeat(64) } }])] });
  await refused(/its subject is not this evidence file/, 'another file\'s attestation');
  // Evidence edited after it was attested: gh finds no attestation for the edited file.
  const edited = evidence.replace('"exit_code": 0', '"exit_code": 0 ');
  serve({ file: edited, att: null });
  await refused(/has no valid attestation/, 'evidence edited after attestation');

  // Replays: an older run's attestation, an older attempt, and a newer run that left no evidence.
  serve({ att: [attested(cert({ runInvocationURI: 'https://github.com/acme/demo/actions/runs/900/attempts/1' }), subject)] });
  await refused(/not the latest run https:\/\/github.com\/acme\/demo\/actions\/runs\/901\/attempts\/1/, 'an older run\'s attestation');
  serve({ runs: [wfRun({ run_attempt: 2 })] });
  await refused(/not the latest run .*901\/attempts\/2/, 'an older attempt of the run');
  serve({ runs: [wfRun({ id: 902, conclusion: 'failure' }), wfRun()], artifacts: { 902: [], 901: [fixture('artifact')] }, extra: { 'DOWNLOAD 901 unknot-evidence': evidence } });
  await refused(/run 902 of \.github\/workflows\/unknot\.yml .* is newer than the attested evidence/, 'a newer run without evidence');

  // A changed workflow ran: the head's .github/workflows differs from the base branch's on GitHub.
  serve({ tree: 'e'.repeat(40) });
  await refused(/the head's \.github\/workflows \(.*\) is not the base branch's \(eeeeeeeeeeee\): a changed workflow ran/, 'a workflow changed in the pull request');

  // Fork and pull_request_target runs: not a push in the pinned repository.
  serve({ runs: [wfRun({ event: 'pull_request', head_repository: { id: 9, name: 'demo', full_name: 'mallory/demo' } })] });
  await refused(/no push run on head .* uploaded unknot-evidence/, 'a fork\'s pull request run');
  serve({ att: [attested(cert({ buildTrigger: 'pull_request_target', githubWorkflowTrigger: 'pull_request_target' }), subject)] });
  await refused(/triggered by pull_request_target, not a push/, 'a pull_request_target run');
  serve({ att: [attested(cert({ runnerEnvironment: 'self-hosted' }), subject)] });
  await refused(/self-hosted runner/, 'a self-hosted runner');

  // Attested evidence, but for another slice or diff.
  const other = evidence.replace(`"slice_id": "${sliceId}"`, '"slice_id": "UK-9999"');
  serve({ file: other, att: [attested(cert(), [{ name: 'unknot-evidence.json', digest: { sha256: sha256(other) } }])] });
  await refused(/the evidence is not for .* at head/, 'evidence for another slice');

  // Every gh call stays on github.com, and gh is asked to enforce the identity too.
  const verifyArgs = gh.calls().find((c) => c[0] === 'attestation');
  for (const [flag, value] of [['--repo', 'acme/demo'], ['--signer-workflow', 'acme/unknot/.github/workflows/unknot-verify.yml'], ['--signer-digest', WF_SHA], ['--source-digest', head], ['--source-ref', `refs/heads/${slice.branch}`], ['--hostname', 'github.com']]) {
    assert.equal(verifyArgs[verifyArgs.indexOf(flag) + 1], value, flag);
  }
  assert.ok(verifyArgs.includes('--deny-self-hosted-runners'));
  assert.ok(gh.calls().filter((c) => c[0] === 'run').every((c) => c[c.indexOf('--repo') + 1] === 'github.com/acme/demo'));

  // Human obligations are never satisfiable by CI (FR-003), and only the planned command counts.
  const human = commands.find((oid) => oid !== unit.id);
  assert.ok(human, 'a second command obligation to turn into a human one');
  ctx.store.run('UPDATE proof_obligations SET requires_human = 1 WHERE id = ?', human);
  const forged = JSON.parse(evidence);
  // The human obligation's CI result is a genuine pass of its old command; it still cannot count.
  forged.results = forged.results.map((r) => (r.id === unit.id ? { ...r, command: ['true'] } : r));
  const forgedText = `${JSON.stringify(forged, null, 2)}\n`;
  serve({ file: forgedText, att: [attested(cert(), [{ name: 'unknot-evidence.json', digest: { sha256: sha256(forgedText) } }])] });
  let res = await fromCi();
  assert.match(res.out, new RegExp(`${human} .*not_counted.*needs a person; CI evidence cannot pass it`));
  assert.match(res.out, new RegExp(`${unit.id} .*not_counted.*CI ran true, not node --test`));
  assert.match(res.out, /Nothing recorded/);
  assert.equal(ciRecorded().length, 0);
  ctx.store.run('UPDATE proof_obligations SET requires_human = 0 WHERE id = ?', human);

  // A failing command in CI is reported and records nothing.
  const failing = evidence.replaceAll('"exit_code": 0', '"exit_code": 1');
  serve({ file: failing, att: [attested(cert(), [{ name: 'unknot-evidence.json', digest: { sha256: sha256(failing) } }])] });
  res = await fromCi();
  assert.equal(res.code, 1);
  assert.match(res.out, new RegExp(`${unit.id} .*fail`));
  assert.equal(ciRecorded().length, 0);

  // The slice's code runs in the job that writes the file, so it can rewrite a failure to exit 0
  // after Unknot wrote it. The attestation is then genuine, but the run failed: nothing counts.
  serve({ runs: [wfRun({ conclusion: 'failure' })] });
  res = await fromCi();
  assert.equal(res.code, 1);
  assert.match(res.out, new RegExp(`${unit.id} +[a-z-]+ +inconclusive`));
  assert.match(res.out, /Nothing recorded\./);
  assert.equal(ciRecorded().length, 0);

  // Scenario 3: the genuine attested evidence is recorded as passed by CI, bound to the run and head.
  serve();
  res = await fromCi();
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /attestation verified/);
  assert.match(res.out, /Recorded 2 obligation\(s\) as passed by CI evidence/);
  const rec = ciRecorded();
  assert.equal(rec.length, 2);
  assert.equal(rec[0].actor, 'ci:acme/unknot/.github/workflows/unknot-verify.yml');
  const o = ctx.store.get('SELECT status, evidence_id FROM proof_obligations WHERE id = ?', unit.id);
  assert.equal(o.status, 'pass');
  const record = JSON.parse(ctx.store.get('SELECT record FROM evidence WHERE id = ?', o.evidence_id).record);
  assert.equal(record.kind, 'ci');
  assert.deepEqual(record.ci, { pull_request: 'https://github.com/acme/demo/pull/7', head, run: 'https://github.com/acme/demo/actions/runs/901/attempts/1', workflow: `https://github.com/${WF}`, evidence_digest: `sha256:${sha256(evidence)}` });
  assert.equal(loadSlice(ctx, sliceId).state, 'REVIEW_READY');
});

test('the CI side runs only in GitHub Actions, never from an agent session: it runs commands without the sandbox', async () => {
  const { judgeShell } = await import('../../runtime/policy/commands.mjs');
  const pluginRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
  const bin = join(pluginRoot, 'bin/unknot');
  for (const cmd of [`${bin} verify --in-ci /tmp/e.json`, `${bin} verify --in-ci=/tmp/e.json`, `node ${bin} --json verify --in-ci x`]) {
    const j = judgeShell(cmd, { pluginRoot, projectRoot: tmpdir() });
    assert.equal(j.allow, false, cmd);
    assert.match(j.reasons.join(' '), /--in-ci` runs commands without the sandbox/, cmd);
  }
  assert.equal(judgeShell(`${bin} verify --from-ci 7`, { pluginRoot, projectRoot: tmpdir() }).allow, true, 'recording CI evidence is not human-only');
  const dir = mkTmp(join(tmpdir(), 'uk-inci-'));
  for (const env of [{ GITHUB_ACTIONS: undefined }, { GITHUB_ACTIONS: 'true', CLAUDECODE: '1' }]) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try {
      await assert.rejects(cli(verifyCmd, dir, [], { in_ci: join(dir, 'e.json') }), /runs only in the GitHub Actions evidence workflow/);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  // In Actions, a failed command fails the step, so the run's conclusion records it where the slice's code cannot rewrite it.
  g(dir, ['init', '-q']);
  const plan = { v: 1, slice: 'S-0001', diff_hash: 'x', obligations: [{ id: 'PO-1', kind: 'test', run: ['false'] }, { id: 'PO-2', kind: 'review', not_run: 'needs a person' }] };
  g(dir, ['commit', '-q', '--allow-empty', '-m', `slice\n\nUnknot-CI: ${JSON.stringify(plan)}`]);
  const saved = { a: process.env.GITHUB_ACTIONS, c: process.env.CLAUDECODE, e: process.env.CLAUDE_CODE_ENTRYPOINT };
  process.env.GITHUB_ACTIONS = 'true';
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  try {
    const res = await cli(verifyCmd, dir, [], { in_ci: join(dir, 'e.json') });
    assert.equal(res.code, 1, 'a failed command fails the CI step');
    assert.equal(JSON.parse(readFileSync(join(dir, 'e.json'), 'utf8')).results[0].exit_code, 1);
  } finally {
    for (const [k, v] of [['GITHUB_ACTIONS', saved.a], ['CLAUDECODE', saved.c], ['CLAUDE_CODE_ENTRYPOINT', saved.e]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('doctor: the base branch must require the unknot / verify check when CI evidence is on (scenario 6)', () => {
  const dir = mkTmp(join(tmpdir(), 'uk-doc-'));
  g(dir, ['init', '-q']);
  g(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git']);
  const config = { approvals: { via: 'forge', forge: { gh: gh.bin, repository: 'acme/demo', agent_accounts: [], ci_workflow: WF } } };
  const prot = (checks) => fixture('protection', { required_status_checks: { strict: true, contexts: checks, checks: checks.map((context) => ({ context, app_id: 15368 })) } });
  gh.routes({ 'GET repos/acme/demo': fixture('repo'), 'GET repos/acme/demo/branches/main/protection': prot([]) });
  assert.equal(forgeChecks(dir, config).find((c) => c.name === 'forge ci check').level, 'fail');
  gh.routes({ 'GET repos/acme/demo': fixture('repo'), 'GET repos/acme/demo/branches/main/protection': prot(['unknot / verify']) });
  assert.equal(forgeChecks(dir, config).find((c) => c.name === 'forge ci check').level, 'ok');
  const unpinned = { approvals: { ...config.approvals, forge: { ...config.approvals.forge, ci_workflow: 'acme/unknot/.github/workflows/unknot-verify.yml@main' } } };
  assert.match(forgeChecks(dir, unpinned).find((c) => c.name === 'forge ci check').detail, /must be pinned by SHA/);
  assert.equal(forgeChecks(dir, { approvals: { ...config.approvals, forge: { ...config.approvals.forge, ci_workflow: undefined } } }).some((c) => c.name === 'forge ci check'), false);
});
