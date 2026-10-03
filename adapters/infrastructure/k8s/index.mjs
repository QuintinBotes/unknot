// Kubernetes, Helm, Kustomize, container and config-management adapter (spec §15).
//
// Per-file `extract` is pure and needs no tools. `link` resolves selectors, backends,
// bindings and policies across files. `discover` renders Helm charts and Kustomize
// overlays through the broker (`ctx.exec`, no shell) and feeds the output through the same
// manifest extractor; when a renderer is missing the gap is recorded as a node, never
// skipped silently. No network, no cluster access.

import { posix } from 'node:path';
import { nodeFact, edgeFact } from '../../../runtime/graph/facts.mjs';
import { ID, VERSION, capFacts, provMaker, parseImage, imageBase, parseDocs, isObj } from './util.mjs';
import { extractManifests, resolveManifests } from './manifests.mjs';
import { extractChart, extractValues } from './helm.mjs';
import { extractKustomization } from './kustomize.mjs';
import { extractDockerfile, extractCompose } from './docker.mjs';
import { extractAnsible, extractPuppet, extractChef, extractSalt, isAnsiblePath } from './config_mgmt.mjs';

const DOCKERFILE = /(^|\/)Dockerfile[^/]*$|\.dockerfile$/i;
const COMPOSE = /^(docker-)?compose.*\.ya?ml$/;
const KUSTOMIZATION = /^kustomization\.ya?ml$/;
const VALUES = /^values.*\.ya?ml$/;
const YAML_EXT = /\.ya?ml$/;
const RENDER_TIMEOUT_MS = 120000;

/** Reduce exec output to text; tolerate a bare string or a `{stdout}` result. */
const outputText = (r) => (typeof r === 'string' ? r : typeof r?.stdout === 'string' ? r.stdout : '');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Per-file extraction. Dispatch is by file name so every handler stays pure and cheap.
 * @param {{path: string, kind?: string}} file
 * @param {string} text
 */
export function extract(file, text) {
  const path = file.path;
  if (file.kind === 'binary') return [];
  const base = posix.basename(path);
  let facts = [];
  if (DOCKERFILE.test(path)) facts = extractDockerfile(path, text);
  else if (COMPOSE.test(base)) facts = extractCompose(path, text);
  else if (base === 'Chart.yaml') facts = extractChart(path, text);
  else if (KUSTOMIZATION.test(base)) facts = extractKustomization(path, text);
  else if (/\.pp$/.test(base)) facts = extractPuppet(path, text);
  else if (/(^|\/)recipes\/[^/]+\.rb$/.test(path)) facts = extractChef(path, text);
  else if (/\.sls$/.test(base)) facts = extractSalt(path, text);
  else if (YAML_EXT.test(base)) {
    if (isAnsiblePath(path)) facts = extractAnsible(path, text);
    else if (VALUES.test(base)) facts = [...extractValues(path, text), ...extractManifests(path, text)];
    else facts = extractManifests(path, text);
  }
  return capFacts(facts);
}

const nodeKey = (n) => n.id.slice(n.type.length + 1);

/**
 * Files covered by a kustomization that sets `namespace`, following resource directories.
 * Returns path -> namespace so un-namespaced manifests can be resolved correctly.
 */
function kustomizeNamespaces(nodes) {
  const ks = new Map(nodes.filter((n) => n.type === 'build_target' && n.attrs.kind === 'kustomization').map((n) => [nodeKey(n), n]));
  const covered = new Map();
  for (const k of [...ks.values()].filter((n) => n.attrs.namespace).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const seen = new Set();
    const stack = [k];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      for (const f of cur.attrs.resource_files ?? []) if (!covered.has(f)) covered.set(f, k.attrs.namespace);
      for (const d of cur.attrs.resource_dirs ?? []) if (ks.has(d)) stack.push(ks.get(d));
    }
  }
  return covered;
}

/**
 * Cross-file linking from cached per-file facts.
 * @param {{factsByFile: Map<string, object[]>}} ctx
 */
export function link(ctx) {
  const nodes = [];
  for (const path of [...ctx.factsByFile.keys()].sort()) {
    for (const f of ctx.factsByFile.get(path)) if (f.kind === 'node') nodes.push(f);
  }
  const out = [];
  const covered = kustomizeNamespaces(nodes);
  const resolved = nodes.map((n) => {
    const ns = n.attrs.ns_explicit === false && !n.attrs.rendered_from ? covered.get(n.path) : undefined;
    if (!ns) return n;
    out.push(nodeFact(n.type, nodeKey(n), { name: n.name, path: n.path, attrs: { effective_namespace: ns } }, n.provenance));
    return { ...n, attrs: { ...n.attrs, effective_namespace: ns } };
  });
  out.push(...resolveManifests(resolved));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mkFor = (n, extra) => ({ ...n.provenance, ...extra });

  // Helm values belong to the chart in the same directory.
  for (const v of nodes.filter((n) => n.type === 'resource' && n.attrs.kind === 'HelmValues')) {
    const chart = byId.get(`build_target:${v.attrs.dir}`);
    if (chart?.attrs.kind === 'helm_chart') out.push(edgeFact('CONTAINS', chart.id, v.id, {}, mkFor(v)));
  }

  // Ansible roles used by a play resolve to the role's tasks file when it is in the repo.
  const modules = nodes.filter((n) => n.type === 'iac_module' && n.attrs.tool === 'ansible');
  for (const m of modules) {
    for (const r of m.attrs.roles ?? []) {
      const target = modules.find((c) => c.id !== m.id && c.attrs.role_file && new RegExp(`(^|/)roles/${r.replace(/[^\w.-]/g, '')}/tasks/main\\.ya?ml$`).test(c.path));
      if (target) out.push(edgeFact('DEPENDS_ON', m.id, target.id, { via: 'role', role: r }, mkFor(m)));
    }
  }

  // A locally built image (Compose build + image tag) that a workload runs: medium
  // confidence because the match is by image name only.
  const workloads = resolved.filter((n) => n.type === 'workload');
  for (const svc of nodes.filter((n) => n.type === 'service' && n.attrs.deployable && n.attrs.built_image && n.attrs.image)) {
    if (!byId.has(svc.attrs.built_image)) continue;
    const local = parseImage(svc.attrs.image);
    for (const w of workloads) {
      const hit = (w.attrs.containers ?? []).some((c) => {
        const ref = parseImage(c.image);
        return ref.name === local.name || imageBase(ref.name) === imageBase(local.name);
      });
      if (hit) {
        out.push(edgeFact('DEPLOYS_TO', svc.attrs.built_image, w.id, { via: 'image-name', compose_service: svc.id },
          mkFor(svc, { source_type: 'inference', confidence: 'medium' })));
      }
    }
  }
  return capFacts(out, Number.MAX_SAFE_INTEGER);
}

/** Run a renderer; returns `{ok, text}` or `{ok:false, unsupported, reason}`. */
async function render(ctx, argv) {
  try {
    const r = await ctx.exec(argv, { timeoutMs: RENDER_TIMEOUT_MS });
    return { ok: true, text: outputText(r) };
  } catch (e) {
    return { ok: false, unsupported: e?.code === 'UK_ADAPTER_UNSUPPORTED', reason: oneLine(e?.message ?? e?.code) };
  }
}

async function readText(ctx, path) {
  try {
    return await ctx.readText(path);
  } catch {
    return null;
  }
}

/**
 * Render charts and kustomizations. Results are `source_type: 'config'` facts that carry
 * `rendered_from`; missing tools produce an explicit `render: 'unavailable'` node.
 */
export async function discover(ctx) {
  const entries = Array.isArray(ctx.census) ? ctx.census : ctx.census?.files ?? [];
  const paths = entries.map((e) => e.path).sort();
  const pathSet = new Set(paths);
  const facts = [];
  const namespace = ctx.options?.namespace ?? 'default';

  const record = (dir, path, attrs) => {
    const mk = provMaker(path);
    facts.push(nodeFact('build_target', dir, { name: dir, path, attrs }, mk(1)));
  };
  const ingest = (dir, path, tool, text, ns) => {
    const rendered = extractManifests(path, text, { rendered: true, renderedFrom: dir, defaultNamespace: ns });
    const capped = capFacts(rendered);
    facts.push(...capped, ...resolveManifests(capped.filter((f) => f.kind === 'node')));
    return capped.filter((f) => f.kind === 'node' && f.type === 'workload').length;
  };

  // Helm charts. Subcharts under `charts/` are rendered through their parent.
  const chartPaths = paths.filter((p) => posix.basename(p) === 'Chart.yaml');
  for (const cp of chartPaths) {
    const dir = posix.dirname(cp);
    const parent = posix.dirname(posix.dirname(dir));
    if (posix.basename(posix.dirname(dir)) === 'charts' && pathSet.has(posix.join(parent, 'Chart.yaml'))) continue;
    const text = await readText(ctx, cp);
    const doc = text ? parseDocs(text)[0]?.doc : null;
    const release = isObj(doc) && typeof doc.name === 'string' ? doc.name : posix.basename(dir);
    const r = await render(ctx, ['helm', 'template', release, dir, '--namespace', namespace]);
    if (!r.ok) {
      record(dir, cp, { render: r.unsupported ? 'unavailable' : 'failed', render_tool: 'helm', reason: r.reason });
      continue;
    }
    const workloads = ingest(dir, cp, 'helm', r.text, namespace);
    record(dir, cp, { render: 'ok', render_tool: 'helm', release, rendered_workloads: workloads });
  }

  // Kustomizations: render only roots (not referenced by another), skip Components.
  const ksFacts = [];
  for (const p of paths.filter((x) => KUSTOMIZATION.test(posix.basename(x)))) {
    const text = await readText(ctx, p);
    if (!text) continue;
    const doc = parseDocs(text)[0]?.doc;
    if (isObj(doc) && doc.kind === 'Component') continue;
    ksFacts.push(...extractKustomization(p, text).filter((f) => f.kind === 'node'));
  }
  const referenced = new Set(ksFacts.flatMap((n) => n.attrs.resource_dirs ?? []));
  for (const n of ksFacts.filter((k) => !referenced.has(nodeKey(k)))) {
    const dir = nodeKey(n);
    let r = await render(ctx, ['kustomize', 'build', dir]);
    let tool = 'kustomize';
    if (!r.ok && r.unsupported) {
      const first = r.reason;
      r = await render(ctx, ['kubectl', 'kustomize', dir]);
      tool = 'kubectl';
      if (!r.ok) r.reason = oneLine(`${first}; ${r.reason}`);
    }
    if (!r.ok) {
      record(dir, n.path, { render: r.unsupported ? 'unavailable' : 'failed', render_tool: tool, reason: r.reason });
      continue;
    }
    const workloads = ingest(dir, n.path, tool, r.text, namespace);
    record(dir, n.path, { render: 'ok', render_tool: tool, rendered_workloads: workloads });
  }
  return facts;
}

export default {
  id: ID,
  version: VERSION,
  kind: 'infrastructure',
  capabilities: {
    files: [
      '**/*.{yaml,yml}', '**/Dockerfile*', '**/*.dockerfile', '**/docker-compose*.{yml,yaml}',
      '**/compose*.{yml,yaml}', '**/Chart.yaml', '**/values*.yaml', '**/kustomization.{yaml,yml}',
      '**/playbook*.yml', '**/roles/**', '**/*.pp', '**/recipes/*.rb', '**/*.sls',
    ],
    executes: ['helm', 'kustomize', 'kubectl'],
    network: false,
  },
  extract,
  link,
  discover,
};
