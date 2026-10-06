// `unknot search <text> [--regex] [--limit N] [scope...]` — where a string occurs in the files
// the map covers: definitions (a constant or config key holding it) apart from uses, the uses
// of a constant that holds it, and each hit's module, kind and owners. For checking the
// strings runbooks and alerts are made of (metric names, setting keys, roles, flags).

import { UnknotError } from '../../core/errors.mjs';
import { Graph } from '../../graph/graph.mjs';
import { searchText } from '../../graph/search.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

const line = (h) => `  ${h.path}:${h.line}${h.kind !== 'source' ? ` [${h.kind}]` : ''}${h.owners ? ` (${h.owners.join(', ')})` : ''}\n      ${h.text}`;

export async function run({ positional, flags }) {
  const [text, ...scope] = positional;
  if (!text) throw new UnknotError('UK_CONFIG_INVALID', 'usage: unknot search <text> [--regex] [--scan] [--limit N] [scope...]');
  const { ctx, config } = open(flags);
  const graph = ctx.store.meta('generation') ? Graph.fromStore(ctx.store) : null;
  const limit = Math.min(Number(flags.limit ?? 100) || 100, 1000);
  const r = searchText(ctx.root, { config, text, regex: Boolean(flags.regex), scan: Boolean(flags.scan), scope, graph, store: ctx.store, limit });
  if (flags.json) return output(r, { json: true });
  const c = r.counts;
  const out = [r.answered_by === 'graph'
    ? `"${text}": ${c.hits} site(s) of ${r.constants_matched} constant(s) from the graph index`
    : `"${text}": ${c.hits} occurrence(s) in ${r.files_searched} files searched (${Object.entries(c.by_kind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})${graph ? '' : '; map first for modules and owners'}`,
  `Answered by: ${r.answered_by} (${r.answered_by_note})`];
  for (const k of r.constants ?? []) out.push(`  constant ${k.value}: ${k.subkind} (inferred: ${k.subkind_evidence}); ${k.definitions} definition(s), ${k.uses} use(s)`);
  if (r.definitions.length) out.push('', 'Defined (a constant or key holding it):', ...r.definitions.map((h) => `${line(h)}\n      -> ${h.definition.kind === 'constant' ? `constant ${h.definition.name}` : 'key'}`));
  if (r.uses.length) out.push('', 'Used:', ...r.uses.map(line));
  if (r.via_constants.length) out.push('', 'Used through its constant:', ...r.via_constants.map((h) => `${line(h)}\n      -> via ${h.constant}`));
  if (!c.hits) out.push('', 'Not found in the files the map covers (generated and vendored files and credential files are excluded).');
  if (r.constants_left_out) out.push('', `${r.constants_left_out} more constant(s) start with this text and are not shown (the first ${r.constants.length} are); use a longer text or a scope to see them.`);
  if (r.truncated) out.push('', `(cut at ${limit} per section; raise --limit or narrow with a scope)`);
  output(out.join('\n'));
}
