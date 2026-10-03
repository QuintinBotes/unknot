// Delivery detectors (spec §11.4): lockstep deployables, duplicated pipelines, missing
// health checks and rollback paths, dead feature flags and over-broad CI permissions.
// Supply-chain issues (floating actions, unpinned images) belong to the security detectors.

const LONG_RUNNING = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);
const ROLLBACK_HINT = /roll-?back|\bundo\b|revert|blue[-_ ]?green|canary|progressive|flagger|argo[-_ ]?rollouts?|rollout undo|helm rollback/i;

const sortedUniq = (xs) => [...new Set(xs)].sort();
const byId = (a, b) => (a.id < b.id ? -1 : 1);

function draft(o) {
  return {
    quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'low' },
    blast_radius: 'bounded',
    recovery: { type: 'revert', notes: 'Pipeline and manifest changes are reverted by restoring the previous file.' },
    uncertainties: [],
    ...o,
  };
}

function groups(pairs) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of pairs) parent.set(find(a), find(b));
  const out = new Map();
  for (const x of parent.keys()) {
    const r = find(x);
    if (!out.has(r)) out.set(r, []);
    out.get(r).push(x);
  }
  return [...out.values()].map((v) => v.sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const lockstep = {
  id: 'delivery.lockstep-deployables',
  version: '1.0.0',
  category: 'delivery',
  kinds: ['delivery.lockstep-deployables'],
  detect({ graph: g }) {
    const pairs = [];
    for (const d of g.nodes('deployable')) for (const o of d.attrs.co_deployed_with ?? []) pairs.push([d.name, o]);
    return groups(pairs).filter((names) => names.length >= 2).map((names) => {
      const nodes = names.map((n) => g.nodes('deployable').find((d) => d.name === n)).filter(Boolean);
      return draft({
        kind: 'delivery.lockstep-deployables',
        title: `${names.length} deployables always release together (${names.join(', ')})`,
        scope: sortedUniq(nodes.map((n) => n.path ?? n.provenance?.[0]?.source_ref?.split(':')[0]).filter(Boolean)),
        key: `deployables:${names.join(',')}`,
        evidence: nodes.map((n) => ({ ref: n.id, label: 'inferred', summary: `Co-deployed with ${(n.attrs.co_deployed_with ?? []).join(', ')}`, source_ref: n.provenance?.[0]?.source_ref ?? null })),
        measurements: { 'service.count': names.length, 'ci.present': 1 },
        thresholds: { min_group: 2 },
        why_accidental: 'Units that cannot ship alone carry the overhead of separate artifacts without the benefit of independent release.',
        essential_considerations: ['A deliberate atomic release (schema plus app) can legitimately ship together'],
        smallest_simplification: 'Either give each deployable its own path-filtered pipeline job, or treat the group as one deployable. Choose by whether the units truly change independently.',
        invariants: ['Release order between the units is preserved where one depends on the other'],
        risks: ['Splitting pipelines exposes version skew between the units'],
        verification: ['Release one unit alone in a staging pipeline and run the integration suite'],
        factors: { benefit: 3, evidence: 0.55, reversibility: 0.8, blast: 3, cost: 2, uncertainty: 3 },
        uncertainties: ['Co-deployment is inferred from pipeline structure (shared job or unfiltered workflow), not from release history'],
        alternatives: [{ id: 'retain', summary: 'Keep lockstep release and document it as one deployable.' }, { id: 'independent-pipelines', summary: 'Path-filter per-unit jobs.' }, { id: 'merge', summary: 'Merge into one artifact.' }],
        patterns: ['anti-pattern.distributed-monolith', 'infrastructure.merge-lockstep-stacks'],
      });
    });
  },
};

const duplicatedPipelines = {
  id: 'delivery.duplicated-pipelines',
  version: '1.0.0',
  category: 'delivery',
  kinds: ['delivery.duplicated-pipelines'],
  detect({ graph: g }) {
    return g.nodes('workflow').filter((w) => w.attrs.duplicate_of).sort(byId).map((w) => draft({
      kind: 'delivery.duplicated-pipelines',
      title: `${w.path} duplicates ${w.attrs.duplicate_of.replace(/^workflow:/, '')} (${Math.round((w.attrs.duplicate_similarity ?? 0) * 100)}% same steps)`,
      scope: sortedUniq([w.path, w.attrs.duplicate_of.replace(/^workflow:/, '')]),
      key: `workflow:${w.id}`,
      evidence: [{ ref: w.id, label: 'inferred', summary: `Step signatures ${Math.round((w.attrs.duplicate_similarity ?? 0) * 100)}% identical to ${w.attrs.duplicate_of}`, source_ref: w.path }],
      measurements: { 'duplication.similarity': w.attrs.duplicate_similarity ?? 0, 'duplication.instances': 2, 'ci.present': 1 },
      thresholds: { similarity: 0.85 },
      why_accidental: 'Copied pipelines drift: a fix applied to one is missed in the other.',
      essential_considerations: ['Per-environment pipelines are sometimes kept separate on purpose for access control'],
      smallest_simplification: 'Extract the shared steps into a reusable workflow or template and call it from both, parametrised by the differences.',
      invariants: ['Triggers, secrets scope and permissions of each caller stay the same'],
      risks: ['A shared template widens the blast radius of a bad edit'],
      verification: ['Both pipelines run green on a branch after extraction'],
      blast_radius: 'local',
      factors: { benefit: 2, evidence: 0.7, reversibility: 0.9, blast: 1, cost: 2, uncertainty: 2 },
      uncertainties: ['Similarity is computed on normalised step signatures, not on semantics'],
      alternatives: [{ id: 'retain', summary: 'Keep both and note why they differ.' }, { id: 'reusable-workflow', summary: 'Extract a reusable workflow.' }],
      patterns: ['infrastructure.golden-path'],
    }));
  },
};

const missingHealthChecks = {
  id: 'delivery.missing-health-checks',
  version: '1.0.0',
  category: 'delivery',
  kinds: ['delivery.missing-health-checks'],
  detect({ graph: g }) {
    const out = [];
    for (const w of g.nodes('workload').filter((n) => LONG_RUNNING.has(n.attrs.kind)).sort(byId)) {
      const cs = w.attrs.containers ?? [];
      if (!cs.length || cs.some((c) => c.probes?.liveness || c.probes?.readiness || c.probes?.startup)) continue;
      out.push(draft({
        kind: 'delivery.missing-health-checks',
        title: `${w.attrs.kind} ${w.name} has no readiness or liveness probes`,
        scope: [w.path ?? w.id],
        key: `workload:${w.id}`,
        evidence: [{ ref: w.id, label: 'observed', summary: `${cs.length} container(s), none with a probe`, source_ref: w.provenance?.[0]?.source_ref ?? null }],
        measurements: { 'service.count': 1 },
        thresholds: { probes_required: 'readiness or liveness' },
        why_accidental: 'Without probes the platform routes traffic to instances that have not started and never restarts hung ones.',
        essential_considerations: ['Workers with no network listener may use an exec probe or none'],
        smallest_simplification: 'Add a readiness probe against an existing health route; add a liveness probe only once readiness is stable.',
        invariants: ['Application behaviour unchanged'],
        risks: ['A wrong liveness probe causes restart loops; start with readiness only'],
        verification: ['Rollout waits for readiness in a staging deploy', 'Kill the health route and observe the pod leave service'],
        quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
        blast_radius: 'local',
        factors: { benefit: 3, evidence: 0.85, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 2 },
        uncertainties: ['Probes may be injected by a mesh, operator or kustomize patch not in the mapped manifests'],
        alternatives: [{ id: 'retain', summary: 'Keep as is and rely on external monitoring.' }, { id: 'readiness-probe', summary: 'Add a readiness probe.' }],
        patterns: ['resilience.health-endpoint-monitoring'],
      }));
    }
    for (const s of g.nodes('service').filter((n) => n.attrs.runtime === 'compose' && n.attrs.deployable).sort(byId)) {
      if (s.attrs.healthcheck) continue;
      const image = s.attrs.built_image ? g.node(s.attrs.built_image) : null;
      if (image?.attrs.healthcheck) continue;
      out.push(draft({
        kind: 'delivery.missing-health-checks',
        title: `Compose service ${s.name} defines no healthcheck`,
        scope: [s.path ?? s.id],
        key: `compose:${s.id}`,
        evidence: [{ ref: s.id, label: 'observed', summary: image ? 'No healthcheck in compose or Dockerfile HEALTHCHECK' : 'No healthcheck in compose and no Dockerfile to inspect', source_ref: s.path ?? null }],
        measurements: { 'service.count': 1 },
        thresholds: { probes_required: 'healthcheck' },
        why_accidental: 'depends_on conditions and restarts cannot reason about a service that never reports health.',
        essential_considerations: ['Local development stacks often omit healthchecks deliberately'],
        smallest_simplification: 'Add a healthcheck using a command the image already contains.',
        invariants: ['Service behaviour unchanged'],
        risks: ['A slow-starting service needs a start_period'],
        verification: ['docker compose ps reports healthy'],
        quality_impacts: { changeability: 'low', reliability: 'medium', security: 'low' },
        blast_radius: 'local',
        factors: { benefit: 2, evidence: image ? 0.6 : 0.45, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 2 },
        uncertainties: ['Compose may be a development-only file', 'The base image may declare HEALTHCHECK outside the mapped Dockerfile'],
        alternatives: [{ id: 'retain', summary: 'Keep as is for development use.' }, { id: 'add-healthcheck', summary: 'Add a healthcheck.' }],
        patterns: ['resilience.health-endpoint-monitoring'],
      }));
    }
    return out;
  },
};

const missingRollback = {
  id: 'delivery.missing-rollback-path',
  version: '1.0.0',
  category: 'delivery',
  kinds: ['delivery.missing-rollback-path'],
  detect({ graph: g }) {
    const out = [];
    for (const j of g.nodes('job').filter((n) => n.attrs.deploy_signal && n.attrs.deploys?.length).sort(byId)) {
      const wf = g.node(j.attrs.workflow);
      const siblings = (g.out(j.attrs.workflow, 'CONTAINS') ?? []).map((e) => g.node(e.to)).filter(Boolean);
      const text = [
        j.name, wf?.name, ...(wf?.attrs.step_signatures ?? []), ...(j.attrs.deploy_evidence ?? []),
        ...siblings.flatMap((s) => [s.name, s.id.split('#').pop()]),
      ].join('\n');
      if (ROLLBACK_HINT.test(text)) continue;
      out.push(draft({
        kind: 'delivery.missing-rollback-path',
        title: `Deploy job ${j.name} has no visible rollback, blue-green or canary step`,
        scope: [j.path ?? j.id],
        key: `job:${j.id}`,
        evidence: [{ ref: j.id, label: 'inferred', summary: `Deploys ${j.attrs.deploys.join(', ')}; no step, job or workflow name mentions rollback/revert/canary/blue-green`, source_ref: j.provenance?.[0]?.source_ref ?? null }],
        measurements: { 'ci.present': 1 },
        thresholds: { name_based_inference: true },
        why_accidental: 'A deploy that can only move forward turns every bad release into an incident with no rehearsed way back.',
        essential_considerations: ['The platform (Argo Rollouts, Helm atomic, serverless aliases) may roll back outside this pipeline'],
        smallest_simplification: 'Add a manual rollback job that redeploys the previous artifact version; leave the deploy job unchanged.',
        invariants: ['Forward deploy behaviour unchanged'],
        risks: ['Rollback after a destructive migration needs the expand/contract pattern'],
        verification: ['Rehearse the rollback job in staging'],
        factors: { benefit: 3, evidence: 0.3, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 4 },
        uncertainties: ['Low confidence: judged from names, not step bodies', 'Rollback may be handled by the deploy platform'],
        alternatives: [{ id: 'retain', summary: 'Keep as is if the platform provides rollback; record where.' }, { id: 'rollback-job', summary: 'Add a rollback job.' }, { id: 'canary', summary: 'Adopt progressive delivery.' }],
        patterns: ['infrastructure.rolling-canary-bluegreen-rollout', 'migration.blue-green', 'migration.canary-release'],
      }));
    }
    return out;
  },
};

const unusedFlags = {
  id: 'delivery.unused-feature-flags',
  version: '1.0.0',
  category: 'delivery',
  kinds: ['delivery.unused-feature-flags'],
  detect({ graph: g }) {
    // Without any code-side flag references recorded we cannot tell unused from unscanned.
    const scanned = g.nodes('module').some((m) => Array.isArray(m.attrs.flags)) || g.nodes('feature_flag').some((f) => f.attrs.referenced_in);
    const out = [];
    for (const f of g.nodes('feature_flag').sort(byId)) {
      const refs = f.attrs.reference_count ?? f.attrs.referenced_in?.length ?? g.in(f.id, 'DEPENDS_ON').length;
      const archived = f.attrs.archived === true;
      if (!(archived || (scanned && !refs))) continue;
      out.push(draft({
        kind: 'delivery.unused-feature-flags',
        title: archived ? `Flag ${f.name} is archived but still defined${refs ? ` and referenced in ${refs} place(s)` : ''}` : `Flag ${f.name} has no references in code`,
        scope: [f.path ?? f.id],
        key: `flag:${f.id}`,
        evidence: [{ ref: f.id, label: archived ? 'observed' : 'inferred', summary: archived ? 'Archived in the flag definition' : 'No module references this flag key', source_ref: f.path ?? null }],
        measurements: { 'symbol.references': refs },
        thresholds: { references: 0 },
        why_accidental: 'A flag that is archived or never read is dead configuration and, if still referenced, a hidden code path.',
        essential_considerations: ['Flags read by non-scanned languages, mobile clients or other repositories will look unreferenced'],
        smallest_simplification: archived && refs ? 'Remove the remaining checks keeping the archived (off) branch, then delete the definition.' : 'Delete the flag definition after confirming no other consumer reads it.',
        invariants: ['Behaviour equals the flag current default for every environment'],
        risks: ['Another repository or client may still evaluate the flag'],
        verification: ['Search other repositories and client code for the key', 'Run the suite with the flag removed'],
        blast_radius: 'local',
        factors: { benefit: 2, evidence: archived ? 0.8 : 0.5, reversibility: 0.9, blast: 1, cost: 1, uncertainty: 2 },
        uncertainties: archived ? [] : ['Reference scanning covers only mapped languages'],
        alternatives: [{ id: 'retain', summary: 'Keep the flag and document its consumer.' }, { id: 'remove', summary: 'Delete the flag.' }],
        patterns: ['migration.feature-flags'],
      }));
    }
    return out;
  },
};

const broadPermissions = {
  id: 'delivery.broad-ci-permissions',
  version: '1.0.0',
  category: 'delivery',
  kinds: ['delivery.broad-ci-permissions'],
  detect({ graph: g }) {
    return g.nodes('workflow').filter((w) => w.attrs.permissions_broad === true).sort(byId).map((w) => {
      const explicit = w.attrs.permissions === 'write-all';
      const jobs = g.out(w.id, 'CONTAINS').map((e) => g.node(e.to)).filter((j) => j?.attrs.permissions_broad === true).map((j) => j.name);
      return draft({
        kind: 'delivery.broad-ci-permissions',
        title: `${w.path} ${explicit ? 'grants write-all' : 'sets no top-level permissions (token defaults apply)'}`,
        scope: [w.path],
        key: `workflow:${w.id}`,
        evidence: [{ ref: w.id, label: 'observed', summary: explicit ? 'permissions: write-all' : 'No permissions block at workflow or job level', source_ref: w.path }],
        measurements: { 'ci.present': 1 },
        thresholds: { allowed: 'explicit least-privilege permissions' },
        why_accidental: 'The default or write-all token lets any step, including third-party actions, push code or alter releases.',
        essential_considerations: ['Release jobs need specific write scopes; grant them per job'],
        smallest_simplification: 'Add top-level `permissions: contents: read` and grant extra scopes only on the jobs that need them.',
        invariants: ['Every job still has the scopes it uses'],
        risks: ['A job that silently relied on the default token fails until its scope is added'],
        verification: ['Run each job on a branch; fix any 403 by adding the one scope it needs'],
        quality_impacts: { changeability: 'low', reliability: 'low', security: 'high' },
        factors: { benefit: 3, evidence: 0.85, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 2 },
        uncertainties: [`The repository or organisation setting may already restrict the default token${jobs.length ? `; broad jobs: ${jobs.join(', ')}` : ''}`],
        alternatives: [{ id: 'retain', summary: 'Keep and rely on the organisation default token setting.' }, { id: 'least-privilege', summary: 'Declare read-only permissions at the top.' }],
        patterns: ['infrastructure.policy-as-code'],
      });
    });
  },
};

export default [lockstep, duplicatedPipelines, missingHealthChecks, missingRollback, unusedFlags, broadPermissions];
