// Cross-command consistency: the commands that read the shared derived facts agree on cycles,
// declared-only members, the public surface, test code and layers, over the golden fixtures and a C#
// fixture with an injected-but-unused member inside a cycle.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkTmp } from '../helpers/tmp.mjs';
import { test } from 'node:test';
import { analyse, FIXTURES } from '../golden/_harness.mjs';

const { checkConsistency } = await import('../../runtime/graph/consistency.mjs');
const { Graph } = await import('../../runtime/graph/graph.mjs');
const { readDerived } = await import('../../runtime/graph/derived.mjs');
const { mapRepository } = await import('../../runtime/graph/builder.mjs');
const { CHECKS } = await import('../../runtime/verify/checks.mjs');
const { diagnose } = await import('../../runtime/diagnose/engine.mjs');
const { TOOLS } = await import('../../runtime/mcp/tools.mjs');

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

test('layered-monolith: one layer per module, configured or by directory, read by diagnose, architecture and MCP (#245)', async () => {
  const LAYERS = ['src/controllers/**', 'src/services/**', 'src/repositories/**'];
  for (const [config, source, first] of [[{}, 'directory', 'presentation'], [{ detectors: { 'module.layer-bypass': { layers: LAYERS } } }, 'configured', LAYERS[0]]]) {
    const a = await analyse('layered-monolith', { config, skipDiagnose: true });
    const rows = readDerived(a.ctx, 'layers', { graph: Graph.fromStore(a.ctx.store) });
    assert.equal(rows.length, 7, 'every controller, service and repository; not app.js, legacy or the test');
    assert.ok(rows.every((r) => r.body.source === source));
    assert.deepEqual(rows.find((r) => r.key === 'module:src/controllers/orderController.js').body, { layer: first, index: 0, source });
    const r = await checkConsistency(a.ctx, { config: a.config });
    assert.deepEqual(r.disagreements, []);
    assert.equal(r.counts.layer_modules, 7);
    if (source === 'configured') assert.ok((await diagnose(a.ctx, { config: a.config, only: ['module'] })).findings.some((f) => f.kind === 'module.layer-bypass'), 'the configured run has layer-bypass findings to check');
  }
});

test('the checker reports a module whose stored layer differs from what the graph and commands give', async () => {
  const a = await analyse('layered-monolith', { skipDiagnose: true });
  a.ctx.store.run("UPDATE derived SET body = json_set(body, '$.layer', 'data', '$.index', 2) WHERE kind = 'layers' AND key = 'module:src/controllers/orderController.js'");
  const r = await checkConsistency(a.ctx, { config: a.config });
  assert.ok(r.disagreements.some((d) => d.check === 'layers' && /orderController\.js is stored in data \(directory\), the graph and config give presentation/.test(d.detail)), JSON.stringify(r.disagreements));
  assert.ok(r.disagreements.some((d) => d.check === 'layers' && /architecture reports/.test(d.detail)), 'architecture read the stored row');
});

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

test('a component too large for one MCP result is cut there, which is no disagreement (#244)', async () => {
  const a = await analyse('cycle-injection', { skipDiagnose: true });
  a.ctx.store.run("UPDATE derived SET body = json_set(body, '$.pad', ?) WHERE kind = 'scc'", 'x'.repeat(60000));
  assert.equal(TOOLS.graph_query.run(a.ctx, { derived: 'scc', limit: 200 }).truncated, true, 'the MCP result is cut');
  const r = await checkConsistency(a.ctx, { config: a.config });
  assert.deepEqual(r.disagreements, []);
  assert.equal(r.counts.components, 1);
});

test('readDerived fills a store mapped before the table existed, and the facts survive a re-read', async () => {
  const a = await analyse('cycle-injection', { skipDiagnose: true });
  a.ctx.store.run('DELETE FROM derived');
  const first = readDerived(a.ctx, 'scc', { graph: Graph.fromStore(a.ctx.store) });
  assert.equal(first.length, 1);
  assert.equal(a.ctx.store.get("SELECT COUNT(*) AS n FROM derived WHERE kind = 'scc'").n, 1);
  assert.deepEqual(readDerived(a.ctx, 'scc', { graph: Graph.fromStore(a.ctx.store) }), first);
});

test('scripts/consistency.mjs --work checks every corpus repository not marked large, and names one that was not mapped (#244)', async () => {
  const a = await analyse('layered-monolith', { skipDiagnose: true });
  const work = mkTmp(join(tmpdir(), 'uk-consistency-work-'));
  const repo = (name, extra = {}) => ({ name, sha: `${name.length}`.padEnd(40, '0'), url: 'https://example.invalid', ...extra });
  const mapped = repo('mapped');
  mkdirSync(join(work, `mapped@${mapped.sha.slice(0, 12)}`));
  symlinkSync(a.dir, join(work, `mapped@${mapped.sha.slice(0, 12)}`, 'src'));
  const run = (repositories, ...flags) => {
    const corpus = join(work, `corpus-${repositories.length}.json`);
    writeFileSync(corpus, JSON.stringify({ repositories }));
    return spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/consistency.mjs', import.meta.url)), '--work', work, '--corpus', corpus, ...flags], { encoding: 'utf8' });
  };
  const ok = run([mapped, repo('huge', { large: true })]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /no disagreement/);
  assert.doesNotMatch(ok.stdout, /huge/, 'a large repository is not checked');
  const missing = run([mapped, repo('absent')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /MISSING absent: not mapped/);
  assert.match(missing.stdout, /no disagreement/, 'the mapped one is still checked');
  const quick = run([mapped, repo('absent'), repo('fast', { quick: true })], '--quick');
  assert.equal(quick.status, 1);
  assert.match(quick.stdout, /MISSING fast/);
  assert.doesNotMatch(quick.stdout, /absent|== /, '--quick selects the quick corpus only');
});
