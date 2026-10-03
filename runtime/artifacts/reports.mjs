// Domain inventories behind `unknot database`, `infrastructure` and `security`. Each is a
// pure function of the graph (plus, where noted, the store) and reports only what the
// graph or config states. A missing objective is reported as missing; nothing here
// invents an invariant, an owner, a backup policy or a layer that was not observed.

import { matchAny } from '../core/glob.mjs';
import { dedupe, publicEntries, riskyRole, unitModel, unitOf, WRITE_EDGES } from './model.mjs';

const count = (arr, key) => {
  const out = {};
  for (const x of arr) { const k = key(x) ?? 'unknown'; out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
};
const refs = (list, n = 5) => list.slice(0, n).map((x) => x.id ?? x);
const ev = (summary, list = []) => ({ summary, refs: refs(list) });
const msDay = 86_400_000;

// --------------------------------------------------------------------------- database

/** Spec §14.5: every persistent-data campaign declares these. */
export const DB_INVARIANTS = [
  ['source_of_truth', 'Source of truth and owner', (g) => g.edges('OWNS_DATA')],
  ['read_write_paths', 'Read and write paths', (g) => g.edges().filter((e) => ['QUERIES', 'MUTATES', 'READS', 'WRITES'].includes(e.type) && ['table', 'collection'].includes(g.node(e.to)?.type))],
  ['transaction_boundaries', 'Transaction and consistency boundaries', (g) => g.nodes('transaction_boundary')],
  ['isolation_concurrency', 'Isolation and concurrency requirements', (g) => g.nodes('transaction_boundary').filter((n) => n.attrs?.isolation)],
  ['constraints', 'Nullability, uniqueness, referential and domain constraints', (g) => [...g.nodes('constraint'), ...g.edges('REFERENCES')]],
  ['ordering_idempotency', 'Ordering, idempotency and deduplication', () => []],
  ['classification_retention', 'Classification, tenant boundary, residency and retention', (g) => [...g.nodes('data_class'), ...g.nodes('retention_rule'), ...g.nodes('residency_rule'), ...g.edges('CLASSIFIED_AS'), ...g.edges('RETAINED_UNDER'), ...g.edges('RESIDENT_IN')]],
  ['encryption_keys', 'Encryption and key management', (g) => [...g.nodes('encryption_key'), ...g.edges('ENCRYPTED_BY')]],
  ['rpo_rto_backup_restore', 'RPO, RTO, backup and restore mechanism', (g) => g.nodes('backup_policy').filter((n) => n.attrs?.rpo || n.attrs?.rto || n.attrs?.rpo_minutes || n.attrs?.rto_minutes)],
  ['compatibility_window', 'Old/new application compatibility window', () => []],
  ['reconciliation', 'Reconciliation rule and acceptable discrepancy', () => []],
  ['cutover_abort', 'Cutover, abort and roll-forward conditions', () => []],
];

const HAZARD_LOCK = /ACCESS EXCLUSIVE|^EXCLUSIVE$/i;

function hazards(m) {
  const reasons = [];
  if (m.attrs?.destructive) reasons.push('destructive');
  if (m.attrs?.irreversible) reasons.push('irreversible');
  if (m.attrs?.has_down === false) reasons.push('no down migration');
  for (const s of m.attrs?.statements ?? []) {
    const f = s.forecast;
    if (!f) continue;
    if (f.rewrite && f.rewrite !== 'none' && f.rewrite !== false) reasons.push(`${s.kind} rewrites ${s.table ?? 'a table'}`);
    else if (f.lock_mode && HAZARD_LOCK.test(f.lock_mode)) reasons.push(`${s.kind} takes ${f.lock_mode} on ${s.table ?? 'a table'}`);
  }
  return dedupe(reasons);
}

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {{config?: object, catalog?: object|null}} [opts] `catalog` is the store's catalog-evidence age
 */
export function databaseInventory(graph, { config = {}, catalog = null } = {}) {
  const engines = graph.nodes('engine').map((n) => ({ id: n.id, name: n.name, version: n.attrs?.version ?? null }));
  const migrations = graph.nodes('migration');
  const um = unitModel(graph);
  const groupSet = um.pkg.units.length >= 2 ? um.pkg : um.dirs;
  const groupName = (id) => {
    const u = unitOf(graph, um.deploy, id) ?? unitOf(graph, groupSet, id);
    const unit = [...um.deploy.units, ...groupSet.units].find((x) => x.id === u);
    return unit?.name ?? graph.node(id)?.name ?? id;
  };

  const tables = graph.nodes('table').filter((t) => !t.attrs?.placeholder);
  const writers = new Map();
  const writersByGroup = {};
  for (const e of graph.edges()) {
    if (!WRITE_EDGES.includes(e.type) || e.type === 'OWNS_DATA') continue;
    const t = graph.node(e.to);
    if (!t || !['table', 'collection'].includes(t.type) || graph.node(e.from)?.type === 'migration') continue;
    const who = groupName(e.from);
    if (!writers.has(t.id)) writers.set(t.id, new Set());
    writers.get(t.id).add(who);
    (writersByGroup[who] ??= new Set()).add(t.name);
  }
  const sharedWriterTables = [...writers].filter(([, s]) => s.size >= 2).map(([id, s]) => ({ table: graph.node(id).name, id, writers: [...s].sort() })).sort((a, b) => b.writers.length - a.writers.length || a.table.localeCompare(b.table));

  const hazardous = migrations.map((m) => ({ m, why: hazards(m) })).filter((x) => x.why.length).map(({ m, why }) => ({
    id: m.id, path: m.path, framework: m.attrs?.framework ?? null, hazards: why,
    forecasts: (m.attrs?.statements ?? []).filter((s) => s.forecast).map((s) => ({
      statement: s.kind, table: s.table ?? null, lock_mode: s.forecast.lock_mode ?? null, rewrite: s.forecast.rewrite ?? null,
      scan: s.forecast.scan ?? null, safer_alternative: s.forecast.safer_alternative ?? null, confidence: s.forecast.confidence ?? null,
    })),
  }));

  const declared = config.database?.invariants ?? {};
  const invariants = DB_INVARIANTS.map(([id, title, fromGraph]) => {
    const g = fromGraph(graph);
    const c = declared[id];
    if (g.length) return { id, title, status: 'declared', source: 'graph', evidence: g.length };
    if (c) return { id, title, status: 'declared', source: 'config', evidence: 1 };
    return { id, title, status: 'missing', source: null, evidence: 0 };
  });

  return {
    engines,
    migrations: { total: migrations.length, by_framework: count(migrations, (m) => m.attrs?.framework) },
    tables: { total: tables.length, with_writers: writers.size },
    writers_by_group: Object.fromEntries(Object.entries(writersByGroup).map(([k, v]) => [k, [...v].sort()]).sort((a, b) => a[0].localeCompare(b[0]))),
    shared_writer_tables: sharedWriterTables,
    hazardous_migrations: hazardous,
    catalog_evidence: catalog ?? { facts: 0, newest: null, oldest: null, age_days: null },
    invariants,
    missing_invariants: invariants.filter((i) => i.status === 'missing').map((i) => i.id),
  };
}

/** Age of imported database-catalog evidence, from the facts table. */
export function catalogEvidenceAge(ctx, { prefixes = ['table:', 'engine:', 'query:', 'plan:', 'db_role:', 'grant:'], now = Date.now() } = {}) {
  const where = prefixes.map(() => 'subject LIKE ?').join(' OR ');
  const row = ctx.store.get(`SELECT COUNT(*) AS n, MAX(observed_at) AS newest, MIN(observed_at) AS oldest FROM facts WHERE source_type = 'catalog' AND (${where})`, ...prefixes.map((p) => `${p}%`));
  const newest = row?.newest ?? null;
  return { facts: row?.n ?? 0, newest, oldest: row?.oldest ?? null, age_days: newest ? +((now - Date.parse(newest)) / msDay).toFixed(1) : null };
}

// ------------------------------------------------------------------- infrastructure

const INFRA_TYPES = ['workload', 'k8s_namespace', 'ingress', 'gateway', 'service', 'cluster', 'node_pool', 'compute', 'network', 'subnet', 'load_balancer', 'bucket', 'volume', 'cloud_function', 'queue', 'dns_zone', 'firewall_rule', 'role', 'service_account', 'secret_ref', 'state_backend', 'iac_module'];

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {{config?: object}} [opts]
 */
export function infrastructureInventory(graph, { config = {} } = {}) {
  const declared = graph.nodes('resource').filter((r) => !r.attrs?.drift && !r.attrs?.data && r.attrs?.type);
  const driftNodes = graph.nodes('resource').filter((r) => r.attrs?.drift);
  const planNodes = graph.nodes('plan_action');
  const planHeads = planNodes.filter((p) => p.attrs?.summary);
  const changes = planNodes.filter((p) => p.attrs?.action);
  const backends = graph.nodes('state_backend');
  const exposure = publicEntries(graph);
  const iam = ['role', 'policy', 'permission', 'resource'].flatMap((t) => graph.nodes(t))
    .filter((n) => !n.attrs?.drift && !n.attrs?.placeholder)
    .map((n) => ({ n, why: riskyRole(n) })).filter((x) => x.why.length);

  const hasActual = driftNodes.some((d) => d.attrs?.source) || (config.evidence?.infra_inventory ?? []).length > 0;
  const observed = graph.edges('RUNTIME_CALLS').length + graph.edges('COSTS_TO').length + graph.nodes('slo').length + graph.nodes('alert').length;
  const intended = graph.nodes('adr').length + graph.nodes('policy').filter((p) => p.id.startsWith('policy:iac-baseline')).length + graph.nodes('slo').length + graph.nodes('requirement').length + graph.edges('OWNED_BY').length;
  const layers = [
    ['declared', 'Version-controlled desired configuration', declared.length + graph.nodes('workload').length],
    ['planned', 'Plan, change set, preview, rendered chart or dry-run', planNodes.length],
    ['recorded', 'IaC state and controller inventory', backends.filter((b) => b.attrs?.recorded).length],
    ['actual', 'Read-only provider or cluster inventory', hasActual ? Math.max(1, driftNodes.length) : 0],
    ['observed', 'Traffic, cost, metrics, traces and logs', observed],
    ['intended', 'Policy, ADR, SLO and owner statement', intended],
  ].map(([layer, description, n]) => ({ layer, description, present: n > 0, evidence: n }));

  const kinds = count(INFRA_TYPES.flatMap((t) => graph.nodes(t).filter((n) => !n.attrs?.placeholder).map(() => t)), (t) => t);
  return {
    resources: {
      declared: declared.length,
      by_type: count(declared, (r) => r.attrs.type),
      by_kind: kinds,
    },
    state_backends: backends.map((b) => ({ id: b.id, name: b.name, recorded: Boolean(b.attrs?.recorded), type: b.attrs?.type ?? null, serial: b.attrs?.serial ?? null, resource_count: b.attrs?.resource_count ?? null, bucket: b.attrs?.bucket ?? null })),
    plans: {
      imported: planHeads.length,
      actions: count(changes, (c) => c.attrs.action),
      summaries: planHeads.map((p) => ({ id: p.id, source: p.attrs.source ?? p.path, summary: p.attrs.summary })),
    },
    drift: { total: driftNodes.length, by_kind: count(driftNodes, (d) => d.attrs.drift.kind), items: driftNodes.slice(0, 25).map((d) => ({ kind: d.attrs.drift.kind, address: d.attrs.drift.address ?? d.attrs.drift.id ?? d.name })) },
    public_exposure: exposure.map(({ node, why }) => ({ id: node.id, type: node.type, name: node.name, why, path: node.path })),
    iam_wildcards: iam.map(({ n, why }) => ({ id: n.id, type: n.type, name: n.name, reasons: why, path: n.path })),
    state_hierarchy: layers,
    absent_layers: layers.filter((l) => !l.present).map((l) => l.layer),
  };
}

// ------------------------------------------------------------------------- security

const SECRET_KIND = /secret|credential|password|passwd|token|api[-_ ]?key|private[-_ ]?key|hardcoded/i;
const SHELL_KIND = /shell|command|exec|child[-_ ]?process|eval|subprocess|os[-_ ]?system|path[-_ ]?traversal|symlink/i;
const PROMPT_KIND = /prompt[-_ ]?inject|instruction[-_ ]?override|llm[-_ ]?inject/i;
const TENANT_NAME = /^(tenant|org|organization|account|workspace)(_id)?$/i;

const signalsOf = (graph) => graph.nodes().flatMap((n) => (Array.isArray(n.attrs?.security_signals) ? n.attrs.security_signals.map((s) => ({ ...s, node: n })) : []));

/** Spec §16.1 threats, each with the evidence the graph holds for it (possibly none). */
export function threatChecklist(graph, { staleFacts = 0 } = {}) {
  const sig = signalsOf(graph);
  const bad = (re) => sig.filter((s) => re.test(String(s.kind)));
  const roles = [...graph.nodes('role'), ...graph.nodes('policy'), ...graph.nodes('resource')].filter((n) => !n.attrs?.drift && riskyRole(n).length);
  const deps = graph.nodes('dependency').filter((d) => d.attrs?.pinned === false || d.attrs?.unpinned || d.attrs?.integrity === false || ['git', 'url', 'path'].includes(d.attrs?.source_kind));
  const mcp = graph.nodes().filter((n) => ['dependency', 'package', 'file', 'command'].includes(n.type) && /\bmcp\b|language[-_]?server|\blsp\b/i.test(`${n.name} ${n.path ?? ''}`));
  const tenantCols = graph.nodes('column').filter((c) => TENANT_NAME.test(c.name ?? ''));
  const destructive = [...graph.nodes('migration').filter((m) => m.attrs?.destructive || m.attrs?.irreversible), ...graph.nodes('plan_action').filter((p) => ['delete', 'replace', 'destroy'].includes(p.attrs?.action) || p.attrs?.destroys)];
  const secrets = [...bad(SECRET_KIND).map((s) => s.node), ...graph.nodes('secret_ref'), ...graph.edges('READS_SECRET')];
  const entries = (id, threat, list, summary, note = null) => ({ id, threat, evidenced: list.length > 0, evidence: list.length ? [ev(summary(list.length), list)] : [], ...(note ? { note } : {}) });
  return [
    entries('prompt-injection', 'Prompt injection in repository content, issues, docs, tool output and dependency metadata', bad(PROMPT_KIND).map((s) => s.node), (n) => `${n} node(s) carry prompt-injection signals`),
    entries('malicious-repository', 'Malicious repositories attempting command execution or exfiltration', graph.nodes().filter((n) => ['command', 'build_target', 'pipeline'].includes(n.type) && n.attrs?.lifecycle_script), (n) => `${n} install or lifecycle script(s) execute code on checkout or build`),
    entries('shell-injection-traversal', 'Shell injection, path traversal and symlink escape', bad(SHELL_KIND).map((s) => s.node), (n) => `${n} module(s) call process execution or build paths from input`),
    entries('secrets-in-context', 'Secrets entering model context or proof bundles', secrets, (n) => `${n} secret signal(s), secret references or secret reads`),
    entries('dependency-confusion', 'Dependency confusion and tool substitution', deps, (n) => `${n} dependency(ies) are unpinned, unverified or fetched from git/url/path`),
    entries('compromised-tooling', 'Compromised MCP servers, scanners or language servers', mcp, (n) => `${n} MCP or language-server related component(s) present`),
    entries('excessive-permission', 'Confused-deputy and excessive-permission behavior', roles, (n) => `${n} role/policy node(s) are broader than least privilege`),
    entries('cross-boundary-leakage', 'Cross-repository, tenant or run leakage', tenantCols, (n) => `${n} tenant-scoping column(s) found; every query on them must filter by tenant`),
    entries('stale-evidence', 'Poisoned cache and stale evidence', Array.from({ length: Math.min(staleFacts, 5) }, (_, i) => `stale-fact-${i + 1}`), () => `${staleFacts} fact(s) are past their expiry`),
    entries('destructive-actions', 'Destructive Git, database, cloud or cluster actions', destructive, (n) => `${n} destructive migration(s) or plan action(s)`),
    entries('hallucinated-evidence', 'Hallucinated evidence and unexecuted tests', [], () => '', 'Enforced by proof obligations and the evidence ledger at verify time, not a repository property: nothing to read from the graph.'),
  ];
}

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {{staleFacts?: number}} [opts]
 */
export function securityInventory(graph, { staleFacts = 0 } = {}) {
  const secretFindings = signalsOf(graph).filter((s) => SECRET_KIND.test(String(s.kind))).map((s) => ({
    kind: String(s.kind), location: `${s.node.path ?? s.node.name}${s.line ? `:${s.line}` : ''}`,
  }));
  const privilegePaths = [];
  for (const sa of graph.nodes('service_account')) {
    const roles = graph.out(sa.id, 'ASSUMES').map((e) => graph.node(e.to)).filter(Boolean);
    const workloads = graph.nodes('workload').filter((w) => w.attrs?.service_account === sa.name && (w.attrs.namespace ?? '') === (sa.attrs?.namespace ?? '')).map((w) => w.name);
    for (const role of roles) {
      const grants = graph.out(role.id, 'GRANTS').map((e) => graph.node(e.to)).filter(Boolean);
      privilegePaths.push({
        service_account: sa.name, namespace: sa.attrs?.namespace ?? null, workloads, role: role.name,
        permissions: grants.map((g) => g.name), risky: riskyRole(role), path: [sa.id, role.id, ...grants.map((g) => g.id)],
      });
    }
    if (!roles.length) privilegePaths.push({ service_account: sa.name, namespace: sa.attrs?.namespace ?? null, workloads, role: null, permissions: [], risky: [], path: [sa.id] });
  }
  const entries = publicEntries(graph);
  const policies = graph.nodes('firewall_rule');
  return {
    threats: threatChecklist(graph, { staleFacts }),
    secret_findings: secretFindings,
    secret_references: graph.nodes('secret_ref').length,
    privilege_paths: privilegePaths.sort((a, b) => b.risky.length - a.risky.length || a.service_account.localeCompare(b.service_account)),
    trust_boundaries: {
      public_entries: entries.map(({ node, why }) => ({ id: node.id, type: node.type, name: node.name, why })),
      network_policies: policies.length,
      namespaces: graph.nodes('k8s_namespace').length,
      workloads_without_policy: policies.length ? graph.nodes('workload').filter((w) => !graph.out(w.id, 'PROTECTED_BY').some((e) => graph.node(e.to)?.type === 'firewall_rule')).map((w) => w.name) : null,
    },
  };
}

const SECURITY_GLOBS = [
  '**/auth/**', '**/authn/**', '**/authz/**', '**/security/**', '**/permissions/**', '**/rbac/**', '**/session*/**', '**/crypto/**',
  '**/*auth*.*', '**/*login*.*', '**/*token*.*', '**/*secret*.*', '**/*password*.*', '**/*oauth*.*', '**/*jwt*.*', '**/*cors*.*', '**/*csrf*.*',
  '**/middleware/**', '**/*iam*.*', '**/*policy*.*', '**/*role*.*', '**/*firewall*.*', '**/*security_group*.*', '**/*.tf', '**/*.tfvars',
  '**/k8s/**', '**/kubernetes/**', '**/helm/**', '**/Dockerfile*', '**/.github/workflows/**', '**/package.json', '**/*lock*',
];

/**
 * The security view of one slice: which of its changed paths touch security-relevant code
 * and what security obligations it carries.
 * @param {{store: object}} ctx
 * @param {import('../graph/graph.mjs').Graph} graph
 * @param {string} sliceId
 * @returns {object|null} null when no such slice exists
 */
export function sliceSecurityDelta(ctx, graph, sliceId) {
  const row = ctx.store.get('SELECT * FROM slices WHERE id = ?', sliceId);
  if (!row) return null;
  const body = JSON.parse(row.body);
  const paths = dedupe([...(body.changes ?? []).map((c) => (typeof c === 'string' ? c : c.path)), ...(body.scope?.include ?? [])].filter(Boolean));
  const byPath = new Map();
  for (const n of graph.nodes()) if (n.path) { if (!byPath.has(n.path)) byPath.set(n.path, []); byPath.get(n.path).push(n); }
  const changed = [];
  for (const p of paths) {
    const reasons = [];
    if (matchAny(p, SECURITY_GLOBS, { nocase: true })) reasons.push('path pattern');
    for (const n of byPath.get(p) ?? []) {
      if (['role', 'policy', 'permission', 'service_account', 'firewall_rule', 'secret_ref', 'ingress', 'gateway', 'endpoint'].includes(n.type)) reasons.push(`defines ${n.type} ${n.name}`);
      if (Array.isArray(n.attrs?.security_signals) && n.attrs.security_signals.length) reasons.push(`${n.attrs.security_signals.length} security signal(s)`);
      if (n.type === 'resource' && riskyRole(n).length) reasons.push(`privileged resource ${n.name}`);
    }
    if (reasons.length) changed.push({ path: p, reasons: dedupe(reasons) });
  }
  const SEC_KIND = /secur|secret|auth|iam|permission|network|dependenc|vuln|infra-plan/i;
  const obligations = ctx.store.all('SELECT id, kind, status, requires_human, evidence_id, body FROM proof_obligations WHERE slice_id = ? ORDER BY CAST(substr(id, 4) AS INTEGER)', sliceId)
    .map((o) => ({ ob: o, b: JSON.parse(o.body) }))
    .filter(({ ob, b }) => SEC_KIND.test(ob.kind) || /secur|secret|credential|authoriz|privilege|permission/i.test(b.description ?? '') || (ob.kind === 'human-review' && /security/i.test(b.description ?? '')))
    .map(({ ob, b }) => ({ id: ob.id, kind: ob.kind, status: ob.status, human: Boolean(ob.requires_human), evidence: ob.evidence_id, description: b.description }));
  return {
    slice: sliceId, state: row.state, risk: row.risk, objective: body.objective,
    changed_paths: changed,
    unchanged_paths: paths.length - changed.length,
    obligations,
    unsatisfied: obligations.filter((o) => o.status !== 'pass').map((o) => o.id),
  };
}
