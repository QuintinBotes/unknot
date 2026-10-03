// Backstage catalog-info.yaml (multi-document). Component -> service, API -> endpoint:api:,
// Resource -> resource, Group -> team, User -> owner, System -> namespace. This is declared
// metadata (source_type 'catalog'), so confidence is high, but it can disagree with the code;
// that disagreement is a finding for later stages, not something to resolve here.

import { parseYAML } from '../../runtime/core/yaml.mjs';
import { nodeFact, edgeFact } from '../../runtime/graph/facts.mjs';
import {
  P, isObj, asArray, clean, capFacts, dirname, uniqSorted, emailHash,
} from './util.mjs';

/** `group:default/payments` | `payments` -> {kind, name}. Namespaces are dropped. */
export function parseRef(ref, defaultKind) {
  if (typeof ref !== 'string' || !ref) return null;
  const m = /^(?:([A-Za-z]+):)?(?:([^/\s]+)\/)?([^/\s]+)$/.exec(ref.trim());
  if (!m) return null;
  return { kind: (m[1] ?? defaultKind).toLowerCase(), name: m[3] };
}

const short = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined);

export function parseCatalog(path, text) {
  const docs = parseYAML(text, { multi: true, filename: path }).filter(isObj);
  const codeRoot = dirname(path);
  const nodes = new Map();
  const edges = [];
  const defined = new Set();
  const put = (f, definitive = true) => {
    if (definitive || !nodes.has(f.id)) nodes.set(f.id, f);
    if (definitive) defined.add(f.id);
  };
  const prov = (line = 1) => P(path, line, 'high', 'catalog');
  // An owner ref yields a team (group) or owner (user) node, unless this file defines it fully.
  const ownerTarget = (ref) => {
    const r = parseRef(ref, 'group');
    if (!r) return null;
    const type = r.kind === 'user' ? 'owner' : 'team';
    const id = `${type}:${r.name}`;
    put(nodeFact(type, r.name, { name: r.name, attrs: { from_catalog: true } }, prov()), false);
    return id;
  };

  for (const doc of docs) {
    const kind = doc.kind;
    const meta = isObj(doc.metadata) ? doc.metadata : {};
    const spec = isObj(doc.spec) ? doc.spec : {};
    const name = meta.name;
    if (typeof kind !== 'string' || typeof name !== 'string') continue;
    const base = clean({
      catalog_file: path,
      namespace: meta.namespace,
      description: short(meta.description),
      tags: asArray(meta.tags).sort(),
      lifecycle: spec.lifecycle,
      type: spec.type,
    });
    if (kind === 'Component') {
      const id = `service:${name}`;
      put(nodeFact('service', name, {
        name,
        path: codeRoot === '.' ? null : codeRoot,
        attrs: clean({ ...base, kind, code_root: codeRoot, system: spec.system ? parseRef(spec.system, 'system')?.name : undefined, owner_ref: spec.owner }),
      }, prov()));
      const owner = ownerTarget(spec.owner);
      if (owner) edges.push(edgeFact('OWNED_BY', id, owner, {}, prov()));
      for (const a of asArray(spec.providesApis)) {
        const r = parseRef(a, 'api');
        if (r) edges.push(edgeFact('EXPOSES', id, `endpoint:api:${r.name}`, {}, prov()));
      }
      for (const a of asArray(spec.consumesApis)) {
        const r = parseRef(a, 'api');
        if (r) edges.push(edgeFact('CONSUMES', id, `endpoint:api:${r.name}`, {}, prov()));
      }
      for (const d of asArray(spec.dependsOn)) {
        const r = parseRef(d, 'component');
        if (!r) continue;
        const to = r.kind === 'resource' ? `resource:${r.name}` : r.kind === 'api' ? `endpoint:api:${r.name}` : `service:${r.name}`;
        edges.push(edgeFact('DEPENDS_ON', id, to, { via: 'catalog' }, prov()));
      }
      if (spec.system) {
        const sys = parseRef(spec.system, 'system');
        if (sys) edges.push(edgeFact('CONTAINS', `namespace:system:${sys.name}`, id, {}, prov()));
      }
    } else if (kind === 'API') {
      const id = `endpoint:api:${name}`;
      const def = spec.definition;
      put(nodeFact('endpoint', `api:${name}`, {
        name,
        attrs: clean({ ...base, kind, api_type: spec.type, definition_ref: isObj(def) ? def.$text ?? def.$openapi ?? def.$asyncapi : undefined, owner_ref: spec.owner }),
      }, prov()));
      const owner = ownerTarget(spec.owner);
      if (owner) edges.push(edgeFact('OWNED_BY', id, owner, {}, prov()));
    } else if (kind === 'Resource') {
      const id = `resource:${name}`;
      put(nodeFact('resource', name, { name, attrs: clean({ ...base, kind, owner_ref: spec.owner }) }, prov()));
      const owner = ownerTarget(spec.owner);
      if (owner) edges.push(edgeFact('OWNED_BY', id, owner, {}, prov()));
      for (const d of asArray(spec.dependsOn)) {
        const r = parseRef(d, 'resource');
        if (r) edges.push(edgeFact('DEPENDS_ON', id, r.kind === 'component' ? `service:${r.name}` : `resource:${r.name}`, { via: 'catalog' }, prov()));
      }
    } else if (kind === 'System') {
      const id = `namespace:system:${name}`;
      put(nodeFact('namespace', `system:${name}`, { name, attrs: clean({ ...base, kind: 'System', owner_ref: spec.owner }) }, prov()));
      const owner = ownerTarget(spec.owner);
      if (owner) edges.push(edgeFact('OWNED_BY', id, owner, {}, prov()));
    } else if (kind === 'Group') {
      const profile = isObj(spec.profile) ? spec.profile : {};
      put(nodeFact('team', name, {
        name,
        attrs: clean({
          ...base,
          kind,
          display_name: short(profile.displayName),
          // Group mailboxes are still personal data in some orgs; keep only a hash.
          email_hash: typeof profile.email === 'string' ? emailHash(profile.email) : undefined,
          parent: spec.parent ? parseRef(spec.parent, 'group')?.name : undefined,
          members: asArray(spec.members).map((m) => parseRef(m, 'user')?.name).filter(Boolean).sort(),
        }),
      }, prov()));
    } else if (kind === 'User') {
      const profile = isObj(spec.profile) ? spec.profile : {};
      put(nodeFact('owner', name, {
        name,
        attrs: clean({
          kind: 'user',
          from_catalog: true,
          display_name: short(profile.displayName),
          email_hash: typeof profile.email === 'string' ? emailHash(profile.email) : undefined,
          member_of: asArray(spec.memberOf).map((m) => parseRef(m, 'group')?.name).filter(Boolean).sort(),
        }),
      }, prov()));
    }
  }
  const sortedNodes = [...nodes].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, f]) => f);
  return capFacts([...sortedNodes, ...uniqSorted(edges.map((e) => JSON.stringify(e))).map((s) => JSON.parse(s))]);
}
