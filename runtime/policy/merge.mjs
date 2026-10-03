// Tighten-only merging (spec §8: "Repository policy may tighten but never weaken
// organization-managed policy"). Each key has one rule; a key without a rule cannot be
// set by a repository at all once the organization sets it.

import { parseDuration } from '../core/clock.mjs';
import { LADDERS, MODES, modeRank } from './defaults.mjs';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge `over` onto `base` (plain override). Used for repo-over-defaults. */
export function overlay(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...(isObj(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? overlay(out[k], v) : v;
  return out;
}

const union = (a = [], b = []) => [...new Set([...a, ...b])];
const intersect = (a, b) => (a == null ? b : b == null ? a : a.filter((x) => b.includes(x)));
const minNum = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
const minDuration = (a, b) => (a == null ? b : b == null ? a : parseDuration(a) <= parseDuration(b) ? a : b);
const stricter = (ladder) => (a, b) => {
  if (a == null) return b;
  if (b == null) return a;
  return ladder.indexOf(a) >= ladder.indexOf(b) ? a : b;
};

/**
 * Apply organization policy `org` to an already-defaulted repository config `repo`.
 * Returns `{ config, adjustments }`, where each adjustment records a repo value that
 * org policy overrode, so `doctor` can show why the effective config differs.
 */
export function applyOrgPolicy(repo, org) {
  if (!org) return { config: repo, adjustments: [] };
  const c = structuredClone(repo);
  const adjustments = [];
  const note = (path, from, to) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) adjustments.push({ path, from, to });
  };
  const set = (path, value) => {
    const keys = path.split('.');
    let cur = c;
    for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
    note(path, cur[keys.at(-1)], value);
    cur[keys.at(-1)] = value;
  };
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

  if (org.max_mode && MODES.includes(org.max_mode) && modeRank(c.mode) > modeRank(org.max_mode)) set('mode', org.max_mode);
  if (org.mode && modeRank(c.mode) > modeRank(org.mode)) set('mode', org.mode);

  if (org.scope?.include?.length) {
    // An empty include means "everything", so a disjoint intersection must become a
    // pattern that matches nothing, never the empty list.
    const both = c.scope.include.length ? intersect(c.scope.include, org.scope.include) : org.scope.include;
    set('scope.include', both.length ? both : ['.unknot-no-scope/__nothing__']);
  }
  for (const key of ['scope.exclude', 'protected_paths', 'generated_paths', 'security.redact_patterns']) {
    const o = get(org, key);
    if (o) set(key, union(get(c, key), o));
  }
  for (const [k, v] of Object.entries(org.limits ?? {})) if (typeof v === 'number') set(`limits.${k}`, minNum(c.limits[k], v));
  if (org.quality?.forbid_new_cycles) set('quality.forbid_new_cycles', true);
  if (org.security?.require_os_sandbox) set('security.require_os_sandbox', true);
  if (org.infrastructure?.require_saved_plan) set('infrastructure.require_saved_plan', true);
  if (org.quality?.max_complexity_increase != null) {
    set('quality.max_complexity_increase', minNum(c.quality.max_complexity_increase, org.quality.max_complexity_increase));
  }
  for (const [path, ladder] of Object.entries(LADDERS)) {
    const o = get(org, path);
    if (o != null) set(path, stricter(ladder)(get(c, path), o));
  }
  for (const risk of ['low', 'medium', 'high', 'critical']) {
    if (org.approvals?.[risk]) set(`approvals.${risk}`, union(c.approvals[risk], org.approvals[risk]));
  }
  if (org.approvals?.critical_min_approvers) {
    set('approvals.critical_min_approvers', Math.max(c.approvals.critical_min_approvers ?? 2, org.approvals.critical_min_approvers));
  }
  if (org.approvals?.expiry) set('approvals.expiry', minDuration(c.approvals.expiry, org.approvals.expiry));
  if (org.approvers) {
    set('approvers', org.approvers_locked ? { ...org.approvers } : { ...c.approvers, ...org.approvers });
  }
  if (org.mcp?.allowed_servers) set('mcp.allowed_servers', intersect(c.mcp.allowed_servers ?? [], org.mcp.allowed_servers));
  if (org.network?.allowed_domains) set('network.allowed_domains', intersect(c.network.allowed_domains, org.network.allowed_domains));
  if (org.telemetry?.enabled === false) set('telemetry.enabled', false);
  for (const k of ['runs', 'cache']) if (org.retention?.[k]) set(`retention.${k}`, minDuration(c.retention[k], org.retention[k]));
  if (org.forbid_executables) set('forbid_executables', union(c.forbid_executables, org.forbid_executables));
  return { config: c, adjustments };
}
