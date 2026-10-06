// `unknot workspace`: explicitly linked repository sets (spec §2.1).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UnknotError } from '../../core/errors.mjs';
import { isInside, realpathLenient } from '../../core/paths.mjs';
import { parseYAML, stringifyYAML } from '../../core/yaml.mjs';
import { listWorkspace, loadWorkspaceGraph, mapWorkspace, summarizeWorkspace } from '../../enterprise/workspace.mjs';
import { readSources, writeSources } from '../../policy/config-diff.mjs';
import { parseConfigText } from '../../policy/config.mjs';
import { appendEvent } from '../../state/ledger.mjs';
import { humanCommand, output, table, withRun } from '../util.mjs';
import { open } from './_shared.mjs';
import { baseProposal } from './init.mjs';

const USAGE = 'usage: unknot workspace list | map [--no-history] | graph [--json] | add <name> <path> | remove <name>';

const PROPOSAL_COMMENT = /^(?:#[^\n]*\n)+/;

/** The repositories listed in a proposal nobody has accepted, or an empty list. */
function proposedRepositories(ctx) {
  if (!existsSync(ctx.paths.proposedConfig)) return [];
  try {
    return parseConfigText(readFileSync(ctx.paths.proposedConfig, 'utf8'), 'config.proposed.yaml').workspace?.repositories ?? [];
  } catch {
    return [];
  }
}

/** Fail with a distinct code when the repositories exist only in a proposal that is not accepted. */
function requireAcceptedRepositories(ctx, config) {
  if ((config.workspace?.repositories ?? []).length || !proposedRepositories(ctx).length) return;
  throw new UnknotError('UK_WORKSPACE_UNACCEPTED', `the workspace repositories are in an unaccepted proposal; a person reviews \`${humanCommand('config diff')}\` and runs \`unknot config accept\``, { details: { proposal: '.unknot/config.proposed.yaml' } });
}

/** Edit the workspace section of the proposal; the accepted configuration is never touched. */
async function editProposal(ctx, change) {
  let proposed;
  let header = '';
  let sources = null;
  if (existsSync(ctx.paths.proposedConfig)) {
    const text = readFileSync(ctx.paths.proposedConfig, 'utf8');
    proposed = parseYAML(text) ?? {};
    header = PROPOSAL_COMMENT.exec(text)?.[0] ?? '';
    sources = readSources(ctx.paths, text);
  } else if (ctx.store.meta('accepted_config_text')) proposed = parseConfigText(ctx.store.meta('accepted_config_text'), '<accepted>');
  else {
    ({ proposed } = await baseProposal(ctx));
    header = '# repository.publishes_api: true treats public members as possible library API, so removing one is never a proven deletion.\n# Set it to false only if this repository publishes no library API and its public members are internal.\n';
  }
  const repos = [...(proposed.workspace?.repositories ?? [])];
  change(repos);
  if (repos.length) proposed.workspace = { ...proposed.workspace, repositories: repos };
  else if (proposed.workspace) {
    delete proposed.workspace.repositories;
    if (!Object.keys(proposed.workspace).length) delete proposed.workspace;
  }
  const out = `${header}${stringifyYAML(proposed)}`;
  writeFileSync(ctx.paths.proposedConfig, out);
  const entries = { ...(sources?.entries ?? {}) };
  if (repos.length) entries['workspace.repositories'] = { source: 'workspace add' };
  else delete entries['workspace.repositories'];
  writeSources(ctx.paths, out, { entries, omitted: sources?.omitted ?? [] });
}

/** Validate the path now; the returned function validates against the list being edited. */
function addRepository(ctx, name, path) {
  const abs = realpathLenient(resolve(ctx.root, path));
  if (!existsSync(abs)) throw new UnknotError('UK_NOT_FOUND', `${abs} does not exist`);
  if (!existsSync(resolve(abs, '.git'))) throw new UnknotError('UK_CONFIG_INVALID', `${abs} is not the root of a git repository`);
  if (abs === realpathLenient(ctx.root)) throw new UnknotError('UK_CONFIG_INVALID', 'the workspace root cannot list itself');
  if (isInside(realpathLenient(resolve(ctx.root, '.unknot')), abs)) throw new UnknotError('UK_CONFIG_INVALID', `${abs} is inside this root's .unknot/ directory`);
  return (repos) => {
    if (repos.some((r) => r.name === name)) throw new UnknotError('UK_CONFIG_INVALID', `a workspace repository named ${name} is already listed`);
    const clash = repos.find((r) => realpathLenient(resolve(ctx.root, r.path)) === abs);
    if (clash) throw new UnknotError('UK_CONFIG_INVALID', `${path} is already listed as ${clash.name}`);
    repos.push({ name, path });
  };
}

export async function run({ positional, flags }) {
  const sub = positional[0] ?? 'list';
  if (sub === 'add' || sub === 'remove') {
    const [, name, path] = positional;
    if (!name || (sub === 'add' && !path)) {
      output(USAGE);
      return 2;
    }
    const { ctx, actor } = open(flags, { create: true });
    const change = sub === 'add'
      ? addRepository(ctx, name, path)
      : (repos) => {
        const i = repos.findIndex((r) => r.name === name);
        if (i < 0) throw new UnknotError('UK_NOT_FOUND', `no workspace repository named ${name} in the proposal`);
        repos.splice(i, 1);
      };
    await editProposal(ctx, change);
    appendEvent(ctx, { type: 'config.proposed', actor, payload: { workspace: sub, name, ...(path && { path }) } });
    if (flags.json) return output({ proposal: '.unknot/config.proposed.yaml', action: sub, name, ...(path && { path }), accepted: false }, { json: true });
    return output([
      `${sub === 'add' ? `Added ${name} (${path}) to` : `Removed ${name} from`} .unknot/config.proposed.yaml. The accepted configuration was not changed; the repository list applies only once a person accepts the proposal.`,
      `To review the proposal: ${humanCommand('config diff')}`,
      'To accept it (a person, in a separate terminal window): unknot config accept.',
    ].join('\n'));
  }
  const { ctx, cfg, config, actor } = open(flags);
  if (sub === 'list' || sub === 'map') requireAcceptedRepositories(ctx, config);
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
