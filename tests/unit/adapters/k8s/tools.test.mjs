import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/infrastructure/k8s/index.mjs';
import { UnknotError } from '../../../../runtime/core/errors.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { census, read, extractFile, node, nodes, hasEdge, extractAll, flat } from './helpers.mjs';

const RENDERED = `---
# Source: api/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: rel-ns
spec:
  replicas: 2
  selector:
    matchLabels: {app: api}
  template:
    metadata:
      labels: {app: api}
    spec:
      containers:
        - name: api
          image: registry.example.com/api:latest
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: rel-ns
spec:
  selector: {app: api}
  ports:
    - port: 80
`;

const unsupported = (tool) => new UnknotError('UK_ADAPTER_UNSUPPORTED', `${tool} is not installed`);

function ctxWith(exec) {
  const entries = census();
  return { root: '/nowhere', census: { files: entries }, readText: (p) => read(p), exec, options: {}, evidence: [] };
}

test('Chart.yaml and values facts: dependencies pinned, image tags, credential key paths only', () => {
  const chart = node(extractFile('helm/api/Chart.yaml'), 'build_target:helm/api');
  assert.equal(chart.attrs.chart_name, 'api');
  assert.equal(chart.attrs.chart_version, '0.3.1');
  assert.deepEqual(chart.attrs.unpinned_dependencies, ['redis']);
  assert.equal(chart.attrs.dependencies.find((d) => d.name === 'postgresql').pinned, true);

  const values = extractFile('helm/api/values.yaml').find((f) => f.type === 'resource');
  assert.equal(values.attrs.kind, 'HelmValues');
  assert.deepEqual(values.attrs.images_latest, ['image']);
  assert.deepEqual(values.attrs.replica_counts, [{ path: 'replicaCount', value: 2 }, { path: 'worker.replicaCount', value: 1 }]);
  assert.deepEqual(values.attrs.resources_present, ['']);
  assert.deepEqual(values.attrs.images_without_resources, ['worker']);
  assert.deepEqual(values.attrs.literal_credential_keys, ['auth.adminPassword']);
});

test('discover renders charts via helm template and tags facts as rendered', async () => {
  const calls = [];
  const exec = async (argv, opts) => {
    calls.push(argv);
    assert.ok(opts.timeoutMs > 0);
    if (argv[0] === 'helm') return { stdout: RENDERED };
    throw unsupported(argv[0]);
  };
  const facts = await adapter.discover(ctxWith(exec));
  facts.forEach(assertFact);
  const helmCall = calls.find((c) => c[0] === 'helm');
  assert.deepEqual(helmCall, ['helm', 'template', 'api', 'helm/api', '--namespace', 'default']);
  const w = node(facts, 'workload:rel-ns/Deployment/api');
  assert.equal(w.attrs.rendered_from, 'helm/api');
  assert.equal(w.attrs.containers[0].image_tag_latest, true);
  assert.equal(w.provenance.source_type, 'config');
  assert.equal(w.provenance.extractor, 'k8s@0.1.0');
  assert.ok(hasEdge(facts, 'ROUTES_TO', 'service:rel-ns/api', 'workload:rel-ns/Deployment/api'));
  const bt = node(facts, 'build_target:helm/api');
  assert.equal(bt.attrs.render, 'ok');
  assert.equal(bt.attrs.rendered_workloads, 1);
});

test('missing helm and kustomize are recorded explicitly, not silently skipped', async () => {
  const calls = [];
  const exec = async (argv) => {
    calls.push(argv[0]);
    throw Object.assign(new Error(`${argv[0]} unavailable`), { code: 'UK_ADAPTER_UNSUPPORTED' });
  };
  const facts = await adapter.discover(ctxWith(exec));
  facts.forEach(assertFact);
  assert.equal(nodes(facts, 'workload').length, 0);
  const chart = node(facts, 'build_target:helm/api');
  assert.equal(chart.attrs.render, 'unavailable');
  assert.match(chart.attrs.reason, /helm unavailable/);
  const ks = node(facts, 'build_target:kustomize/overlays/prod');
  assert.equal(ks.attrs.render, 'unavailable');
  assert.match(ks.attrs.reason, /kustomize unavailable.*kubectl unavailable/);
  // kubectl is only the fallback when kustomize itself is unsupported.
  assert.ok(calls.includes('kubectl'));
  // The base overlay target is rendered through the overlay, not on its own.
  assert.ok(!facts.some((f) => f.kind === 'node' && f.id === 'build_target:kustomize/base' && f.attrs.render));
});

test('kustomize falls back to kubectl kustomize and a tool failure is reported as failed', async () => {
  let seen = [];
  const exec = async (argv) => {
    seen.push(argv.join(' '));
    if (argv[0] === 'helm') throw new Error('Error: found in Chart.yaml, but missing in charts/ directory: postgresql');
    if (argv[0] === 'kustomize') throw unsupported('kustomize');
    return RENDERED;
  };
  const facts = await adapter.discover(ctxWith(exec));
  assert.ok(seen.includes('kustomize build kustomize/overlays/prod'));
  assert.ok(seen.includes('kubectl kustomize kustomize/overlays/prod'));
  assert.equal(node(facts, 'build_target:kustomize/overlays/prod').attrs.render, 'ok');
  assert.equal(node(facts, 'build_target:kustomize/overlays/prod').attrs.render_tool, 'kubectl');
  const chart = node(facts, 'build_target:helm/api');
  assert.equal(chart.attrs.render, 'failed');
  assert.match(chart.attrs.reason, /missing in charts/);
});

test('static kustomization parsing works without any tool', () => {
  const overlay = node(extractFile('kustomize/overlays/prod/kustomization.yaml'), 'build_target:kustomize/overlays/prod');
  assert.equal(overlay.attrs.namespace, 'billing-prod');
  assert.deepEqual(overlay.attrs.resource_dirs, ['kustomize/base']);
  assert.equal(overlay.attrs.unpinned_remote, 1);
  assert.deepEqual(overlay.attrs.patch_files, ['kustomize/overlays/prod/replicas.yaml']);
  assert.equal(overlay.attrs.image_overrides[0].new_tag, '1.2.0');
  assert.deepEqual(overlay.attrs.secret_generators, [{ name: 'billing-secret', keys: ['API_KEY'] }]);
  const base = extractFile('kustomize/base/kustomization.yaml');
  assert.deepEqual(node(base, 'build_target:kustomize/base').attrs.resource_files, ['kustomize/base/deployment.yaml']);
  assert.ok(hasEdge(extractFile('kustomize/overlays/prod/kustomization.yaml'), 'DEPENDS_ON', 'build_target:kustomize/overlays/prod', 'build_target:kustomize/base'));
});

test('discovery is deterministic', async () => {
  const exec = async () => RENDERED;
  const a = JSON.stringify(await adapter.discover(ctxWith(exec)));
  const b = JSON.stringify(await adapter.discover(ctxWith(exec)));
  assert.equal(a, b);
  assert.ok(flat(extractAll()).length > 0);
});
