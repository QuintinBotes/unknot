// Semantic facts imported from a SCIP index (https://github.com/sourcegraph/scip) that a person
// produced with an indexer: scip-dotnet (Roslyn) for C#, scip-typescript, scip-java, scip-python.
// Unknot never runs the indexer, builds or restores packages (network: false); it reads the file.
// The index is the compiler's own resolution, so what it says is `observed` (source_type `lsp`).
//
// Per file in the index (matched to a mapped file):
//   - the module is marked `parse_quality: 'semantic'` and carries a `semantic` summary:
//     definitions, types, member symbols, and the members nothing references outside their own
//     definition (`unreferenced`; a member symbol's reference count is not kept as a node each)
//   - REFERENCES module -> module for resolved references, CALLS where the symbol is a method
//   - EXTENDS / IMPLEMENTS between types from the index's implementation relationships
// For C# the adapter also hands the unused-injected-member decision to the generic adapter
// (`ctx.semantic`): see csharp.mjs. This adapter's link runs before generic's for that reason.

import { UnknotError } from '../../../runtime/core/errors.mjs';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { analyzeIndex } from './analyze.mjs';
import { locateIndexes } from './locate.mjs';

const VERSION = '0.1.0';
const EXTRACTOR = `scip@${VERSION}`;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const MAX_LISTED = 50;

const pv = (path, line) => prov({ source_type: 'lsp', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence: 'high' });

function link(ctx) {
  const options = ctx.options ?? {};
  const found = locateIndexes(ctx.root, options);
  if (found.missing.length) throw new UnknotError('UK_NOT_FOUND', `adapters.scip.index names ${found.missing.join(', ')}, which does not exist; produce it with the indexer (see \`unknot doctor\`) or remove the setting`);
  if (!found.entries.length) return [];
  const limit = Number.isFinite(options.max_index_bytes) ? options.max_index_bytes : DEFAULT_MAX_BYTES;
  for (const e of found.entries) {
    if (e.size > limit) throw new UnknotError('UK_BUDGET_EXCEEDED', `${e.rel} is ${e.size} bytes, over adapters.scip.max_index_bytes (${limit})`);
  }

  const mods = new Map();
  const typeIds = new Map(); // path\0name → id of a type node another adapter already made
  for (const [path, facts] of ctx.factsByFile) {
    for (const f of facts) {
      if (f.kind !== 'node') continue;
      if (f.type === 'module' && !mods.has(path)) mods.set(path, f);
      else if ((f.type === 'class' || f.type === 'interface') && !typeIds.has(`${path}\0${f.name}`)) typeIds.set(`${path}\0${f.name}`, f.id);
    }
  }
  const res = analyzeIndex(found.entries.map((e) => e.abs), { root: ctx.root, hasFile: (p) => mods.has(p) });
  const tool = res.tools.join(', ');
  const out = [];

  for (const [path, info] of [...res.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const mod = mods.get(path);
    mod.attrs.parse_quality = 'semantic'; // the coverage report reads the module fact as extracted
    const unref = info.members.filter((m) => !m.refs).map((m) => `${m.owner ? `${m.owner}.` : ''}${m.name}`).sort();
    out.push(nodeFact('module', path, {
      name: path,
      path,
      attrs: {
        parse_quality: 'semantic',
        semantic: { definitions: info.definitions, types: info.types, members: info.members.length, unreferenced: unref.slice(0, MAX_LISTED), unreferenced_count: unref.length, ...(tool && { indexer: tool }) },
      },
    }, pv(path, 1)));
    // The unused-injected-member decision: a field or property is read when some occurrence outside
    // its definition is not a pure write. Same-named members of types in one file merge (any read counts).
    if (mod.attrs.decl_cands && ctx.semantic) {
      const members = new Map();
      for (const m of info.members) if (m.kind === 'member') members.set(m.name, (members.get(m.name) ?? false) || m.reads > 0);
      ctx.semantic.set(path, { members });
    } else ctx.semantic?.set(path, { members: new Map() });
  }

  // Types: one node per defined type (made here only when no other adapter named it), then inheritance.
  const idOf = new Map();
  const typeNode = (t) => {
    const k = `${t.path}\0${t.name}`;
    if (idOf.has(k)) return idOf.get(k);
    let id = typeIds.get(k);
    if (!id) {
      const type = t.interface ? 'interface' : 'class';
      const key = `${t.path}#${t.name}`;
      id = `${type}:${key}`;
      out.push(nodeFact(type, key, { name: t.name, path: t.path, attrs: { language: res.files.get(t.path)?.language ?? null, start_line: t.line } }, pv(t.path, t.line)));
      out.push(edgeFact('CONTAINS', `module:${t.path}`, id, {}, pv(t.path, t.line)));
    }
    idOf.set(k, id);
    return id;
  };
  for (const t of res.types) typeNode(t);
  for (const r of res.inherits) out.push(edgeFact(r.edge, typeNode(r.from), typeNode(r.to), { via: 'scip' }, pv(r.from.path, r.from.line)));

  for (const l of res.links) {
    if (l.refs) out.push(edgeFact('REFERENCES', `module:${l.from}`, `module:${l.to}`, { via: 'scip', count: l.refs }, pv(l.from, l.line)));
    if (l.calls) out.push(edgeFact('CALLS', `module:${l.from}`, `module:${l.to}`, { via: 'scip', count: l.calls }, pv(l.from, l.callLine)));
  }

  ctx.stats.scip = { indexes: found.entries.map((e) => e.rel), documents: res.stats.documents, covered: res.stats.matched, symbols_defined: res.stats.symbols_defined, ms: res.stats.ms, ...(tool && { indexer: tool }) };
  if (res.stats.unmatched) ctx.notes?.push(`scip: ${res.stats.unmatched} of ${res.stats.documents} index documents matched no mapped file (generated, ignored, outside the scope or the index is for another checkout)`);
  return out;
}

export default {
  id: 'scip',
  version: VERSION,
  kind: 'language',
  capabilities: { files: [], executes: [], network: false },
  link,
};
