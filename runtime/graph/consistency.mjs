// Cross-command consistency (roadmap item 6): run the commands that read the shared derived
// facts over one mapped repository and report every place they disagree. Used by the
// consistency suite and by `scripts/consistency.mjs` on any repository.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decompose } from '../decompose/index.mjs';
import { diagnose } from '../diagnose/engine.mjs';
import { TOOLS } from '../mcp/tools.mjs';
import { loadConfig } from '../policy/config.mjs';
import { CHECKS } from '../verify/checks.mjs';
import { readDerived } from './derived.mjs';
import { Graph } from './graph.mjs';

const BIN = fileURLToPath(new URL('../../bin/unknot', import.meta.url));
const pathOf = (id) => id.replace(/^module:/, '');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * @returns {{disagreements: {check: string, detail: string}[], counts: object}} nothing in
 *   `disagreements` means every command agreed. `counts` says how much each check looked at.
 */
export async function checkConsistency(ctx, { config = loadConfig(ctx).config } = {}) {
  const out = [];
  const bad = (check, detail) => out.push({ check, detail });
  const graph = Graph.fromStore(ctx.store);
  const scc = readDerived(ctx, 'scc', { graph }).map((r) => r.body);
  const declared = readDerived(ctx, 'declared_only', { graph }).map((r) => r.body);
  const tests = new Set(readDerived(ctx, 'test_code', { graph }).map((r) => r.key));
  const counts = { components: scc.length, declared_only: declared.length, test_modules: tests.size };

  // The three surfaces that print cycles: the CLI, the MCP tool and the derived store itself.
  const limit = String(Math.max(200, scc.length));
  const cli = JSON.parse(execFileSync(process.execPath, [BIN, 'graph', 'cycles', '--json', '--limit', limit], { cwd: ctx.root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const mcp = TOOLS.graph_query.run(ctx, { derived: 'scc', limit: 200 }).facts ?? [];
  const keyOf = (members) => members.join('|');
  const stored = scc.map((c) => keyOf(c.members));
  const cliKeys = cli.map((c) => keyOf(c.members));
  if (!same(cliKeys, stored)) bad('cycles', `graph cycles lists ${cli.length} components, the derived store ${scc.length}`);
  if (mcp.length !== Math.min(200, scc.length) || mcp.some((c, i) => keyOf(c.members) !== stored[i])) bad('cycles', 'the MCP graph_query derived scc differs from the derived store');

  // Every component has a cycle finding, or the store records why diagnose does not report it.
  const diag = await diagnose(ctx, { config });
  const cycleFindings = diag.findings.filter((f) => f.kind === 'module.dependency-cycle');
  for (const c of scc) {
    const paths = new Set(c.members.map(pathOf));
    const hit = cycleFindings.some((f) => f.scope.filter((p) => paths.has(p)).length >= Math.min(2, c.members.length));
    if (c.finding && !hit) bad('cycle-finding', `component of ${c.size} starting at ${pathOf(c.members[0])} has no cycle finding`);
    if (!c.finding && !c.reason) bad('cycle-finding', `component starting at ${pathOf(c.members[0])} has no finding and no recorded reason`);
    if (!c.finding && hit) bad('cycle-finding', `component starting at ${pathOf(c.members[0])} is recorded as unreported (${c.reason}) but a finding covers it`);
  }

  // Every declared-only edge between non-test modules has an unused-injected-member finding.
  const unusedFindings = new Map(diag.findings.filter((f) => f.kind === 'code.unused-injected-member').map((f) => [f.key, f]));
  const needing = declared.filter((r) => r.modules && !r.test);
  counts.unused_member_edges = needing.length;
  for (const r of needing) {
    if (!unusedFindings.has(`unused-member:${r.from}>${r.to}`)) bad('unused-member-finding', `${pathOf(r.from)} -> ${pathOf(r.to)} (member ${r.member ?? '?'}) has no unused-injected-member finding`);
  }

  // Removing that member passes the API check: the graph without the member and its edge.
  let publicEdges = 0;
  for (const r of declared.filter((x) => x.visibility === 'public')) {
    publicEdges++;
    const names = String(r.member ?? '').split(', ').filter(Boolean);
    const verdict = CHECKS.api({ pair: { before: graph, after: withoutMember(graph, r, names) }, changes: [{ path: pathOf(r.from), status: 'M' }] });
    if (verdict.verdict !== 'pass') bad('api-check', `removing ${names.join(', ')} from ${pathOf(r.from)} fails the API check: ${verdict.detail}`);
  }
  counts.public_declared_only = publicEdges;

  // Test code is excluded from decomposition candidates and from module-size findings.
  const dec = await decompose(ctx, { config, dryRun: true });
  const inCandidates = new Set(dec.details.flatMap((d) => d.candidate.modules));
  for (const id of tests) if (inCandidates.has(id)) bad('test-code', `${pathOf(id)} is test code but sits in a decomposition candidate`);
  const sized = diag.findings.filter((f) => f.kind === 'code.large-module');
  counts.module_size_findings = sized.length;
  for (const f of sized) for (const p of f.scope) if (tests.has(`module:${p}`)) bad('test-code', `${p} is test code but has a module-size finding`);

  // Decomposition's cycle detail names members `graph cycles` also lists.
  for (const d of dec.details) {
    const cd = d.candidate.cycle_detail;
    if (!cd) continue;
    counts.decomposition_cycles = (counts.decomposition_cycles ?? 0) + 1;
    if (!cliKeys.includes(keyOf(cd.members))) bad('decomposition-cycle', `${d.id} lists a cycle of ${cd.members.length} modules that graph cycles does not`);
  }
  return { disagreements: out, counts };
}

/** A copy of the graph as it is once the member and the IMPORTS edge `r` describes are gone. */
function withoutMember(g, r, names) {
  const out = new Graph();
  for (const n of g.nodes()) {
    const node = n.id === r.from ? { ...n, attrs: { ...n.attrs, public_members: (n.attrs.public_members ?? []).filter((m) => !names.includes(m)) } } : n;
    out.nodeMap.set(n.id, node);
    out.index(out.typeIdx, n.type, n.id);
  }
  for (const e of g.edges()) {
    if (e.type === 'IMPORTS' && e.from === r.from && e.to === r.to) continue;
    out.edgeMap.set(e.id, e);
    out.index(out.outIdx, e.from, e);
    out.index(out.inIdx, e.to, e);
  }
  return out;
}
