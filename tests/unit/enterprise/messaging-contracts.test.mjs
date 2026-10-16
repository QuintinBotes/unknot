import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { casPut } from '../../../runtime/state/cas.mjs';
import { contractEvidence } from '../../../runtime/decompose/contracts.mjs';
import { buildWorkspaceGraph, graphToDocument, MEMBER_META, WORKSPACE_GRAPH_META, workspaceLinks } from '../../../runtime/enterprise/workspace.mjs';

// Project state and generated keys stay inside the fixture directory.
const { openProject } = await import('../../../runtime/context.mjs');
const pv = prov({ source_type: 'inference', extractor: 'contracts@0.1.1', confidence: 'medium' });
function channelGraph(paths, edge) {
  return Graph.fromFacts([nodeFact('contract', 'topic orders.created', { attrs: { kind: 'messaging_channel', channel: 'orders.created', channel_type: 'topic' } }, pv),
    ...paths.flatMap((path) => [nodeFact('module', path, { path }, pv), edgeFact(edge, `module:${path}`, 'contract:topic orders.created', {}, pv)])]);
}

test('persisted workspace messaging links reach both repositories and count each remote consumer module', () => {
  const temp = mkdtempSync(join(tmpdir(), 'contracts-messaging-'));
  const contexts = [];
  const previousHome = process.env.UNKNOT_HOME;
  process.env.UNKNOT_HOME = join(temp, 'keys');
  try {
    const root = join(temp, 'workspace');
    const orders = join(temp, 'orders');
    const ledger = join(temp, 'ledger');
    for (const path of [root, orders, ledger]) mkdirSync(join(path, '.unknot'), { recursive: true });
    const rootCtx = openProject(root, { create: true });
    const ordersCtx = openProject(orders, { create: true });
    const ledgerCtx = openProject(ledger, { create: true });
    contexts.push(rootCtx, ordersCtx, ledgerCtx);
    const publisher = channelGraph(['orders.js'], 'PUBLISHES');
    const consumers = channelGraph(['ledger.js', 'invoices.js'], 'CONSUMES');
    const { graph, analysis } = buildWorkspaceGraph(new Map([['orders', publisher], ['ledger', consumers]]));
    const doc = graphToDocument(graph, analysis, []);
    rootCtx.store.meta(WORKSPACE_GRAPH_META, casPut(rootCtx, JSON.stringify(doc)));
    ordersCtx.store.meta(MEMBER_META, JSON.stringify({ root, repository: 'orders' }));
    ledgerCtx.store.meta(MEMBER_META, JSON.stringify({ root, repository: 'ledger' }));
    const links = workspaceLinks(ordersCtx);
    assert.equal(links.links.length, 2);
    assert.ok(links.links.every((l) => l.kind === 'messaging'));
    const evidence = contractEvidence(publisher, ['module:orders.js'], links);
    assert.equal(evidence.routes[0].consumers, 2);
    assert.deepEqual(evidence.routes[0].client_repositories, ['ledger']);
    const consumerEvidence = contractEvidence(consumers, ['module:ledger.js'], workspaceLinks(ledgerCtx));
    assert.deepEqual(consumerEvidence.routes[0].served_by, ['orders']);
  } finally {
    for (const ctx of contexts) ctx.store.close();
    if (previousHome === undefined) delete process.env.UNKNOT_HOME;
    else process.env.UNKNOT_HOME = previousHome;
    rmSync(temp, { recursive: true, force: true });
  }
});
