// Issue #46: a finding produced by the real map and diagnose keeps its confidence, so a slice
// planned from an unused private member can qualify as a proven deletion; the same in two
// languages, since the rule is about the finding, not the language.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../helpers/kernel.mjs';
import { mapRepository } from '../../runtime/graph/builder.mjs';
import { diagnose } from '../../runtime/diagnose/engine.mjs';
import { provenDeletion } from '../../runtime/policy/proven.mjs';

after(() => K.cleanup());

const CASES = [
  {
    language: 'C#',
    file: 'Shop/Legacy.cs',
    files: {
      'Shop/Mailer.cs': 'namespace Shop\n{\n    public class Mailer\n    {\n        public void Send() { }\n    }\n}\n',
      'Shop/Legacy.cs': 'namespace Shop\n{\n    public class Legacy\n    {\n        [Inject] private Mailer _mailer;\n        public void Run() { }\n    }\n}\n',
    },
  },
  {
    language: 'TypeScript',
    file: 'src/legacy.ts',
    files: {
      'src/mailer.ts': 'export class Mailer {\n  send(): void {}\n}\n',
      'src/legacy.ts': "import { Mailer } from './mailer';\n\nexport class Legacy {\n  constructor(private readonly mailer: Mailer) {}\n  run(): void {}\n}\n",
    },
  },
];

for (const c of CASES) {
  test(`${c.language}: the stored unused-member finding keeps its confidence and can qualify`, async () => {
    const p = K.makeProject({ files: c.files });
    const config = K.cfg({ mode: 'plan', repository: { publishes_api: false } });
    await mapRepository(p.ctx, { config, configDigest: 'd', history: false });
    const { run } = K.startTestRun(p, { command: 'diagnose' });
    await diagnose(p.ctx, { config, run, scope: [] });
    const row = p.ctx.store.get("SELECT id, body FROM findings WHERE kind = 'code.unused-injected-member'");
    assert.ok(row, 'the finding exists');
    const f = JSON.parse(row.body);
    assert.equal(f.confidence, 'medium');
    assert.ok(f.evidence.every((e) => e.label === 'observed'));
    const slice = { id: 'UK-9998', kind: 'code', objective: 'remove the unused member', scope: { include: [c.file], exclude: [] }, changes: [], sources: [row.id] };
    const v = provenDeletion(p.ctx, slice, { config });
    assert.ok(!v.problems.some((x) => /confidence|evidence:/.test(x)), v.problems.join('; '));
    assert.equal(v.qualifies, true, v.problems.join('; '));
  });
}

test('the problem text names the measured value against the requirement', async () => {
  const p = K.makeProject({ files: CASES[0].files });
  const config = K.cfg({ mode: 'plan', repository: { publishes_api: false } });
  const insert = (over) => {
    const id = `F-${Math.floor(Math.random() * 9000) + 1000}`;
    const body = { id, status: 'open', kind: 'code.unused-injected-member', category: 'code', title: 't', scope: [CASES[0].file], evidence: [{ ref: 'r', label: 'observed', summary: 's', source_ref: null }], measurements: { 'member.public': false }, patterns: [{ id: 'code.remove-dead-code' }], ...over };
    p.ctx.store.insert('findings', { id, fingerprint: `fp-${id}`, schema_version: '1', kind: body.kind, category: 'code', status: 'open', priority: 1, body, first_seen_commit: 'c', last_seen_commit: 'c', last_run_id: null, created_at: 'x', updated_at: 'x' });
    return id;
  };
  const problems = (id) => provenDeletion(p.ctx, { id: 'UK-9997', kind: 'code', objective: 'x', scope: { include: [CASES[0].file], exclude: [] }, changes: [], sources: [id] }, { config }).problems.join('; ');
  assert.match(problems(insert({})), /confidence: none recorded \(diagnose again to record it\); needs medium or high/);
  assert.match(problems(insert({ confidence: 'low' })), /confidence: low; needs medium or high/);
  assert.doesNotMatch(problems(insert({ confidence: 'high' })), /confidence/);
});
