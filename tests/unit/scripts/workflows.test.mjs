import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseYAML } from '../../../runtime/core/yaml.mjs';

const DIR = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (f) => readFileSync(DIR + f, 'utf8');

test('workflows are present', () => {
  assert.ok(files.includes('quality.yml'));
});

for (const f of files) {
  test(`${f}: parses, starts with no permissions, grants per job`, () => {
    const wf = parseYAML(read(f), { filename: f });
    assert.ok(wf.name && wf.jobs && Object.keys(wf.jobs).length);
    assert.deepEqual(wf.permissions, {}, 'top-level permissions must be {}');
    for (const [id, job] of Object.entries(wf.jobs)) {
      assert.ok(job['runs-on'], `${id} has runs-on`);
      assert.ok(job.permissions && Object.keys(job.permissions).length, `${id} restates its own permissions`);
      assert.ok(job['timeout-minutes'], `${id} has a timeout`);
    }
  });

  test(`${f}: every action is pinned to a full commit SHA`, () => {
    const uses = [...read(f).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/, `${f}: ${u}`);
  });
}

test('quality.yml: weekly and manual, read-only, accuracy then consistency, uploads results', () => {
  const text = read('quality.yml');
  const wf = parseYAML(text, { filename: 'quality.yml' });
  assert.ok(Array.isArray(wf.on.schedule) && wf.on.schedule[0].cron);
  assert.ok('workflow_dispatch' in wf.on);
  const job = wf.jobs.quality;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job['timeout-minutes'], 60);
  assert.equal(job.permissions.contents, 'read');
  assert.ok(!Object.entries(job.permissions).some(([k, v]) => v === 'write' || k === 'id-token'));
  assert.match(text, /scripts\/accuracy\.mjs --quick --work "\$RUNNER_TEMP\/corpus" --out "\$RUNNER_TEMP\/accuracy"/);
  assert.match(text, /scripts\/consistency\.mjs --work/);
  assert.match(text, /scripts\/accuracy-compare\.mjs/);
  assert.match(text, /hashFiles\('scripts\/corpus\.json'\)/);
  assert.match(text, /GITHUB_STEP_SUMMARY/);
  assert.match(text, /actions\/upload-artifact@/);
});

test('ci.yml: the blocking validator is pinned, the latest-version one never blocks', () => {
  const wf = parseYAML(read('ci.yml'), { filename: 'ci.yml' });
  const pinned = wf.jobs['validate-plugin'];
  const latest = wf.jobs['validate-plugin-latest'];
  const cmd = (j) => j.steps.map((s) => s.run ?? '').join('\n');
  assert.match(cmd(pinned), /@anthropic-ai\/claude-code@\d+\.\d+\.\d+ plugin validate --strict/);
  assert.notEqual(pinned['continue-on-error'], true);
  assert.match(cmd(latest), /@anthropic-ai\/claude-code@latest plugin validate --strict/);
  assert.equal(latest['continue-on-error'], true);
});

test('the validator pin in ci.yml equals the Claude Code pin in live.yml', () => {
  const pin = (f, re) => read(f).match(re)?.[1];
  const ci = pin('ci.yml', /claude-code@(\d+\.\d+\.\d+) plugin validate/);
  const live = pin('live.yml', /claude-code@(\d+\.\d+\.\d+)/);
  assert.ok(ci, 'ci.yml pins a version');
  assert.equal(ci, live);
});

test('codeql.yml: JavaScript analysis on PRs and main, least permissions', () => {
  const text = read('codeql.yml');
  const wf = parseYAML(text, { filename: 'codeql.yml' });
  assert.ok('pull_request' in wf.on && wf.on.push);
  assert.deepEqual(wf.jobs.analyze.permissions, { contents: 'read', 'security-events': 'write' });
  assert.match(text, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(text, /github\/codeql-action\/analyze@[0-9a-f]{40}/);
  assert.match(text, /languages: javascript-typescript/);
});

test('release.yml: notes come from the CHANGELOG section, not generated', () => {
  const text = read('release.yml');
  assert.match(text, /scripts\/release-notes\.mjs "\$TAG"/);
  assert.match(text, /--notes-file/);
  assert.doesNotMatch(text, /--generate-notes/);
});

test('release.yml: a restore drill runs before anything is published', () => {
  const text = read('release.yml');
  assert.match(text, /run: node scripts\/restore-drill\.mjs\n/);
  assert.ok(text.indexOf('restore-drill.mjs') < text.indexOf('gh release create'), 'a failed drill fails the release');
});

test('release.yml: publishing waits for the upgrade, consistency and benchmark gates; a dispatch runs only the gates', () => {
  const text = read('release.yml');
  const wf = parseYAML(text, { filename: 'release.yml' });
  assert.ok('workflow_dispatch' in wf.on && wf.on.push.tags);
  const gates = { test: /npm test/, upgrade: /node scripts\/upgrade-test\.mjs --count 5/, consistency: /node scripts\/consistency\.mjs --work/, bench: /node scripts\/bench\.mjs --sizes \w+ --release-gate/ };
  const run = (job) => job.steps.map((s) => s.run ?? '').join('\n');
  for (const [id, re] of Object.entries(gates)) {
    assert.match(run(wf.jobs[id]), re, id);
    assert.deepEqual(wf.jobs[id].permissions, { contents: 'read' }, `${id} only reads`);
  }
  assert.match(run(wf.jobs.consistency), /scripts\/accuracy\.mjs --quick/, 'the quick corpus is mapped before consistency');
  assert.equal(wf.jobs.upgrade.steps[0].with['fetch-depth'], 0, 'the upgrade test needs the release tags');
  const release = wf.jobs.release;
  assert.deepEqual([...release.needs].sort(), Object.keys(gates).sort());
  assert.match(release.if, /github\.event_name == 'push'/);
  assert.doesNotMatch(run(release), /npm test|upgrade-test|consistency|bench\.mjs/, 'gates run in their own jobs, before this one');
});

test('release.yml: stable advance names the owner command instead of a bare 403', () => {
  const text = read('release.yml');
  assert.match(text, /git diff --quiet "\$stable" "\$sha" -- \.github\/workflows/);
  assert.match(text, /cmd="git push git@github\.com:\$GITHUB_REPOSITORY\.git \$sha:refs\/heads\/stable"/);
  assert.match(text, /::error::[^\n]*\$cmd/);
  assert.match(text, /HTTP 403/);
  assert.ok(text.indexOf('git diff --quiet') < text.indexOf('gh api -X PATCH'), 'check runs before the API call');
});

test('unknot-verify.yml: reusable; the slice runs read-only, attesting runs no repository code, no key anywhere (#153)', () => {
  const text = read('unknot-verify.yml');
  const wf = parseYAML(text, { filename: 'unknot-verify.yml' });
  assert.deepEqual(Object.keys(wf.on), ['workflow_call']);
  assert.deepEqual(wf.jobs.run.permissions, { contents: 'read' }, 'the job that runs the slice\'s commands can only read');
  assert.match(wf.jobs.run.steps.map((s) => s.run ?? '').join('\n'), /bin\/unknot" verify --in-ci /);
  const own = wf.jobs.run.steps.find((s) => s.with?.path === 'unknot');
  assert.equal(own.with.ref, '${{ job.workflow_sha }}', 'Unknot runs at this workflow\'s own pinned commit');
  assert.deepEqual(wf.jobs.verify.permissions, { 'id-token': 'write', attestations: 'write', checks: 'write' });
  assert.equal(wf.jobs.verify.needs, 'run');
  // `--in-ci` exits 1 on a failed command, so the run fails; the evidence is still uploaded and attested.
  assert.equal(wf.jobs.run.steps.find((s) => /upload-artifact@/.test(s.uses ?? '')).if, '${{ !cancelled() }}');
  assert.equal(wf.jobs.verify.if, '${{ !cancelled() }}');
  assert.ok(!wf.jobs.verify.steps.some((s) => /actions\/checkout@/.test(s.uses ?? '')), 'the attesting job checks out nothing');
  assert.match(text, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(text, /conclusion=neutral/, 'obligations CI cannot run get a neutral check');
  assert.doesNotMatch(text, /secrets\.|_KEY|passphrase/i, 'no signing key or secret reaches CI (SC-002)');
  for (const step of wf.jobs.run.steps.filter((s) => /actions\/checkout@/.test(s.uses ?? ''))) assert.equal(step.with['persist-credentials'], false);
});

test('bump-claude-pin.yml: weekly and manual, writes only on its job, one fixed branch', () => {
  const text = read('bump-claude-pin.yml');
  const wf = parseYAML(text, { filename: 'bump-claude-pin.yml' });
  assert.ok(wf.on.schedule[0].cron && 'workflow_dispatch' in wf.on);
  assert.deepEqual(wf.jobs.bump.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.match(text, /scripts\/bump-claude-pin\.mjs/);
  assert.match(text, /branch=automation\/bump-claude-code-pin/);
});
