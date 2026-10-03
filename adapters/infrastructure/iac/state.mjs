// Recorded state (spec §15.4 level 3) from `terraform state pull` (state format v4).
//
// State is where secrets live: passwords, private keys and tokens sit in plain text in
// `attributes`. So this module keeps only (a) attribute KEY names that are not sensitive,
// (b) a short digest per non-sensitive attribute so drift can be compared without values,
// and (c) the identifiers drift matching needs (id/arn/name). It never returns an attribute
// value except those identifiers, and never for types that are secret-bearing.

import { canonicalJSON, sha256 } from '../../../runtime/core/canonical.mjs';
import { SECRET_KEY_RE } from './analysis.mjs';

/** Types whose `id`/`name` can themselves be secret material. */
const NO_IDENTITY_RE = /^(random_|tls_|aws_secretsmanager_secret_version|aws_iam_access_key|azurerm_key_vault_secret|google_secret_manager_secret_version|vault_)/;

/** Short, stable digest of any JSON value (secret-looking nested keys are blanked first). */
export function valueDigest(value) {
  return sha256(canonicalJSON(redactDeep(value))).slice(0, 16);
}

function redactDeep(v, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redactDeep(x, depth + 1);
    return out;
  }
  return v;
}

/** Strip `module.x[...]` prefixes and instance indexes: the form declared facts use. */
export function shortAddress(address) {
  return String(address).replace(/^(?:module\.[^.\[]+(?:\[[^\]]*\])?\.)+/, '').replace(/\[[^\]]*\]$/, '');
}

function sensitiveTopKeys(list) {
  const out = new Set();
  for (const path of Array.isArray(list) ? list : []) {
    const first = Array.isArray(path) ? path[0] : undefined;
    if (first && typeof first.value === 'string') out.add(first.value);
  }
  return out;
}

const safeId = (v) => (typeof v === 'string' && v.length <= 300 ? v : undefined);

/**
 * Parse state v4 JSON (string or object) into a value-free summary.
 * @returns {{version:number|null, serial:number|null, lineage:string|null, terraform_version:string|null,
 *   outputs:{name:string, sensitive:boolean}[], resources:object[], resource_count:number,
 *   instance_count:number, redacted_attribute_count:number}}
 */
export function parseState(input) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch {
      doc = {};
    }
  }
  doc = doc && typeof doc === 'object' ? doc : {};
  let redactedTotal = 0;
  let instanceTotal = 0;
  const resources = [];
  for (const r of Array.isArray(doc.resources) ? doc.resources : []) {
    if (!r || typeof r !== 'object') continue;
    const mode = r.mode === 'data' ? 'data' : 'managed';
    const type = String(r.type ?? '');
    const name = String(r.name ?? '');
    const base = `${r.module ? `${r.module}.` : ''}${mode === 'data' ? 'data.' : ''}${type}.${name}`;
    const instances = [];
    for (const inst of Array.isArray(r.instances) ? r.instances : []) {
      const attrs = inst?.attributes && typeof inst.attributes === 'object' ? inst.attributes : {};
      const sens = sensitiveTopKeys(inst?.sensitive_attributes);
      const keys = [];
      const digests = {};
      let redacted = 0;
      for (const k of Object.keys(attrs).sort()) {
        if (sens.has(k) || SECRET_KEY_RE.test(k)) {
          redacted++;
          continue;
        }
        keys.push(k);
        digests[k] = valueDigest(attrs[k]);
      }
      const identity = {};
      if (!NO_IDENTITY_RE.test(type)) {
        for (const k of ['id', 'arn', 'name']) {
          if (!sens.has(k) && safeId(attrs[k])) identity[k] = attrs[k];
        }
      }
      const tags = attrs.tags_all ?? attrs.tags ?? attrs.labels;
      const indexKey = inst?.index_key;
      instances.push({
        index_key: indexKey === undefined ? null : indexKey,
        address: indexKey === undefined ? base : `${base}[${typeof indexKey === 'number' ? indexKey : JSON.stringify(indexKey)}]`,
        schema_version: inst?.schema_version ?? null,
        identity,
        attribute_keys: keys,
        attr_digests: digests,
        tags_digest: tags && typeof tags === 'object' && !sens.has('tags') ? valueDigest(tags) : null,
        digest: sha256(canonicalJSON(digests)).slice(0, 16),
        redacted_attributes: redacted,
        dependencies: Array.isArray(inst?.dependencies) ? inst.dependencies.map(String).sort() : [],
      });
      redactedTotal += redacted;
      instanceTotal++;
    }
    resources.push({
      address: base, short: shortAddress(base), mode, type, name, module: r.module ?? null,
      provider: typeof r.provider === 'string' ? r.provider : null, instances,
    });
  }
  const outputs = Object.entries(doc.outputs && typeof doc.outputs === 'object' ? doc.outputs : {})
    .map(([name, o]) => ({ name, sensitive: o?.sensitive === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    version: Number.isInteger(doc.version) ? doc.version : null,
    serial: Number.isInteger(doc.serial) ? doc.serial : null,
    lineage: typeof doc.lineage === 'string' ? doc.lineage : null,
    terraform_version: typeof doc.terraform_version === 'string' ? doc.terraform_version : null,
    outputs,
    resources,
    resource_count: resources.length,
    instance_count: instanceTotal,
    redacted_attribute_count: redactedTotal,
  };
}
