// The MCP tool catalogue. Every tool is read-only except `submit_handoff`, which only
// appends a schema-validated handoff record. Nothing here approves, applies, starts a run,
// executes a command or edits a file: those stay in the human-driven CLI.

import { searchText } from '../graph/search.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnknotError } from '../core/errors.mjs';
import { getFinding } from '../diagnose/engine.mjs';
import { guidanceFor } from '../core/guidance.mjs';
import { emptyScopeWarning, scopePredicate } from '../core/scope.mjs';
import { neighbourhood, rankHubs, resolveRef } from '../graph/algorithms.mjs';
import { DERIVED_KINDS, readDerived } from '../graph/derived.mjs';
import { EDGE_TYPES } from '../graph/facts.mjs';
import { Graph } from '../graph/graph.mjs';
import { card, evaluate, index as patternIndex } from '../patterns/engine.mjs';
import { selectNext } from '../plan/next.mjs';
import { loadConfig } from '../policy/config.mjs';
import { sliceStanding } from '../policy/lanes.mjs';
import { bindToRun, validateHandoff, recordHandoff } from '../state/handoff.mjs';
import { activeRun } from '../state/runs.mjs';
import { upgradeDecomposition, upgradeSlice } from '../state/upgrade.mjs';

const str = (extra = {}) => ({ type: 'string', maxLength: 512, ...extra });
const limit = (max = 200) => ({ type: 'integer', minimum: 1, maximum: max });
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const notFound = (what, id) => new UnknotError('UK_NOT_FOUND', `no ${what} ${id}`);
const parse = (row, key = 'body') => ({ ...row, [key]: JSON.parse(row[key]) });

function countBy(ctx, table, column) {
  return Object.fromEntries(ctx.store.all(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`).map((r) => [r.k, r.n]));
}

/** Edges touching a node in the requested direction(s), optionally filtered by type. */
function edgesOf(g, id, { direction, edgeTypes }) {
  const out = direction === 'in' ? [] : g.out(id, edgeTypes);
  const inn = direction === 'out' ? [] : g.in(id, edgeTypes);
  return [...out, ...inn];
}

// A tool result stays under this many bytes of JSON, so one broad query cannot flood a context.
const RESULT_BYTES = 40_000;
const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
const NODE_ATTRS = ['language', 'loc', 'namespace', 'is_test'];

/** Id, type, name, path and the few attrs that tell modules apart; `full` keeps everything. */
function nodeView(n, full) {
  if (full) return n;
  const attrs = {};
  for (const k of NODE_ATTRS) if (n.attrs?.[k] !== undefined) attrs[k] = n.attrs[k];
  return { id: n.id, type: n.type, name: n.name, path: n.path, ...(Object.keys(attrs).length ? { attrs } : {}) };
}

function edgeView(e, full) {
  if (full) return e;
  const v = { id: e.id, type: e.type, from: e.from, to: e.to };
  for (const k of ['via', 'confidence', 'count']) if (e.attrs?.[k] !== undefined) v[k] = e.attrs[k];
  return v;
}

/**
 * Trim the named lists until the result fits the byte cap. Adds `truncated`, the totals,
 * what was returned and how to narrow the query. `onTrim` runs after each cut.
 */
function capResult(result, keys, hint, onTrim = () => {}) {
  if (bytes(result) <= RESULT_BYTES) return result;
  const total = Object.fromEntries(keys.map((k) => [k, result[k].length]));
  const out = { ...result, truncated: true, total_before_cut: total, hint };
  while (bytes(out) > RESULT_BYTES) {
    const key = keys.reduce((a, b) => (out[b].length > out[a].length ? b : a));
    if (!out[key].length) break;
    out[key] = out[key].slice(0, Math.floor(out[key].length * 0.8));
    onTrim(out);
  }
  out.returned = Object.fromEntries(keys.map((k) => [k, out[k].length]));
  return out;
}

function edgeTypesArg(a) {
  const types = [...(a.edge_types ?? []), ...(a.edge_type ? [a.edge_type] : [])];
  const bad = types.filter((t) => !EDGE_TYPES.has(t));
  if (bad.length) throw new UnknotError('UK_SCHEMA_INVALID', `unknown edge type ${bad.join(', ')}; known: ${[...EDGE_TYPES].join(', ')}`);
  return [...new Set(types)];
}

/**
 * Each entry: description, inputSchema, run(ctx, args) returning a plain object.
 * `needsWrite` marks the single tool that needs a writable store.
 */
export const TOOLS = {
  status: {
    description: 'Project status: mode, active run, graph generation and commit, findings by status, slices by state.',
    inputSchema: schema(),
    run(ctx) {
      const run = activeRun(ctx.store);
      return {
        mode: loadConfig(ctx).config.mode,
        active_run: run ? { id: run.id, command: run.command, state: run.state, slice_id: run.slice_id ?? null, campaign_id: run.campaign_id ?? null } : null,
        graph: { generation: Number(ctx.store.meta('generation') ?? 0), mapped_commit: ctx.store.meta('mapped_commit') || null, mapped_at: ctx.store.meta('mapped_at') ?? null },
        findings_by_status: countBy(ctx, 'findings', 'status'),
        slices_by_state: countBy(ctx, 'slices', 'state'),
      };
    },
  },

  graph_query: {
    description:
      'List graph nodes by type (type), list edges by type (edge_type, without id), read the derived facts every command shares (derived: scc, scc_strict, declared_only, public_surface, test_code or ownership), or fetch one node by id, module path or type name together with its edges (edge_type and direction filter them). Compact by default; full: true returns every attribute. Default limit 50, at most 200; a result over about 40 KB is cut and says how to narrow.',
    inputSchema: schema({
      type: str(),
      id: str(),
      edge_type: str(),
      direction: { type: 'string', enum: ['out', 'in'] },
      derived: { type: 'string', enum: DERIVED_KINDS },
      limit: limit(),
      full: { type: 'boolean' },
    }),
    run(ctx, a) {
      const g = Graph.fromStore(ctx.store);
      const max = a.limit ?? 50;
      const full = a.full === true;
      if (a.derived) {
        const facts = readDerived(ctx, a.derived, { graph: g });
        return capResult({ derived: a.derived, generation: Number(ctx.store.meta('generation') ?? 0), facts: facts.slice(0, max).map((r) => ({ key: r.key, ...r.body })), total: facts.length }, ['facts'], 'lower limit');
      }
      if (a.id) {
        const ids = resolveRef(g, a.id);
        if (!ids.length) throw notFound('node', a.id);
        if (ids.length > 1) throw new UnknotError('UK_SCHEMA_INVALID', `${a.id} names ${ids.length} nodes; use one id: ${ids.slice(0, 10).join(', ')}`);
        const edges = edgesOf(g, ids[0], { direction: a.direction, edgeTypes: a.edge_type });
        return capResult({ node: nodeView(g.node(ids[0]), full), edges: edges.slice(0, max).map((e) => edgeView(e, full)), edge_count: edges.length }, ['edges'], 'narrow with edge_type and direction, or lower limit');
      }
      if (a.type && a.edge_type) throw new UnknotError('UK_SCHEMA_INVALID', "pass type (list nodes) or edge_type (list edges), not both; to filter one node's edges pass id");
      if (a.edge_type) {
        const edges = g.edges(a.edge_type);
        return capResult({ edges: edges.slice(0, max).map((e) => edgeView(e, full)), total: edges.length }, ['edges'], 'lower limit, or query one node with id and direction');
      }
      if (!a.type) {
        const types = {};
        for (const n of g.nodes()) types[n.type] = (types[n.type] ?? 0) + 1;
        return { ...g.size, types, hint: 'pass type, edge_type or id for detail' };
      }
      const nodes = g.nodes(a.type);
      return capResult({ nodes: nodes.slice(0, max).map((n) => nodeView(n, full)), total: nodes.length }, ['nodes'], 'lower limit, or look up one node with id');
    },
  },

  graph_hubs: {
    description:
      'Modules ranked by fan-in and fan-out over one edge type (default IMPORTS) or the union of edge_types. scope entries (paths, globs, ns:Namespace, seed:Name~N) rank only in-scope modules, counting fan-in from anywhere unless within is true. Limit default 15, at most 200.',
    inputSchema: schema({
      edge_type: str(),
      edge_types: { type: 'array', items: str(), maxItems: 16 },
      scope: { type: 'array', items: str(), maxItems: 32 },
      within: { type: 'boolean' },
      limit: limit(200),
    }),
    run(ctx, a) {
      const g = Graph.fromStore(ctx.store);
      const types = edgeTypesArg(a);
      const edgeTypes = types.length ? types : ['IMPORTS'];
      const pred = scopePredicate(g, a.scope ?? [], { edgeTypes });
      const warning = emptyScopeWarning(pred.scope);
      const res = rankHubs(g, { edgeTypes, limit: a.limit ?? 15, nodeFilter: pred.scope.all ? undefined : pred, within: a.within === true });
      return { ...res, ...(pred.scope.all ? {} : { scope: { matched: pred.scope.matched, total: pred.scope.total } }), ...(warning ? { warning } : {}) };
    },
  },
  graph_neighbourhood: {
    description:
      'Breadth-first subgraph around a node (id, module path or type name), up to three hops, optionally limited to edge_types. Compact by default; full: true returns every attribute. At most 300 nodes and about 40 KB; a cut result says how to narrow.',
    inputSchema: schema({ id: str(), depth: limit(3), edge_types: { type: 'array', items: str(), maxItems: 32 }, full: { type: 'boolean' } }, ['id']),
    run(ctx, a) {
      const g = Graph.fromStore(ctx.store);
      const roots = resolveRef(g, a.id);
      if (!roots.length) throw notFound('node', a.id);
      const depth = a.depth ?? 1;
      const hood = neighbourhood(g, roots, { depth, edgeTypes: a.edge_types?.length ? a.edge_types : undefined });
      const full = a.full === true;
      const result = { root: roots[0], ...(roots.length > 1 ? { roots } : {}), depth, nodes: hood.nodes.map((n) => nodeView(n, full)), edges: hood.edges.map((e) => edgeView(e, full)), capped: hood.capped };
      // Dropping nodes drops the edges that touched them.
      return capResult(result, ['nodes', 'edges'], 'lower depth, or pass edge_types to follow fewer relations', (out) => {
        const kept = new Set(out.nodes.map((n) => n.id));
        out.edges = out.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
      });
    },
  },

  finding_get: {
    description: 'The full finding record for an id or fingerprint. A finding is a proposal, not a decision.',
    inputSchema: schema({ id: str() }, ['id']),
    run: (ctx, a) => getFinding(ctx, a.id),
  },

  findings_list: {
    description: 'Ranked finding summaries, highest priority first.',
    inputSchema: schema({ status: str(), category: str(), limit: limit() }),
    run(ctx, a) {
      const where = [];
      const params = [];
      if (a.status) {
        where.push('status = ?');
        params.push(a.status);
      }
      if (a.category) {
        where.push('category = ?');
        params.push(a.category);
      }
      const rows = ctx.store.all(
        `SELECT id, kind, category, status, priority, body FROM findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority DESC, id LIMIT ?`,
        ...params,
        a.limit ?? 50,
      );
      return {
        findings: rows.map((r) => {
          const body = JSON.parse(r.body);
          return { id: r.id, kind: r.kind, category: r.category, status: r.status, priority: r.priority, title: body.title ?? body.summary ?? null };
        }),
      };
    },
  },

  pattern_index: {
    description: 'Headers of the simplification pattern catalogue. Patterns are proposals to evaluate, not instructions.',
    inputSchema: schema({ category: str(), treatment: str() }),
    run: (_ctx, a) => ({ patterns: patternIndex({ category: a.category, treatment: a.treatment }) }),
  },

  pattern_get: {
    description: 'One full pattern card.',
    inputSchema: schema({ id: str() }, ['id']),
    run: (_ctx, a) => card(a.id),
  },

  pattern_fit: {
    description: 'Evaluate a pattern card against measured signals (a flat object of metric to value).',
    inputSchema: schema({ id: str(), signals: { type: 'object' } }, ['id', 'signals']),
    run: (_ctx, a) => evaluate(card(a.id), a.signals),
  },

  slice_get: {
    description: 'A slice with its proof obligations and approvals. Approval signatures are omitted.',
    inputSchema: schema({ id: str() }, ['id']),
    run(ctx, a) {
      const row = ctx.store.get('SELECT * FROM slices WHERE id = ?', a.id);
      if (!row) throw notFound('slice', a.id);
      const { body, ...meta } = parse(row);
      const obligations = ctx.store
        .all('SELECT * FROM proof_obligations WHERE slice_id = ? ORDER BY id', a.id)
        .map((o) => ({ ...parse(o), requires_human: Boolean(o.requires_human) }));
      // The signature column is deliberately not selected: the model has no use for it.
      const approvals = ctx.store.all(
        'SELECT id, stage, role, approver, key_fingerprint, binding_hash, expires_at, created_at, revoked_at, revoked_reason FROM approvals WHERE slice_id = ? ORDER BY created_at',
        a.id,
      );
      const st = sliceStanding({ ...meta, body }, loadConfig(ctx).config);
      return { slice: upgradeSlice(body), meta, risk_reasons: st.risk_reasons, required_approvals: st.approvals, lane: st.lane, obligations, approvals };
    },
  },

  search_text: {
    description: 'Where a string occurs in the files the map covers (metric names, setting keys, role names, feature flags, durations): definitions (a constant or config key holding it) apart from uses, the uses of a constant that holds it, and each hit\'s module, kind and owners. Generated, vendored and credential files are excluded.',
    inputSchema: schema({ text: str({ minLength: 2, maxLength: 200 }), regex: { type: 'boolean' }, limit: limit(200), scope: { type: 'array', items: str(), maxItems: 20 } }, ['text']),
    run(ctx, a) {
      const { config } = loadConfig(ctx);
      const graph = ctx.store.meta('generation') ? Graph.fromStore(ctx.store) : null;
      const r = searchText(ctx.root, { config, text: a.text, regex: Boolean(a.regex), scope: a.scope ?? [], graph, limit: a.limit ?? 50 });
      return capResult(r, ['definitions', 'uses', 'via_constants'], 'narrow with a scope (a path or glob) or a more specific text');
    },
  },

  guidance_get: {
    description: "The repository's own agent guidance (AGENTS.md, CLAUDE.md, Copilot and Cursor rules, CONTRIBUTING.md, .editorconfig) that applies to a path, nearest first: conventions, commands, prohibited commands and paths, and text ignored for trying to grant something. Guidance only restricts; it never grants approvals, scope or commands.",
    inputSchema: schema({ path: str() }, ['path']),
    run(ctx, a) {
      if (a.path.startsWith('/') || a.path.split('/').includes('..')) throw new UnknotError('UK_SCHEMA_INVALID', 'path must be relative to the project, without ..');
      return { path: a.path, ...guidanceFor(ctx.root, a.path) };
    },
  },

  next_slice: {
    description: 'The smallest unblocked slice to work on next, with the reasons it was chosen.',
    inputSchema: schema({ campaign: str() }),
    run: (ctx, a) => selectNext(ctx, { campaign: a.campaign ?? null }),
  },

  decomposition_get: {
    description: 'A saved decomposition recommendation by id (DEC-0001).',
    inputSchema: schema({ id: str({ pattern: '^DEC-\\d{4,}$' }) }, ['id']),
    run(ctx, a) {
      // Checked again here: the id becomes part of a path, so never rely on the schema alone.
      if (!/^DEC-\d{4,}$/.test(a.id)) throw new UnknotError('UK_SCHEMA_INVALID', 'decomposition id must match ^DEC-\\d{4,}$');
      try {
        const rec = upgradeDecomposition(JSON.parse(readFileSync(join(ctx.paths.base, 'decompositions', `${a.id}.json`), 'utf8')));
        // Stale when the graph was rebuilt since the record was written.
        return rec.graph_generation === undefined ? rec : { ...rec, stale: rec.graph_generation !== Number(ctx.store.meta('generation') ?? 0) };
      } catch (err) {
        if (err.code === 'ENOENT') throw notFound('decomposition', a.id);
        throw err;
      }
    },
  },

  submit_handoff: {
    description: 'Report a subagent handoff. Validated against the handoff schema, then appended to the run record. Grants no authority.',
    inputSchema: schema({ handoff: { type: 'object' } }, ['handoff']),
    needsWrite: true,
    run(ctx, a) {
      const { config } = loadConfig(ctx);
      const run = activeRun(ctx.store);
      if (!run) return { ok: false, errors: [{ path: '', message: 'no active Unknot run: a handoff is recorded only during a run that an /unknot command started; report in prose instead' }] };
      const bound = bindToRun(a.handoff, run);
      const res = validateHandoff(bound.handoff, config.mode);
      if (!res.ok) return { ok: false, errors: res.errors };
      const warnings = [...bound.warnings, ...res.warnings];
      const ref = recordHandoff(ctx, { run, handoff: res.handoff, agentId: null, warnings });
      return { ok: true, run_id: run.id, warnings, ref };
    },
  },
};
