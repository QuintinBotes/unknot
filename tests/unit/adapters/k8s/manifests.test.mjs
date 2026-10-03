import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/infrastructure/k8s/index.mjs';
import { extractManifests } from '../../../../adapters/infrastructure/k8s/manifests.mjs';
import { extractAll, extractFile, flat, linked, node, nodes, edges, hasEdge, read } from './helpers.mjs';

test('adapter shape follows the contract', () => {
  assert.equal(adapter.id, 'k8s');
  assert.equal(adapter.version, '0.1.0');
  assert.equal(adapter.kind, 'infrastructure');
  assert.deepEqual(adapter.capabilities.executes, ['helm', 'kustomize', 'kubectl']);
  assert.equal(adapter.capabilities.network, false);
  for (const fn of ['extract', 'link', 'discover']) assert.equal(typeof adapter[fn], 'function');
});

test('workload facts capture reliability and security posture', () => {
  const facts = extractFile('manifests/workloads.yaml');
  const web = node(facts, 'workload:shop/Deployment/web');
  assert.ok(web);
  assert.equal(web.attrs.replicas, 3);
  const [c, proxy] = web.attrs.containers;
  assert.equal(c.image_tag_latest, true);
  assert.equal(c.image_pinned, false);
  assert.equal(c.securityContext.privileged, true);
  assert.deepEqual(c.probes, { liveness: false, readiness: false, startup: false });
  assert.deepEqual(c.resources, { requests: false, limits: false });
  assert.equal(proxy.name, 'istio-proxy');
  assert.deepEqual(web.attrs.sidecars, [{ name: 'istio-proxy', image: 'proxyv2' }]);
  assert.equal(web.attrs.service_account, 'web-sa');
  assert.deepEqual(web.attrs.secret_refs, ['db-creds']);
  assert.deepEqual(web.attrs.config_map_refs, ['web-config']);
  assert.deepEqual(web.attrs.pvc_claims, ['web-data']);
  assert.deepEqual(web.attrs.literal_secret_env, ['API_TOKEN']);

  const cache = node(facts, 'workload:shop/StatefulSet/cache');
  const r = cache.attrs.containers[0];
  assert.equal(r.image_pinned, true);
  assert.equal(r.image_tag_latest, false);
  assert.deepEqual(r.probes, { liveness: true, readiness: true, startup: false });
  assert.deepEqual(r.resources, { requests: true, limits: true });
  assert.equal(r.securityContext.runAsNonRoot, true);
  assert.equal(r.securityContext.drops_all, true);
  assert.equal(cache.attrs.topology_spread, true);
  assert.equal(cache.attrs.automount_service_account_token, false);
});

test('workloads gain edges to namespace, service account and secrets', () => {
  const facts = extractFile('manifests/workloads.yaml');
  const id = 'workload:shop/Deployment/web';
  assert.ok(hasEdge(facts, 'AUTHENTICATES_AS', id, 'service_account:shop/web-sa'));
  assert.ok(hasEdge(facts, 'READS_SECRET', id, 'secret_ref:shop/db-creds'));
  assert.ok(hasEdge(facts, 'CONTAINS', 'k8s_namespace:shop', id));
  assert.equal(node(facts, 'k8s_namespace:shop').attrs.labels.team, 'storefront');
  // The cache workload names no service account, so it authenticates as `default`.
  assert.ok(hasEdge(facts, 'AUTHENTICATES_AS', 'workload:shop/StatefulSet/cache', 'service_account:shop/default'));
});

test('services, ingress and HTTPRoute resolve to workloads and services in link', () => {
  const facts = linked();
  const svc = node(facts, 'service:shop/web');
  assert.equal(svc.attrs.type, 'LoadBalancer');
  assert.equal(svc.attrs.externally_reachable, true);
  assert.ok(hasEdge(facts, 'ROUTES_TO', 'service:shop/web', 'workload:shop/Deployment/web'));
  assert.ok(!hasEdge(facts, 'ROUTES_TO', 'service:shop/web', 'workload:shop/StatefulSet/cache'));
  const ing = node(facts, 'ingress:shop/web');
  assert.deepEqual(ing.attrs.hosts, ['shop.example.com']);
  assert.equal(ing.attrs.tls, true);
  assert.ok(hasEdge(facts, 'ROUTES_TO', 'ingress:shop/web', 'service:shop/web'));
  assert.ok(hasEdge(facts, 'ROUTES_TO', 'ingress:shop/web-route', 'service:shop/web'));
});

test('NetworkPolicies: default deny detection and resolved allow edges', () => {
  const facts = linked();
  const deny = node(facts, 'firewall_rule:shop/default-deny');
  assert.equal(deny.attrs.default_deny_ingress, true);
  assert.equal(deny.attrs.default_deny_egress, true);
  assert.equal(deny.attrs.selects_count, 2);
  assert.deepEqual(deny.attrs.selects, ['workload:shop/Deployment/web', 'workload:shop/StatefulSet/cache']);
  const allow = node(facts, 'firewall_rule:shop/allow-web-to-cache');
  assert.equal(allow.attrs.default_deny_ingress, false);
  assert.deepEqual(allow.attrs.selects, ['workload:shop/StatefulSet/cache']);
  assert.ok(hasEdge(facts, 'ALLOWS_INGRESS_FROM', 'workload:shop/StatefulSet/cache', 'workload:shop/Deployment/web'));
  assert.ok(!hasEdge(facts, 'ALLOWS_INGRESS_FROM', 'workload:shop/Deployment/web', 'workload:shop/StatefulSet/cache'));
  assert.ok(hasEdge(facts, 'PROTECTED_BY', 'workload:shop/Deployment/web', 'firewall_rule:shop/default-deny'));
});

test('RBAC: wildcard roles, escalation flags, bindings and builtin roles', () => {
  const facts = linked();
  const op = node(facts, 'role:_cluster/super-operator');
  assert.equal(op.attrs.wildcard_verbs, true);
  assert.equal(op.attrs.wildcard_resources, true);
  assert.equal(op.attrs.cluster_admin, true);
  assert.equal(op.attrs.secrets_read, true);
  assert.equal(op.attrs.workload_create, true);
  const dep = node(facts, 'role:shop/deployer');
  assert.equal(dep.attrs.secrets_read, true);
  assert.equal(dep.attrs.pods_exec, true);
  assert.equal(dep.attrs.workload_create, true);
  assert.equal(dep.attrs.escalation_risk, true);
  assert.equal(dep.attrs.wildcard_verbs, false);
  assert.equal(dep.attrs.cluster_admin, false);
  assert.ok(hasEdge(facts, 'GRANTS', 'role:shop/deployer', 'permission:k8s/shop/deployer'));
  assert.ok(hasEdge(facts, 'ASSUMES', 'service_account:shop/web-sa', 'role:shop/deployer'));
  assert.ok(hasEdge(facts, 'ASSUMES', 'service_account:shop/web-sa', 'role:_cluster/super-operator'));
  const admin = node(facts, 'role:_cluster/cluster-admin');
  assert.equal(admin.attrs.builtin, true);
  assert.equal(admin.attrs.cluster_admin, true);
  assert.ok(hasEdge(facts, 'ASSUMES', 'service_account:shop/web-sa', 'role:_cluster/cluster-admin'));
  assert.deepEqual(node(facts, 'service_account:shop/web-sa').attrs.workload_identity, ['eks.amazonaws.com/role-arn']);
});

test('PDB, HPA and PVC attach to the right workload', () => {
  const facts = linked();
  const web = node(facts, 'workload:shop/Deployment/web');
  assert.equal(web.attrs.pdb, true);
  assert.deepEqual(web.attrs.autoscaling, { hpa: 'resource:shop/HorizontalPodAutoscaler/web-hpa', min: 2, max: 10 });
  assert.equal(node(facts, 'workload:shop/StatefulSet/cache').attrs.pdb, undefined);
  assert.ok(hasEdge(facts, 'MOUNTS', 'workload:shop/Deployment/web', 'volume:shop/web-data'));
});

test('Secret and ConfigMap facts carry names and keys, never values', () => {
  const all = JSON.stringify(flat(extractAll()).concat(linked()));
  const secret = node(extractFile('manifests/config.yaml'), 'secret_ref:shop/db-creds');
  assert.deepEqual(secret.attrs.keys, ['password', 'token', 'username']);
  assert.equal(secret.attrs.kind, 'Secret');
  assert.equal(secret.attrs.secret_type, 'Opaque');
  assert.deepEqual(node(extractFile('manifests/config.yaml'), 'secret_ref:shop/web-config').attrs.keys, ['LOG_LEVEL', 'feature.flags']);
  for (const leak of [
    'cGFzc3dvcmQxMjM=', 'YWRtaW4tdXNlcg==', 'hunter2-plaintext-secret', 'configmap-value-debug',
    'inline-token-value-must-not-leak', 'literal-cli-token-should-not-leak', 'literal-kustomize-secret-value',
    'baked-in-secret-value', 'literal-compose-password', 'literal-ansible-password', 'super-secret-chart-password',
  ]) {
    assert.ok(!all.includes(leak), `fact output leaked ${leak}`);
  }
});

test('output is deterministic and every fact has config provenance with a line', () => {
  const a = JSON.stringify(flat(extractAll()));
  const b = JSON.stringify(flat(extractAll()));
  assert.equal(a, b);
  for (const f of flat(extractAll())) {
    assert.match(f.provenance.extractor, /^k8s@0\.1\.0$/);
    assert.match(f.provenance.source_ref, /:\d+$/);
  }
  const web = node(extractFile('manifests/workloads.yaml'), 'workload:shop/Deployment/web');
  assert.equal(web.provenance.source_ref, 'manifests/workloads.yaml:8');
});

test('non-Kubernetes YAML and Helm templates yield no K8s facts', () => {
  assert.deepEqual(extractFile('noise/workflow.yml'), []);
  assert.deepEqual(extractFile('noise/openapi.yaml'), []);
  assert.deepEqual(extractFile('helm/api/templates/deployment.yaml'), []);
  assert.deepEqual(extractManifests('x.yaml', 'a: 1\nb:\n  - c\n'), []);
  assert.deepEqual(extractManifests('x.yaml', 'apiVersion: v1\nkind: Widget\n'), []);
});

test('kind List is expanded and namespace defaults to default', () => {
  const text = 'apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: Service\n    metadata:\n      name: s\n    spec:\n      selector: {a: b}\n';
  const facts = extractManifests('l.yaml', text);
  assert.ok(node(facts, 'service:default/s'));
  assert.equal(read('manifests/config.yaml').includes('kind: Secret'), true);
});

test('kustomization namespace applies to un-namespaced manifests during link', () => {
  const facts = linked();
  const billing = node(facts, 'workload:default/Deployment/billing');
  assert.ok(billing);
  assert.equal(billing.attrs.effective_namespace, 'billing-prod');
});

test('rendered facts carry rendered_from and config provenance', () => {
  const facts = extractManifests('helm/api/Chart.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  containers:\n    - name: a\n      image: x\n', {
    rendered: true, renderedFrom: 'helm/api', defaultNamespace: 'rel',
  });
  const pod = node(facts, 'workload:rel/Pod/p');
  assert.equal(pod.attrs.rendered_from, 'helm/api');
  assert.equal(pod.provenance.source_type, 'config');
  assert.equal(pod.provenance.extractor, 'k8s@0.1.0');
  assert.equal(nodes(facts, 'workload').length, 1);
  assert.ok(edges(facts).length > 0);
});
