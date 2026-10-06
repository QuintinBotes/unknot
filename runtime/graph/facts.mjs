// The Codebase Knowledge Graph vocabulary (spec §9, §14.4, §15.3, §15A) and the one way
// adapters create facts. Observed facts, inferences and recommendations stay separate:
// a fact is only ever something an extractor saw, with where and how it saw it.

import { digest } from '../core/canonical.mjs';

export const NODE_TYPES = Object.freeze(new Set([
  // code and build
  'repository', 'workspace', 'package', 'module', 'namespace', 'build_target', 'file', 'dependency',
  'function', 'method', 'class', 'interface', 'type', 'endpoint', 'command', 'route', 'component', 'store',
  // messaging and deployment
  'event', 'topic', 'queue', 'job', 'workflow', 'service', 'deployable', 'feature_flag',
  // identifier-like string constants: metric names, config keys, routes, roles, queue names
  'constant',
  // data (§14.4)
  'engine', 'cluster', 'database', 'schema', 'table', 'collection', 'view', 'column', 'field', 'constraint',
  'index', 'partition', 'sequence', 'routine', 'trigger', 'query', 'plan', 'transaction_boundary',
  'migration', 'backfill', 'replica', 'backup_policy', 'restore_test', 'data_class', 'retention_rule',
  'residency_rule', 'encryption_key', 'db_role', 'grant', 'pool', 'cdc_stream',
  // infrastructure (§15.3)
  'cloud', 'account', 'region', 'zone', 'network', 'subnet', 'net_route', 'firewall_rule', 'net_endpoint',
  'dns_zone', 'compute', 'node_pool', 'k8s_namespace', 'workload', 'cloud_function', 'load_balancer',
  'gateway', 'ingress', 'egress_path', 'volume', 'bucket', 'snapshot', 'backup_vault', 'identity', 'role',
  'policy', 'permission', 'service_account', 'key', 'secret_ref', 'trust_boundary', 'iac_module',
  'state_backend', 'resource', 'plan_action', 'field_manager', 'pipeline', 'builder', 'artifact', 'image',
  'registry', 'attestation', 'slo', 'alert', 'runbook', 'recovery_plan', 'cost_center',
  // people and decisions
  'team', 'owner', 'reviewer', 'adr', 'requirement',
  // verification and planning
  'test', 'benchmark', 'finding', 'campaign', 'slice', 'proof_obligation',
]));

export const EDGE_TYPES = Object.freeze(new Set([
  // §9.2
  'IMPORTS', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'INSTANTIATES',
  'READS', 'WRITES', 'OWNS_DATA', 'MIGRATES', 'REPLICATES_TO',
  'EXPOSES', 'CONSUMES', 'PUBLISHES', 'SUBSCRIBES',
  'DEPENDS_ON', 'BUILDS', 'TESTS', 'DEPLOYS_TO',
  'ROUTES_TO', 'ALLOWS_INGRESS_FROM', 'ALLOWS_EGRESS_TO',
  'AUTHENTICATES_AS', 'ASSUMES', 'GRANTS', 'AUTHORIZED_BY',
  'OWNED_BY', 'REVIEWED_BY', 'DESCRIBED_BY', 'VIOLATES',
  'REPLACES', 'SHADOWS', 'SUPERSEDES', 'BACKED_UP_BY',
  // §14.4
  'QUERIES', 'MUTATES', 'JOINS_WITH', 'REFERENCES', 'INDEXED_BY',
  'DERIVED_FROM', 'RESTORED_BY', 'MIGRATED_BY', 'BACKFILLED_BY', 'EMITS_CHANGES_TO',
  'CLASSIFIED_AS', 'RETAINED_UNDER', 'RESIDENT_IN', 'ENCRYPTED_BY',
  'AUTHORIZED_FOR', 'OWNS_SCHEMA', 'SHARES_TRANSACTION_WITH',
  // §15.3
  'PROVISIONS', 'MANAGES_STATE_FOR', 'DEPLOYED_TO', 'RESOLVES_TO', 'READS_SECRET',
  'MOUNTS', 'SNAPSHOTS_TO', 'FAILS_OVER_TO', 'REPLICATES_ACROSS',
  'SIGNS', 'DEPLOYS', 'OBSERVES', 'COSTS_TO', 'PROTECTED_BY', 'VIOLATES_POLICY',
  // structure, history, runtime and UI (Unknot extensions)
  'CONTAINS', 'CO_CHANGES', 'RUNTIME_CALLS', 'RENDERS', 'DEFINES',
]));

// 'vcs' extends the spec's list: git history is recorded fact, not inference.
export const SOURCE_TYPES = Object.freeze(new Set(['ast', 'lsp', 'trace', 'config', 'catalog', 'human', 'inference', 'vcs']));
export const CONFIDENCE = Object.freeze(new Set(['high', 'medium', 'low']));
export const LABELS = Object.freeze(new Set(['observed', 'corroborated', 'inferred', 'unknown', 'contradicted']));

/**
 * Provenance as an adapter states it. `observed_at` and `commit` are stamped by the
 * builder, which knows them; an adapter that set them could set them wrongly.
 */
export function prov({ source_type, source_ref, extractor, confidence = 'high', scope = [], contradicts = [] }) {
  if (!SOURCE_TYPES.has(source_type)) throw new TypeError(`bad source_type ${source_type}`);
  if (!CONFIDENCE.has(confidence)) throw new TypeError(`bad confidence ${confidence}`);
  if (!extractor || typeof extractor !== 'string') throw new TypeError('extractor is required');
  return { source_type, source_ref: source_ref ?? null, extractor, confidence, scope, contradicts };
}

/** A node fact. `id` is `<type>:<stable key>`, e.g. `module:src/a.ts`, `table:public.orders`. */
export function nodeFact(type, key, { name, path, attrs = {} } = {}, provenance) {
  if (!NODE_TYPES.has(type)) throw new TypeError(`unknown node type ${type}`);
  if (!provenance) throw new TypeError('provenance is required on every fact');
  return { kind: 'node', id: nodeId(type, key), type, name: name ?? String(key), path: path ?? null, attrs, provenance };
}

/** An edge fact between two node ids. */
export function edgeFact(type, from, to, attrs = {}, provenance) {
  if (!EDGE_TYPES.has(type)) throw new TypeError(`unknown edge type ${type}`);
  if (!provenance) throw new TypeError('provenance is required on every fact');
  return { kind: 'edge', type, from, to, attrs, provenance };
}

export function nodeId(type, key) {
  return `${type}:${key}`;
}

export function edgeId(type, from, to) {
  return `${type}|${from}|${to}`;
}

/** Content-derived fact id: the same observation from the same place is the same fact. */
export function factId(fact) {
  const key = fact.kind === 'node' ? fact.id : edgeId(fact.type, fact.from, fact.to);
  return `f-${digest({ key, ref: fact.provenance.source_ref, ex: fact.provenance.extractor, attrs: fact.attrs }).slice(7, 31)}`;
}

/** Throws on a malformed fact so a buggy adapter fails loudly, not silently partially. */
export function assertFact(f) {
  if (!f || (f.kind !== 'node' && f.kind !== 'edge')) throw new TypeError('fact.kind must be node or edge');
  if (!f.provenance || !SOURCE_TYPES.has(f.provenance.source_type)) throw new TypeError('fact has no valid provenance');
  if (f.kind === 'node' && (!NODE_TYPES.has(f.type) || typeof f.id !== 'string')) throw new TypeError(`bad node fact ${f.id}`);
  if (f.kind === 'edge' && (!EDGE_TYPES.has(f.type) || typeof f.from !== 'string' || typeof f.to !== 'string')) {
    throw new TypeError(`bad edge fact ${f.type}`);
  }
  return f;
}
