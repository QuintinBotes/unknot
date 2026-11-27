// Candidates are parts of the system (#161): CI configuration and its helper scripts are never
// decomposition targets, and a boundary nothing crosses earns no confidence from its isolation.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse } from '../../golden/_harness.mjs';

const { decompose } = await import('../../../runtime/decompose/index.mjs');

async function run(name, extra) {
  const r = await analyse(name, { extra, skipDiagnose: true });
  return { ...r, out: await decompose(r.ctx, { config: r.config, dryRun: true }) };
}

const py = (next) => `import os\nfrom ${next} import main as nxt\n\ndef main():\n    return nxt(os.environ)\n`;

test('scripts under CI configuration paths are members of no candidate', async () => {
  const extra = {
    '.github/scripts/export_owners.py': py('export_contacts'),
    '.github/scripts/export_contacts.py': py('resolve_managers'),
    '.github/scripts/resolve_managers.py': py('export_owners'),
    '.gitlab/ci/check.py': py('report'),
    '.gitlab/ci/report.py': py('check'),
    '.circleci/tools/notify.py': py('notify'),
    '.azure-pipelines/scripts/tag.py': py('tag'),
  };
  const r = await run('dotnet-projects', extra);
  const members = r.out.details.flatMap((d) => [...d.candidate.modules, ...(d.candidate.units ?? []).map((u) => u.id)]);
  assert.ok(members.length > 0);
  assert.deepEqual(members.filter((m) => /^module:\.(github|gitlab|circleci|azure-pipelines)\//.test(m)), []);
  // The real candidates are what they are without the scripts.
  const plain = await run('dotnet-projects', {});
  assert.deepEqual(r.out.details.map((d) => [d.candidate.name, d.treatment, d.confidence]), plain.out.details.map((d) => [d.candidate.name, d.treatment, d.confidence]));
});

test('a standalone script folder nothing uses gets no confidence from having no coupling', async () => {
  const script = 'import os\n\ndef main():\n    return os.environ\n';
  const r = await run('dotnet-projects', { 'tools/scripts/a.py': script, 'tools/scripts/b.py': script, 'tools/scripts/c.py': script });
  const alone = r.out.details.find((d) => d.candidate.modules.some((m) => m.startsWith('module:tools/scripts/')));
  assert.ok(alone, JSON.stringify(r.out.details.map((d) => d.candidate.name)));
  assert.equal(alone.candidate.metrics['module.consumers'], 0);
  assert.equal(alone.candidate.robust, true);
  assert.equal(alone.confidence, 'low');
  assert.match(alone.confidence_lowered, /no module outside the candidate uses it/);
  const rank = { low: 0, medium: 1, high: 2 };
  for (const d of r.out.details) if (d !== alone) assert.ok(rank[d.confidence] >= rank[alone.confidence]);
});
