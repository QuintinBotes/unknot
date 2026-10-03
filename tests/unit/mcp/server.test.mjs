// The MCP server is exercised the way Claude Code does it: a child process speaking
// newline-delimited JSON-RPC over stdio, against a real temporary project.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/unknot-mcp', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'uk-mcp-home-'));
const proj = mkdtempSync(join(tmpdir(), 'uk-mcp-proj-'));
process.env.UNKNOT_HOME = home;

const { openProject } = await import('../../../runtime/context.mjs');
const { project } = await import('../../../runtime/graph/builder.mjs');
const { nodeFact, edgeFact, prov } = await import('../../../runtime/graph/facts.mjs');
const { index } = await import('../../../runtime/patterns/engine.mjs');

const p = prov({ source_type: 'ast', source_ref: 'src/a.ts:1', extractor: 'test' });
const SECRET = 'AKIAIOSFODNN7EXAMPLE';

/** A line-oriented JSON-RPC client over a child process. */
function client(projectDir) {
  const child = spawn(process.execPath, [BIN], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, UNKNOT_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = [];
  const queue = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.shift();
      if (w) w(msg);
      else queue.push(msg);
    }
  });
  const next = () => new Promise((res) => (queue.length ? res(queue.shift()) : waiting.push(res)));
  let id = 0;
  return {
    child,
    raw: (line) => child.stdin.write(`${line}\n`),
    next,
    async request(method, params) {
      const rid = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
      const msg = await next();
      assert.equal(msg.id, rid);
      return msg;
    },
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    async call(name, args = {}) {
      const msg = await this.request('tools/call', { name, arguments: args });
      return msg.result ?? msg;
    },
    close() {
      child.stdin.end();
      return new Promise((res) => child.on('close', res));
    },
  };
}

let c;
let patternId;
before(() => {
  const ctx = openProject(proj, { create: true });
  project(
    ctx,
    [
      nodeFact('module', 'src/a.ts', { name: 'a', path: 'src/a.ts' }, p),
      nodeFact('module', 'src/b.ts', { name: 'b', path: 'src/b.ts' }, p),
      nodeFact('module', 'src/c.ts', { name: 'c', path: 'src/c.ts' }, p),
      nodeFact('service', 'leaky', { name: `svc ${SECRET}` }, p),
      edgeFact('IMPORTS', 'module:src/a.ts', 'module:src/b.ts', {}, p),
      edgeFact('IMPORTS', 'module:src/b.ts', 'module:src/c.ts', {}, p),
    ],
    { commit: 'abc123', observedAt: '2026-01-01T00:00:00Z' },
  );
  const now = '2026-01-01T00:00:00Z';
  ctx.store.insert('findings', {
    id: 'F-0001', fingerprint: 'fp-1', schema_version: '1.0', kind: 'cycle', category: 'architecture', status: 'open', priority: 0.8,
    body: { id: 'F-0001', title: 'a imports b imports c' }, created_at: now, updated_at: now,
  });
  const body = { id: 'UK-0001', objective: 'Split module a', preconditions: [], blast_radius: 'local', recovery: { type: 'revert' }, owners: [], changes: [], scope: { include: ['src/a.ts'] }, sources: ['F-0001'] };
  ctx.store.insert('slices', {
    id: 'UK-0001', campaign_id: null, schema_version: '1.0', state: 'PLANNED', risk: 'low', body, slice_digest: 'sha256:x', created_at: now, updated_at: now,
  });
  ctx.store.insert('proof_obligations', { id: 'PO-1', slice_id: 'UK-0001', kind: 'tests', body: { description: 'tests pass' }, requires_human: 0, status: 'pending' });
  ctx.store.insert('approvals', {
    id: 'AP-1', slice_id: 'UK-0001', stage: 'apply', role: 'owner', approver: 'dana', key_fingerprint: 'fp', binding: { a: 1 },
    binding_hash: 'sha256:b', signature: 'SECRET-SIGNATURE-BYTES', expires_at: '2099-01-01T00:00:00Z', created_at: now,
  });
  mkdirSync(join(ctx.paths.base, 'decompositions'), { recursive: true });
  writeFileSync(join(ctx.paths.base, 'decompositions', 'DEC-0001.json'), JSON.stringify({ id: 'DEC-0001', recommendation: 'keep the monolith' }));
  ctx.store.close();
  patternId = index()[0].id;
  c = client(proj);
});

after(async () => {
  await c.close();
});

test('initialize negotiates the protocol version and describes the server', async () => {
  const r = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.serverInfo.name, 'unknot');
  assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.match(r.result.instructions, /human terminal/);
  c.notify('notifications/initialized');
  const ping = await c.request('ping');
  assert.deepEqual(ping.result, {});
  const unknown = await c.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
});

test('tools/list exposes every tool, objects only, none that suggests mutation', async () => {
  const { result } = await c.request('tools/list');
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'decomposition_get', 'finding_get', 'findings_list', 'graph_neighbourhood', 'graph_query', 'next_slice',
    'pattern_fit', 'pattern_get', 'pattern_index', 'slice_get', 'status', 'submit_handoff',
  ]);
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.description.length > 10);
    assert.doesNotMatch(t.name, /approve|apply|exec|write|delete|run_|rollback/);
  }
});

test('read-only tools answer valid calls', async () => {
  const st = await c.call('status');
  assert.equal(st.isError, undefined);
  assert.equal(st.structuredContent.mode, 'plan');
  assert.equal(st.structuredContent.graph.generation, 1);
  assert.equal(st.structuredContent.graph.mapped_commit, 'abc123');
  assert.equal(st.structuredContent.findings_by_status.open, 1);
  assert.equal(st.structuredContent.slices_by_state.PLANNED, 1);
  assert.deepEqual(JSON.parse(st.content[0].text), st.structuredContent);

  const byType = await c.call('graph_query', { type: 'module' });
  assert.equal(byType.structuredContent.total, 3);
  const one = await c.call('graph_query', { id: 'module:src/b.ts' });
  assert.equal(one.structuredContent.edge_count, 2);
  const outOnly = await c.call('graph_query', { id: 'module:src/b.ts', direction: 'out', edge_type: 'IMPORTS' });
  assert.equal(outOnly.structuredContent.edge_count, 1);
  const missing = await c.call('graph_query', { id: 'module:nope' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.code, 'UK_NOT_FOUND');

  const hood1 = await c.call('graph_neighbourhood', { id: 'module:src/a.ts' });
  assert.equal(hood1.structuredContent.nodes.length, 2);
  const hood2 = await c.call('graph_neighbourhood', { id: 'module:src/a.ts', depth: 2, edge_types: ['IMPORTS'] });
  assert.equal(hood2.structuredContent.nodes.length, 3);
  assert.equal(hood2.structuredContent.edges.length, 2);

  const f = await c.call('finding_get', { id: 'F-0001' });
  assert.equal(f.structuredContent.title, 'a imports b imports c');
  const fl = await c.call('findings_list', { status: 'open', category: 'architecture', limit: 5 });
  assert.equal(fl.structuredContent.findings[0].id, 'F-0001');

  const pi = await c.call('pattern_index');
  assert.ok(pi.structuredContent.patterns.length > 0);
  const pg = await c.call('pattern_get', { id: patternId });
  assert.equal(pg.structuredContent.id, patternId);
  const pf = await c.call('pattern_fit', { id: patternId, signals: {} });
  assert.equal(pf.structuredContent.id, patternId);
  assert.ok(['fits', 'contraindicated', 'insufficient_evidence', 'not_applicable'].includes(pf.structuredContent.fit));

  const sl = await c.call('slice_get', { id: 'UK-0001' });
  assert.equal(sl.structuredContent.slice.objective, 'Split module a');
  assert.equal(sl.structuredContent.obligations.length, 1);
  assert.equal(sl.structuredContent.approvals.length, 1);
  assert.ok(!sl.content[0].text.includes('SECRET-SIGNATURE-BYTES'));
  assert.ok(!('signature' in sl.structuredContent.approvals[0]));

  const nx = await c.call('next_slice');
  assert.equal(nx.structuredContent.next.id, 'UK-0001');

  const d = await c.call('decomposition_get', { id: 'DEC-0001' });
  assert.equal(d.structuredContent.recommendation, 'keep the monolith');
  const dMissing = await c.call('decomposition_get', { id: 'DEC-9999' });
  assert.equal(dMissing.isError, true);
});

test('secrets in graph data are redacted before leaving the server', async () => {
  const r = await c.call('graph_query', { type: 'service' });
  assert.ok(!r.content[0].text.includes(SECRET));
  assert.match(r.structuredContent.nodes[0].name, /REDACTED/);
});

test('bad parameters are rejected with -32602', async () => {
  for (const [name, args] of [
    ['graph_query', { limit: 1000 }],
    ['graph_query', { direction: 'sideways' }],
    ['graph_query', { bogus: 1 }],
    ['graph_neighbourhood', { id: 'x', depth: 9 }],
    ['finding_get', {}],
    ['pattern_fit', { id: 'x' }],
    ['status', { extra: true }],
  ]) {
    const r = await c.request('tools/call', { name, arguments: args });
    assert.equal(r.error?.code, -32602, `${name} ${JSON.stringify(args)}`);
  }
  const unknownTool = await c.request('tools/call', { name: 'approve_slice', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const noName = await c.request('tools/call', {});
  assert.equal(noName.error.code, -32602);
});

test('decomposition_get refuses path traversal', async () => {
  for (const id of ['../../etc/passwd', 'DEC-0001/../../x', 'DEC-1', '..\\..\\x']) {
    const r = await c.request('tools/call', { name: 'decomposition_get', arguments: { id } });
    assert.equal(r.error?.code, -32602, id);
  }
});

test('protocol errors: unknown method, invalid request, batch, malformed, oversized', async () => {
  const unknown = await c.request('nope/nothing');
  assert.equal(unknown.error.code, -32601);

  c.raw(JSON.stringify({ jsonrpc: '1.0', id: 99, method: 'ping' }));
  assert.equal((await c.next()).error.code, -32600);
  c.raw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
  assert.equal((await c.next()).error.code, -32600);
  c.raw('{this is not json');
  assert.equal((await c.next()).error.code, -32700);

  // A notification with an unknown method gets no reply; the next answer must be the ping's.
  c.notify('nope/notification');
  assert.deepEqual((await c.request('ping')).result, {});

  const big = `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${'x'.repeat(4 * 1024 * 1024 + 10)}"}}`;
  c.raw(big);
  assert.equal((await c.next()).error.code, -32600);
  assert.deepEqual((await c.request('ping')).result, {});
});

test('submit_handoff records a valid handoff and reports invalid ones', async () => {
  const good = {
    schema_version: '1.0', run_id: 'run-abc', slice_id: null, agent: 'cartographer', status: 'complete',
    facts: [], proposals: [], uncertainties: [], conflicts: [], artifacts: [], recommended_next_state: 'MAPPED',
  };
  const ok = await c.call('submit_handoff', { handoff: good });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.structuredContent.ok, true);
  const bad = await c.call('submit_handoff', { handoff: { ...good, agent: 'wizard' } });
  assert.equal(bad.structuredContent.ok, false);
  assert.ok(bad.structuredContent.errors.length > 0);
  const notObj = await c.request('tools/call', { name: 'submit_handoff', arguments: { handoff: 'x' } });
  assert.equal(notObj.error.code, -32602);
});

test('an uninitialised project yields an isError result pointing at /unknot:init', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'uk-mcp-empty-'));
  const c2 = client(empty);
  const r = await c2.call('status');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknot:init/);
  await c2.close();
});

test('oversized results are truncated and say so', async () => {
  const { toolResult, MAX_RESULT_TEXT } = await import('../../../runtime/mcp/server.mjs');
  const r = toolResult({ items: Array.from({ length: 20000 }, (_, i) => ({ i, pad: 'y'.repeat(50) })) });
  assert.ok(r.content[0].text.length <= MAX_RESULT_TEXT);
  assert.match(r.structuredContent._truncated, /200 KB/);
  assert.ok(r.structuredContent.items.length < 20000);
});
