// `unknot workspace`: explicitly linked repository sets (spec §2.1).

import { UnknotError } from '../../core/errors.mjs';
import { listWorkspace, loadWorkspaceGraph, mapWorkspace, summarizeWorkspace } from '../../enterprise/workspace.mjs';
import { output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';

const USAGE = 'usage: unknot workspace list | map [--no-history] | graph [--json]';

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'list';
  const { ctx, cfg, config, actor } = open(flags);
  if (sub === 'list') {
    const rows = listWorkspace(ctx, config);
    if (flags.json) return output(rows, { json: true });
    return output(table(rows.map((r) => ({ name: r.name, path: r.path, initialized: r.initialized ? 'yes' : 'no', generation: r.generation ?? '', commit: (r.mapped_commit ?? '').slice(0, 12) })), ['name', 'path', 'initialized', 'generation', 'commit']));
  }
  if (sub === 'map') {
    const r = await withRun(ctx, cfg, 'map', { actor, scope: [] }, () => mapWorkspace(ctx, { config, history: !flags.no_history }));
    if (flags.json) return output({ digest: r.digest, repositories: r.repositories, ...r.analysis }, { json: true });
    const a = r.analysis;
    return output([
      `Mapped ${r.repositories.length} repositories into ${r.nodes} workspace nodes and ${r.edges} edges.`,
      `Cross-repository edges: ${a.cross_repo_edges.total}${a.cross_repo_edges.total ? ` (${Object.entries(a.cross_repo_edges.by_via).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}.`,
      ...(a.client_operations?.total ? [`Client operations: ${a.client_operations.total} (${a.client_operations.linked} linked to an endpoint in another repository, ${a.client_operations.internal} served in their own repository, ${a.client_operations.unmatched.length} unmatched).`, ...a.client_operations.unmatched.map((u) => `  unmatched: ${u.route} in ${u.repo}${u.interfaces.length ? ` (${u.interfaces.join(', ')})` : ''}`)] : []),
      a.shared_database ? `SHARED DATABASE: ${a.shared_tables.map((t) => t.table).join(', ')}` : 'No tables are shared between repositories.',
    ].join('\n'));
  }
  if (sub === 'graph') {
    const doc = loadWorkspaceGraph(ctx);
    if (!doc) throw new UnknotError('UK_NOT_FOUND', 'no workspace graph yet; run unknot workspace map');
    const s = summarizeWorkspace(doc);
    if (flags.json) return output(s, { json: true });
    const lines = [
      `Workspace graph generated ${s.generated_at}`,
      '',
      table(s.repositories, ['name', 'commit', 'generation', 'status', 'nodes', 'edges']),
      '',
      `Cross-repository edges: ${s.cross_repo_edges.total} (${Object.entries(s.cross_repo_edges.by_type).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
      ...s.repo_dependencies.map((d) => `  ${d.from} -> ${d.to} via ${d.via.join(', ')} (${d.edges})`),
      ...(s.client_operations.total ? [`Client operations: ${s.client_operations.total} (${s.client_operations.linked} linked, ${s.client_operations.internal} internal, ${s.client_operations.unmatched.length} unmatched)`, ...s.client_operations.unmatched.map((u) => `  unmatched: ${u.route} in ${u.repo}${u.interfaces.length ? ` (${u.interfaces.join(', ')})` : ''}`)] : []),
      s.shared_database ? `Shared tables: ${s.shared_tables.map((t) => `${t.table} (owner ${t.owner_repo})`).join(', ')}` : 'Shared tables: none',
      ...(s.release_coupling.length ? ['Release coupling:', ...s.release_coupling.map((h) => `  ${h.hint}`)] : []),
      `Catalog: ${s.catalog.services.length} services, ${s.catalog.unmapped_code_roots.length} unmapped code roots, ${s.catalog.services_without_owner.length} without owner, ${s.catalog.owners_without_services.length} owners without services`,
    ];
    return output(lines.join('\n'));
  }
  output(USAGE);
  return 2;
}
