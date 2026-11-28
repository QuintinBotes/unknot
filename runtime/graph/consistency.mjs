// Cross-command consistency (roadmap item 6): run the commands that read the shared derived
// facts over one mapped repository and report every place they disagree. Used by the
// consistency suite and by `scripts/consistency.mjs` on any repository.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyStyles } from '../artifacts/styles.mjs';
import { decompose } from '../decompose/index.mjs';
import { diagnose } from '../diagnose/engine.mjs';
import { TOOLS } from '../mcp/tools.mjs';
import { loadConfig } from '../policy/config.mjs';
import { CHECKS } from '../verify/checks.mjs';
import { computeLayers, configuredLayers, readDerived } from './derived.mjs';
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

  // Layers (#245): the stored rows are what the graph and the configured layers give now, and
  // the MCP tool, layer-bypass findings and the layered style report those rows.
  const layerRows = readDerived(ctx, 'layers', { graph });
  const spec = configuredLayers(config);
  const layerOf = new Map(layerRows.map((r) => [r.key, r.body]));
  const fresh = new Map(computeLayers(graph, spec).map((r) => [r.key, r.body]));
  counts.layer_modules = layerRows.length;
  const show = (b) => (b ? `${b.layer} (${b.source})` : 'no layer');
  for (const id of new Set([...layerOf.keys(), ...fresh.keys()])) {
    if (JSON.stringify(layerOf.get(id)) !== JSON.stringify(fresh.get(id))) bad('layers', `${pathOf(id)} is stored in ${show(layerOf.get(id))}, the graph and config give ${show(fresh.get(id))}`);
  }
  // A result over the MCP byte cap is cut (`truncated`): its total and the rows it kept must still agree.
  const mcpLayerResult = TOOLS.graph_query.run(ctx, { derived: 'layers', limit: 200 });
  const mcpLayers = mcpLayerResult.facts ?? [];
  if (mcpLayerResult.total !== layerRows.length || (!mcpLayerResult.truncated && mcpLayers.length !== Math.min(200, layerRows.length)) || mcpLayers.some(({ key, ...b }, i) => key !== layerRows[i].key || JSON.stringify(b) !== JSON.stringify(layerRows[i].body))) bad('layers', 'the MCP graph_query derived layers differs from the derived store');
  const names = spec.map((l) => l.name);
  for (const f of diag.findings.filter((x) => x.kind === 'module.layer-bypass')) {
    const from = f.key.slice(f.key.indexOf(':') + 1).split('->')[0];
    if (!same(f.thresholds.layers, names)) bad('layers', `${f.key} names layers ${f.thresholds.layers.join(', ')}, the derived store ${names.join(', ')}`);
    for (const p of f.scope) if (layerOf.get(`module:${p}`)?.layer !== from) bad('layers', `${f.key} places ${p} in ${from}, the derived store in ${show(layerOf.get(`module:${p}`))}`);
  }
  const styleOf = (styles) => JSON.stringify(styles.find((x) => x.style === 'layered') ?? null);
  const arch = JSON.parse(execFileSync(process.execPath, [BIN, 'architecture', '--json'], { cwd: ctx.root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  if (styleOf(arch.styles) !== styleOf(classifyStyles(graph, [...fresh].map(([key, body]) => ({ key, body }))))) bad('layers', 'architecture reports a layered style the layers the graph and config give do not');

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
    out.indexEdge(e);
  }
  return out;
}
