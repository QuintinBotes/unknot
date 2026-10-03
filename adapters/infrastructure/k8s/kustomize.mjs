// Kustomize: static parsing of kustomization.yaml. Always available (no tool needed);
// rendering via `kustomize build` happens separately in discover.
//
// SECRECY: secretGenerator `literals` carry values, so only generator names and the key
// names (left of `=`) are recorded.

import { nodeFact, edgeFact } from '../../../runtime/graph/facts.mjs';
import { isObj, asArray, asString, provMaker, dirOf, resolveRel, parseDocs, parseImage } from './util.mjs';

const YAML_FILE = /\.ya?ml$/i;

const generatorInfo = (g) => ({
  name: asString(g?.name),
  keys: [
    ...asArray(g?.literals).map((l) => String(l).split('=')[0]),
    ...asArray(g?.files).map((f) => String(f).split('=')[0]),
    ...asArray(g?.envs).map((f) => `env:${String(f)}`),
  ].sort(),
});

/** @returns {object[]} facts for one kustomization file */
export function extractKustomization(path, text) {
  const [first] = parseDocs(text);
  const doc = first?.doc;
  if (!isObj(doc)) return [];
  const known = ['resources', 'bases', 'components', 'patches', 'patchesStrategicMerge', 'images', 'namespace', 'configMapGenerator', 'secretGenerator'];
  if (doc.kind !== 'Kustomization' && !known.some((k) => k in doc)) return [];
  const mk = provMaker(path);
  const dir = dirOf(path);
  const files = [];
  const dirs = [];
  const remote = [];
  const entries = [
    ...asArray(doc.resources).map((r) => [r, 'resource']),
    ...asArray(doc.bases).map((r) => [r, 'base']),
    ...asArray(doc.components).map((r) => [r, 'component']),
  ];
  for (const [raw, role] of entries) {
    if (typeof raw !== 'string') continue;
    const rel = resolveRel(dir, raw);
    if (rel === null) {
      // Remote bases are supply-chain inputs; unpinned means no ?ref= (it floats on HEAD).
      if (/^[a-z][a-z0-9+.-]*:\/\/|^git@/i.test(raw)) remote.push({ url: raw.replace(/\/\/[^/@]*@/, '//'), pinned: /[?&]ref=/.test(raw), role });
      continue;
    }
    if (YAML_FILE.test(rel) && role === 'resource') files.push(rel);
    else dirs.push({ dir: rel, role });
  }
  const patchFiles = [
    ...asArray(doc.patchesStrategicMerge).filter((p) => typeof p === 'string' && YAML_FILE.test(p)),
    ...asArray(doc.patches).map((p) => asString(p?.path)).filter(Boolean),
  ].map((p) => resolveRel(dir, p)).filter(Boolean).sort();
  const images = asArray(doc.images).filter(isObj).map((i) => {
    const target = i.newName ?? i.name;
    const ref = parseImage(`${target}${i.newTag != null ? `:${i.newTag}` : ''}${i.digest ? `@${i.digest}` : ''}`);
    return { name: asString(i.name), new_name: asString(i.newName), new_tag: asString(i.newTag), pinned: ref.pinned, tag_latest: ref.latest && i.newTag !== undefined };
  });
  const facts = [nodeFact('build_target', dir, {
    name: dir,
    path,
    attrs: {
      tool: 'kustomize', kind: 'kustomization',
      namespace: asString(doc.namespace),
      name_prefix: asString(doc.namePrefix),
      resource_files: files.sort(),
      resource_dirs: dirs.map((d) => d.dir).sort(),
      remote_resources: remote,
      unpinned_remote: remote.filter((r) => !r.pinned).length,
      patch_files: patchFiles,
      patch_count: asArray(doc.patches).length + asArray(doc.patchesStrategicMerge).length,
      image_overrides: images,
      config_map_generators: asArray(doc.configMapGenerator).map(generatorInfo),
      secret_generators: asArray(doc.secretGenerator).map(generatorInfo),
    },
  }, mk(1))];
  for (const d of dirs) {
    if (d.dir === dir) continue;
    facts.push(edgeFact('DEPENDS_ON', `build_target:${dir}`, `build_target:${d.dir}`, { role: d.role }, mk(1)));
  }
  return facts;
}
