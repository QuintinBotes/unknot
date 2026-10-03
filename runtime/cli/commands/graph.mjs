import { stronglyConnected } from '../../graph/algorithms.mjs';
import { Graph } from '../../graph/graph.mjs';
import { output, table } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ positional, flags }) {
  const [sub = 'stats', arg] = positional;
  const { ctx } = open(flags);
  const limit = Number(flags.limit ?? 50);
  if (sub === 'stats') {
    const nodes = ctx.store.all('SELECT type, COUNT(*) AS n FROM nodes GROUP BY type ORDER BY n DESC');
    const edges = ctx.store.all('SELECT type, COUNT(*) AS n FROM edges GROUP BY type ORDER BY n DESC');
    return output({ generation: ctx.store.meta('generation'), mapped_commit: ctx.store.meta('mapped_commit'), mapped_at: ctx.store.meta('mapped_at'), nodes, edges }, { json: true });
  }
  if (sub === 'nodes') {
    const rows = ctx.store.all(`SELECT id, type, label, path FROM nodes ${arg ? 'WHERE type = ?' : ''} ORDER BY id LIMIT ?`, ...(arg ? [arg, limit] : [limit]));
    return output(flags.json ? rows : table(rows, ['id', 'type', 'label']), { json: flags.json });
  }
  if (sub === 'node') {
    const n = ctx.store.get('SELECT * FROM nodes WHERE id = ?', arg);
    if (!n) return output(`no node ${arg}`);
    const out = ctx.store.all('SELECT type, dst, label FROM edges WHERE src = ? LIMIT ?', arg, limit);
    const inn = ctx.store.all('SELECT type, src, label FROM edges WHERE dst = ? LIMIT ?', arg, limit);
    const facts = ctx.store.all(`SELECT source_type, source_ref, extractor, confidence FROM facts WHERE id IN (SELECT value FROM json_each(?))`, n.fact_ids);
    return output({ ...n, attrs: JSON.parse(n.attrs), out, in: inn, provenance: facts }, { json: true });
  }
  if (sub === 'edges') {
    const rows = ctx.store.all(`SELECT type, src, dst, label FROM edges ${arg ? 'WHERE type = ?' : ''} LIMIT ?`, ...(arg ? [arg, limit] : [limit]));
    return output(flags.json ? rows : table(rows, ['type', 'src', 'dst', 'label']), { json: flags.json });
  }
  if (sub === 'cycles') {
    const g = Graph.fromStore(ctx.store);
    const comps = stronglyConnected(g, { edgeTypes: [arg ?? 'IMPORTS'] });
    return output(flags.json ? comps : comps.length ? comps.map((c, i) => `cycle ${i + 1} (${c.length}): ${c.slice(0, 8).join(' → ')}${c.length > 8 ? ' …' : ''}`).join('\n') : 'no cycles', { json: flags.json });
  }
  output('usage: unknot graph stats|nodes [type]|node <id>|edges [type]|cycles [EDGE_TYPE]');
  return 2;
}
