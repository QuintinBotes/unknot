// The MCP tool catalogue. Every tool is read-only except `submit_handoff`, which only
// appends a schema-validated handoff record. Nothing here approves, applies, starts a run,
// executes a command or edits a file: those stay in the human-driven CLI.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnknotError } from '../core/errors.mjs';
import { getFinding } from '../diagnose/engine.mjs';
import { rankHubs } from '../graph/algorithms.mjs';
import { Graph } from '../graph/graph.mjs';
import { card, evaluate, index as patternIndex } from '../patterns/engine.mjs';
import { selectNext } from '../plan/next.mjs';
import { loadConfig } from '../policy/config.mjs';
import { bindToRun, validateHandoff, recordHandoff } from '../state/handoff.mjs';
import { activeRun } from '../state/runs.mjs';

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
    description: 'List graph nodes by type, or fetch one node by id together with its edges.',
    inputSchema: schema({
      type: str(),
      id: str(),
      edge_type: str(),
      direction: { type: 'string', enum: ['out', 'in'] },
      limit: limit(),
    }),
    run(ctx, a) {
      const g = Graph.fromStore(ctx.store);
      const max = a.limit ?? 50;
      if (a.id) {
        const node = g.node(a.id);
        if (!node) throw notFound('node', a.id);
        const edges = edgesOf(g, a.id, { direction: a.direction, edgeTypes: a.edge_type });
        return { node, edges: edges.slice(0, max), edge_count: edges.length };
      }
      if (!a.type) {
        const types = {};
        for (const n of g.nodes()) types[n.type] = (types[n.type] ?? 0) + 1;
        return { ...g.size, types, hint: 'pass type or id for detail' };
      }
      const nodes = g.nodes(a.type);
      return { nodes: nodes.slice(0, max), total: nodes.length };
    },
  },

  graph_hubs: {
    description: 'Modules ranked by fan-in and fan-out over one edge type (default IMPORTS).',
    inputSchema: schema({ edge_type: str(), limit: limit(15) }),
    run(ctx, a) {
      return rankHubs(Graph.fromStore(ctx.store), { edgeType: a.edge_type ?? 'IMPORTS', limit: Math.min(a.limit ?? 15, 200) });
    },
  },
  graph_neighbourhood: {
    description: 'Breadth-first subgraph around a node, up to three hops.',
    inputSchema: schema({ id: str(), depth: limit(3), edge_types: { type: 'array', items: str(), maxItems: 32 } }, ['id']),
    run(ctx, a) {
      const g = Graph.fromStore(ctx.store);
      if (!g.node(a.id)) throw notFound('node', a.id);
      const depth = a.depth ?? 1;
      const seen = new Set([a.id]);
      const edges = new Map();
      let frontier = [a.id];
      // Bounded so one hub node cannot make a single call enormous.
      const NODE_CAP = 300;
      for (let d = 0; d < depth && frontier.length && seen.size < NODE_CAP; d++) {
        const next = [];
        for (const id of frontier) {
          for (const e of edgesOf(g, id, { edgeTypes: a.edge_types })) {
            edges.set(e.id, e);
            for (const end of [e.from, e.to]) {
              if (!seen.has(end) && seen.size < NODE_CAP) {
                seen.add(end);
                next.push(end);
              }
            }
          }
        }
        frontier = next;
      }
      return {
        root: a.id,
        depth,
        nodes: [...seen].map((id) => g.node(id)).filter(Boolean),
        edges: [...edges.values()].filter((e) => seen.has(e.from) && seen.has(e.to)),
        capped: seen.size >= NODE_CAP,
      };
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
      return { slice: body, meta, obligations, approvals };
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
        const rec = JSON.parse(readFileSync(join(ctx.paths.base, 'decompositions', `${a.id}.json`), 'utf8'));
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
