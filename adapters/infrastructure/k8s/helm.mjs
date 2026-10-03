// Helm charts: Chart.yaml metadata and values.yaml hygiene. Templates themselves contain
// `{{ }}` and are only analysed after `helm template` renders them (see index.mjs discover).
//
// SECRECY: values are never copied. For values files we record image coordinates (public by
// nature), integer replica counts, and the *paths* of keys that look like literal credentials.

import { nodeFact, edgeFact } from '../../../runtime/graph/facts.mjs';
import { isObj, asArray, asString, provMaker, dirOf, parseDocs, parseImage } from './util.mjs';

const EXACT_VERSION = /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/;
const CRED_KEY = /(password|passwd|token|api_?key|secret_?key|private_?key|access_?key|client_?secret)$/i;

/** @returns {object[]} facts for one Chart.yaml */
export function extractChart(path, text) {
  const [first] = parseDocs(text);
  const doc = first?.doc;
  if (!isObj(doc) || typeof doc.name !== 'string' || !(doc.apiVersion === 'v1' || doc.apiVersion === 'v2')) return [];
  const mk = provMaker(path);
  const dir = dirOf(path);
  const deps = asArray(doc.dependencies).filter(isObj).map((d) => ({
    name: asString(d.name),
    version: asString(d.version),
    repository: asString(d.repository),
    pinned: typeof d.version === 'string' && EXACT_VERSION.test(d.version),
  })).filter((d) => d.name);
  const facts = [nodeFact('build_target', dir, {
    name: doc.name,
    path,
    attrs: {
      tool: 'helm', kind: 'helm_chart', chart_name: doc.name, chart_version: asString(doc.version),
      app_version: asString(doc.appVersion), chart_type: asString(doc.type) ?? 'application',
      dependencies: deps, unpinned_dependencies: deps.filter((d) => !d.pinned).map((d) => d.name).sort(),
    },
  }, mk(1))];
  for (const d of deps) {
    const key = `helm/${d.name}`;
    facts.push(nodeFact('dependency', key, { name: d.name, path, attrs: { ecosystem: 'helm', version: d.version, pinned: d.pinned, repository: d.repository } }, mk(1)));
    facts.push(edgeFact('DEPENDS_ON', `build_target:${dir}`, `dependency:${key}`, { version: d.version, pinned: d.pinned }, mk(1)));
  }
  return facts;
}

/** Walk plain data to a bounded depth, calling `fn(path, mapping)` for every mapping. */
function walk(value, fn, trail = '', depth = 0) {
  if (depth > 6 || !isObj(value)) return;
  fn(trail, value);
  for (const [k, v] of Object.entries(value)) walk(v, fn, trail ? `${trail}.${k}` : k, depth + 1);
}

/** @returns {object[]} facts for a chart values file, or [] when it does not look like one */
export function extractValues(path, text) {
  if (text.includes('{{')) return [];
  const [first] = parseDocs(text);
  const doc = first?.doc;
  if (!isObj(doc)) return [];
  const images = [];
  const replicas = [];
  const withResources = new Set();
  const imageParents = [];
  const credentialKeys = [];
  walk(doc, (trail, obj) => {
    if ('image' in obj) {
      const im = obj.image;
      let ref = null;
      if (typeof im === 'string') ref = parseImage(im);
      else if (isObj(im) && typeof im.repository === 'string') {
        ref = parseImage(`${im.repository}${im.tag != null ? `:${im.tag}` : ''}${im.digest ? `@${im.digest}` : ''}`);
      }
      if (ref) {
        images.push({ path: trail ? `${trail}.image` : 'image', repository: ref.name, tag: ref.tag, pinned: ref.pinned, tag_latest: ref.latest });
        imageParents.push(trail);
      }
    }
    for (const k of ['replicaCount', 'replicas']) if (Number.isInteger(obj[k])) replicas.push({ path: trail ? `${trail}.${k}` : k, value: obj[k] });
    if (isObj(obj.resources) && (isObj(obj.resources.requests) || isObj(obj.resources.limits))) withResources.add(trail);
    for (const [k, v] of Object.entries(obj)) {
      if (CRED_KEY.test(k) && typeof v === 'string' && v !== '') credentialKeys.push(trail ? `${trail}.${k}` : k);
    }
  });
  if (!images.length && !replicas.length && withResources.size === 0) return [];
  const mk = provMaker(path);
  return [nodeFact('resource', path, {
    name: path,
    path,
    attrs: {
      kind: 'HelmValues', dir: dirOf(path),
      images, image_count: images.length,
      images_unpinned: images.filter((i) => !i.pinned).length,
      images_latest: images.filter((i) => i.tag_latest).map((i) => i.path),
      replica_counts: replicas,
      resources_present: [...withResources].sort(),
      images_without_resources: imageParents.filter((p) => !withResources.has(p)).sort(),
      literal_credential_keys: credentialKeys.sort(),
    },
  }, mk(1))];
}
