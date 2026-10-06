import { UnknotError } from '../../core/errors.mjs';
import { matchAny } from '../../core/glob.mjs';
import { emptyScopeWarning, scopePredicate } from '../../core/scope.mjs';
import { cycleBreakdown, neighbourhood, rankHubs, resolveRef, stronglyConnected } from '../../graph/algorithms.mjs';
import { MAX_CYCLES, readDerived } from '../../graph/derived.mjs';
import { EDGE_TYPES } from '../../graph/facts.mjs';
import { Graph } from '../../graph/graph.mjs';
import { output, table } from '../util.mjs';
import { open } from './_shared.mjs';

const usage = (message) => new UnknotError('UK_SCHEMA_INVALID', message);

/** A whole-number flag; a flag given without a value is an error, never NaN. */
function intFlag(flags, name, fallback, max = Infinity) {
  const v = flags[name];
  if (v === undefined) return fallback;
  if (v === true || !/^\d+$/.test(String(v)) || Number(v) < 1) throw usage(`--${name} needs a whole number of at least 1`);
  return Math.min(max, Number(v));
}

function listFlag(flags, name) {
  const v = flags[name];
  if (v === undefined) return [];
  if (v === true || !String(v).trim()) throw usage(`--${name} needs a value`);
  return String(v).split(',').map((t) => t.trim()).filter(Boolean);
}

/** Edge types from an optional positional and --type, checked against the vocabulary. */
function edgeTypesOf(arg, flags) {
  const types = [...(arg ? [arg] : []), ...listFlag(flags, 'type')];
  const bad = types.filter((t) => !EDGE_TYPES.has(t));
  if (bad.length) throw usage(`unknown edge type ${bad.join(', ')} (known: ${[...EDGE_TYPES].join(', ')})`);
  return [...new Set(types)];
}

/** Ids a reference names (an id, a module path or a declared type); an error when none. */
function refIds(g, flag, ref) {
  if (ref === true || !ref) throw usage(`--${flag} needs a node id or path`);
  const ids = resolveRef(g, ref);
  if (!ids.length) throw usage(`--${flag} ${ref}: no node, module path or type by that name`);
  return ids;
}

/** `--within` may swallow the next scope entry as its value; give it back. */
function scopeOf(rest, flags) {
  return typeof flags.within === 'string' ? [flags.within, ...rest] : rest;
}

/** Words joined to lines of at most 100 columns, each after the first indented. */
function wrap(text, first, indent) {
  const out = [];
  let line = first;
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > 100 && line.trim() && line !== first && line !== indent) { out.push(line.trimEnd()); line = indent; }
    line += `${word} `;
  }
  out.push(line.trimEnd());
  return out;
}

export async function run({ positional, flags }) {
  const [sub = 'stats', arg] = positional;
  const { ctx } = open(flags);
  const limit = intFlag(flags, 'limit', 50);
  if (sub === 'stats') {
    const nodes = ctx.store.all('SELECT type, COUNT(*) AS n FROM nodes GROUP BY type ORDER BY n DESC');
    const edges = ctx.store.all('SELECT type, COUNT(*) AS n FROM edges GROUP BY type ORDER BY n DESC');
    return output({ generation: ctx.store.meta('generation'), mapped_commit: ctx.store.meta('mapped_commit'), mapped_at: ctx.store.meta('mapped_at'), nodes, edges }, { json: true });
  }
  if (sub === 'nodes') {
    const where = [];
    const params = [];
    if (arg) {
      where.push('type = ?');
      params.push(arg);
    }
    if (flags.name !== undefined) {
      if (flags.name === true) throw usage('--name needs text to look for');
      where.push("(lower(id) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')");
      const like = `%${String(flags.name).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let rows = ctx.store.all(`SELECT id, type, label, path FROM nodes ${clause} ORDER BY id`, ...params);
    if (flags.path !== undefined) rows = rows.filter((r) => r.path && matchAny(r.path, [String(flags.path)]));
    const total = rows.length;
    rows = rows.slice(0, limit);
    if (flags.json) return output({ total, nodes: rows }, { json: true });
    return output(`${table(rows, ['id', 'type', 'label'])}${total > rows.length ? `\n(${rows.length} of ${total} nodes; raise --limit or narrow with a type, --name or --path)` : ''}`);
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
    // A first argument that is not an edge type names a node: its edges in both directions.
    const nodeArg = arg && !EDGE_TYPES.has(arg) ? arg : null;
    const types = edgeTypesOf(nodeArg ? null : arg, flags);
    const where = [];
    const params = [];
    const addIn = (col, values) => {
      where.push(`${col} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    };
    if (types.length) addIn('type', types);
    if (flags.from !== undefined || flags.to !== undefined || nodeArg) {
      const g = Graph.fromStore(ctx.store);
      if (flags.from !== undefined) addIn('src', refIds(g, 'from', flags.from));
      if (flags.to !== undefined) addIn('dst', refIds(g, 'to', flags.to));
      if (nodeArg) {
        const ids = refIds(g, 'node', nodeArg);
        const dir = flags.direction ?? 'both';
        if (!['in', 'out', 'both'].includes(dir)) throw usage('--direction is in, out or both');
        const list = ids.map(() => '?').join(',');
        where.push(dir === 'out' ? `src IN (${list})` : dir === 'in' ? `dst IN (${list})` : `(src IN (${list}) OR dst IN (${list}))`);
        params.push(...ids, ...(dir === 'both' ? ids : []));
      }
    }
    const rows = ctx.store.all(`SELECT type, src, dst, label FROM edges ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY src, dst, type LIMIT ?`, ...params, limit);
    return output(flags.json ? rows : table(rows, ['type', 'src', 'dst', 'label']), { json: flags.json });
  }
  if (sub === 'cycles') {
    const g = Graph.fromStore(ctx.store);
    const edgeArg = positional[1] && EDGE_TYPES.has(positional[1]) ? positional[1] : null;
    const types = edgeTypesOf(edgeArg, flags);
    const edgeTypes = types.length ? types : ['IMPORTS'];
    const pred = scopePredicate(g, positional.slice(edgeArg ? 2 : 1), { edgeTypes });
    const warn = emptyScopeWarning(pred.scope);
    if (warn) process.stderr.write(`unknot: ${warn}\n`);
    // The default view (module imports, whole repository) is the stored derived fact every command
    // reads; another edge type or a scope is an ad-hoc view computed here.
    const stored = edgeTypes.length === 1 && edgeTypes[0] === 'IMPORTS' && pred.scope.all ? readDerived(ctx, 'scc', { graph: g }).map((r) => r.body) : null;
    const all = stored ? stored.map((b) => b.members) : stronglyConnected(g, { edgeTypes, nodeFilter: pred.scope.all ? undefined : pred });
    const comps = all.slice(0, limit).map((c, i) => {
      // More cycles than were stored for a component: list that one deeper.
      const b = stored && (limit <= MAX_CYCLES || !stored[i].truncated) ? { ...stored[i], cycles: stored[i].cycles.slice(0, limit), truncated: stored[i].truncated || stored[i].cycles.length > limit } : cycleBreakdown(g, c, { edgeTypes, maxCycles: limit });
      return { size: c.length, members: c, cycles: b.cycles, cycles_truncated: b.truncated, cut: b.cut };
    });
    if (flags.json) return output(comps, { json: true });
    if (!comps.length) return output('no cycles');
    const nameOf = (id) => g.node(id)?.path ?? id;
    const edgeText = (e) => `${nameOf(e.from)} → ${nameOf(e.to)}${e.declared_only ? ` (declared only: ${nameOf(e.to)} member ${e.unused_member ?? '(unnamed)'} is never used)` : ''}`;
    const lines = comps.flatMap((c, i) => [
      ...(i ? [''] : []),
      `cycle ${i + 1}: ${c.size} ${c.size === 1 ? 'module' : 'modules'}`,
      ...wrap(c.members.map(nameOf).join(', '), '  members: ', '    '),
      `  ${c.cycles.length}${c.cycles_truncated ? '+' : ''} elementary ${c.cycles.length === 1 ? 'cycle' : 'cycles'}, shortest first${c.cycles_truncated ? ` (stopped at ${c.cycles.length}; raise --limit)` : ''}:`,
      ...c.cycles.map((y) => `    ${[...y.nodes, y.nodes[0]].map(nameOf).join(' → ')}${y.edges.some((e) => e.declared_only) ? ' (has declared-only edges)' : ''}`),
      `  edges to cut (${c.cut.length}; removing them leaves no cycle):`,
      ...c.cut.map((e) => `    ${edgeText(e)}${e.closes ? ` [closes ${e.closes}]` : ''}`),
    ]);
    const note = all.length > comps.length ? `\n(${comps.length} of ${all.length} cycles; raise --limit)` : '';
    return output(lines.join('\n') + note);
  }
  if (sub === 'hubs') {
    const g = Graph.fromStore(ctx.store);
    const edgeArg = positional[1] && EDGE_TYPES.has(positional[1]) ? positional[1] : null;
    const types = edgeTypesOf(edgeArg, flags);
    const scope = scopeOf(positional.slice(edgeArg ? 2 : 1), flags);
    const within = flags.within !== undefined;
    const pred = scopePredicate(g, scope, { edgeTypes: types.length ? types : ['IMPORTS'] });
    const warn = emptyScopeWarning(pred.scope);
    if (warn) process.stderr.write(`unknot: ${warn}\n`);
    const h = rankHubs(g, { edgeTypes: types.length ? types : ['IMPORTS'], limit: Math.min(limit, 200), nodeFilter: pred.scope.all ? undefined : pred, within });
    if (flags.json) return output(h, { json: true });
    // Full ids: the tail of a path is what tells two modules apart.
    const lines = (list) => (list.length ? list.map((x) => `${String(x.n).padStart(6)}  ${x.id}`) : ['     (none)']);
    return output([`fan-in (${h.edge_type}, distinct sources${within ? ', in scope' : ''}):`, ...lines(h.fan_in), '', `fan-out (${h.edge_type}, distinct targets${within ? ', in scope' : ''}):`, ...lines(h.fan_out)].join('\n'));
  }
  if (sub === 'neighbourhood') {
    if (!arg) throw usage('graph neighbourhood needs a node id, module path or type name');
    const g = Graph.fromStore(ctx.store);
    const roots = resolveRef(g, arg);
    if (!roots.length) throw usage(`no node, module path or type named ${arg}`);
    const depth = intFlag(flags, 'depth', 1);
    if (depth > 3) throw usage('--depth is at most 3');
    const types = edgeTypesOf(null, flags);
    const hood = neighbourhood(g, roots, { depth, edgeTypes: types.length ? types : undefined });
    const rows = hood.edges.map((e) => ({ type: e.type, from: e.from, to: e.to }));
    if (flags.json) return output({ roots, depth, nodes: hood.nodes.map((n) => ({ id: n.id, type: n.type })), edges: rows.slice(0, limit), edge_count: rows.length, capped: hood.capped }, { json: true });
    const head = `${roots.join(', ')}: ${hood.nodes.length} nodes, ${rows.length} edges within ${depth} hop${depth > 1 ? 's' : ''}${hood.capped ? ' (node cap reached)' : ''}`;
    const counts = Object.entries(rows.reduce((m, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {})).map(([t, n]) => `${t} ${n}`).join(', ');
    // Say what the graph cannot show here, rather than letting an absence read as "none".
    const lexical = [...new Set(roots.map((id) => g.node(id)).filter((n) => n?.attrs?.parse_quality === 'lexical').map((n) => n.attrs.language))];
    const gap = !types.length && lexical.length && !rows.some((r) => r.type === 'CALLS') ? `\nNo CALLS edges: ${lexical.join(', ')} is read lexically here, so calls between files are not extracted (only imports and type references). The semantic tier adds them (docs/roadmap.md, item 1).` : '';
    return output(`${head}${counts ? ` (${counts})` : ''}${gap}\n${table(rows.slice(0, limit), ['type', 'from', 'to'])}${rows.length > limit ? `\n(${limit} of ${rows.length} edges; raise --limit or narrow with --type)` : ''}`);
  }
  output('usage: unknot graph stats|nodes [type] [--name text] [--path glob]|node <id>|edges [TYPE|node [--direction in|out|both]] [--type T,..] [--from X] [--to X]|cycles [EDGE] [scope...]|hubs [EDGE] [--type T,..] [--within] [scope...]|neighbourhood <id|path|Type> [--depth N] [--type T,..]  (--limit N)');
  return 2;
}
