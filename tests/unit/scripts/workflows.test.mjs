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
