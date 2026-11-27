// Every finding records a confidence (#179), from one rule over the evidence it rests on: the
// parse quality of its modules, observed against inferred evidence, and what the detector says.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';

const { mapRepository } = await import('../../../runtime/graph/builder.mjs');
const { diagnose, findingConfidence } = await import('../../../runtime/diagnose/engine.mjs');
const { digest } = await import('../../../runtime/core/canonical.mjs');

after(() => K.cleanup());

const NEST = `${['if (a) {', 'if (b) {', 'if (c) {', 'if (d) {', 'if (e) {', 'if (f) {'].join('\n')}\nreturn 1;\n${'}\n'.repeat(6)}`;
const FILES = {
  'cs/BillingHelper.cs': `namespace Billing\n{\n    public class BillingHelper\n    {\n        public int Round(bool a, bool b, bool c, bool d, bool e, bool f)\n        {\n${NEST}            return 0;\n        }\n    }\n}\n`,
  'src/billing.js': `export function round(a, b, c, d, e, f) {\n${NEST}  return 0;\n}\n`,
};

const p = K.makeProject({ files: FILES });
const config = K.cfg({ mode: 'plan' });
await mapRepository(p.ctx, { config, configDigest: 'd', scope: [], history: false });
const res = await diagnose(p.ctx, { config, all: true });

test('every finding records a confidence, and fingerprints do not read it', () => {
  assert.ok(res.findings.length > 0);
  for (const f of res.findings) {
    assert.ok(['low', 'medium', 'high'].includes(f.confidence), `${f.id} ${f.kind}: ${f.confidence}`);
    assert.equal(f.fingerprint, digest({ kind: f.kind, key: f.key }));
  }
});

test('a finding on a lexically read module is low; one on a parsed module is not', () => {
  const cs = res.findings.filter((f) => f.scope.includes('cs/BillingHelper.cs') && f.category === 'local');
  const js = res.findings.filter((f) => f.scope.includes('src/billing.js') && f.category === 'local');
  assert.ok(cs.length && js.length, res.findings.map((f) => `${f.kind} ${f.scope}`).join(' | '));
  for (const f of cs) assert.equal(f.confidence, 'low', f.kind);
  for (const f of js) assert.ok(['medium', 'high'].includes(f.confidence), `${f.kind}: ${f.confidence}`);
});

test('the rule: parse quality, observed evidence, the evidence factor and stated low confidence', () => {
  const nodes = {
    'module:a.ts': { path: 'a.ts', attrs: { parse_quality: 'ok' } },
    'module:b.py': { path: 'b.py', attrs: { parse_quality: 'syntax_error' } },
    'module:c.cs': { path: 'c.cs', attrs: { parse_quality: 'lexical' } },
    'endpoint:GET /x': { path: null, attrs: {}, label: 'inferred' },
  };
  const g = { node: (id) => nodes[id] ?? null };
  const draft = (over) => ({ scope: ['a.ts'], evidence: [{ ref: 'module:a.ts', label: 'observed' }], factors: { evidence: 0.9 }, uncertainties: [], ...over });
  assert.equal(findingConfidence(draft(), g), 'high');
  assert.equal(findingConfidence(draft({ scope: ['b.py'], evidence: [] }), g), 'medium', 'a syntax error caps it at medium');
  assert.equal(findingConfidence(draft({ scope: ['c.cs'], evidence: [] }), g), 'low', 'lexical only');
  assert.equal(findingConfidence(draft({ scope: ['c.cs'] }), g), 'medium', 'partly lexical');
  assert.equal(findingConfidence(draft({ evidence: [{ ref: 'x', label: 'inferred' }] }), g), 'low', 'nothing observed');
  assert.equal(findingConfidence(draft({ evidence: [{ ref: 'x', label: 'inferred' }, { ref: 'y' }] }), g), 'medium', 'partly inferred');
  assert.equal(findingConfidence(draft({ evidence: [{ ref: 'endpoint:GET /x', label: 'observed' }] }), g), 'low', 'the graph fact behind it was inferred');
  assert.equal(findingConfidence(draft({ factors: { evidence: 0.6 } }), g), 'medium');
  assert.equal(findingConfidence(draft({ factors: { evidence: 0.35 } }), g), 'low');
  assert.equal(findingConfidence(draft({ uncertainties: ['Low confidence: inferred from column and table names only.'] }), g), 'low');
  assert.equal(findingConfidence(draft({ uncertainties: ['Inference from names only: low confidence'] }), g), 'low');
  assert.equal(findingConfidence(draft({ uncertainties: ['Medium/low confidence: locals are not examined.'] }), g), 'high');
  assert.equal(findingConfidence(draft({ confidence: 'low' }), g), 'low', "a detector's own judgement stands");
  assert.equal(findingConfidence(draft({ scope: ['c.cs'], evidence: [], confidence: 'medium' }), g), 'medium');
});
