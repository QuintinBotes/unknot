// Plan normalisation (spec §15.8 steps 5-7): Terraform/OpenTofu `show -json`, CloudFormation
// change sets, Pulumi `preview --json` and Azure what-if all become one shape, so blast
// radius and §15.9 risk are computed once, not per tool.
//
// Plans carry secrets (planned values, sensitive attributes). This module therefore reports
// PATHS and verdicts, never attribute values. The only raw plan content that leaves here is
// the plan hash, which is a digest.

import { canonicalJSON, sha256 } from '../../../runtime/core/canonical.mjs';
import {
  analyzeResourcePolicies, classifyResource, comparePrivilege, ingressSummary, isAdminRole, isPrivilegeResource,
  networkCategory, norm, pick, typeKey,
} from './analysis.mjs';

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const cj = (v) => canonicalJSON(v === undefined ? null : v);
const DESTRUCTIVE = new Set(['delete', 'replace', 'forget']);

/** §15.9 requirements attached to any plan that trips a high-risk reason. */
export const HIGH_RISK_REQUIREMENTS = Object.freeze([
  'two_person_approval_including_resource_owner',
  'saved_plan_bound_to_commit_state_serial_and_environment',
  'dependency_and_recovery_role_evidence',
  'backup_restore_or_recreation_proof',
  'staged_execution_where_possible',
  'abort_thresholds_and_observation_period',
  'post_change_proof_and_signed_audit_event',
]);

// ---------------------------------------------------------------------------------------
// Generic helpers over attribute trees

/** Flatten to `path -> leaf`; single-element arrays collapse so `versioning[0].enabled` is `versioning.enabled`. */
function flatten(value, path = '', out = new Map(), depth = 0) {
  if (depth > 8) return out;
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] && typeof value[0] === 'object') flatten(value[0], path, out, depth + 1);
    else if (value.every((v) => v === null || typeof v !== 'object')) out.set(path, value);
    else value.forEach((v, i) => flatten(v, `${path}[${i}]`, out, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value).sort()) flatten(value[k], path ? `${path}.${k}` : k, out, depth + 1);
  } else if (path) out.set(path, value);
  return out;
}

/** Top-level attribute names whose value differs between before and after. */
function changedKeys(before, after) {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].filter((k) => cj(b[k]) !== cj(a[k])).sort();
}

const NOISE_KEYS = /^(tags|tagsall|labels|description|id|arn|etag|timeouts|lastmodified)$/;

/** Dotted paths in a Terraform `*_unknown` / `*_sensitive` tree whose leaf is exactly true. */
function truePaths(tree, path = '', out = [], depth = 0) {
  if (depth > 12 || out.length >= 100) return out;
  if (tree === true) {
    if (path) out.push(path);
  } else if (Array.isArray(tree)) {
    tree.forEach((t, i) => truePaths(t, `${path}[${i}]`, out, depth + 1));
  } else if (tree && typeof tree === 'object') {
    for (const k of Object.keys(tree).sort()) truePaths(tree[k], path ? `${path}.${k}` : k, out, depth + 1);
  }
  return out;
}

function getPath(value, path) {
  let cur = value;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

// ---------------------------------------------------------------------------------------
// Deltas

const SIZE_KEYS = ['instance_class', 'instance_type', 'allocated_storage', 'node_count', 'memory_size', 'size', 'sku', 'machine_type', 'min_size', 'max_size', 'desired_capacity', 'replicas', 'vm_size', 'disk_size_gb', 'iops'].map(norm);
const BILLABLE = new Set(['compute', 'database', 'load_balancer', 'cluster', 'node_pool', 'volume', 'gateway']);

function costHint(cls, type, action, before, after) {
  if (action === 'noop' || action === 'read') return 'none';
  const billable = BILLABLE.has(cls.node) || /nat_gateway|natgateway|elasticache|kinesis|msk_/.test(typeKey(type));
  if (action === 'create') return billable ? 'increase' : 'neutral';
  if (action === 'delete' || action === 'forget') return billable ? 'decrease' : 'neutral';
  if (action === 'replace') return 'neutral';
  const b = flatten(before);
  const a = flatten(after);
  let dir = 'none';
  for (const [p, av] of a) {
    if (!SIZE_KEYS.includes(norm(p.split('.').pop()))) continue;
    const bv = b.get(p);
    if (cj(av) === cj(bv)) continue;
    if (typeof av === 'number' && typeof bv === 'number') dir = av > bv ? 'increase' : 'decrease';
    else dir = 'changed';
  }
  return dir;
}

const PROTECTIVE_BAD = /(skipfinalsnapshot|forcedestroy)/;
const RECOVERY_RE = /(retention|backup|deletionprotection|multiaz|pointintimerecovery|versioning|replication|replica|skipfinalsnapshot|finalsnapshot|softdelete|forcedestroy|keyrotation|copytagstosnapshot)/;

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.toLowerCase();
    if (['enabled', 'true', 'on', 'yes'].includes(t)) return true;
    if (['disabled', 'suspended', 'false', 'off', 'no'].includes(t)) return false;
  }
  return undefined;
}

function recoveryDelta(type, action, before, after, hintKeys) {
  if (action === 'noop' || action === 'read') return { direction: 'none', attrs: [] };
  const cls = classifyResource(type);
  if (cls.node === 'backup_policy' || cls.node === 'backup_vault' || cls.node === 'snapshot') {
    if (action === 'delete' || action === 'forget') return { direction: 'reduced', attrs: ['(resource)'] };
    if (action === 'create') return { direction: 'increased', attrs: ['(resource)'] };
    if (action === 'replace') return { direction: 'changed', attrs: ['(resource)'] };
  }
  const b = flatten(before);
  const a = flatten(after);
  const paths = new Set([...b.keys(), ...a.keys()]);
  const attrs = [];
  let reduced = false;
  let increased = false;
  let changed = false;
  for (const p of [...paths].sort()) {
    const leaf = norm(p);
    if (!RECOVERY_RE.test(leaf)) continue;
    const bv = b.get(p);
    const av = a.get(p);
    if (cj(bv) === cj(av)) continue;
    attrs.push(p);
    const bad = PROTECTIVE_BAD.test(leaf);
    const bb = asBool(bv);
    const ab = asBool(av);
    if (typeof bv === 'number' && typeof av === 'number') (av < bv ? (reduced = true) : (increased = true));
    else if (bb !== undefined && ab !== undefined) {
      if (bb !== ab) ((ab !== bad) ? (increased = true) : (reduced = true));
    } else if (bv === undefined || bv === null) (bad ? (reduced = true) : (increased = true));
    else if (av === undefined || av === null) (bad ? (increased = true) : (reduced = true));
    else changed = true;
  }
  for (const k of hintKeys ?? []) {
    if (RECOVERY_RE.test(norm(k))) {
      attrs.push(k);
      changed = true;
    }
  }
  if (action === 'delete' && cls.stateful) {
    reduced = true;
    attrs.push('(resource)');
  }
  return { direction: reduced ? 'reduced' : increased ? 'increased' : changed ? 'changed' : 'none', attrs: [...new Set(attrs)].slice(0, 20) };
}

function bindingPrivilege(before, after) {
  const role = (o) => pick(o, 'role', 'role_definition_name', 'role_definition_id', 'roleDefinitionId');
  const members = (o) => new Set([...asArray(pick(o, 'members')), ...asArray(pick(o, 'member')), ...asArray(pick(o, 'principal_id', 'principalId'))].filter((m) => typeof m === 'string'));
  const br = role(before);
  const ar = role(after);
  const bm = members(before);
  const am = members(after);
  const gained = [...am].some((m) => !bm.has(m));
  if (isAdminRole(ar) && !isAdminRole(br)) return 'widened';
  if (isAdminRole(br) && !isAdminRole(ar)) return 'narrowed';
  if (gained) return 'widened';
  if (cj(br) !== cj(ar) || cj(pick(before, 'scope')) !== cj(pick(after, 'scope'))) return 'unknown';
  return [...bm].some((m) => !am.has(m)) ? 'narrowed' : 'none';
}

function privilegeDelta(type, action, before, after, unknownPaths, hints) {
  if (action === 'noop' || action === 'read') return 'none';
  const cls = classifyResource(type);
  const bundled = cls.node === 'firewall_rule' || cls.node === 'bucket' || cls.node === 'key' || cls.node === 'secret_ref';
  const policyBearing = isPrivilegeResource(type) || (!bundled && (analyzeResourcePolicies(before) || analyzeResourcePolicies(after)));
  if (!policyBearing) return 'none';
  const policyUnknown = unknownPaths.some((p) => /policy|role|member|principal|statement/i.test(p));
  if (hints?.opaque) {
    if (action === 'delete' || action === 'forget') return 'narrowed';
    if (action === 'create') return cls.node === 'role' || cls.node === 'identity' ? 'none' : 'widened';
    return hints.privilegeKeys?.length ? 'unknown' : 'none';
  }
  const bp = analyzeResourcePolicies(before);
  const ap = analyzeResourcePolicies(after);
  if (action === 'delete' || action === 'forget') return 'narrowed';
  if (policyUnknown) return 'unknown';
  if (action === 'create') {
    if (ap) return comparePrivilege(null, ap);
    if (cls.node === 'role' || cls.node === 'identity' || cls.node === 'service_account') return 'none';
    return pick(after, 'role', 'role_definition_name', 'role_definition_id', 'policy_arn') !== undefined ? 'widened' : 'unknown';
  }
  // update or replace
  if (bp || ap) return comparePrivilege(bp, ap);
  const keys = changedKeys(before, after).filter((k) => !NOISE_KEYS.test(norm(k)));
  if (!keys.length) return 'none';
  if (pick(after, 'role', 'role_definition_name', 'role_definition_id', 'members', 'member', 'policy_arn') !== undefined) return bindingPrivilege(before, after);
  return 'unknown';
}

function networkDelta(type, action, before, after, unknownPaths, hints) {
  const category = networkCategory(type);
  if (!category || action === 'noop' || action === 'read') return null;
  const unresolved = unknownPaths.some((p) => /cidr|ingress|egress|source|port|protocol|route|record|domain|certificate|destination|address/i.test(p));
  const base = { category, change: 'none', public_ingress_added: false, ports_added: [], public_ports_added: [], wildcard_ports_added: false, unresolved };
  if (hints?.opaque) {
    base.change = action === 'create' ? 'added' : action === 'delete' || action === 'forget' ? 'removed' : (hints.networkKeys?.length ? 'modified' : 'none');
    if (action === 'replace') base.change = 'modified';
    return base;
  }
  const b = ingressSummary(type, before);
  const a = ingressSummary(type, after);
  base.public_ingress_added = a.public_ingress && !b.public_ingress;
  base.ports_added = a.ports.filter((p) => !b.ports.includes(p));
  base.public_ports_added = a.public_ports.filter((p) => !b.public_ports.includes(p));
  base.wildcard_ports_added = a.wildcard_ports && !b.wildcard_ports;
  if (action === 'create') base.change = 'added';
  else if (action === 'delete' || action === 'forget') base.change = 'removed';
  else {
    const keys = changedKeys(before, after).filter((k) => !NOISE_KEYS.test(norm(k)));
    base.change = keys.length || action === 'replace' ? 'modified' : 'none';
  }
  return base;
}

/**
 * Build one normalised change with every delta computed.
 * @param {object} c
 */
function buildChange(c) {
  const { address, type, action } = c;
  const before = c.before ?? null;
  const after = c.after ?? null;
  const unknownPaths = c.unknown_paths ?? [];
  const cls = classifyResource(type);
  const out = {
    address,
    type,
    action,
    replace_reason: c.replace_reason ?? null,
    replace_paths: c.replace_paths ?? [],
    sensitive_changes: c.sensitive_changes ?? [],
    unknown_values: unknownPaths.length,
    destructive: DESTRUCTIVE.has(action),
    stateful: cls.stateful,
    node_type: cls.node,
    privilege_delta: privilegeDelta(type, action, before, after, unknownPaths, c.hints),
    network_delta: networkDelta(type, action, before, after, unknownPaths, c.hints),
    recovery_delta: recoveryDelta(type, action, before, after, c.hints?.recoveryKeys),
    cost_hint: costHint(cls, type, action, before, after),
  };
  const bp = analyzeResourcePolicies(before);
  const ap = analyzeResourcePolicies(after);
  // Newly granted wildcard action or admin: the case a policy gate most wants to name.
  out.wildcard_privilege_added = Boolean(ap && !DESTRUCTIVE.has(action) && ((ap.admin && !bp?.admin)
    || ap.wildcard_actions.some((x) => !(bp?.wildcard_actions ?? []).includes(x))));
  if (c.importing) out.importing = true;
  if (c.moved_from) out.moved_from = c.moved_from;
  if (c.conditional_replacement) out.conditional_replacement = true;
  if (c.hints?.opaque) out.detail_level = 'opaque';
  return out;
}

// ---------------------------------------------------------------------------------------
// Tool front ends

function terraformAction(actions) {
  const a = asArray(actions).map(String);
  const key = a.join(',');
  switch (key) {
    case 'no-op': return 'noop';
    case 'read': return 'read';
    case 'create': return 'create';
    case 'update': return 'update';
    case 'delete': return 'delete';
    case 'forget': return 'forget';
    case 'delete,create':
    case 'create,delete': return 'replace';
    default: return 'unknown';
  }
}

function fromTerraform(json, opts, unknowns) {
  if (!/^1\./.test(String(json.format_version ?? ''))) {
    unknowns.push({ kind: 'format_version', message: `unrecognised plan format_version ${json.format_version ?? '(missing)'}; verdicts may be incomplete` });
  }
  const preventDestroy = new Set(asArray(opts.prevent_destroy));
  const changes = [];
  for (const rc of asArray(json.resource_changes)) {
    const ch = rc.change ?? {};
    const action = terraformAction(ch.actions);
    const before = ch.before ?? null;
    const after = ch.after ?? null;
    const unknownPaths = truePaths(ch.after_unknown);
    const sens = new Set();
    for (const p of [...truePaths(ch.before_sensitive), ...truePaths(ch.after_sensitive)]) {
      const bv = getPath(before, p);
      const av = getPath(after, p);
      if (cj(bv) !== cj(av) || unknownPaths.includes(p)) sens.add(p);
    }
    const c = buildChange({
      address: rc.address, type: rc.type, action, before, after, unknown_paths: unknownPaths,
      replace_reason: rc.action_reason ?? null,
      replace_paths: asArray(ch.replace_paths).map((p) => asArray(p).join('.')),
      sensitive_changes: [...sens].sort(),
      importing: Boolean(ch.importing), moved_from: rc.previous_address,
    });
    if (c.destructive && preventDestroy.has(rc.address)) c.prevent_destroy_overridden = true;
    if (action === 'unknown') unknowns.push({ address: rc.address, kind: 'unknown_action', message: `unrecognised actions ${JSON.stringify(ch.actions)}` });
    if (unknownPaths.length) unknowns.push({ address: rc.address, kind: 'unknown_values', paths: unknownPaths.slice(0, 50) });
    changes.push(c);
  }
  const outputs = Object.entries(json.output_changes ?? {}).map(([name, oc]) => ({
    name, action: terraformAction(oc.actions), sensitive: Boolean(oc.before_sensitive || oc.after_sensitive), unknown: oc.after_unknown === true,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const hashInput = {
    resource_changes: asArray(json.resource_changes).slice().sort((a, b) => `${a.address}|${a.deposed ?? ''}`.localeCompare(`${b.address}|${b.deposed ?? ''}`)),
    output_changes: json.output_changes ?? {},
  };
  return {
    changes, outputs, hashInput,
    serial: json.prior_state?.serial ?? json.serial ?? null,
    extra: { terraform_version: json.terraform_version ?? null, format_version: json.format_version ?? null },
  };
}

function fromCloudFormation(json, opts, unknowns) {
  const changes = [];
  const raw = asArray(json.Changes).filter((c) => c?.ResourceChange);
  for (const { ResourceChange: rc } of raw) {
    const details = asArray(rc.Details);
    const names = [...new Set(details.map((d) => d?.Target?.Name).filter(Boolean))].sort();
    const always = details.filter((d) => d?.Target?.RequiresRecreation === 'Always').map((d) => d.Target.Name);
    const cond = details.filter((d) => d?.Target?.RequiresRecreation === 'Conditionally').map((d) => d.Target.Name);
    let action;
    switch (rc.Action) {
      case 'Add': case 'Import': action = 'create'; break;
      case 'Remove': action = 'delete'; break;
      case 'Modify': action = rc.Replacement === 'True' || rc.Replacement === true ? 'replace' : 'update'; break;
      default: action = 'unknown';
    }
    // "Conditional" means CloudFormation cannot tell until it runs: treat as a replacement.
    const conditional = rc.Action === 'Modify' && rc.Replacement === 'Conditional';
    if (conditional) {
      action = 'replace';
      unknowns.push({ address: rc.LogicalResourceId, kind: 'conditional_replacement', paths: cond });
    }
    if (action === 'unknown') unknowns.push({ address: rc.LogicalResourceId, kind: 'unknown_action', message: `unrecognised Action ${rc.Action}` });
    changes.push(buildChange({
      address: rc.LogicalResourceId, type: rc.ResourceType, action,
      replace_reason: action === 'replace' ? (always.length ? `requires_recreation:${always.join(',')}` : cond.length ? `conditional:${cond.join(',')}` : 'replacement') : null,
      replace_paths: [...always, ...cond],
      conditional_replacement: conditional, importing: rc.Action === 'Import',
      hints: {
        opaque: true, recoveryKeys: names,
        privilegeKeys: names.filter((n) => /policy|role|principal|assume|permission/i.test(n)),
        networkKeys: names.filter((n) => /ingress|egress|cidr|route|record|certificate|port|gateway/i.test(n)),
      },
    }));
  }
  return { changes, outputs: [], hashInput: { Changes: json.Changes ?? [] }, serial: null, extra: { change_set: json.ChangeSetName ?? null, stack: json.StackName ?? null } };
}

const PULUMI_SECRET_SIG = '4dabf18193072939515e22adb298388d';

function pulumiOp(ops) {
  if (ops.some((o) => ['replace', 'create-replacement', 'delete-replaced'].includes(o))) return 'replace';
  if (ops.includes('delete')) return 'delete';
  if (ops.includes('create') || ops.includes('import')) return 'create';
  if (ops.includes('update')) return 'update';
  if (ops.some((o) => ['read', 'refresh'].includes(o))) return 'read';
  if (ops.includes('same')) return 'noop';
  return 'unknown';
}

function fromPulumi(json, opts, unknowns) {
  const steps = asArray(json.steps);
  const byUrn = new Map();
  for (const s of steps) {
    if (!s?.urn) continue;
    (byUrn.get(s.urn) ?? byUrn.set(s.urn, []).get(s.urn)).push(s);
  }
  const changes = [];
  for (const urn of [...byUrn.keys()].sort()) {
    const group = byUrn.get(urn);
    const action = pulumiOp(group.map((s) => s.op));
    const old = group.find((s) => s.oldState)?.oldState;
    const neu = group.find((s) => s.newState)?.newState;
    const parts = urn.split('::');
    const type = neu?.type ?? old?.type ?? parts[parts.length - 2] ?? 'unknown';
    const before = old?.inputs ?? null;
    const after = neu?.inputs ?? null;
    const diffKeys = new Set();
    const replaceKeys = new Set();
    for (const s of group) {
      for (const p of Object.keys(s.detailedDiff ?? {})) diffKeys.add(p.split(/[.[]/)[0]);
      for (const p of asArray(s.diffReasons)) diffKeys.add(String(p).split(/[.[]/)[0]);
      for (const p of asArray(s.replaceKeys)) replaceKeys.add(String(p));
    }
    const sens = [];
    for (const [k, v] of Object.entries(after ?? {})) {
      if (v && typeof v === 'object' && PULUMI_SECRET_SIG in v && (diffKeys.has(k) || cj(v) !== cj(before?.[k]))) sens.push(k);
    }
    if (action === 'unknown') unknowns.push({ address: urn, kind: 'unknown_action', message: `unrecognised ops ${group.map((s) => s.op).join(',')}` });
    changes.push(buildChange({
      address: urn, type, action, before, after, sensitive_changes: sens.sort(),
      replace_reason: action === 'replace' ? (replaceKeys.size ? `replace_keys:${[...replaceKeys].sort().join(',')}` : 'replacement') : null,
      replace_paths: [...replaceKeys].sort(), importing: group.some((s) => s.op === 'import'),
    }));
  }
  return { changes, outputs: [], hashInput: { steps }, serial: null, extra: { change_summary: json.changeSummary ?? null } };
}

/** `/subscriptions/../providers/Microsoft.Sql/servers/s/databases/d` -> `Microsoft.Sql/servers/databases`. */
function azureType(resourceId) {
  const idx = resourceId.toLowerCase().lastIndexOf('/providers/');
  if (idx < 0) return resourceId.split('/').filter(Boolean).slice(-2, -1)[0] ?? 'unknown';
  const parts = resourceId.slice(idx + 11).split('/');
  const ns = parts.shift();
  const types = parts.filter((_, i) => i % 2 === 0);
  return [ns, ...types].join('/');
}

function fromAzure(json, opts, unknowns) {
  const list = asArray(json.changes ?? json.properties?.changes);
  const changes = [];
  for (const c of list) {
    const id = c.resourceId ?? c.resourceID ?? '';
    const type = azureType(id);
    let action;
    switch (String(c.changeType).toLowerCase()) {
      case 'create': action = 'create'; break;
      case 'delete': action = 'delete'; break;
      case 'modify': case 'deploy': action = 'update'; break;
      case 'ignore': case 'nochange': action = 'noop'; break;
      default: action = 'unknown';
    }
    if (String(c.changeType).toLowerCase() === 'deploy') unknowns.push({ address: id, kind: 'deploy_unknown', message: 'what-if cannot evaluate this resource; properties unknown' });
    if (action === 'unknown') unknowns.push({ address: id, kind: 'unknown_action', message: `unrecognised changeType ${c.changeType}` });
    const flat = (o) => (o ? { ...o, ...(o.properties && typeof o.properties === 'object' ? o.properties : {}) } : null);
    const deltaPaths = asArray(c.delta).map((d) => String(d.path ?? '')).filter(Boolean);
    changes.push(buildChange({
      address: id, type, action, before: flat(c.before), after: flat(c.after),
      unknown_paths: [], replace_paths: [], sensitive_changes: [],
      hints: { recoveryKeys: [], deltaPaths },
    }));
  }
  return { changes, outputs: [], hashInput: { changes: list }, serial: null, extra: { status: json.status ?? null } };
}

/** Guess the producing tool from the document shape. */
export function detectTool(json) {
  if (!json || typeof json !== 'object') return 'unknown';
  if (Array.isArray(json.resource_changes) || (json.format_version && (json.planned_values || json.configuration))) return 'terraform';
  if (Array.isArray(json.Changes) || json.ChangeSetName) return 'cloudformation';
  if (Array.isArray(json.steps)) return 'pulumi';
  if (Array.isArray(json.changes ?? json.properties?.changes)) return 'azure';
  return 'unknown';
}

const REASON_RULES = [
  ['destroy_or_replace', (c) => c.destructive],
  ['state_removal', (c) => c.action === 'forget'],
  ['stateful_destruction', (c) => c.destructive && c.stateful],
  ['stateful_replacement', (c) => c.action === 'replace' && c.stateful],
  ['cluster_or_account_removal', (c) => c.destructive && (['cluster', 'node_pool'].includes(c.node_type) || /(organizations_account|google_project$|azurerm_subscription|resourcegroup)/.test(typeKey(c.type)))],
  ['iam_change', (c) => c.privilege_delta !== 'none'],
  ['privilege_widened', (c) => c.privilege_delta === 'widened'],
  ['network_change', (c) => c.network_delta && c.network_delta.change !== 'none'],
  ['public_ingress_added', (c) => c.network_delta?.public_ingress_added === true],
  ['recovery_change', (c) => c.recovery_delta.direction !== 'none'],
  ['recovery_reduced', (c) => c.recovery_delta.direction === 'reduced'],
  ['rekey', (c) => c.node_type === 'key' && ['update', 'replace', 'delete', 'forget'].includes(c.action)],
  ['import_or_move', (c) => c.importing === true || Boolean(c.moved_from)],
  ['unresolved_security_value', (c) => (c.privilege_delta === 'unknown' || c.network_delta?.unresolved === true)],
  ['prevent_destroy_overridden', (c) => c.prevent_destroy_overridden === true],
];

function blastRadius(changes) {
  const active = changes.filter((c) => c.action !== 'noop' && c.action !== 'read');
  const detail = {};
  for (const [code, test] of REASON_RULES) {
    const hit = active.filter(test).map((c) => c.address);
    if (hit.length) detail[code] = hit;
  }
  const reasons = Object.keys(detail).sort();
  return {
    resources: active.length,
    stateful_resources: active.filter((c) => c.stateful).length,
    destructive: active.filter((c) => c.destructive).length,
    high_risk: reasons.length > 0,
    high_risk_reasons: reasons,
    reasons_detail: detail,
  };
}

/**
 * Normalise a plan/preview/change-set document.
 * @param {object} json parsed plan JSON
 * @param {{tool?: string, workspace?: string, environment?: string, state_serial?: number, prevent_destroy?: string[]}} [opts]
 */
export function normalizePlan(json, opts = {}) {
  const tool = (opts.tool ?? detectTool(json)).toLowerCase();
  const unknowns = [];
  let front;
  if (tool === 'terraform' || tool === 'opentofu' || tool === 'tofu') front = fromTerraform(json ?? {}, opts, unknowns);
  else if (tool === 'cloudformation' || tool === 'cfn') front = fromCloudFormation(json ?? {}, opts, unknowns);
  else if (tool === 'pulumi') front = fromPulumi(json ?? {}, opts, unknowns);
  else if (tool === 'azure' || tool === 'bicep' || tool === 'arm') front = fromAzure(json ?? {}, opts, unknowns);
  else {
    front = { changes: [], outputs: [], hashInput: json ?? null, serial: null, extra: {} };
    unknowns.push({ kind: 'unsupported_tool', message: `cannot normalise a plan of kind ${tool}` });
  }
  const changes = front.changes.slice().sort((a, b) => a.address.localeCompare(b.address) || a.action.localeCompare(b.action));
  const actions = { create: 0, update: 0, replace: 0, delete: 0, forget: 0, read: 0, noop: 0, unknown: 0 };
  for (const c of changes) actions[c.action]++;
  return {
    tool: tool === 'tofu' ? 'opentofu' : tool,
    plan_hash: sha256(canonicalJSON(front.hashInput)),
    workspace: opts.workspace ?? null,
    environment: opts.environment ?? null,
    state_serial: opts.state_serial ?? front.serial ?? null,
    ...front.extra,
    actions,
    changes,
    output_changes: front.outputs,
    blast_radius: blastRadius(changes),
    unknowns,
  };
}

/**
 * The `infrastructure-plan-summary.json` body (spec §19.4): everything a reviewer or the
 * approval gate needs, no attribute values.
 */
export function planSummary(normalized) {
  const n = normalized;
  return {
    schema: 'unknot.infrastructure-plan-summary/1',
    tool: n.tool,
    plan_hash: n.plan_hash,
    workspace: n.workspace,
    environment: n.environment,
    state_serial: n.state_serial,
    actions: n.actions,
    blast_radius: {
      resources: n.blast_radius.resources,
      stateful_resources: n.blast_radius.stateful_resources,
      destructive: n.blast_radius.destructive,
      high_risk_reasons: n.blast_radius.high_risk_reasons,
    },
    high_risk: n.blast_radius.high_risk,
    requirements: n.blast_radius.high_risk ? [...HIGH_RISK_REQUIREMENTS] : [],
    binding_complete: n.workspace !== null && n.environment !== null && n.state_serial !== null,
    changes: n.changes.filter((c) => c.action !== 'noop' && c.action !== 'read').map((c) => ({
      address: c.address, type: c.type, action: c.action, replace_reason: c.replace_reason, destructive: c.destructive,
      stateful: c.stateful, privilege_delta: c.privilege_delta, network_change: c.network_delta?.change ?? 'none',
      public_ingress_added: c.network_delta?.public_ingress_added ?? false, recovery_delta: c.recovery_delta.direction,
      cost_hint: c.cost_hint, sensitive_changes: c.sensitive_changes, unknown_values: c.unknown_values,
    })),
    unknowns: n.unknowns.length,
  };
}
