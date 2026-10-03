// Drift across the §15.4 hierarchy: declared (source) vs recorded (state) vs actual
// (read-only inventory). Drift is a finding, never an instruction: items describe a
// disagreement and carry digests and identifiers as evidence, nothing here recommends
// overwriting one side or the other, and no values from state or inventory are repeated.

import { valueDigest, parseState } from './state.mjs';

const MANUAL_RE = /(console|manual|portal|cli|user|human|clickops)/i;

/**
 * @typedef {{kind: 'unmanaged'|'missing'|'orphaned_in_state'|'attribute_drift'|'manual_change',
 *   address?: string, id?: string, type?: string, evidence: object, finding_input: true}} DriftItem
 */

function declaredEntries(declared) {
  const out = new Map();
  for (const f of Array.isArray(declared) ? declared : []) {
    if (f?.kind !== 'node' || f.type !== 'resource' || !f.attrs || f.attrs.data || !f.attrs.address) continue;
    if (!out.has(f.attrs.address)) {
      out.set(f.attrs.address, { short: f.attrs.address, node: f.id, conditional: Boolean(f.attrs.count || f.attrs.for_each), type: f.attrs.type });
    }
  }
  return out;
}

/**
 * Compare declared, recorded and actual state.
 * @param {{declared?: object[], recorded?: object|string, actual?: {provider?: string, resources: object[]}|null}} input
 * @returns {DriftItem[]}
 */
export function detectDrift({ declared, recorded, actual } = {}) {
  const items = [];
  const decl = declaredEntries(declared);
  const rec = recorded ? (typeof recorded === 'object' && recorded.resource_count !== undefined ? recorded : parseState(recorded)) : null;
  const managed = (rec?.resources ?? []).filter((r) => r.mode === 'managed');

  if (rec && decl.size) {
    const recShorts = new Set(managed.map((r) => r.short));
    for (const [short, d] of [...decl].sort(([a], [b]) => a.localeCompare(b))) {
      if (recShorts.has(short)) continue;
      items.push({
        kind: 'missing', address: short, type: d.type,
        evidence: { declared_in: d.node, recorded: false, conditional: d.conditional, note: 'declared in source but absent from recorded state' },
        finding_input: true,
      });
    }
    const seen = new Set();
    for (const r of managed) {
      if (decl.has(r.short) || seen.has(r.short)) continue;
      seen.add(r.short);
      items.push({
        kind: 'orphaned_in_state', address: r.address, type: r.type,
        evidence: { recorded: true, declared: false, instances: r.instances.length, state_serial: rec.serial, note: 'present in recorded state but not declared in source' },
        finding_input: true,
      });
    }
  }

  if (actual && Array.isArray(actual.resources)) {
    const ids = new Map();
    const names = new Map();
    for (const r of managed) {
      for (const inst of r.instances) {
        for (const k of ['id', 'arn']) if (inst.identity[k]) ids.set(inst.identity[k], { r, inst });
        if (inst.identity.name) names.set(`${r.type}|${inst.identity.name}`, { r, inst });
      }
    }
    for (const a of actual.resources) {
      if (!a || typeof a !== 'object') continue;
      const hit = (a.id !== undefined && ids.get(String(a.id))) || (a.name !== undefined && names.get(`${a.type}|${a.name}`)) || null;
      if (!hit) {
        items.push({
          kind: 'unmanaged', id: a.id !== undefined ? String(a.id) : undefined, type: a.type,
          evidence: {
            provider: actual.provider ?? null, name: a.name ?? null, region: a.region ?? null,
            tag_keys: a.tags && typeof a.tags === 'object' ? Object.keys(a.tags).sort() : [],
            note: 'exists in the actual inventory but is not in recorded state',
          },
          finding_input: true,
        });
        continue;
      }
      const { r, inst } = hit;
      const differing = [];
      const evidence = { recorded_digests: {}, actual_digests: {} };
      if (inst.tags_digest && a.tags && typeof a.tags === 'object') {
        const ad = valueDigest(a.tags);
        if (ad !== inst.tags_digest) {
          differing.push('tags');
          evidence.recorded_digests.tags = inst.tags_digest;
          evidence.actual_digests.tags = ad;
        }
      }
      if (a.region !== undefined && inst.attr_digests.region && valueDigest(a.region) !== inst.attr_digests.region) {
        differing.push('region');
        evidence.recorded_digests.region = inst.attr_digests.region;
        evidence.actual_digests.region = valueDigest(a.region);
      }
      if (a.attributes && typeof a.attributes === 'object') {
        for (const [k, v] of Object.entries(a.attributes)) {
          if (!inst.attr_digests[k]) continue;
          const ad = valueDigest(v);
          if (ad !== inst.attr_digests[k]) {
            differing.push(k);
            evidence.recorded_digests[k] = inst.attr_digests[k];
            evidence.actual_digests[k] = ad;
          }
        }
      }
      if (differing.length) {
        items.push({
          kind: 'attribute_drift', address: inst.address, id: a.id !== undefined ? String(a.id) : undefined, type: r.type,
          evidence: { attributes: differing.sort(), ...evidence },
          finding_input: true,
        });
      }
      const via = a.change_source ?? a.modified_via ?? a.last_modified_by;
      if (a.manual === true || (typeof via === 'string' && MANUAL_RE.test(via))) {
        items.push({
          kind: 'manual_change', address: inst.address, id: a.id !== undefined ? String(a.id) : undefined, type: r.type,
          evidence: { source: typeof via === 'string' ? via.slice(0, 80) : 'flagged', note: 'inventory reports a change made outside the delivery pipeline' },
          finding_input: true,
        });
      }
    }
  }
  const order = ['unmanaged', 'missing', 'orphaned_in_state', 'attribute_drift', 'manual_change'];
  return items.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind)
    || String(x.address ?? x.id ?? '').localeCompare(String(y.address ?? y.id ?? '')));
}
