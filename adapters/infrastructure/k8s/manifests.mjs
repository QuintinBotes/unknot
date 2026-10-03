// Kubernetes manifest extraction (spec §15.3, §15.5). Detects K8s objects by `apiVersion`
// plus `kind` in any YAML file and silently ignores everything else, so GitHub workflows
// and OpenAPI documents yield nothing.
//
// SECRECY: Secret `data`/`stringData` values, env literal values, container commands and
// annotations are never copied into a fact. Only names, keys and booleans are recorded.

import { nodeFact, edgeFact } from '../../../runtime/graph/facts.mjs';
import {
  isObj, asArray, asString, uniqSorted, provMaker, parseDocs, parseImage, imageBase,
  matchesSelector, selectorEmpty, SECRET_NAME,
} from './util.mjs';

export const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod', 'ReplicaSet']);
const CLUSTER_NS = '_cluster';
const SIDECAR_RE = /(istio-proxy|istio\/proxyv2|envoy|linkerd-proxy|linkerd2-proxy|datadog|fluent|vault-agent|cloudsql-proxy|cloud-sql-proxy)/i;
const BUILTIN_CLUSTER_ROLES = new Set(['cluster-admin', 'admin', 'edit', 'view']);
const WORKLOAD_CREATE = new Set(['pods', 'deployments', 'daemonsets', 'statefulsets', 'replicasets', 'jobs', 'cronjobs']);

const sortedObj = (o) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => (a < b ? -1 : 1)));
const hasKeys = (o) => isObj(o) && Object.keys(o).length > 0;

/** Pod spec and pod-template metadata for each workload kind. */
function podParts(kind, doc) {
  const spec = isObj(doc.spec) ? doc.spec : {};
  if (kind === 'Pod') return { pod: spec, meta: isObj(doc.metadata) ? doc.metadata : {} };
  if (kind === 'CronJob') {
    const t = spec.jobTemplate?.spec?.template;
    return { pod: isObj(t?.spec) ? t.spec : {}, meta: isObj(t?.metadata) ? t.metadata : {} };
  }
  const t = spec.template;
  return { pod: isObj(t?.spec) ? t.spec : {}, meta: isObj(t?.metadata) ? t.metadata : {} };
}

function describeContainer(c, podSc) {
  const img = parseImage(c.image);
  const sc = isObj(c.securityContext) ? c.securityContext : {};
  const caps = isObj(sc.capabilities) ? sc.capabilities : {};
  const res = isObj(c.resources) ? c.resources : {};
  return {
    name: asString(c.name) ?? '',
    image: img.raw,
    image_pinned: img.pinned,
    image_tag_latest: img.latest,
    image_untagged: img.untagged,
    resources: { requests: hasKeys(res.requests), limits: hasKeys(res.limits) },
    probes: { liveness: !!c.livenessProbe, readiness: !!c.readinessProbe, startup: !!c.startupProbe },
    securityContext: {
      privileged: sc.privileged === true,
      runAsNonRoot: sc.runAsNonRoot ?? podSc.runAsNonRoot ?? null,
      allowPrivilegeEscalation: sc.allowPrivilegeEscalation ?? null,
      readOnlyRootFilesystem: sc.readOnlyRootFilesystem ?? null,
      capabilities_added: uniqSorted(asArray(caps.add).map(String)),
      drops_all: asArray(caps.drop).map(String).includes('ALL'),
    },
  };
}

/** Everything a workload references by name, gathered without touching any value. */
function referencedNames(pod, containers) {
  const secrets = new Set();
  const configMaps = new Set();
  const pvcs = new Set();
  const hostPaths = new Set();
  const literalSecretEnv = new Set();
  for (const c of containers) {
    for (const e of asArray(c.env)) {
      if (!isObj(e)) continue;
      const vf = isObj(e.valueFrom) ? e.valueFrom : {};
      if (vf.secretKeyRef?.name) secrets.add(String(vf.secretKeyRef.name));
      if (vf.configMapKeyRef?.name) configMaps.add(String(vf.configMapKeyRef.name));
      if (typeof e.name === 'string' && SECRET_NAME.test(e.name) && e.value !== undefined && e.value !== null && e.value !== '') {
        literalSecretEnv.add(e.name);
      }
    }
    for (const f of asArray(c.envFrom)) {
      if (!isObj(f)) continue;
      if (f.secretRef?.name) secrets.add(String(f.secretRef.name));
      if (f.configMapRef?.name) configMaps.add(String(f.configMapRef.name));
    }
  }
  for (const v of asArray(pod.volumes)) {
    if (!isObj(v)) continue;
    if (v.secret?.secretName) secrets.add(String(v.secret.secretName));
    if (v.configMap?.name) configMaps.add(String(v.configMap.name));
    if (v.persistentVolumeClaim?.claimName) pvcs.add(String(v.persistentVolumeClaim.claimName));
    if (v.hostPath?.path) hostPaths.add(String(v.hostPath.path));
    for (const s of asArray(v.projected?.sources)) {
      if (s?.secret?.name) secrets.add(String(s.secret.name));
      if (s?.configMap?.name) configMaps.add(String(s.configMap.name));
    }
  }
  for (const s of asArray(pod.imagePullSecrets)) if (s?.name) secrets.add(String(s.name));
  return {
    secrets: uniqSorted([...secrets]),
    configMaps: uniqSorted([...configMaps]),
    pvcs: uniqSorted([...pvcs]),
    hostPaths: uniqSorted([...hostPaths]),
    literalSecretEnv: uniqSorted([...literalSecretEnv]),
  };
}

function summarizeRules(rules) {
  const has = (arr, v) => arr.includes('*') || arr.includes(v);
  const a = {
    rules: 0, wildcard_verbs: false, wildcard_resources: false, secrets_read: false, pods_exec: false,
    workload_create: false, escalate: false, bind: false, impersonate: false, cluster_admin_rule: false,
  };
  const verbsAll = new Set();
  const resourcesAll = new Set();
  for (const r of asArray(rules)) {
    if (!isObj(r)) continue;
    a.rules += 1;
    const verbs = asArray(r.verbs).map(String);
    const res = asArray(r.resources).map(String);
    const groups = asArray(r.apiGroups).map(String);
    verbs.forEach((v) => verbsAll.add(v));
    res.forEach((v) => resourcesAll.add(v));
    const wv = verbs.includes('*');
    const wr = res.includes('*');
    if (wv) a.wildcard_verbs = true;
    if (wr) a.wildcard_resources = true;
    if (wv && wr && groups.includes('*')) a.cluster_admin_rule = true;
    if ((has(res, 'secrets')) && ['get', 'list', 'watch'].some((v) => has(verbs, v))) a.secrets_read = true;
    if ((has(res, 'pods/exec') || res.includes('pods/*')) && has(verbs, 'create')) a.pods_exec = true;
    if ((wr || res.some((x) => WORKLOAD_CREATE.has(x))) && has(verbs, 'create')) a.workload_create = true;
    if (has(verbs, 'escalate')) a.escalate = true;
    if (has(verbs, 'bind')) a.bind = true;
    if (has(verbs, 'impersonate')) a.impersonate = true;
  }
  return { ...a, verbs: [...verbsAll].sort(), resources: [...resourcesAll].sort() };
}

function peers(list) {
  return asArray(list).map((rule) => {
    const r = isObj(rule) ? rule : {};
    const targets = asArray(r.from ?? r.to);
    return {
      // A rule without from/to matches every peer on the listed ports.
      any_peer: targets.length === 0,
      peers: targets.filter(isObj).map((p) => ({
        pod_selector: isObj(p.podSelector) ? p.podSelector : null,
        namespace_selector: isObj(p.namespaceSelector) ? p.namespaceSelector : null,
        ip_block: isObj(p.ipBlock) ? { cidr: asString(p.ipBlock.cidr), except: asArray(p.ipBlock.except).map(String) } : null,
      })),
      ports: asArray(r.ports).filter(isObj).map((p) => ({ port: p.port ?? null, protocol: p.protocol ?? 'TCP' })),
    };
  });
}

/**
 * Extract K8s facts from YAML text.
 * @param {string} path repository path (or rendered pseudo-path)
 * @param {string} text
 * @param {{sourceType?: string, defaultNamespace?: string, renderedFrom?: string|null,
 *   rendered?: boolean}} [opts]
 * @returns {object[]} facts
 */
export function extractManifests(path, text, opts = {}) {
  const rendered = opts.rendered === true;
  // Helm templates are not YAML until rendered; `discover` handles them via `helm template`.
  if (!rendered && text.includes('{{')) return [];
  if (!/\bapiVersion:/.test(text) || !/\bkind:/.test(text)) return [];
  const mk = provMaker(path, { sourceType: opts.sourceType ?? 'config' });
  const defaultNs = opts.defaultNamespace ?? 'default';
  const extra = opts.renderedFrom ? { rendered_from: opts.renderedFrom } : {};
  const facts = [];
  const seenNs = new Set();

  const node = (type, key, name, attrs, line) =>
    facts.push(nodeFact(type, key, { name, path, attrs: { ...attrs, ...extra } }, mk(line)));
  const edge = (type, from, to, attrs, line, p) => facts.push(edgeFact(type, from, to, attrs ?? {}, p ?? mk(line)));
  const inNamespace = (ns, id, line, explicit) => {
    if (ns === CLUSTER_NS) return;
    if (!seenNs.has(ns)) {
      seenNs.add(ns);
      node('k8s_namespace', ns, ns, {}, line);
    }
    edge('CONTAINS', `k8s_namespace:${ns}`, id, {}, line);
    void explicit;
  };

  const handle = (doc, line) => {
    if (!isObj(doc) || typeof doc.apiVersion !== 'string' || typeof doc.kind !== 'string') return;
    if (doc.kind === 'List' && Array.isArray(doc.items)) {
      doc.items.forEach((it) => handle(it, line));
      return;
    }
    const md = isObj(doc.metadata) ? doc.metadata : {};
    const name = asString(md.name) ?? asString(md.generateName);
    if (!name) return;
    const kind = doc.kind;
    const explicit = typeof md.namespace === 'string';
    const ns = explicit ? md.namespace : defaultNs;
    const spec = isObj(doc.spec) ? doc.spec : {};
    const base = { namespace: ns, ns_explicit: explicit, kind, api_version: doc.apiVersion };

    if (WORKLOAD_KINDS.has(kind)) {
      const { pod, meta } = podParts(kind, doc);
      const podSc = isObj(pod.securityContext) ? pod.securityContext : {};
      const cs = asArray(pod.containers).filter(isObj);
      const containers = cs.map((c) => describeContainer(c, podSc));
      const sidecars = containers
        .filter((c, i) => i > 0 && (SIDECAR_RE.test(c.name) || SIDECAR_RE.test(c.image)))
        .map((c) => ({ name: c.name, image: imageBase(parseImage(c.image).name) }));
      const refs = referencedNames(pod, [...cs, ...asArray(pod.initContainers).filter(isObj)]);
      const id = `workload:${ns}/${kind}/${name}`;
      const sa = asString(pod.serviceAccountName) ?? asString(pod.serviceAccount);
      node('workload', `${ns}/${kind}/${name}`, name, {
        ...base,
        replicas: Number.isInteger(spec.replicas) ? spec.replicas : null,
        containers,
        init_container_count: asArray(pod.initContainers).length,
        sidecars,
        sidecar_injection: meta.annotations?.['sidecar.istio.io/inject'] === 'true' || meta.labels?.['sidecar.istio.io/inject'] === 'true',
        service_account: sa,
        automount_service_account_token: typeof pod.automountServiceAccountToken === 'boolean' ? pod.automountServiceAccountToken : null,
        topology_spread: asArray(pod.topologySpreadConstraints).length > 0,
        anti_affinity: !!pod.affinity?.podAntiAffinity,
        host_network: pod.hostNetwork === true,
        host_pid: pod.hostPID === true,
        host_ipc: pod.hostIPC === true,
        host_path_mounts: refs.hostPaths,
        pvc_claims: refs.pvcs,
        volume_claim_templates: asArray(spec.volumeClaimTemplates).map((t) => asString(t?.metadata?.name)).filter(Boolean).sort(),
        secret_refs: refs.secrets,
        config_map_refs: refs.configMaps,
        literal_secret_env: refs.literalSecretEnv,
        pod_labels: sortedObj(meta.labels),
        pod_security_run_as_non_root: podSc.runAsNonRoot ?? null,
      }, line);
      inNamespace(ns, id, line, explicit);
      const saName = sa ?? 'default';
      const saId = `service_account:${ns}/${saName}`;
      node('service_account', `${ns}/${saName}`, saName, { namespace: ns, kind: 'ServiceAccount' }, line);
      edge('AUTHENTICATES_AS', id, saId, { explicit: sa !== null }, line);
      for (const s of refs.secrets) {
        node('secret_ref', `${ns}/${s}`, s, { namespace: ns, kind: 'Secret' }, line);
        edge('READS_SECRET', id, `secret_ref:${ns}/${s}`, {}, line);
      }
      return;
    }

    switch (kind) {
      case 'Namespace':
        node('k8s_namespace', name, name, {
          kind, labels: sortedObj(md.labels),
          pod_security_enforce: asString(md.labels?.['pod-security.kubernetes.io/enforce']),
        }, line);
        return;
      case 'Service': {
        const id = `service:${ns}/${name}`;
        const type = asString(spec.type) ?? 'ClusterIP';
        node('service', `${ns}/${name}`, name, {
          ...base,
          type,
          headless: spec.clusterIP === 'None',
          ports: asArray(spec.ports).filter(isObj).map((p) => ({
            name: asString(p.name), port: p.port ?? null, target_port: p.targetPort ?? null,
            protocol: p.protocol ?? 'TCP', node_port: p.nodePort ?? null,
          })),
          selector: sortedObj(spec.selector),
          externally_reachable: type === 'NodePort' || type === 'LoadBalancer',
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      case 'Ingress': {
        const paths = [];
        const backends = [];
        const ref = (b) => {
          const s = b?.service;
          if (!s?.name) return null;
          const port = s.port?.number ?? s.port?.name ?? null;
          return { service: String(s.name), port };
        };
        for (const r of asArray(spec.rules)) {
          for (const p of asArray(r?.http?.paths)) {
            const b = ref(p?.backend);
            paths.push({ host: asString(r.host), path: asString(p.path) ?? '/', service: b?.service ?? null, port: b?.port ?? null });
            if (b) backends.push(b);
          }
        }
        const def = ref(spec.defaultBackend);
        if (def) backends.push(def);
        const id = `ingress:${ns}/${name}`;
        node('ingress', `${ns}/${name}`, name, {
          ...base,
          ingress_class: asString(spec.ingressClassName),
          hosts: uniqSorted(asArray(spec.rules).map((r) => asString(r?.host))),
          paths,
          tls: asArray(spec.tls).length > 0,
          tls_hosts: uniqSorted(asArray(spec.tls).flatMap((t) => asArray(t?.hosts).map(String))),
          backends: backends.map((b) => ({ ...b, namespace: ns })),
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      case 'HTTPRoute': {
        const backends = [];
        const paths = [];
        for (const r of asArray(spec.rules)) {
          for (const b of asArray(r?.backendRefs)) {
            if (!b?.name || (b.kind && b.kind !== 'Service')) continue;
            backends.push({ service: String(b.name), port: b.port ?? null, namespace: asString(b.namespace) ?? ns });
          }
          for (const m of asArray(r?.matches)) paths.push({ path: asString(m?.path?.value) ?? '/', type: asString(m?.path?.type) });
        }
        const id = `ingress:${ns}/${name}`;
        node('ingress', `${ns}/${name}`, name, {
          ...base,
          hosts: uniqSorted(asArray(spec.hostnames).map(String)),
          paths,
          tls: false,
          parent_refs: uniqSorted(asArray(spec.parentRefs).map((p) => asString(p?.name))),
          backends,
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      case 'Gateway': {
        const id = `gateway:${ns}/${name}`;
        node('gateway', `${ns}/${name}`, name, {
          ...base,
          gateway_class: asString(spec.gatewayClassName),
          listeners: asArray(spec.listeners).filter(isObj).map((l) => ({ name: asString(l.name), port: l.port ?? null, protocol: asString(l.protocol), hostname: asString(l.hostname) })),
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      case 'NetworkPolicy': {
        const selector = isObj(spec.podSelector) ? spec.podSelector : {};
        const ingressRules = Array.isArray(spec.ingress) ? spec.ingress : [];
        const egressRules = Array.isArray(spec.egress) ? spec.egress : [];
        const types = asArray(spec.policyTypes).map(String);
        // Kubernetes defaults policyTypes to Ingress, plus Egress when egress rules exist.
        const effective = types.length ? types : ['Ingress', ...(egressRules.length ? ['Egress'] : [])];
        const all = selectorEmpty(selector);
        const ing = peers(ingressRules);
        const eg = peers(egressRules);
        const id = `firewall_rule:${ns}/${name}`;
        node('firewall_rule', `${ns}/${name}`, name, {
          ...base,
          pod_selector: selector,
          selects_all_pods: all,
          policy_types: effective,
          default_deny_ingress: all && effective.includes('Ingress') && ingressRules.length === 0,
          default_deny_egress: all && effective.includes('Egress') && egressRules.length === 0,
          ingress_rules: ing,
          egress_rules: eg,
          allows_any_ingress: ing.some((r) => r.any_peer && r.ports.length === 0) || undefined,
          open_cidr: [...ing, ...eg].some((r) => r.peers.some((p) => p.ip_block?.cidr === '0.0.0.0/0')),
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      case 'Role':
      case 'ClusterRole': {
        const cluster = kind === 'ClusterRole';
        const rns = cluster ? CLUSTER_NS : ns;
        const s = summarizeRules(doc.rules);
        const id = `role:${rns}/${name}`;
        node('role', `${rns}/${name}`, name, {
          kind, namespace: rns, ns_explicit: explicit, rules: s.rules,
          wildcard_verbs: s.wildcard_verbs, wildcard_resources: s.wildcard_resources,
          secrets_read: s.secrets_read, pods_exec: s.pods_exec, workload_create: s.workload_create,
          escalate: s.escalate, bind: s.bind, impersonate: s.impersonate,
          escalation_risk: s.workload_create || s.escalate || s.bind || s.impersonate,
          cluster_admin: cluster && s.cluster_admin_rule,
          namespace_admin: !cluster && s.cluster_admin_rule,
        }, line);
        node('permission', `k8s/${rns}/${name}`, `${name} permissions`, {
          role: id, verbs: s.verbs, resources: s.resources, rules: s.rules,
        }, line);
        edge('GRANTS', id, `permission:k8s/${rns}/${name}`, {}, line);
        if (!cluster) inNamespace(ns, id, line, explicit);
        return;
      }
      case 'RoleBinding':
      case 'ClusterRoleBinding': {
        const rb = isObj(doc.roleRef) ? doc.roleRef : {};
        node('resource', `${ns}/${kind}/${name}`, name, {
          kind, namespace: kind === 'ClusterRoleBinding' ? CLUSTER_NS : ns,
          role_ref: { kind: asString(rb.kind), name: asString(rb.name) },
          subjects: asArray(doc.subjects).filter(isObj).map((s) => ({
            kind: asString(s.kind), name: asString(s.name), namespace: asString(s.namespace),
          })),
        }, line);
        return;
      }
      case 'ServiceAccount': {
        const ann = isObj(md.annotations) ? md.annotations : {};
        const idKeys = Object.keys(ann).filter((k) => /eks\.amazonaws\.com\/role-arn|iam\.gke\.io\/gcp-service-account|azure\.workload\.identity\/client-id/.test(k));
        const id = `service_account:${ns}/${name}`;
        node('service_account', `${ns}/${name}`, name, {
          ...base, declared: true,
          automount_service_account_token: typeof doc.automountServiceAccountToken === 'boolean' ? doc.automountServiceAccountToken : null,
          image_pull_secret_count: asArray(doc.imagePullSecrets).length,
          workload_identity: idKeys.sort(),
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      case 'PodDisruptionBudget':
        node('resource', `${ns}/${kind}/${name}`, name, {
          ...base, selector: isObj(spec.selector) ? spec.selector : {},
          min_available: spec.minAvailable ?? null, max_unavailable: spec.maxUnavailable ?? null,
        }, line);
        return;
      case 'HorizontalPodAutoscaler': {
        const t = isObj(spec.scaleTargetRef) ? spec.scaleTargetRef : {};
        node('resource', `${ns}/${kind}/${name}`, name, {
          ...base, target: { kind: asString(t.kind), name: asString(t.name) },
          min_replicas: spec.minReplicas ?? 1, max_replicas: spec.maxReplicas ?? null,
          metrics: asArray(spec.metrics).length,
        }, line);
        return;
      }
      case 'ConfigMap':
      case 'Secret': {
        // Keys only. `Object.keys` never reads a value, so none can leak into a fact.
        const keys = uniqSorted([
          ...Object.keys(isObj(doc.data) ? doc.data : {}),
          ...Object.keys(isObj(doc.stringData) ? doc.stringData : {}),
          ...Object.keys(isObj(doc.binaryData) ? doc.binaryData : {}),
        ]);
        const id = `secret_ref:${ns}/${name}`;
        node('secret_ref', `${ns}/${name}`, name, {
          ...base, declared: true, keys, key_count: keys.length,
          secret_type: kind === 'Secret' ? asString(doc.type) ?? 'Opaque' : null,
          immutable: doc.immutable === true,
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      case 'PersistentVolumeClaim': {
        const id = `volume:${ns}/${name}`;
        node('volume', `${ns}/${name}`, name, {
          ...base, storage_class: asString(spec.storageClassName),
          access_modes: asArray(spec.accessModes).map(String),
          requested: asString(spec.resources?.requests?.storage),
        }, line);
        inNamespace(ns, id, line, explicit);
        return;
      }
      default:
    }
  };

  for (const d of parseDocs(text)) {
    if (d.error) {
      // Only a document that really claims to be a K8s object is worth failing loudly for.
      if (!rendered && /^apiVersion:/m.test(text) && /^kind:/m.test(text)) throw d.error;
      continue;
    }
    handle(d.doc, d.line);
  }
  return facts;
}

const nodeKey = (n) => n.id.slice(n.type.length + 1);

/**
 * Cross-object resolution shared by `link` (whole repo) and `discover` (one render):
 * selectors to workloads, ingress backends to services, bindings to roles, policies to pods.
 * @param {object[]} nodes node facts (possibly with `effective_namespace` set in attrs)
 * @returns {object[]} new edge facts and attr-only node patches
 */
export function resolveManifests(nodes) {
  const out = [];
  const byType = (t) => nodes.filter((n) => n.type === t);
  const ns = (n) => n.attrs.effective_namespace ?? n.attrs.namespace;
  const mkp = (n, extra = {}) => ({ ...n.provenance, ...extra });
  const patch = (n, attrs) => out.push(nodeFact(n.type, nodeKey(n), { name: n.name, path: n.path, attrs }, mkp(n)));
  const idOf = (n) => n.id;

  const workloads = byType('workload');
  const services = byType('service');
  const nsNodes = byType('k8s_namespace');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const labelsOf = (w) => w.attrs.pod_labels ?? {};

  // Services select workloads by label; this is the traffic path graph consumers rely on.
  for (const s of services) {
    const sel = s.attrs.selector;
    if (!hasKeys(sel)) continue;
    for (const w of workloads) {
      if (ns(w) !== ns(s) || !matchesSelector(sel, labelsOf(w))) continue;
      out.push(edgeFact('ROUTES_TO', s.id, w.id, { via: 'selector', ports: (s.attrs.ports ?? []).map((p) => p.port) }, mkp(s)));
    }
  }

  for (const ing of byType('ingress')) {
    const unresolved = [];
    for (const b of ing.attrs.backends ?? []) {
      const target = byId.get(`service:${b.namespace ?? ns(ing)}/${b.service}`);
      if (target) out.push(edgeFact('ROUTES_TO', ing.id, target.id, { port: b.port }, mkp(ing)));
      else unresolved.push(b.service);
    }
    if (unresolved.length) patch(ing, { unresolved_backends: uniqSorted(unresolved) });
  }

  // Namespaces a namespaceSelector can match: declared ones plus any seen on workloads.
  const nsLabels = new Map();
  for (const n of nsNodes) nsLabels.set(nodeKey(n), n.attrs.labels ?? {});
  for (const w of workloads) if (!nsLabels.has(ns(w))) nsLabels.set(ns(w), {});
  const nsMatching = (selector) => [...nsLabels.entries()]
    .filter(([name, labels]) => matchesSelector(selector, { 'kubernetes.io/metadata.name': name, ...labels }))
    .map(([name]) => name);

  const peerWorkloads = (policy, peer) => {
    const nss = peer.namespace_selector ? nsMatching(peer.namespace_selector) : [ns(policy)];
    return workloads.filter((w) => nss.includes(ns(w)) && (!peer.pod_selector || matchesSelector(peer.pod_selector, labelsOf(w))));
  };
  let pairBudget = 2000;
  for (const p of byType('firewall_rule')) {
    const sel = p.attrs.pod_selector ?? {};
    const selected = workloads.filter((w) => ns(w) === ns(p) && (selectorEmpty(sel) || matchesSelector(sel, labelsOf(w))));
    patch(p, { selects: selected.map(idOf).sort(), selects_count: selected.length });
    for (const w of selected) out.push(edgeFact('PROTECTED_BY', w.id, p.id, {}, mkp(p)));
    const types = p.attrs.policy_types ?? [];
    const emit = (rules, edgeType, enabled) => {
      if (!enabled) return;
      for (const rule of rules ?? []) {
        for (const peer of rule.peers ?? []) {
          if (!peer.pod_selector && !peer.namespace_selector) continue;
          const targets = peerWorkloads(p, peer);
          for (const a of selected) {
            for (const b of targets) {
              if (pairBudget-- <= 0) break;
              out.push(edgeFact(edgeType, a.id, b.id, { via: p.id, ports: rule.ports }, mkp(p)));
            }
          }
        }
      }
    };
    emit(p.attrs.ingress_rules, 'ALLOWS_INGRESS_FROM', types.includes('Ingress'));
    emit(p.attrs.egress_rules, 'ALLOWS_EGRESS_TO', types.includes('Egress'));
  }
  if (pairBudget < 0) patch(byType('firewall_rule')[0], { edges_truncated: true });

  // Bindings: service account ASSUMES role. Built-in ClusterRoles get an explicit stub.
  for (const b of byType('resource').filter((r) => /RoleBinding$/.test(r.attrs.kind))) {
    const ref = b.attrs.role_ref ?? {};
    if (!ref.name) continue;
    const clusterRole = ref.kind === 'ClusterRole';
    const roleId = `role:${clusterRole ? CLUSTER_NS : b.attrs.kind === 'ClusterRoleBinding' ? CLUSTER_NS : b.attrs.namespace}/${ref.name}`;
    if (!byId.has(roleId)) {
      if (clusterRole && BUILTIN_CLUSTER_ROLES.has(ref.name)) {
        out.push(nodeFact('role', `${CLUSTER_NS}/${ref.name}`, {
          name: ref.name, path: b.path,
          attrs: { kind: 'ClusterRole', namespace: CLUSTER_NS, builtin: true, cluster_admin: ref.name === 'cluster-admin' },
        }, mkp(b, { confidence: 'medium' })));
      } else {
        patch(b, { unresolved_role: ref.name });
        continue;
      }
    }
    for (const s of b.attrs.subjects ?? []) {
      if (s.kind !== 'ServiceAccount' || !s.name) continue;
      const sns = s.namespace ?? b.attrs.namespace;
      const saId = `service_account:${sns}/${s.name}`;
      if (!byId.has(saId)) out.push(nodeFact('service_account', `${sns}/${s.name}`, { name: s.name, path: b.path, attrs: { namespace: sns, kind: 'ServiceAccount' } }, mkp(b)));
      out.push(edgeFact('ASSUMES', saId, roleId, {
        binding: b.id, scope: b.attrs.kind === 'ClusterRoleBinding' ? 'cluster' : 'namespace',
      }, mkp(b)));
    }
  }

  for (const r of byType('resource')) {
    if (r.attrs.kind === 'PodDisruptionBudget') {
      const matched = workloads.filter((w) => ns(w) === ns(r) && !selectorEmpty(r.attrs.selector) && matchesSelector(r.attrs.selector, labelsOf(w)));
      for (const w of matched) {
        patch(w, { pdb: true, pdb_ref: r.id });
        out.push(edgeFact('PROTECTED_BY', w.id, r.id, { kind: 'PodDisruptionBudget' }, mkp(r)));
      }
    } else if (r.attrs.kind === 'HorizontalPodAutoscaler') {
      const t = r.attrs.target ?? {};
      const target = byId.get(`workload:${ns(r)}/${t.kind}/${t.name}`);
      if (target) {
        patch(target, { autoscaling: { hpa: r.id, min: r.attrs.min_replicas, max: r.attrs.max_replicas } });
      }
    }
  }

  const volumes = new Map(byType('volume').map((v) => [v.id, v]));
  for (const w of workloads) {
    for (const claim of w.attrs.pvc_claims ?? []) {
      const v = volumes.get(`volume:${ns(w)}/${claim}`);
      if (v) out.push(edgeFact('MOUNTS', w.id, v.id, {}, mkp(w)));
    }
  }
  return out;
}
