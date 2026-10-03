// Before/after architecture delta (spec §10.1, last view): what a change added, removed
// and re-wired, as a markdown page with a Mermaid picture of the changed neighbourhood.
// Pure function of two graphs, so it works for a slice worktree against its baseline.

import { stronglyConnected } from '../graph/algorithms.mjs';
import { mermaidFence, plain } from './mermaid.mjs';
import { appModules } from './model.mjs';

const MAX_EXAMPLES = 8;
const MAX_DIAGRAM_NODES = 40;

const nameOf = (g, id) => g.node(id)?.path ?? g.node(id)?.name ?? id;
const exportNames = (n) => new Set((n.attrs?.exports ?? []).map((e) => (typeof e === 'string' ? e : e.name)).filter(Boolean));
const cycleKey = (c) => c.join('|');

function diffSets(before, after) {
  return { added: [...after].filter((x) => !before.has(x)).sort(), removed: [...before].filter((x) => !after.has(x)).sort() };
}

/**
 * Structured delta; `architectureDelta` renders it.
 * @param {import('../graph/graph.mjs').Graph} before
 * @param {import('../graph/graph.mjs').Graph} after
 */
export function computeDelta(before, after) {
  const bm = new Map(appModules(before).map((m) => [m.id, m]));
  const am = new Map(appModules(after).map((m) => [m.id, m]));
  const modules = diffSets(new Set(bm.keys()), new Set(am.keys()));

  const edgesBy = {};
  const bEdges = new Map(before.edges().map((e) => [e.id, e]));
  const aEdges = new Map(after.edges().map((e) => [e.id, e]));
  const changedEdges = [];
  for (const [id, e] of aEdges) if (!bEdges.has(id)) { (edgesBy[e.type] ??= { added: 0, removed: 0 }).added++; changedEdges.push({ e, change: 'added', g: after }); }
  for (const [id, e] of bEdges) if (!aEdges.has(id)) { (edgesBy[e.type] ??= { added: 0, removed: 0 }).removed++; changedEdges.push({ e, change: 'removed', g: before }); }

  const cyc = (g) => new Map(stronglyConnected(g, { nodeTypes: ['module'] }).map((c) => [cycleKey(c), c]));
  const bc = cyc(before);
  const ac = cyc(after);
  const cycles = {
    introduced: [...ac].filter(([k]) => !bc.has(k)).map(([, c]) => c),
    removed: [...bc].filter(([k]) => !ac.has(k)).map(([, c]) => c),
  };

  const api = [];
  for (const [id, m] of am) {
    const prev = bm.get(id);
    if (!prev) continue;
    const d = diffSets(exportNames(prev), exportNames(m));
    if (d.added.length || d.removed.length) api.push({ module: nameOf(after, id), ...d });
  }
  for (const id of modules.added) if (exportNames(am.get(id)).size) api.push({ module: nameOf(after, id), added: [...exportNames(am.get(id))].sort(), removed: [], new_module: true });
  for (const id of modules.removed) if (exportNames(bm.get(id)).size) api.push({ module: nameOf(before, id), added: [], removed: [...exportNames(bm.get(id))].sort(), removed_module: true });

  return { modules, edgesBy, changedEdges, cycles, api, sizes: { before: before.size, after: after.size } };
}

function diagram(before, after, delta) {
  const ids = new Map();
  const n = (id) => { if (!ids.has(id)) ids.set(id, `n${ids.size + 1}`); return ids.get(id); };
  const status = new Map();
  for (const id of delta.modules.added) status.set(id, 'added');
  for (const id of delta.modules.removed) status.set(id, 'removed');
  const edges = [];
  for (const { e, change } of delta.changedEdges) {
    if (!['IMPORTS', 'CALLS', 'DEPENDS_ON', 'RUNTIME_CALLS', 'QUERIES', 'MUTATES', 'PUBLISHES', 'SUBSCRIBES'].includes(e.type)) continue;
    if (ids.size >= MAX_DIAGRAM_NODES && (!ids.has(e.from) || !ids.has(e.to))) continue;
    edges.push({ e, change });
    n(e.from);
    n(e.to);
  }
  if (!edges.length && !status.size) return null;
  for (const id of [...status.keys()].slice(0, MAX_DIAGRAM_NODES)) n(id);
  const lines = ['flowchart LR'];
  for (const [id, nid] of ids) {
    const g = status.get(id) === 'removed' || !after.node(id) ? before : after;
    lines.push(`  ${nid}["${plain(nameOf(g, id), 48)}"]`);
  }
  for (const { e, change } of edges) lines.push(`  ${n(e.from)} ${change === 'added' ? '-->' : '-.->'}|"${change} ${plain(e.type, 20)}"| ${n(e.to)}`);
  for (const [id, s] of status) if (ids.has(id)) lines.push(`  class ${n(id)} ${s}`);
  lines.push('  classDef added fill:#d4edda,stroke:#1e8449', '  classDef removed fill:#fde2e2,stroke:#c0392b,stroke-dasharray:4 3');
  return lines.join('\n');
}

const bullets = (items, fmt, max = MAX_EXAMPLES) => [...items.slice(0, max).map((x) => `- ${fmt(x)}`), ...(items.length > max ? [`- ...and ${items.length - max} more`] : [])];

/**
 * @param {import('../graph/graph.mjs').Graph} beforeGraph
 * @param {import('../graph/graph.mjs').Graph} afterGraph
 * @returns {string} markdown
 */
export function architectureDelta(beforeGraph, afterGraph) {
  const d = computeDelta(beforeGraph, afterGraph);
  const out = ['# Architecture delta', ''];
  const edgeAdded = Object.values(d.edgesBy).reduce((s, x) => s + x.added, 0);
  const edgeRemoved = Object.values(d.edgesBy).reduce((s, x) => s + x.removed, 0);
  out.push(
    `Nodes ${d.sizes.before.nodes} -> ${d.sizes.after.nodes}, edges ${d.sizes.before.edges} -> ${d.sizes.after.edges}. `
    + `${d.modules.added.length} module(s) added, ${d.modules.removed.length} removed; ${edgeAdded} edge(s) added, ${edgeRemoved} removed; `
    + `${d.cycles.introduced.length} cycle(s) introduced, ${d.cycles.removed.length} removed; ${d.api.length} module(s) with exported API changes.`,
    '',
  );
  out.push('## Modules', '');
  if (!d.modules.added.length && !d.modules.removed.length) out.push('No modules were added or removed.');
  else {
    out.push(...bullets(d.modules.added, (id) => `added \`${plain(nameOf(afterGraph, id), 100)}\``));
    out.push(...bullets(d.modules.removed, (id) => `removed \`${plain(nameOf(beforeGraph, id), 100)}\``));
  }
  out.push('', '## Edges by type', '');
  const types = Object.keys(d.edgesBy).sort();
  if (!types.length) out.push('No edges changed.');
  else {
    out.push('| Type | Added | Removed |', '|---|---:|---:|', ...types.map((t) => `| ${plain(t, 30)} | ${d.edgesBy[t].added} | ${d.edgesBy[t].removed} |`));
    const notable = d.changedEdges.filter(({ e }) => !['CONTAINS', 'CO_CHANGES'].includes(e.type));
    if (notable.length) {
      out.push('', 'Examples:', ...bullets(notable, ({ e, change, g }) => `${change} ${plain(e.type, 20)}: \`${plain(nameOf(g, e.from), 80)}\` -> \`${plain(nameOf(g, e.to), 80)}\``));
    }
  }
  out.push('', '## Dependency cycles', '');
  if (!d.cycles.introduced.length && !d.cycles.removed.length) out.push('No module import cycles were introduced or removed.');
  else {
    out.push(...bullets(d.cycles.introduced, (c) => `introduced (${c.length} modules): ${c.slice(0, 5).map((id) => `\`${plain(nameOf(afterGraph, id), 60)}\``).join(', ')}`));
    out.push(...bullets(d.cycles.removed, (c) => `removed (${c.length} modules): ${c.slice(0, 5).map((id) => `\`${plain(nameOf(beforeGraph, id), 60)}\``).join(', ')}`));
  }
  out.push('', '## Exported API changes', '');
  if (!d.api.length) out.push('No exported symbols changed.');
  else {
    out.push(...bullets(d.api, (a) => `\`${plain(a.module, 80)}\`${a.new_module ? ' (new)' : a.removed_module ? ' (removed)' : ''}: ${[a.added.length ? `+${a.added.map((x) => plain(x, 30)).join(', +')}` : '', a.removed.length ? `-${a.removed.map((x) => plain(x, 30)).join(', -')}` : ''].filter(Boolean).join(' ')}`, 20));
  }
  const dg = diagram(beforeGraph, afterGraph, d);
  out.push('', '## Changed neighbourhood', '');
  out.push(dg ? mermaidFence(dg) : 'Nothing to draw: no module or dependency edge changed.');
  return `${out.join('\n')}\n`;
}
