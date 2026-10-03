// Risk classification and required approvals (spec §20, §15.9, §14.11). Classification
// only ever raises risk; nothing a slice declares about itself can lower it.

import { matchAny } from '../core/glob.mjs';
import { riskRank } from './defaults.mjs';

const AUTH_PATHS = ['**/auth/**', '**/authn/**', '**/authz/**', '**/security/**', '**/permissions/**', '**/rbac/**', '**/session*/**', '**/crypto/**', '**/*auth*.*'];
const DB_PATHS = ['**/migrations/**', '**/migrate/**', '**/*.sql', '**/schema.prisma', '**/db/schema.*', '**/alembic/**', '**/liquibase/**', '**/flyway/**'];
const INFRA_PATHS = ['**/*.tf', '**/*.tfvars', '**/terraform/**', '**/k8s/**', '**/kubernetes/**', '**/helm/**', '**/charts/**', '**/kustomize/**', '**/cloudformation/**', '**/*.bicep', '**/Pulumi.*', '**/cdk/**'];
const IAM_HINT = /iam|role|policy|permission|rbac|serviceaccount|service_account|identity/i;
const NET_HINT = /firewall|security_group|securitygroup|ingress|egress|route|dns|certificate|gateway|networkpolicy|load_?balancer|vpc|subnet|nat/i;
const DEP_MANIFESTS = ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/requirements*.txt', '**/pyproject.toml', '**/poetry.lock', '**/go.mod', '**/go.sum', '**/Cargo.toml', '**/Cargo.lock', '**/pom.xml', '**/build.gradle*', '**/Gemfile*', '**/composer.*'];
const RECOVERY_HINT = /backup|snapshot|retention|vault|replica|failover|restore|pitr/i;

const raise = (state, risk, reason) => {
  if (riskRank(risk) > riskRank(state.risk)) state.risk = risk;
  state.reasons.push(`${risk}: ${reason}`);
};

/**
 * @param {object} slice slice body (spec §17.3 schema)
 * @param {{config: object, surfaces?: object}} opts surfaces are measured facts about the
 *   change (from the graph or the diff): public_api, internal_contract, module_boundary,
 *   tenant_boundary, data_movement, destructive_infra.
 */
export function classifyRisk(slice, { config, surfaces = {} } = {}) {
  const state = { risk: 'low', reasons: [], specialists: new Set() };
  const paths = [...(slice.changes ?? []).map((c) => c.path), ...(slice.scope?.include ?? [])].filter(Boolean);
  const any = (globs) => paths.some((p) => matchAny(p, globs, { nocase: true }));
  const text = JSON.stringify(slice.changes ?? []) + JSON.stringify(slice.objective ?? '');

  if (slice.declared_risk && riskRank(slice.declared_risk) > 0) raise(state, slice.declared_risk, 'declared by the planner');
  if (['T1', 'T2', 'T4', 'T5', 'T8'].includes(slice.treatment)) raise(state, 'medium', `treatment ${slice.treatment} changes module boundaries`);
  if (surfaces.module_boundary || surfaces.internal_contract) raise(state, 'medium', 'module boundary or internal contract changes');
  if (any(DEP_MANIFESTS) || surfaces.dependency_change) raise(state, 'medium', 'dependency manifest changes');

  if (surfaces.public_api) raise(state, 'high', 'public API surface changes');
  if (any(AUTH_PATHS)) {
    raise(state, 'high', 'authentication/authorization or crypto code');
    state.specialists.add('security-owner');
  }
  if (slice.kind === 'database' || any(DB_PATHS)) {
    raise(state, 'high', 'database schema or data');
    state.specialists.add('data-owner');
  }
  if (slice.kind === 'infrastructure' || any(INFRA_PATHS)) {
    raise(state, 'medium', 'infrastructure declaration');
    state.specialists.add('platform-owner');
    if (IAM_HINT.test(text)) {
      raise(state, 'high', 'IAM or permission change');
      state.specialists.add('security-owner');
    }
    if (NET_HINT.test(text)) {
      raise(state, 'high', 'network, DNS, certificate or gateway change');
      state.specialists.add('security-owner');
    }
  }
  if (surfaces.destructive_infra) raise(state, 'high', 'plan deletes or replaces resources');
  if (['T3', 'T6', 'T7', 'T9'].includes(slice.treatment)) raise(state, 'high', `treatment ${slice.treatment} changes runtime topology or data ownership`);
  if (config && any(config.protected_paths ?? [])) raise(state, 'high', 'protected paths');

  if (surfaces.data_movement || (slice.kind === 'database' && /backfill|switch_writes|switch_reads|copy|move/i.test(text))) {
    raise(state, 'critical', 'production data movement');
    state.specialists.add('data-owner');
  }
  if (RECOVERY_HINT.test(text) && (slice.kind === 'database' || slice.kind === 'infrastructure')) {
    raise(state, 'critical', 'recovery posture (backup, retention, replication)');
  }
  if (surfaces.tenant_boundary) {
    raise(state, 'critical', 'tenant boundary');
    state.specialists.add('security-owner');
  }
  if (slice.irreversible) raise(state, 'critical', 'irreversible step');
  return { risk: state.risk, reasons: state.reasons, specialists: [...state.specialists].sort() };
}

/** Roles that must approve, and how many distinct people. */
export function requiredApprovals(classification, config) {
  const roles = new Set();
  for (const r of config.approvals[classification.risk] ?? []) {
    if (r === 'specialist-owner') {
      const s = classification.specialists.length ? classification.specialists : ['security-owner'];
      s.forEach((x) => roles.add(x));
    } else roles.add(r);
  }
  if (riskRank(classification.risk) >= riskRank('high')) classification.specialists.forEach((x) => roles.add(x));
  const minApprovers = classification.risk === 'critical' ? Math.max(2, config.approvals.critical_min_approvers ?? 2) : 1;
  return { roles: [...roles].sort(), min_approvers: minApprovers };
}
