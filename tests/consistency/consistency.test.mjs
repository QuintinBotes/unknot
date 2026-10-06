// Cross-command consistency: the commands that read the shared derived facts agree on cycles,
// declared-only members, the public surface and test code, over the golden fixtures and a C#
// fixture with an injected-but-unused member inside a cycle.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyse, FIXTURES } from '../golden/_harness.mjs';

const { checkConsistency } = await import('../../runtime/graph/consistency.mjs');
const { Graph } = await import('../../runtime/graph/graph.mjs');
const { readDerived } = await import('../../runtime/graph/derived.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { CHECKS } = await import('../../runtime/verify/checks.mjs');

// A test module far over the module-size threshold, so the exclusion is exercised.
const bigTest = `namespace Shop.Orders.Tests\n{\n    public class BulkTests\n    {\n${Array.from({ length: 1100 }, (_, i) => `        public int Case${i}() { return ${i}; }`).join('\n')}\n    }\n}\n`;

for (const name of readdirSync(FIXTURES).sort()) {
  test(`${name}: every command agrees on the shared facts`, async () => {
    const a = await analyse(name, { skipDiagnose: true, ...(name === 'cycle-injection' && { extra: { 'Orders.Tests/BulkTests.cs': bigTest } }) });
    const r = await checkConsistency(a.ctx, { config: a.config });
    assert.deepEqual(r.disagreements, []);
    if (name === 'cycle-injection') {
      // Not vacuous: a component, its declared-only edges, a finding for each and the test modules.
      assert.equal(r.counts.components, 1);
      assert.equal(r.counts.declared_only, 2);
      assert.equal(r.counts.public_declared_only, 1);
      assert.equal(r.counts.unused_member_edges, 2);
      assert.equal(r.counts.test_modules, 2);
      assert.equal(r.counts.module_size_findings, 0);
    }
  });
}

test('cycle-injection: removing the unused public member for real passes the API check and ends the cycle', async () => {
  const a = await analyse('cycle-injection', { skipDiagnose: true });
  const before = Graph.fromStore(a.ctx.store);
  const edge = readDerived(a.ctx, 'declared_only', { graph: before }).map((r) => r.body).find((b) => b.visibility === 'public');
  assert.ok(edge, 'a public declared-only edge');
  assert.equal(edge.member, 'Peer');
  const file = join(a.dir, 'Ledger/LedgerService.cs');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/ *\[Dependency\]\n *public OrderService Peer \{ get; set; \}\n/, ''));
  await mapRepository(a.ctx, { config: a.config, configDigest: a.cfg.digest, history: false });
  const after = Graph.fromStore(a.ctx.store);
  assert.deepEqual(readDerived(a.ctx, 'scc', { graph: after }), []);
  const verdict = CHECKS.api({ pair: { before, after }, changes: [{ path: 'Ledger/LedgerService.cs', status: 'M' }] });
  assert.equal(verdict.verdict, 'pass');
  assert.match(verdict.detail, /Peer/);
});

test('the checker reports a disagreement when a component has no finding and no reason', async () => {
  const a = await analyse('cycle-injection', { skipDiagnose: true });
  a.ctx.store.run("UPDATE derived SET body = json_set(body, '$.finding', json('false')) WHERE kind = 'scc'");
  const r = await checkConsistency(a.ctx, { config: a.config });
  assert.ok(r.disagreements.some((d) => d.check === 'cycle-finding'), JSON.stringify(r.disagreements));
});

test('readDerived fills a store mapped before the table existed, and the facts survive a re-read', async () => {
  const a = await analyse('cycle-injection', { skipDiagnose: true });
  a.ctx.store.run('DELETE FROM derived');
  const first = readDerived(a.ctx, 'scc', { graph: Graph.fromStore(a.ctx.store) });
  assert.equal(first.length, 1);
  assert.equal(a.ctx.store.get("SELECT COUNT(*) AS n FROM derived WHERE kind = 'scc'").n, 1);
  assert.deepEqual(readDerived(a.ctx, 'scc', { graph: Graph.fromStore(a.ctx.store) }), first);
});
