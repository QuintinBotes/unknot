// Shared, tool-neutral infrastructure analysis: what kind of thing a resource type is,
// whether it holds state, and what its IAM policy and ingress rules say. Terraform
// declarations, plan JSON, CloudFormation, Pulumi and Azure all funnel through here so one
// rule is written once. Inputs are "plain" values: JSON, or the HCL value model where
// unresolved references are `{expr: '...'}` leaves.

import { isExpr, parseExpression, unwrapJsonencode } from './hcl.mjs';

/** Attribute names whose values must never be recorded anywhere (secrets live in state and plans). */
export const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|credential|private_?key|access_?key|api_?key|apikey|auth|pem|user_?data|connection_?string|signature|bearer|ssh|master_?user|sas_|custom_?data|cert(ificate)?_?body)/i;

/** Lower-case and drop separators so `source_ranges`, `SourceRanges` and `sourceRanges` meet. */
export function norm(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Case/separator-insensitive property lookup. */
export function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const want = new Set(names.map(norm));
  for (const k of Object.keys(obj)) if (want.has(norm(k))) return obj[k];
  return undefined;
}

/** Normalised type string used for rule matching across dialects. */
export function typeKey(type) {
  return String(type ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// [regex over typeKey(type), graph node type, holds state]. Order matters: first match wins.
const RULES = [
  [/^aws_s3_bucket_policy/, 'policy', false],
  [/^aws_(sqs_queue|sns_topic|kms_key|lambda_function)_policy/, 'policy', false],
  [/^aws_iam_.*(policy|attachment)/, 'policy', false],
  [/^aws_iam_(role|instanceprofile|instance_profile)/, 'role', false],
  [/^aws_iam_(user|group|accesskey|access_key|openid|saml)/, 'identity', false],
  [/^google_.*_iam_/, 'policy', false],
  [/^google_service_account_key/, 'key', false],
  [/^google_service_account/, 'service_account', false],
  [/^azurerm_role_definition|^microsoft_authorization_roledefinitions/, 'role', false],
  [/^azurerm_role_assignment|^microsoft_authorization_roleassignments|^azurerm_policy_/, 'policy', false],
  [/^azurerm_user_assigned_identity|^microsoft_managedidentity/, 'identity', false],
  [/firewall_rule|^microsoft_sql_servers_firewallrules/, 'firewall_rule', false],
  [/^(aws_security_group|aws_ec2_securitygroup|aws_vpc_security_group_(in|e)gress_rule|aws_network_acl|aws_ec2_networkacl|google_compute_firewall|google_compute_.*network_firewall_policy|azurerm_network_security_(rule|group)|microsoft_network_networksecuritygroups)/, 'firewall_rule', false],
  [/^aws_s3_(bucket|bucketv2)(_(bucket|bucketv2))?$|^google_storage_bucket$|^azurerm_storage_(account|container)$|^microsoft_storage_storageaccounts|^aws_s3_bucket_bucket$/, 'bucket', true],
  [/^(aws_db_snapshot|aws_ebs_snapshot|aws_rds_dbsnapshot|google_compute_snapshot|azurerm_snapshot)/, 'snapshot', true],
  [/(parameter_group|parametergroup|subnet_group|subnetgroup|option_group|optiongroup|event_subscription|_configuration$)/, null, false],
  [/^(aws_db_instance|aws_rds_cluster|aws_rds_dbinstance|aws_rds_dbcluster|aws_rds_instance|aws_rds_global_cluster|aws_dynamodb_table|aws_dynamodb_globaltable|aws_elasticache_(cluster|cachecluster|replication_group|replicationgroup)|aws_redshift_cluster|aws_docdb_cluster|aws_neptune_cluster|aws_opensearch_domain|aws_elasticsearch_domain|google_sql_database|google_spanner_instance|google_bigtable_instance|google_firestore_database|azurerm_cosmosdb_account|microsoft_documentdb|microsoft_dbfor|microsoft_sql_servers)/, 'database', true],
  [/^azurerm_.*(sql|postgresql|mysql|mariadb)/, 'database', true],
  [/^(aws_lb|aws_alb|aws_elb|aws_elasticloadbalancingv2_loadbalancer|aws_elasticloadbalancing_loadbalancer)(_(lb|alb|elb|loadbalancer))?$|^google_compute_(global_)?forwarding_rule|^azurerm_(lb|application_gateway)$|^microsoft_network_(loadbalancers|applicationgateways)/, 'load_balancer', false],
  [/^(aws_route53_|aws_route53$|google_dns_|azurerm_(private_)?dns_|microsoft_network_(privatedns|dns)zones)/, 'dns_zone', false],
  [/^(aws_eks_cluster|aws_ecs_cluster|google_container_cluster|azurerm_kubernetes_cluster|microsoft_containerservice_managedclusters)(_cluster)?$/, 'cluster', false],
  [/^(aws_eks_node_group|aws_eks_nodegroup|google_container_node_pool|azurerm_kubernetes_cluster_node_pool)/, 'node_pool', false],
  [/^(aws_lambda_function|aws_serverless_function|google_cloudfunctions2?_function|azurerm_(linux|windows)_function_app|azurerm_function_app)(_function)?$/, 'cloud_function', false],
  [/^(aws_kms_key|google_kms_crypto_key|azurerm_key_vault_key)(_key)?$/, 'key', true],
  [/^(aws_backup_plan|aws_backup_backupplan|azurerm_backup_policy|google_backup_dr_backup_plan)/, 'backup_policy', false],
  [/^(aws_backup_vault|aws_backup_backupvault|azurerm_recovery_services_vault|azurerm_backup_vault|google_backup_dr_backup_vault)/, 'backup_vault', true],
  [/^(aws_secretsmanager_secret|aws_ssm_parameter|google_secret_manager_secret|azurerm_key_vault_secret)/, 'secret_ref', true],
  [/^(aws_ebs_volume|aws_efs_file_system|aws_fsx_\w*file_system|google_compute_(region_)?disk|google_filestore_instance|azurerm_managed_disk|azurerm_storage_share|azurerm_netapp_volume|aws_ec2_volume|microsoft_compute_disks)/, 'volume', true],
  [/^(aws_sqs_queue|aws_kinesis_stream|aws_msk_cluster|google_pubsub_(topic|subscription)|azurerm_servicebus_(queue|topic)|azurerm_eventhub)/, 'queue', true],
  [/^(aws_vpc|aws_ec2_vpc|google_compute_network|azurerm_virtual_network|microsoft_network_virtualnetworks)(_vpc)?$/, 'network', false],
  [/^(aws_subnet|aws_ec2_subnet|google_compute_subnetwork|azurerm_subnet)(_subnet)?$/, 'subnet', false],
  [/^(aws_route_table|aws_route|aws_ec2_route|aws_ec2_routetable|google_compute_route|azurerm_route|azurerm_route_table)(_\w+)?$/, 'net_route', false],
  [/^(aws_(internet|nat|vpn|customer|transit|egress_only_internet)_gateway|aws_ec2_(internetgateway|natgateway|transitgateway)|aws_api_gateway|aws_apigatewayv2|google_compute_(router|vpn_gateway)|azurerm_(nat|virtual_network|vpn)_gateway)/, 'gateway', false],
  [/^(aws_instance|aws_launch_template|aws_ec2_instance|google_compute_instance|azurerm_(linux|windows)_virtual_machine|microsoft_compute_virtualmachines)(_\w+)?$/, 'compute', false],
];

/**
 * Classify a provider resource type (Terraform, CloudFormation, Pulumi or ARM spelling).
 * @param {string} type
 * @returns {{node: string|null, stateful: boolean}}
 */
export function classifyResource(type) {
  const k = typeKey(type);
  for (const [re, node, stateful] of RULES) if (re.test(k)) return { node, stateful };
  return { node: null, stateful: false };
}

/** Network-affecting category for §15.9 "route, firewall, DNS, certificate or gateway change". */
export function networkCategory(type) {
  const k = typeKey(type);
  const { node } = classifyResource(type);
  if (node === 'firewall_rule') return 'firewall';
  if (node === 'net_route') return 'route';
  if (node === 'dns_zone') return 'dns';
  if (node === 'gateway') return 'gateway';
  if (node === 'load_balancer') return 'load_balancer';
  if (node === 'network' || node === 'subnet') return 'topology';
  if (/(acm_certificate|_certificate|_ssl_cert|managed_ssl|_listener_certificate|certificates?$)/.test(k)) return 'certificate';
  if (/(_lb_listener|_listener$|_listener_rule|_target_group|_peering|_endpoint_service|_vpc_endpoint)/.test(k)) return 'listener';
  return null;
}

/** True when the type is an IAM/RBAC resource whose change alters who may do what. */
export function isPrivilegeResource(type) {
  const { node } = classifyResource(type);
  return node === 'role' || node === 'policy' || node === 'identity' || node === 'service_account';
}

/** Raw references to other resources inside an expression string. */
export function refsIn(raw) {
  const out = new Set();
  if (typeof raw !== 'string') return [];
  const re = /\b(data\.)?([a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/g;
  let m;
  while ((m = re.exec(raw))) {
    // A trailing `(` means a function call (`file(...)`), not a reference.
    out.add(`${m[1] ?? ''}${m[2]}.${m[3]}`);
  }
  const mod = /\bmodule\.([A-Za-z_][\w-]*)/g;
  while ((m = mod.exec(raw))) out.add(`module.${m[1]}`);
  return [...out].sort();
}

/** Collect every reference found in expression leaves anywhere inside a value. */
export function collectRefs(value, acc = new Set(), depth = 0) {
  if (depth > 32 || value === null || value === undefined) return acc;
  if (isExpr(value)) {
    for (const r of refsIn(value.expr)) acc.add(r);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, acc, depth + 1);
  } else if (typeof value === 'object') {
    for (const v of Object.values(value)) collectRefs(v, acc, depth + 1);
  }
  return acc;
}

/** True when a value contains an unresolved expression anywhere. */
export function hasExpr(value, depth = 0) {
  if (depth > 32 || value === null || typeof value !== 'object') return false;
  if (isExpr(value)) return true;
  return (Array.isArray(value) ? value : Object.values(value)).some((v) => hasExpr(v, depth + 1));
}

// ---------------------------------------------------------------------------------------
// IAM

const ADMIN_ROLES = new Set([
  'roles/owner', 'roles/editor', 'owner', 'contributor', 'user access administrator',
  '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', 'b24988ac-6180-42a0-ab88-20f7382dd24c', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9',
]);

/** GCP/Azure built-in roles that amount to administrator. */
export function isAdminRole(role) {
  if (typeof role !== 'string') return false;
  const r = role.toLowerCase();
  return ADMIN_ROLES.has(r) || [...ADMIN_ROLES].some((a) => a.includes('-') && r.endsWith(a));
}

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Turn whatever carries a policy (a JSON string, a heredoc with template holes, an HCL
 * `jsonencode(...)` expression, or an already-parsed object) into a plain document.
 * @returns {any|null} null when it is not recognisably a policy document.
 */
export function policyFromValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t.startsWith('{')) return null;
    try {
      return JSON.parse(t);
    } catch {
      try {
        // Template holes inside a JSON heredoc: keep the document shape, lose the value.
        return JSON.parse(t.replace(/\$\{[^}]*\}/g, '__template__'));
      } catch {
        return null;
      }
    }
  }
  if (isExpr(v)) {
    const inner = unwrapJsonencode(v);
    return inner && typeof inner === 'object' && !isExpr(inner) ? inner : null;
  }
  if (typeof v === 'object') return v;
  return null;
}

/** Reduce a principal (any case, string or typed map) to `Type:value` strings. */
function principalStrings(p) {
  if (p === undefined || p === null) return [];
  if (typeof p === 'string') return [p];
  if (isExpr(p)) return [`expr:${p.expr}`];
  const out = [];
  for (const [type, ids] of Object.entries(p)) {
    for (const id of asArray(ids)) out.push(id !== null && typeof id === 'object' ? `${type}:ref` : type === '*' ? '*' : `${type}:${id}`);
  }
  return out;
}

/**
 * Summarise an IAM policy document (AWS JSON, any key case).
 * @param {any} doc
 * @returns {{statements:number, actions:string[], wildcard_actions:string[], wildcard_resources:boolean,
 *   admin:boolean, principals:string[], public_principal:boolean, resource_refs:string[],
 *   literal:boolean}|null}
 */
export function analyzePolicyDocument(doc) {
  const d = policyFromValue(doc);
  if (!d || typeof d !== 'object') return null;
  const statements = asArray(pick(d, 'Statement'));
  if (!statements.length) return null;
  const actions = new Set();
  const wildcards = new Set();
  const principals = new Set();
  const refs = new Set();
  let wildcardResources = false;
  let admin = false;
  let publicPrincipal = false;
  for (const st of statements) {
    if (!st || typeof st !== 'object') continue;
    const effect = String(pick(st, 'Effect') ?? 'Allow').toLowerCase();
    const acts = asArray(pick(st, 'Action')).filter((a) => typeof a === 'string');
    const notActions = asArray(pick(st, 'NotAction'));
    const res = asArray(pick(st, 'Resource'));
    const notRes = asArray(pick(st, 'NotResource'));
    for (const p of principalStrings(pick(st, 'Principal'))) {
      principals.add(p);
      if (p === '*' || p === 'AWS:*') publicPrincipal = true;
    }
    for (const r of res) for (const ref of collectRefs(r)) refs.add(ref);
    if (effect !== 'allow') continue;
    for (const a of acts) {
      actions.add(a);
      if (a.includes('*')) wildcards.add(a);
    }
    // Allow + NotAction is "everything except", which is a wildcard by another name.
    if (notActions.length) wildcards.add('NotAction');
    const allRes = res.some((r) => r === '*') || notRes.length > 0;
    if (allRes) wildcardResources = true;
    if (acts.includes('*') && allRes) admin = true;
    if (notActions.length && allRes) admin = true;
  }
  return {
    statements: statements.length,
    actions: [...actions].sort().slice(0, 100),
    wildcard_actions: [...wildcards].sort(),
    wildcard_resources: wildcardResources,
    admin,
    principals: [...principals].sort(),
    public_principal: publicPrincipal,
    resource_refs: [...refs].sort(),
    literal: !hasExpr(d),
  };
}

/** Build a policy document from `aws_iam_policy_document` statement blocks (plain form). */
export function policyFromStatementBlocks(statements) {
  return {
    Statement: asArray(statements).map((s) => ({
      Effect: s.effect ?? 'Allow',
      Action: s.actions,
      NotAction: s.not_actions,
      Resource: s.resources,
      NotResource: s.not_resources,
      Principal: s.principals
        ? Object.fromEntries(asArray(s.principals).map((p) => [Array.isArray(p.type) ? p.type[0] : p.type, p.identifiers]))
        : undefined,
    })),
  };
}

/**
 * Find policy documents among a resource's attributes and summarise them together.
 * Looks at the attributes that carry policies in every dialect.
 */
export function analyzeResourcePolicies(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  const docs = [];
  const trust = [];
  for (const [k, v] of Object.entries(attrs)) {
    const nk = norm(k);
    if (nk === 'assumerolepolicy' || nk === 'assumerolepolicydocument') trust.push(v);
    else if (/policy(document)?$|^policies$|^inlinepolicy$|^policydocument$/.test(nk) && nk !== 'policyarn') {
      for (const item of nk === 'policies' || nk === 'inlinepolicy' ? asArray(v) : [v]) {
        docs.push(nk === 'policies' || nk === 'inlinepolicy' ? pick(item, 'PolicyDocument', 'policy') ?? item : item);
      }
    }
  }
  const parts = docs.map(analyzePolicyDocument).filter(Boolean);
  const trusts = trust.map(analyzePolicyDocument).filter(Boolean);
  if (!parts.length && !trusts.length) return null;
  const merged = {
    statements: 0, actions: [], wildcard_actions: [], wildcard_resources: false, admin: false,
    principals: [], public_principal: false, resource_refs: [], literal: true,
  };
  for (const p of parts) {
    merged.statements += p.statements;
    merged.actions.push(...p.actions);
    merged.wildcard_actions.push(...p.wildcard_actions);
    merged.wildcard_resources ||= p.wildcard_resources;
    merged.admin ||= p.admin;
    merged.principals.push(...p.principals);
    merged.public_principal ||= p.public_principal;
    merged.resource_refs.push(...p.resource_refs);
    merged.literal &&= p.literal;
  }
  for (const t of trusts) {
    merged.principals.push(...t.principals);
    merged.public_principal ||= t.public_principal;
    merged.literal &&= t.literal;
  }
  for (const k of ['actions', 'wildcard_actions', 'principals', 'resource_refs']) merged[k] = [...new Set(merged[k])].sort();
  return merged;
}

/**
 * Compare two summaries (before/after) as a privilege delta.
 * @returns {'widened'|'narrowed'|'none'|'unknown'}
 */
export function comparePrivilege(before, after) {
  if (!before && !after) return 'none';
  if (!before) return after.statements || after.principals.length ? 'widened' : 'none';
  if (!after) return 'narrowed';
  // An action is only "gained" if no pattern the other side already held covers it
  // (`*` and `s3:*` cover `s3:GetObject`); otherwise narrowing an admin policy reads as widening.
  const covered = (patterns, action) => patterns.some((p) => p === action || (p.includes('*') && new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(action)));
  const added = (a, b) => b.filter((x) => !a.includes(x));
  const gainedActions = after.actions.filter((x) => !covered(before.actions, x)).length;
  const lostActions = before.actions.filter((x) => !covered(after.actions, x)).length;
  const gainedWild = added(before.wildcard_actions, after.wildcard_actions).length;
  const gainedPrincipals = added(before.principals, after.principals).length;
  const lostPrincipals = added(after.principals, before.principals).length;
  const widened = gainedActions || gainedWild || gainedPrincipals
    || (after.wildcard_resources && !before.wildcard_resources) || (after.admin && !before.admin)
    || (after.public_principal && !before.public_principal);
  if (widened) return 'widened';
  if (lostActions || lostPrincipals || (before.wildcard_resources && !after.wildcard_resources) || (before.admin && !after.admin)) return 'narrowed';
  return 'none';
}

// ---------------------------------------------------------------------------------------
// Network ingress

const CIDR_KEYS = ['cidr_blocks', 'ipv6_cidr_blocks', 'cidr_ip', 'cidr_ipv4', 'cidr_ipv6', 'cidr', 'source_ranges', 'source_address_prefix', 'source_address_prefixes', 'source_cidr', 'CidrIp', 'CidrIpv6'];

/** True for an address/range that means "the whole internet". */
export function isPublicCidr(c) {
  if (typeof c !== 'string') return false;
  const v = c.trim().toLowerCase();
  return v === '0.0.0.0/0' || v === '::/0' || v === '*' || v === 'internet' || v === 'any' || v === '0.0.0.0';
}

function portText(from, to) {
  const f = from === undefined || from === null ? undefined : Number(from);
  const t = to === undefined || to === null ? f : Number(to);
  if (Number.isNaN(f) || f === undefined) return { text: null, wildcard: false };
  if (f === -1 || (f === 0 && (t === 65535 || t === 0)) || t === -1) return { text: '0-65535', wildcard: true };
  return { text: f === t ? String(f) : `${f}-${t}`, wildcard: f === 0 && t === 65535 };
}

function portRangeStrings(v) {
  const out = [];
  for (const p of asArray(v)) {
    if (p === '*' || p === 'any') out.push('0-65535');
    else if (typeof p === 'string' || typeof p === 'number') out.push(String(p));
  }
  return out;
}

/** One rule object (AWS `ingress` block / CFN SecurityGroupIngress entry / standalone rule). */
function awsStyleRule(o) {
  const cidrs = [];
  for (const k of CIDR_KEYS) for (const c of asArray(pick(o, k))) if (typeof c === 'string') cidrs.push(c);
  const proto = pick(o, 'protocol', 'ip_protocol', 'IpProtocol');
  const allProto = proto === '-1' || proto === -1 || proto === 'all';
  const { text, wildcard } = allProto ? { text: '0-65535', wildcard: true } : portText(pick(o, 'from_port', 'FromPort'), pick(o, 'to_port', 'ToPort'));
  return { cidrs, ports: text ? [text] : [], wildcard_ports: wildcard, protocol: proto === undefined ? null : String(proto) };
}

/**
 * Ingress analysis for one firewall resource.
 * @param {string} type resource type in any dialect
 * @param {Record<string, any>} attrs plain attributes
 * @returns {{public_ingress:boolean, ports:string[], wildcard_ports:boolean, cidrs:string[], rule_count:number}}
 */
export function ingressSummary(type, attrs) {
  const k = typeKey(type);
  const rules = [];
  const a = attrs ?? {};
  if (/^google_compute_firewall|^google_compute_.*firewall_policy_rule/.test(k)) {
    const dir = String(pick(a, 'direction') ?? 'INGRESS').toUpperCase();
    if (dir === 'INGRESS') {
      const cidrs = asArray(pick(a, 'source_ranges')).filter((c) => typeof c === 'string');
      for (const al of asArray(pick(a, 'allow'))) {
        const ports = portRangeStrings(pick(al, 'ports'));
        const proto = pick(al, 'protocol');
        const wildcard = !ports.length || ports.includes('0-65535') || proto === 'all';
        rules.push({ cidrs, ports: wildcard ? ['0-65535'] : ports, wildcard_ports: wildcard, protocol: String(proto ?? '') });
      }
    }
  } else if (/^azurerm_network_security_rule|networksecuritygroups|securityrules/.test(k) || pick(a, 'source_address_prefix', 'sourceAddressPrefix') !== undefined) {
    const nsgRules = pick(a, 'security_rule', 'securityRules');
    const list = nsgRules ? asArray(nsgRules) : [a];
    for (const r of list) {
      const flat = pick(r, 'properties') && typeof pick(r, 'properties') === 'object' ? { ...r, ...pick(r, 'properties') } : r;
      if (String(pick(flat, 'direction') ?? 'Inbound').toLowerCase() !== 'inbound') continue;
      if (String(pick(flat, 'access') ?? 'Allow').toLowerCase() !== 'allow') continue;
      const cidrs = [...asArray(pick(flat, 'source_address_prefix')), ...asArray(pick(flat, 'source_address_prefixes'))].filter((c) => typeof c === 'string');
      const ports = [...portRangeStrings(pick(flat, 'destination_port_range')), ...portRangeStrings(pick(flat, 'destination_port_ranges'))];
      const wildcard = ports.includes('0-65535');
      rules.push({ cidrs, ports, wildcard_ports: wildcard, protocol: String(pick(flat, 'protocol') ?? '') });
    }
  } else {
    // AWS-shaped: embedded ingress list, CFN SecurityGroupIngress, or a standalone rule.
    const embedded = pick(a, 'ingress', 'SecurityGroupIngress');
    if (embedded !== undefined) {
      for (const r of asArray(embedded)) if (r && typeof r === 'object') rules.push(awsStyleRule(r));
    } else if (/ingress/.test(k) || String(pick(a, 'type') ?? '').toLowerCase() === 'ingress') {
      rules.push(awsStyleRule(a));
    }
  }
  const cidrSet = new Set();
  const ports = new Set();
  const publicPorts = new Set();
  let wildcard = false;
  let isPublic = false;
  for (const r of rules) {
    for (const c of r.cidrs) cidrSet.add(c);
    for (const p of r.ports) ports.add(p);
    wildcard ||= r.wildcard_ports;
    if (r.cidrs.some(isPublicCidr)) {
      isPublic = true;
      for (const p of r.ports) publicPorts.add(p);
    }
  }
  const byPort = (x, y) => parseInt(x, 10) - parseInt(y, 10) || x.localeCompare(y);
  return {
    public_ingress: isPublic,
    ports: [...ports].sort(byPort),
    public_ports: [...publicPorts].sort(byPort),
    wildcard_ports: wildcard,
    cidrs: [...cidrSet].sort(),
    rule_count: rules.length,
  };
}

// ---------------------------------------------------------------------------------------
// Safe attribute capture

// Attributes worth recording when they are plain literals: they decide exposure, durability
// and recovery, and none of them is a secret.
const KEEP = new Set([
  'acl', 'region', 'engine', 'engine_version', 'instance_class', 'allocated_storage', 'storage_type', 'multi_az',
  'publicly_accessible', 'storage_encrypted', 'encrypted', 'deletion_protection', 'skip_final_snapshot',
  'backup_retention_period', 'versioning', 'force_destroy', 'protocol', 'from_port', 'to_port', 'direction',
  'cidr_blocks', 'ipv6_cidr_blocks', 'source_ranges', 'description', 'runtime', 'handler', 'memory_size', 'timeout',
  'retention_in_days', 'message_retention_seconds', 'enable_key_rotation', 'location', 'public_access_prevention',
  'uniform_bucket_level_access', 'allow_blob_public_access', 'min_tls_version', 'enable_https_traffic_only',
  'point_in_time_recovery', 'delete_retention_days', 'ip_protocol', 'cidr_ipv4', 'cidr_ipv6', 'access', 'priority',
  'source_address_prefix', 'destination_port_range', 'destination_port_ranges', 'role', 'role_definition_name', 'scope',
  'member', 'members', 'public_network_access', 'minimum_tls_version', 'supports_https_traffic_only', 'soft_delete_enabled', 'cluster_version', 'kubernetes_version', 'node_count', 'min_size', 'max_size', 'desired_capacity',
]);

const KEEP_NORM = new Set([...KEEP].map(norm));

/**
 * Literal attributes from the allow-list, never those whose names look secret.
 * @param {Record<string, any>} plain
 */
export function safeAttrs(plain) {
  const out = {};
  for (const [k, v] of Object.entries(plain ?? {})) {
    if (!KEEP_NORM.has(norm(k)) || SECRET_KEY_RE.test(k)) continue;
    if (isExpr(v) || hasExpr(v)) continue;
    // snake_case the key so CloudFormation/Pulumi/ARM spellings query like Terraform's.
    const sk = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[sk] = typeof v === 'string' ? v.slice(0, 200) : v;
    else if (Array.isArray(v) && v.length <= 20 && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) out[sk] = v;
  }
  return out;
}

/** Make the `{expr}` model printable for evidence strings. */
export function exprText(v) {
  return isExpr(v) ? v.expr : String(v);
}

export { parseExpression };
