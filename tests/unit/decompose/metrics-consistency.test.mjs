// One metric name, one value per record: every metric a record's treatment evaluations name
// equals the value in its boundary summary; the edge count and the module count of outbound
// dependencies are two metrics with two names.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { analyse, FIXTURES } from '../../golden/_harness.mjs';

const { decompose } = await import('../../../runtime/decompose/index.mjs');
const { metricMismatches } = await import('../../../runtime/decompose/records.mjs');

// Four groups of eight modules that import each other heavily: many outbound import edges
// into few distinct modules.
const groups = ['a', 'b', 'c', 'd'];
const extra = {};
for (const g of groups) {
  for (let i = 0; i < 8; i++) {
    const own = [...Array(8).keys()].filter((j) => j !== i).map((j) => `import { f_${g}${j} } from './${g}${j}.js';`);
    const other = groups.filter((x) => x !== g).flatMap((x, k) => [0, 1, 2, 3].filter((n) => (n + i + k) % 3 === 0).map((n) => `import { f_${x}${n} } from '../${x}/${x}${n}.js';`));
    extra[`shop/${g}/${g}${i}.js`] = `${own.join('\n')}\n${other.join('\n')}\nexport function f_${g}${i}() { return 1; }\n`;
  }
}

describe('a record names each metric once', () => {
  test('treatment evaluations quote the value the boundary summary shows', async () => {
    const r = await analyse('modular-monolith', { extra, skipDiagnose: true });
    let checked = 0;
    for (const drivers of [[], ['independent_deploy', 'team_autonomy']]) {
      const res = await decompose(r.ctx, { config: r.config, scope: ['shop/**'], drivers, dryRun: true });
      assert.ok(res.details.length >= 1);
      for (const rec of res.details) {
        assert.deepEqual(metricMismatches(rec), []);
        const failed = rec.rejected_treatments.flatMap((t) => t.failed_predicates ?? []);
        const outbound = failed.find((f) => f.signal === 'boundary.outbound_dependencies');
        assert.ok(outbound, 'T3 is rejected on outbound dependencies');
        assert.equal(outbound.value, rec.candidate.metrics['boundary.outbound_dependencies']);
        // Every metric a rejection names is also in the boundary summary.
        for (const f of failed) assert.ok(f.signal in rec.candidate.metrics, f.signal);
        checked += failed.length;
      }
    }
    assert.ok(checked > 0);
  });

  test('edges and distinct modules are different metrics with different names', async () => {
    const r = await analyse('modular-monolith', { extra, skipDiagnose: true });
    const [rec] = (await decompose(r.ctx, { config: r.config, scope: ['shop/**'], dryRun: true })).details;
    const m = rec.candidate.metrics;
    assert.ok(m['boundary.outbound_dependencies'] > m['boundary.outbound_dependency_modules']);
    assert.ok(m['boundary.outbound_dependency_modules'] > 0);
    assert.equal(m['boundary.outbound_dependencies'], m['boundary.reverse_deps'], 'the 0.1.x alias carries the same value');
  });

  test('records on every golden fixture are consistent', async () => {
    for (const name of readdirSync(FIXTURES)) {
      const r = await analyse(name, { skipDiagnose: true });
      for (const drivers of [[], ['independent_deploy']]) {
        for (const rec of (await decompose(r.ctx, { config: r.config, drivers, dryRun: true })).details) assert.deepEqual(metricMismatches(rec), [], name);
      }
    }
  });

  test('a mismatch is detected', () => {
    const rec = { candidate: { metrics: { 'boundary.outbound_dependencies': 25 } }, rejected_treatments: [{ treatment: 'T3', failed_predicates: [{ signal: 'boundary.outbound_dependencies', value: 2 }] }] };
    assert.deepEqual(metricMismatches(rec), [{ metric: 'boundary.outbound_dependencies', summary: 25, evaluation: 2, where: 'rejected T3' }]);
  });
});
