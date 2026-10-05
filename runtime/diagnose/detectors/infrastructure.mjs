// Infrastructure detectors (spec §15.5). They consume IaC facts (declared, planned, recorded
// and drift states, §15.4) and Kubernetes manifest facts. They propose findings only: nothing
// here applies, destroys or refreshes anything, and a simplification never weakens security,
// reliability or recovery (§15.1: "fewer resources are not automatically better").
// Retirement advice always depends on owner evidence (`resource.owner_known`) and says so.

const THRESHOLDS = { duplicate_similarity: 0.8, duplicate_similarity_is_heuristic: true };
const PUBLIC_BY_DESIGN_PORTS = new Set(['80', '443']);
const LONG_LIVED_KEY_TYPES = /^(aws_iam_access_key|google_service_account_key|azuread_(service_principal|application)_password|azurerm_storage_account_key)$/;
const PROTECTED_NODE_TYPES = new Set(['database', 'volume', 'bucket', 'backup_vault', 'snapshot']);
const WORKLOAD_LONG_RUNNING = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
const MESH_PROXY = /(istio|envoy|linkerd)/i;

// -------------------------------------------------------------------------------- helpers

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const evidence = (ref, summary, label = 'observed', source_ref = null) => ({ ref, label, summary, source_ref });
const scopeOf = (...nodes) => [...new Set(nodes.map((n) => n?.path).filter(Boolean))];

/** IaC resources are emitted twice (`resource:K` and a typed twin `bucket:K`) with one key. */
function twinsOf(id) {
  const key = id.slice(id.indexOf(':') + 1);
  return [id, `resource:${key}`];
}

/** 1 when an OWNED_BY edge names an owner for the resource, else 0 (absence is the signal). */
const hasOwnership = new WeakMap();

/**
 * 1 when the resource has a recorded owner, 0 when ownership is recorded elsewhere but not
 * for it, and undefined (unmeasured) when the repository records no ownership at all: then
 * "no owner" is unknown, not a fact, and must not make every pattern look contraindicated.
 */
function ownerKnown(graph, id) {
  if (!hasOwnership.has(graph)) hasOwnership.set(graph, graph.edges('OWNED_BY').length > 0);
  if (!hasOwnership.get(graph)) return undefined;
  return twinsOf(id).some((t) => graph.out(t, 'OWNED_BY').length > 0) ? 1 : 0;
}

/** 1 when a restore test is recorded anywhere in the graph, else 0. */
function restoreTested(graph) {
  return graph.nodes('restore_test').length > 0 ? 1 : 0;
}

function draft(d) {
  return {
    thresholds: THRESHOLDS,
    essential_considerations: [],
    invariants: [],
    risks: [],
    verification: [],
    uncertainties: [],
    blast_radius: 'bounded',
    quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'medium' },
    ...d,
    ...(d.measurements && { measurements: Object.fromEntries(Object.entries(d.measurements).filter(([, v]) => v !== undefined)) }),
    ...(d.measurements && Object.values(d.measurements).includes(undefined) && { uncertainties: [...(d.uncertainties ?? []), 'No ownership is recorded in this repository (CODEOWNERS, catalog or tags), so whether the affected resources have owners is unknown.'] }),
    alternatives: [{ id: 'retain', summary: 'Keep the current declaration, record the reason and an owner, and revisit if the measured cost grows.' }, ...(d.alternatives ?? [])],
  };
}

function detector(name, detect) {
  return { id: `infrastructure.${name}`, version: '1.0.0', category: 'infrastructure', kinds: [`infrastructure.${name}`], detect };
}

const INV = {
  behaviour: 'Observable behaviour, traffic paths and availability of the workload are unchanged.',
  security: 'No change widens privileges, network reachability or secret exposure.',
  recovery: 'Backups, retention and the recovery role of every resource are preserved and a restore is demonstrable.',
  state: 'Source, recorded state and actual inventory agree after the change (no hidden drift).',
  owner: 'An owner is recorded for each affected resource before anything is retired or replaced.',
};

const NO_APPLY = 'Unknot proposes only; apply goes through the organisation delivery system, never directly against cloud or cluster state.';

// -------------------------------------------------------------------------------- Duplication and sprawl

const copyPastedStacks = detector('copy-pasted-stacks', ({ graph }) => {
  const out = [];
  const seen = new Set();
  for (const stack of graph.nodes('iac_module')) {
    const dups = stack.attrs.duplicate_of;
    if (!Array.isArray(dups) || !dups.length) continue;
    const group = [stack.id, ...dups].sort();
    const key = group.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const sim = num(stack.attrs.duplicate_similarity) ?? 0;
    const members = group.map((id) => graph.node(id)).filter(Boolean);
    out.push(draft({
      kind: 'infrastructure.copy-pasted-stacks',
      title: `${stack.name} is near-identical to ${dups.map((d) => d.replace('iac_module:', '')).join(', ')} (similarity ${sim})`,
      scope: scopeOf(...members),
      key,
      evidence: members.map((m) => evidence(m.id, `${m.attrs.resources ?? '?'} resources, backend ${m.attrs.backend ?? 'unknown'}`, 'observed', m.path)),
      measurements: { 'duplication.similarity': sim, 'duplication.instances': group.length, 'resource.owner_known': ownerKnown(graph, stack.id) },
      thresholds: { ...THRESHOLDS, basis: 'multiset Jaccard of resource types per environment directory' },
      why_accidental: 'Copies drift apart: a fix in one environment is forgotten in another, and reviewers must diff whole stacks to find the intended difference.',
      essential_considerations: ['Environments may intentionally differ in size, region or account; similarity is by resource types only.', 'Separate state per environment is a deliberate blast-radius boundary and must stay.'],
      smallest_simplification: 'Extract the shared resources into one module consumed by each environment with explicit variables; keep one state and one backend per environment.',
      invariants: [INV.state, INV.behaviour, INV.recovery, 'Each environment keeps its own state, credentials and approval path.'],
      risks: ['Extraction moves resource addresses; without moved blocks Terraform plans destroy-and-recreate of stateful resources.', 'A shared module couples release timing of environments unless versions are pinned per environment.'],
      verification: ['Run fmt/validate/lint and policy checks.', 'Generate a plan per environment: every resource must show no-op with moved blocks, zero deletes and replaces.', 'Review the plan tied to commit and state serial; two-person approval if any stateful address moves.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Declarations revert with the commit as long as the plan shows no state surgery.' },
      blast_radius: 'moderate',
      quality_impacts: { changeability: 'high', reliability: 'medium', security: 'low' },
      factors: { benefit: 3, evidence: 0.7, reversibility: 0.7, blast: 3, cost: 3, uncertainty: 2 },
      uncertainties: ['Near-identical type lists do not prove identical settings.'],
      alternatives: [{ id: 'extract-module', summary: 'Extract a shared module.' }, { id: 'document-differences', summary: 'Keep separate copies and generate a diff report in CI.' }],
      patterns: ['infrastructure.extract-iac-module', 'anti-pattern.copy-paste-programming'],
    }));
  }
  return out;
});

const oneUseWrapperModule = detector('one-use-wrapper-module', ({ graph }) => {
  const out = [];
  for (const mod of graph.nodes('iac_module')) {
    const a = mod.attrs;
    if (a.kind !== 'module' || a.one_use !== true || a.wrapper !== true) continue;
    out.push(draft({
      kind: 'infrastructure.one-use-wrapper-module',
      title: `Module ${mod.name} is used once and declares no resources of its own`,
      scope: scopeOf(mod),
      key: mod.id,
      evidence: [evidence(mod.id, `0 resources, ${a.module_calls} module call(s), ${a.variables} variable(s), used by 1 stack`, 'inferred', mod.path)],
      measurements: { 'resource.owner_known': ownerKnown(graph, mod.id) },
      thresholds: { ...THRESHOLDS, rule: 'local module, exactly one caller, no resources, at least one inner module call' },
      why_accidental: 'A module that only forwards variables to another module adds a layer to read and version with no standardisation of its own.',
      essential_considerations: ['It may enforce tagging, naming, policy defaults or guardrails through locals the adapter does not inspect.', 'It may be the stable interface the platform team versions for several future callers.'],
      smallest_simplification: 'Call the inner module directly from the one caller, only after confirming the wrapper adds no policy value.',
      invariants: [INV.state, INV.security, INV.behaviour],
      risks: ['Inlining changes resource addresses unless moved blocks are added; stateful resources would otherwise be replaced.', 'Dropping a wrapper that injected defaults silently changes settings.'],
      verification: ['Plan must show zero changes (all no-op) with moved blocks.', 'Diff effective variable values before and after.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Reintroduce the wrapper from version control.' },
      quality_impacts: { changeability: 'medium', reliability: 'low', security: 'low' },
      factors: { benefit: 2, evidence: 0.5, reversibility: 0.8, blast: 2, cost: 2, uncertainty: 3 },
      uncertainties: ['Medium/low confidence: locals, tags and conditional logic inside the wrapper are not examined.'],
      patterns: ['infrastructure.inline-one-use-wrapper-module'],
    }));
  }
  return out;
});

const floatingVersions = detector('floating-versions', ({ graph }) => {
  const out = [];
  // IaC: providers and remote modules per consuming stack.
  const stacks = new Map();
  const normSource = (x) => String(x ?? '').toLowerCase().replace(/^registry\.(?:terraform\.io|opentofu\.org)\//, '');
  const slot = (stackId) => {
    if (!stacks.has(stackId)) stacks.set(stackId, { providers: [], modules: [], pinnedOpen: [] });
    return stacks.get(stackId);
  };
  for (const dep of graph.nodes('dependency')) {
    if (dep.attrs.kind !== 'provider' || dep.attrs.pinned !== 'unpinned') continue;
    const stackId = `iac_module:${dep.attrs.dir ?? '.'}`;
    const stack = graph.node(stackId);
    const src = normSource(dep.attrs.source);
    const openEnded = /^\s*>=?\s*\d/.test(dep.attrs.constraint ?? '');
    const locked = (stack?.attrs?.locked_providers ?? []).some((l) => normSource(l.source) === src);
    // A reusable module states a minimum version; pinning belongs to the root's lock file.
    if (stack?.attrs?.child_module && openEnded) continue;
    if (locked) {
      // A root module with an open-ended constraint is reproducible through its lock file,
      // but HashiCorp recommends ~> there: `init -upgrade` can jump a major version.
      if (openEnded) slot(stackId).pinnedOpen.push(dep);
      continue;
    }
    slot(stackId).providers.push(dep);
  }
  for (const e of graph.edges('DEPENDS_ON')) {
    const target = graph.node(e.to);
    if (target?.type === 'iac_module' && target.attrs.remote && target.attrs.pinned === 'unpinned' && e.from.startsWith('iac_module:') && e.attrs.call) slot(e.from).modules.push({ target, call: e.attrs.call, source: e.attrs.source });
  }
  for (const [stackId, s] of stacks) {
    const stack = graph.node(stackId);
    if (s.pinnedOpen.length) {
      out.push(draft({
        kind: 'infrastructure.floating-versions',
        title: `${stack?.name ?? stackId} has ${s.pinnedOpen.length} provider(s) with an open-ended >= constraint; the lock file pins the exact version, the risk is a major-version jump on terraform init -upgrade`,
        scope: scopeOf(stack, ...s.pinnedOpen),
        key: `${stackId}:iac-open-constraint`,
        evidence: s.pinnedOpen.map((p) => evidence(p.id, `provider ${p.attrs.provider} constraint ${p.attrs.constraint} (pinned by the committed lock file)`, 'observed', p.path)).slice(0, 20),
        measurements: { 'resource.owner_known': stack ? ownerKnown(graph, stack.id) : undefined },
        why_accidental: 'The committed lock file keeps ordinary init reproducible, but a root module with >= lets terraform init -upgrade select a new major version.',
        essential_considerations: ['Reusable (child) modules should keep minimum-only constraints.', 'The lock file already pins the exact version for ordinary init.'],
        smallest_simplification: 'Use a pessimistic (~>) constraint in the root module and keep committing the lock file.',
        invariants: [INV.state],
        risks: ['A ~> constraint blocks major upgrades until the constraint is raised deliberately.'],
        verification: ['terraform init -lockfile=readonly in CI.', 'Plan after tightening must equal the plan before for the same state.', NO_APPLY],
        recovery: { type: 'revert', notes: 'Version constraints revert with the commit.' },
        quality_impacts: { changeability: 'low', reliability: 'low', security: 'low' },
        factors: { benefit: 1, evidence: 0.8, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 1 },
        patterns: ['infrastructure.pin-artifact-digests'],
      }));
    }
    if (!s.providers.length && !s.modules.length) continue;
    const refs = [...s.providers.map((p) => p.id), ...s.modules.map((m) => m.target.id)];
    out.push(draft({
      kind: 'infrastructure.floating-versions',
      title: `${stack?.name ?? stackId} has ${s.providers.length} unpinned provider(s) and ${s.modules.length} unpinned module(s)`,
      scope: scopeOf(stack, ...s.providers),
      key: `${stackId}:iac`,
      evidence: [...s.providers.map((p) => evidence(p.id, `provider ${p.attrs.provider} constraint ${p.attrs.constraint ?? '(none)'}`, 'observed', p.path)), ...s.modules.map((m) => evidence(m.target.id, `module "${m.call}" source ${m.source} without a version or ref`, 'observed'))].slice(0, 20),
      measurements: { 'resource.owner_known': stack ? ownerKnown(graph, stack.id) : undefined },
      why_accidental: 'An unconstrained version means the next init can pull a breaking release and the same commit no longer produces the same plan.',
      essential_considerations: ['A committed dependency lock file pins providers even without a version constraint.', 'Pinning needs an update process or security fixes stall.'],
      smallest_simplification: 'Add pessimistic (~>) or exact constraints and commit the lock file; pin remote modules by version or ref, and by digest where supported.',
      invariants: [INV.state, INV.security],
      risks: ['First pin may select a version that produces a non-empty plan; review it, do not apply blindly.', 'A frozen version misses security fixes unless an update bot is configured.'],
      verification: ['terraform init -lockfile=readonly in CI.', 'Plan after pinning must equal the plan before for the same state.', 'Run provider and module security checks.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Version constraints revert with the commit.' },
      quality_impacts: { changeability: 'medium', reliability: 'high', security: 'medium' },
      factors: { benefit: 3, evidence: 0.8, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 1 },
      uncertainties: [`A lock file was not inspected for ${refs.length} reference(s).`],
      patterns: ['infrastructure.pin-artifact-digests'],
    }));
  }
  // Kubernetes: container images with no tag or :latest (mutable by definition).
  for (const w of graph.nodes('workload')) {
    const bad = (w.attrs.containers ?? []).filter((c) => c.image_tag_latest || c.image_untagged);
    if (!bad.length) continue;
    out.push(draft({
      kind: 'infrastructure.floating-versions',
      title: `${w.name} runs ${bad.length} container image(s) without a fixed tag or digest`,
      scope: scopeOf(w),
      key: `${w.id}:images`,
      evidence: bad.map((c) => evidence(w.id, `container ${c.name} image ${c.image}`, 'observed', w.path)),
      measurements: { 'resource.owner_known': ownerKnown(graph, w.id) },
      why_accidental: ':latest or an untagged image can change under a running rollout, so rollback and reproduction are not possible.',
      essential_considerations: ['A fixed tag is still mutable; a digest is immutable.'],
      smallest_simplification: 'Reference images by immutable digest (or at least a fixed version tag) produced by the build.',
      invariants: [INV.behaviour, INV.security],
      risks: ['Digests must be updated by the pipeline or deployments stop receiving fixes.', 'Rollout of the pinned version may differ from what is currently running; check the running digest first.'],
      verification: ['Resolve the digest currently running and pin that one.', 'Server-side dry-run of the rendered manifest.', 'Verify provenance and signature of the pinned digest.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Reference revert via GitOps.' },
      quality_impacts: { changeability: 'medium', reliability: 'high', security: 'medium' },
      factors: { benefit: 3, evidence: 0.9, reversibility: 0.9, blast: 2, cost: 1, uncertainty: 1 },
      patterns: ['infrastructure.pin-artifact-digests'],
    }));
  }
  // Dockerfiles: base images on :latest or untagged.
  for (const img of graph.nodes('image')) {
    if (img.attrs.kind !== 'Dockerfile' || !(img.attrs.latest_bases ?? []).length) continue;
    out.push(draft({
      kind: 'infrastructure.floating-versions',
      title: `${img.name} builds from floating base image(s): ${img.attrs.latest_bases.join(', ')}`,
      scope: scopeOf(img),
      key: `${img.id}:bases`,
      evidence: [evidence(img.id, `latest bases: ${img.attrs.latest_bases.join(', ')}`, 'observed', img.path)],
      measurements: {},
      why_accidental: 'Rebuilding the same commit can produce a different image.',
      smallest_simplification: 'Pin base images to a version tag and digest, updated by an automated bot.',
      invariants: [INV.behaviour, INV.security],
      risks: ['Pinned bases miss patches until bumped.'],
      verification: ['Rebuild and compare image contents (SBOM diff).', 'Scan the pinned base for vulnerabilities.'],
      recovery: { type: 'revert' },
      quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'medium' },
      factors: { benefit: 2, evidence: 0.9, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 1 },
      patterns: ['infrastructure.pin-artifact-digests'],
    }));
  }
  return out;
});

// -------------------------------------------------------------------------------- State and drift

/** State backends declared in source (recorded-state summaries have attrs.recorded). */
const declaredBackends = (graph) => graph.nodes('state_backend').filter((b) => !b.attrs.recorded);

const localOrUnencryptedState = detector('local-or-unencrypted-state', ({ graph }) => {
  const out = [];
  for (const b of declaredBackends(graph)) {
    const a = b.attrs;
    const local = a.type === 'local' || a.remote === false;
    const unencrypted = a.encrypt === false;
    if (!local && !unencrypted) continue;
    out.push(draft({
      kind: 'infrastructure.local-or-unencrypted-state',
      title: `State backend ${b.name} is ${local ? 'local' : 'remote but not encrypted'}`,
      scope: scopeOf(b),
      key: b.id,
      evidence: [evidence(b.id, `type ${a.type}, remote ${a.remote}, encrypt ${a.encrypt}${a.implicit ? ' (implicit: no backend block)' : ''}`, a.implicit ? 'inferred' : 'observed', b.path)],
      measurements: { 'resource.owner_known': ownerKnown(graph, b.id) },
      why_accidental: 'State holds secrets and the only copy of resource identity; a laptop file or plaintext object is lost or leaked with it.',
      essential_considerations: ['A scratch or sandbox stack may legitimately use local state.', 'Some remote backends encrypt by default and the setting is not visible.'],
      smallest_simplification: local ? 'Move state to a remote backend with versioning, encryption and locking via a reviewed state migration.' : 'Enable server-side encryption (and a KMS key) on the state bucket.',
      invariants: [INV.state, INV.recovery, INV.security, 'State access is limited to the pipeline role and break-glass operators.'],
      risks: ['State migration (terraform init -migrate-state) is state surgery: a wrong target or concurrent run corrupts it.', 'Re-keying the bucket changes how existing versions are read.'],
      verification: ['Take a verified copy of current state first.', 'After migration, plan must show no changes.', 'Confirm versioning, encryption and access policy of the new backend.', NO_APPLY],
      recovery: { type: 'restore', procedure: 'Restore the pre-migration state copy.', notes: 'State changes are always high risk (spec §15.9).' },
      blast_radius: 'high',
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'high' },
      factors: { benefit: 4, evidence: a.implicit ? 0.7 : 0.9, reversibility: 0.6, blast: 3, cost: 2, uncertainty: 2 },
      uncertainties: a.implicit ? ['Backend is inferred from the absence of a backend block; a CLI -backend-config may supply one.'] : [],
      patterns: ['infrastructure.split-state-by-blast-radius'],
    }));
  }
  return out;
});

const missingStateLocking = detector('missing-state-locking', ({ graph }) => {
  const out = [];
  for (const b of declaredBackends(graph)) {
    const a = b.attrs;
    if (a.locking !== false || a.type === 'local') continue; // local is covered by its own finding
    out.push(draft({
      kind: 'infrastructure.missing-state-locking',
      title: `State backend ${b.name} has no state locking`,
      scope: scopeOf(b),
      key: b.id,
      evidence: [evidence(b.id, `type ${a.type}, locking ${a.locking}, lock mechanism ${a.lock_mechanism ?? 'none'}`, 'observed', b.path)],
      measurements: { 'resource.owner_known': ownerKnown(graph, b.id) },
      why_accidental: 'Two concurrent applies can interleave state writes and corrupt or fork state.',
      essential_considerations: ['A single-writer pipeline with serialised jobs reduces, but does not remove, the risk.'],
      smallest_simplification: 'Enable the backend lock (DynamoDB table or lockfile for S3).',
      invariants: [INV.state, INV.recovery],
      risks: ['A lock table needs IAM permissions; pipeline roles lacking them will fail until updated.', 'A stale lock can block runs; document the force-unlock procedure.'],
      verification: ['Run two plans concurrently in a test workspace and confirm the second waits.', 'Plan after the change must show no resource changes.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Locking can be disabled again; state is unchanged.' },
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
      factors: { benefit: 3, evidence: 0.85, reversibility: 0.9, blast: 2, cost: 1, uncertainty: 1 },
      patterns: ['infrastructure.split-state-by-blast-radius'],
    }));
  }
  return out;
});

const DRIFT_ADVICE = {
  unmanaged: { title: 'exists in the actual inventory but not in recorded state', simplification: 'Decide with the owner: import it with a no-op plan proof, or quarantine it (restrict access, tag) before any retirement.', patterns: ['infrastructure.import-manual-resources', 'infrastructure.quarantine-then-retire-orphans', 'anti-pattern.clickops'] },
  missing: { title: 'is declared in source but absent from recorded state', simplification: 'Check whether it was removed out-of-band, never applied, or moved; reconcile by import or by correcting the declaration after the owner confirms.', patterns: ['infrastructure.import-manual-resources', 'anti-pattern.configuration-drift'] },
  orphaned_in_state: { title: 'is recorded in state but no longer declared', simplification: 'Find the removal commit and owner; either restore the declaration or remove from state through a reviewed state operation.', patterns: ['infrastructure.quarantine-then-retire-orphans', 'anti-pattern.configuration-drift'] },
  attribute_drift: { title: 'differs between recorded state and the actual inventory', simplification: 'Review which side is intended; update the declaration to match the intent or schedule a reviewed correction.', patterns: ['anti-pattern.configuration-drift'] },
  manual_change: { title: 'was changed outside the delivery pipeline', simplification: 'Record who/why, decide to adopt the change into source or revert it through the pipeline.', patterns: ['anti-pattern.clickops', 'anti-pattern.configuration-drift'] },
};

const drift = detector('drift', ({ graph }) => {
  const out = [];
  for (const n of graph.nodes('resource')) {
    const d = n.attrs.drift;
    if (!d || !d.kind) continue;
    const advice = DRIFT_ADVICE[d.kind] ?? DRIFT_ADVICE.attribute_drift;
    const ident = d.address ?? d.id ?? n.name;
    const ownerSeen = ownerKnown(graph, n.id);
    out.push(draft({
      kind: 'infrastructure.drift',
      title: `Drift (${d.kind}): ${ident} ${advice.title}`,
      scope: scopeOf(n),
      key: n.id,
      evidence: [evidence(n.id, `${d.kind}${d.type ? ` ${d.type}` : ''}: ${d.evidence?.note ?? ''}`.trim(), 'observed', n.path)],
      measurements: { 'resource.owner_known': ownerSeen },
      thresholds: { ...THRESHOLDS, source: 'adapter drift comparison of declared, recorded and actual state' },
      why_accidental: 'The declared, recorded and actual states disagree, so the next apply may do something nobody reviewed.',
      essential_considerations: ['Drift is a finding, not an instruction to overwrite actual state: the actual side may be the intended one.', 'An emergency manual fix may be correct and merely undocumented.'],
      smallest_simplification: ownerSeen ? advice.simplification : `${advice.simplification} Do not retire or delete anything until an owner is recorded (${ownerSeen === 0 ? 'resource.owner_known = 0' : 'no ownership is recorded in this repository'}).`,
      invariants: [INV.owner, INV.state, INV.recovery],
      risks: ['Applying the declared state blindly could delete or revert something in use.', 'Importing without a no-op proof can create a plan that replaces the resource.', 'Unmanaged resources may hold data that has no other copy.'],
      verification: ['Read-only refresh of recorded vs actual inventory; no apply.', 'For import: plan must show a no-op for the imported address.', 'Confirm the owner and dependency evidence before any retirement.', NO_APPLY],
      recovery: { type: 'roll_forward', notes: 'Reconcile source and state forward; do not overwrite actual state to "fix" drift.' },
      blast_radius: 'moderate',
      quality_impacts: { changeability: 'medium', reliability: 'high', security: 'medium' },
      factors: { benefit: 3, evidence: 0.75, reversibility: 0.6, blast: 3, cost: 2, uncertainty: 2 },
      uncertainties: [ownerSeen ? 'Owner recorded; confirm it is current.' : 'Owner is unknown: retirement is out of scope until evidence exists.'],
      alternatives: [{ id: 'adopt', summary: 'Adopt the actual state into source after owner review.' }],
      patterns: advice.patterns,
    }));
  }
  return out;
});

// -------------------------------------------------------------------------------- Plans

/** Real plan changes (the `(plan)` summary node has no address). */
const planChanges = (graph) => graph.nodes('plan_action').filter((n) => n.attrs.address);

/** Per-plan counts so measurements describe the whole plan the change belongs to. */
function planTotals(graph) {
  const totals = new Map();
  for (const c of planChanges(graph)) {
    const t = totals.get(c.attrs.plan_hash) ?? { deletes: 0, replaces: 0 };
    if (c.attrs.action === 'delete') t.deletes++;
    if (c.attrs.action === 'replace') t.replaces++;
    totals.set(c.attrs.plan_hash, t);
  }
  return totals;
}

const planScope = (graph, change) => scopeOf(change, ...graph.out(change.id, 'PROVISIONS').map((e) => graph.node(e.to)));

const destructivePlanChange = detector('destructive-plan-change', ({ graph }) => {
  const out = [];
  const totals = planTotals(graph);
  for (const c of planChanges(graph)) {
    const a = c.attrs;
    const critical = ['cluster', 'node_pool'].includes(a.node_type);
    if (!a.destructive || !(a.stateful || critical)) continue;
    const t = totals.get(a.plan_hash) ?? { deletes: 0, replaces: 0 };
    const recoveryReduced = a.recovery_delta?.direction === 'reduced';
    out.push(draft({
      kind: 'infrastructure.destructive-plan-change',
      title: `Plan ${a.action}s ${a.stateful ? 'stateful ' : ''}${a.type} ${a.address}${a.replace_reason ? ` (${a.replace_reason})` : ''}`,
      scope: planScope(graph, c),
      key: c.id,
      evidence: [evidence(c.id, `${a.action} ${a.address}; stateful ${Boolean(a.stateful)}; recovery ${a.recovery_delta?.direction ?? 'unknown'}${a.prevent_destroy_overridden ? '; prevent_destroy would be overridden' : ''}; plan ${String(a.plan_hash).slice(0, 12)} serial ${a.state_serial ?? 'unknown'}`, 'observed', c.path)],
      measurements: { 'plan.deletes': t.deletes, 'plan.replaces': t.replaces, 'resource.owner_known': ownerKnown(graph, c.id) === undefined ? undefined : ownerKnown(graph, c.id) || Number(graph.out(c.id, 'PROVISIONS').some((e) => ownerKnown(graph, e.to))), 'backup.restore_tested': restoreTested(graph) },
      thresholds: { ...THRESHOLDS, rule: 'delete, replace or forget of a stateful, cluster or node-pool resource (always high risk, spec §15.9)' },
      why_accidental: 'A replace caused by an immutable attribute change deletes the data-bearing resource although an in-place or phased path may exist.',
      essential_considerations: ['The deletion may be an intentional decommission.', 'Recreation may be acceptable if data is restored from a tested backup.'],
      smallest_simplification: 'Do not apply. Revert the attribute change that forces replacement, or split into create-new, migrate data, switch, then remove the old resource; keep prevent_destroy and deletion protection on until the last step.',
      invariants: [INV.recovery, INV.owner, INV.state, 'Data in the stateful resource is restorable after the change.'],
      risks: ['Data loss or extended downtime if the replacement is empty.', recoveryReduced ? 'The plan reduces recovery posture (retention/protection) on the same change.' : 'Dependent resources are replaced transitively.', 'Replication, DNS and connection strings change with a replaced endpoint.'],
      verification: [
        'Two-person approval including the resource owner.',
        'Saved plan tied to commit, state serial and environment.',
        'Dependency and recovery-role evidence for the resource.',
        'Backup/restore or recreation proof: a restore into an isolated instance succeeded.',
        'Staged execution where possible, with abort thresholds and an observation period.',
        'Post-change proof (inventory matches plan) and a signed audit event.',
      ],
      recovery: { type: 'restore', procedure: 'Recover data and state from the tested backup; recreate the resource from the previous declaration.', notes: 'Rollback semantics: restore or recreate (spec §15.10); "apply the old commit" is not accepted without evidence.' },
      blast_radius: 'high',
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'medium' },
      factors: { benefit: 4, evidence: a.detail_level === 'opaque' ? 0.6 : 0.9, reversibility: 0.1, blast: 5, cost: 3, uncertainty: 2 },
      uncertainties: a.unknown_values ? [`${a.unknown_values} planned value(s) are unknown until apply.`] : [],
      alternatives: [{ id: 'create-before-destroy', summary: 'Create the replacement first, migrate data, then retire the old resource.' }],
    }));
  }
  return out;
});

const privilegeWideningPlan = detector('privilege-widening-plan', ({ graph }) => {
  const out = [];
  for (const c of planChanges(graph)) {
    const a = c.attrs;
    if (a.privilege_delta !== 'widened' && !a.wildcard_privilege_added) continue;
    out.push(draft({
      kind: 'infrastructure.privilege-widening-plan',
      title: `Plan widens privileges on ${a.address}${a.wildcard_privilege_added ? ' (new wildcard or admin)' : ''}`,
      scope: planScope(graph, c),
      key: c.id,
      evidence: [evidence(c.id, `${a.action} ${a.type}: privilege_delta ${a.privilege_delta}, wildcard added ${Boolean(a.wildcard_privilege_added)}`, 'observed', c.path)],
      measurements: { 'iam.wildcards': a.wildcard_privilege_added ? 1 : 0, 'resource.owner_known': ownerKnown(graph, c.id) },
      why_accidental: 'Permissions grew in a change that was reviewed as something else, with no stated need for the extra access.',
      essential_considerations: ['A new capability may legitimately need broader access; widening should be scoped to the needed actions and resources.'],
      smallest_simplification: 'Replace the widened statement with the exact actions and resources observed in use.',
      invariants: [INV.security, 'Least privilege: no new wildcard action, wildcard resource or trust principal without a recorded reason.'],
      risks: ['Over-narrowing breaks the workload at runtime; verify with a policy simulator and access analysis.', 'IAM changes are always high risk and need a security owner (spec §15.9).'],
      verification: ['Two-person approval including the security owner.', 'Policy simulator or access analyser against the new policy.', 'Saved plan tied to commit and state serial.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Re-apply the previous policy document; assume the wider access was usable in the meantime.' },
      blast_radius: 'high',
      quality_impacts: { changeability: 'low', reliability: 'low', security: 'high' },
      factors: { benefit: 4, evidence: 0.85, reversibility: 0.8, blast: 4, cost: 2, uncertainty: 2 },
      patterns: ['infrastructure.policy-as-code', 'infrastructure.workload-identity'],
    }));
  }
  return out;
});

// -------------------------------------------------------------------------------- Exposure and identity

const publicExposure = detector('public-exposure', ({ graph }) => {
  const out = [];
  const emit = (node, summary, extra = {}) => out.push(draft({
    kind: 'infrastructure.public-exposure',
    title: `${node.name} is reachable from the public internet`,
    scope: scopeOf(node),
    key: node.id,
    evidence: [evidence(node.id, summary, 'observed', node.path)],
    measurements: { 'network.public_ingress': 1, 'resource.owner_known': ownerKnown(graph, node.id) },
    why_accidental: 'Public reachability is the default of the declaration, not a recorded decision, so exposure is wider than the service needs.',
    essential_considerations: ['A public web front end or API is intentionally exposed; the question is whether the exposure is minimal and protected (TLS, WAF, rate limits).', 'Removing public access can break clients, health checks or partner integrations.'],
    smallest_simplification: extra.simplification ?? 'Restrict the source ranges to the required CIDRs or place the endpoint behind a load balancer or private endpoint; keep a recorded exception if the exposure is by design.',
    invariants: [INV.security, INV.behaviour, 'Legitimate clients keep access.'],
    risks: ['Tightening ingress locks out clients that were silently relying on it.', 'Firewall, route, DNS and gateway changes are always high risk (spec §15.9).'],
    verification: ['Enumerate real sources from flow logs before narrowing.', 'Plan must show only the intended rule change.', 'Run an external reachability test from an allowed and a blocked source.', NO_APPLY],
    recovery: { type: 'revert', notes: 'Rule changes revert quickly; verify clients afterwards.' },
    blast_radius: 'moderate',
    quality_impacts: { changeability: 'low', reliability: 'medium', security: 'high' },
    factors: { benefit: 4, evidence: extra.evidence ?? 0.8, reversibility: 0.85, blast: 3, cost: 2, uncertainty: extra.uncertainty ?? 2 },
    uncertainties: extra.uncertainties ?? [],
    patterns: ['infrastructure.network-segmentation', 'infrastructure.private-endpoints'],
  }));

  for (const f of graph.nodes('firewall_rule')) {
    const a = f.attrs;
    if (a.public_ingress === true) {
      const ports = (a.ports ?? []).map(String);
      const byDesign = ports.length > 0 && ports.every((p) => PUBLIC_BY_DESIGN_PORTS.has(p));
      emit(f, `public ingress from ${(a.cidrs ?? []).join(', ')} on ports ${ports.join(', ') || 'unspecified'}${a.wildcard_ports ? ' (wildcard ports)' : ''}`, {
        evidence: byDesign ? 0.5 : a.wildcard_ports ? 0.95 : 0.8,
        uncertainty: byDesign ? 3 : 2,
        uncertainties: byDesign ? ['Ports 80/443 open to the world are commonly intentional for a public front end.'] : [],
      });
    } else if (a.kind === 'NetworkPolicy' && (a.ingress_rules ?? []).some((r) => (r.peers ?? []).some((p) => p.ip_block?.cidr === '0.0.0.0/0'))) {
      emit(f, 'NetworkPolicy ingress allows 0.0.0.0/0', { evidence: 0.8 });
    }
  }
  for (const s of graph.nodes('service')) {
    if (s.attrs.kind !== 'Service' || !['LoadBalancer', 'NodePort'].includes(s.attrs.type)) continue;
    emit(s, `Service type ${s.attrs.type} exposes ports ${(s.attrs.ports ?? []).map((p) => p.port).join(', ')}`, {
      evidence: s.attrs.type === 'LoadBalancer' ? 0.6 : 0.5,
      uncertainty: 3,
      simplification: 'Use an internal load balancer annotation or ClusterIP behind a governed ingress, with a recorded exception if the exposure is by design.',
      uncertainties: ['Cloud load balancers may be internal by annotation; the adapter records only the Service type.'],
    });
  }
  for (const b of graph.nodes('bucket')) {
    const a = b.attrs;
    if (a.data) continue;
    if (/^public/i.test(String(a.acl ?? '')) || a.allow_blob_public_access === true) {
      emit(b, `bucket is public (acl ${a.acl ?? 'n/a'}${a.allow_blob_public_access ? ', blob public access allowed' : ''})`, { evidence: 0.9, simplification: 'Block public access on the bucket and serve public assets through a CDN with origin access control; keep a recorded exception if the content is meant to be public.' });
    }
  }
  for (const d of graph.nodes('database')) {
    if (d.attrs.data || d.attrs.publicly_accessible !== true) continue;
    emit(d, 'database instance is publicly accessible', { evidence: 0.9, simplification: 'Set publicly_accessible = false and reach the database through the private network or a brokered access path.' });
  }
  return out;
});

const iamWildcards = detector('iam-wildcards', ({ graph }) => {
  const out = [];
  for (const n of [...graph.nodes('role'), ...graph.nodes('policy'), ...graph.nodes('identity')]) {
    const a = n.attrs;
    if (a.builtin) continue;
    let hits;
    if (Array.isArray(a.wildcard_actions)) {
      if (!a.wildcard_actions.length && !a.wildcard_resources && !a.admin) continue;
      hits = { wildcards: a.wildcard_actions.length + (a.wildcard_resources ? 1 : 0), admin: Boolean(a.admin), text: `wildcard actions [${a.wildcard_actions.join(', ')}], wildcard resources ${Boolean(a.wildcard_resources)}, admin ${Boolean(a.admin)}` };
    } else if (a.kind === 'Role' || a.kind === 'ClusterRole') {
      if (!a.wildcard_verbs && !a.wildcard_resources && !a.cluster_admin && !a.escalation_risk) continue;
      hits = { wildcards: Number(Boolean(a.wildcard_verbs)) + Number(Boolean(a.wildcard_resources)), admin: Boolean(a.cluster_admin || a.namespace_admin), text: `RBAC wildcard verbs ${Boolean(a.wildcard_verbs)}, wildcard resources ${Boolean(a.wildcard_resources)}, escalation risk ${Boolean(a.escalation_risk)}` };
    } else continue;
    out.push(draft({
      kind: 'infrastructure.iam-wildcards',
      title: `${n.name} grants ${hits.admin ? 'administrator-level' : 'wildcard'} access`,
      scope: scopeOf(n),
      key: n.id,
      evidence: [evidence(n.id, hits.text, 'observed', n.path)],
      measurements: { 'iam.wildcards': hits.wildcards, 'resource.owner_known': ownerKnown(graph, n.id) },
      why_accidental: 'A wildcard replaces the work of listing what is needed, and its blast radius grows with every new service the account adds.',
      essential_considerations: ['A break-glass or CI role that provisions everything may legitimately be broad; it should be time-bound and audited.', 'Some services (for example logs:*) need a resource wildcard.'],
      smallest_simplification: 'Replace wildcards with the actions and resources observed in use (access advisor, CloudTrail or audit logs), keeping the old policy available until the workload is verified.',
      invariants: [INV.security, 'Existing workloads keep every permission they actually use.'],
      risks: ['Over-narrowing causes runtime AccessDenied; use a policy simulator and a staged rollout.', 'IAM changes are always high risk and need a security owner (spec §15.9).'],
      verification: ['Policy simulator against recorded actions.', 'Access-analyser or audit log comparison over a full cycle.', 'Plan shows only the policy change.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Restore the previous policy document if a runtime denial appears.' },
      blast_radius: 'moderate',
      quality_impacts: { changeability: 'low', reliability: 'low', security: 'high' },
      factors: { benefit: 4, evidence: 0.9, reversibility: 0.8, blast: 3, cost: 2, uncertainty: 2 },
      patterns: ['infrastructure.policy-as-code', 'infrastructure.workload-identity'],
    }));
  }
  return out;
});

const longLivedKeys = detector('long-lived-keys', ({ graph }) => {
  const out = [];
  for (const r of graph.nodes('resource')) {
    if (r.attrs.data || !LONG_LIVED_KEY_TYPES.test(String(r.attrs.type ?? ''))) continue;
    out.push(draft({
      kind: 'infrastructure.long-lived-keys',
      title: `${r.name} creates a long-lived credential`,
      scope: scopeOf(r),
      key: r.id,
      evidence: [evidence(r.id, `${r.attrs.type} issues a static key that does not expire; its value is also stored in state`, 'observed', r.path)],
      measurements: { 'resource.owner_known': ownerKnown(graph, r.id) },
      why_accidental: 'A static key outlives the person and pipeline that created it and sits in state and logs; short-lived workload identity avoids it.',
      essential_considerations: ['A third-party system without OIDC federation may need a key; then rotate and scope it tightly.'],
      smallest_simplification: 'Replace with workload identity or role assumption (OIDC federation); until then rotate the key on a schedule and scope its policy.',
      invariants: [INV.security, 'The consuming system keeps working throughout rotation (two valid credentials during the overlap).'],
      risks: ['Deleting the key outright breaks the consumer immediately.', 'Key rotation needs the secret store and consumer to be updated in order.'],
      verification: ['Identify every consumer of the key from the credential report.', 'Dry-run the federation path before removing the key.', 'Confirm the key never appears in logs, source or images.', NO_APPLY],
      recovery: { type: 'roll_forward', notes: 'A removed key cannot be restored; issue a new one and update consumers.' },
      quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'high' },
      factors: { benefit: 4, evidence: 0.85, reversibility: 0.5, blast: 2, cost: 3, uncertainty: 2 },
      patterns: ['infrastructure.workload-identity'],
    }));
  }
  return out;
});

// -------------------------------------------------------------------------------- Kubernetes workloads

/** Long-running workloads; Jobs, CronJobs and bare Pods do not use disruption budgets or rollouts. */
const longRunning = (graph) => graph.nodes('workload').filter((w) => WORKLOAD_LONG_RUNNING.has(w.attrs.kind));

const missingDisruptionBudget = detector('missing-disruption-budget', ({ graph }) => {
  const out = [];
  for (const w of longRunning(graph)) {
    const a = w.attrs;
    const replicas = num(a.replicas) ?? num(a.autoscaling?.min) ?? 1;
    if (replicas <= 1 || a.pdb) continue;
    out.push(draft({
      kind: 'infrastructure.missing-disruption-budget',
      title: `${w.name} runs ${replicas} replicas with no PodDisruptionBudget`,
      scope: scopeOf(w),
      key: w.id,
      evidence: [evidence(w.id, `replicas ${replicas}, no PDB selects its pods`, 'observed', w.path)],
      measurements: { 'resource.owner_known': ownerKnown(graph, w.id) },
      why_accidental: 'Voluntary disruptions (node drains, upgrades) can evict every replica at once.',
      essential_considerations: ['A PDB on a single-replica workload blocks node drains; replicas > 1 is the condition used.', 'Stateless batch-like workloads may tolerate full eviction.'],
      smallest_simplification: 'Add a PodDisruptionBudget with minAvailable or maxUnavailable that leaves at least one pod serving.',
      invariants: [INV.behaviour, 'Node maintenance can still proceed (budget not set to zero disruptions).'],
      risks: ['An over-strict PDB blocks cluster upgrades and autoscaler scale-down.', 'A selector mismatch makes the PDB protect nothing.'],
      verification: ['Server-side dry-run of the manifest.', 'Check allowed disruptions > 0 after creation.', 'Drain a test node and watch availability.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Delete the PDB.' },
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
      factors: { benefit: 3, evidence: 0.85, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 1 },
    }));
  }
  return out;
});

const missingProbes = detector('missing-probes', ({ graph }) => {
  const out = [];
  for (const w of longRunning(graph)) {
    const bare = (w.attrs.containers ?? []).filter((c) => !c.probes?.liveness && !c.probes?.readiness && !c.probes?.startup);
    if (!bare.length) continue;
    out.push(draft({
      kind: 'infrastructure.missing-probes',
      title: `${w.name} has ${bare.length} container(s) with no probes (${bare.map((c) => c.name).join(', ')})`,
      scope: scopeOf(w),
      key: w.id,
      evidence: bare.map((c) => evidence(w.id, `container ${c.name} defines no liveness, readiness or startup probe`, 'observed', w.path)),
      measurements: { 'resource.owner_known': ownerKnown(graph, w.id) },
      why_accidental: 'Without a readiness probe traffic reaches pods that are not ready, and a hung process is never restarted.',
      essential_considerations: ['Sidecars (log shippers, proxies) often have no meaningful probe.', 'A wrong liveness probe causes restart loops; readiness first.'],
      smallest_simplification: 'Add a readiness probe to serving containers first; add liveness only for failure modes a restart fixes.',
      invariants: [INV.behaviour, 'A slow-starting application is not killed during startup (use a startup probe).'],
      risks: ['A too-aggressive probe causes restarts or removes healthy pods from rotation during load.', 'Probes hitting a dependency turn a dependency outage into a full outage.'],
      verification: ['Server-side dry-run.', 'Load test the probe endpoint and watch restart counts during a canary.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Remove the probe.' },
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
      factors: { benefit: 3, evidence: 0.8, reversibility: 0.95, blast: 2, cost: 1, uncertainty: 2 },
    }));
  }
  return out;
});

const missingResources = detector('missing-resources', ({ graph }) => {
  const out = [];
  for (const w of longRunning(graph)) {
    const noReq = (w.attrs.containers ?? []).filter((c) => !c.resources?.requests);
    const noLim = (w.attrs.containers ?? []).filter((c) => !c.resources?.limits);
    if (!noReq.length && !noLim.length) continue;
    out.push(draft({
      kind: 'infrastructure.missing-resources',
      title: `${w.name}: ${noReq.length} container(s) without resource requests, ${noLim.length} without limits`,
      scope: scopeOf(w),
      key: w.id,
      evidence: [...noReq.map((c) => evidence(w.id, `container ${c.name} has no resource requests`, 'observed', w.path)), ...noLim.filter((c) => !noReq.includes(c)).map((c) => evidence(w.id, `container ${c.name} has no resource limits`, 'observed', w.path))],
      measurements: { 'resource.owner_known': ownerKnown(graph, w.id) },
      why_accidental: 'Without requests the scheduler cannot place pods sensibly and the pod is first to be evicted; without limits one pod can starve its neighbours.',
      essential_considerations: ['A namespace LimitRange may supply defaults the adapter does not see.', 'CPU limits can cause throttling; some teams deliberately omit them.'],
      smallest_simplification: 'Set requests from observed p95 usage and a memory limit; add a CPU limit only with evidence.',
      invariants: [INV.behaviour, 'Capacity headroom is not exhausted by the new requests.'],
      risks: ['Memory limits below real peaks cause OOM kills.', 'Higher requests than before reduce schedulable capacity and raise cost.'],
      verification: ['Compare against observed usage metrics.', 'Server-side dry-run and scheduler simulation.', 'Canary and watch OOM/throttling.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Remove or adjust the values.' },
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
      factors: { benefit: 3, evidence: 0.8, reversibility: 0.95, blast: 2, cost: 1, uncertainty: 2 },
      uncertainties: ['LimitRange defaults are not modelled.'],
    }));
  }
  return out;
});

const privilegedWorkloads = detector('privileged-workloads', ({ graph }) => {
  const out = [];
  for (const w of graph.nodes('workload')) {
    const a = w.attrs;
    const reasons = [];
    for (const c of a.containers ?? []) {
      if (c.securityContext?.privileged) reasons.push(`container ${c.name} is privileged`);
      if (c.securityContext?.runAsNonRoot === false) reasons.push(`container ${c.name} explicitly allows root (runAsNonRoot: false)`);
    }
    if (a.host_network) reasons.push('hostNetwork');
    if (a.host_pid) reasons.push('hostPID');
    if (a.host_ipc) reasons.push('hostIPC');
    if ((a.host_path_mounts ?? []).length) reasons.push(`hostPath mounts ${a.host_path_mounts.join(', ')}`);
    if (!reasons.length) continue;
    out.push(draft({
      kind: 'infrastructure.privileged-workloads',
      title: `${w.name} has host-level or root access: ${reasons.join('; ')}`,
      scope: scopeOf(w),
      key: w.id,
      evidence: reasons.map((r) => evidence(w.id, r, 'observed', w.path)),
      measurements: { 'resource.owner_known': ownerKnown(graph, w.id) },
      why_accidental: 'Host access turns a container compromise into a node compromise and couples the workload to a specific host.',
      essential_considerations: ['Node agents (CNI, CSI, log or metrics collectors) legitimately need host access.', 'Some legacy software only runs as root.'],
      smallest_simplification: 'Drop privileged/host settings the workload does not need, add specific capabilities instead of privileged, run as non-root with a read-only root filesystem.',
      invariants: [INV.behaviour, INV.security, 'Required capabilities are listed explicitly and nothing is added.'],
      risks: ['Removing host access breaks features that silently depended on it (ports, device access, kernel tuning).', 'Changing the user can break file permissions on volumes.'],
      verification: ['Run in a staging cluster with the restricted pod security profile.', 'Server-side dry-run against the namespace pod-security level.', 'Smoke test every feature that touched host resources.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Restore the previous securityContext.' },
      quality_impacts: { changeability: 'low', reliability: 'medium', security: 'high' },
      factors: { benefit: 4, evidence: 0.9, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 2 },
    }));
  }
  for (const img of graph.nodes('image')) {
    if (img.attrs.kind !== 'Dockerfile' || img.attrs.final_stage_root !== true) continue;
    out.push(draft({
      kind: 'infrastructure.privileged-workloads',
      title: `${img.name} final stage runs as root`,
      scope: scopeOf(img),
      key: img.id,
      evidence: [evidence(img.id, `final USER ${img.attrs.final_user ?? '(unset)'}`, 'inferred', img.path)],
      measurements: {},
      why_accidental: 'The image defaults to root; most services do not need it.',
      smallest_simplification: 'Add a dedicated non-root USER in the final stage.',
      invariants: [INV.behaviour, INV.security],
      risks: ['File ownership of mounted volumes may need adjusting.'],
      verification: ['Run the container as the new user in CI and exercise write paths.'],
      recovery: { type: 'revert' },
      quality_impacts: { changeability: 'low', reliability: 'low', security: 'high' },
      factors: { benefit: 3, evidence: 0.6, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 2 },
      uncertainties: ['A runtime securityContext may override the image user.'],
    }));
  }
  return out;
});

const meshSidecarWithoutPolicy = detector('mesh-sidecar-without-policy', ({ graph }) => {
  const out = [];
  // The adapter does not parse mesh CRDs, so "no policy objects" is absence of evidence.
  const policyObjects = graph.nodes().some((n) => /^(PeerAuthentication|AuthorizationPolicy|RequestAuthentication|Server|ServerAuthorization|AuthorizationPolicy)$/.test(String(n.attrs?.kind ?? '')));
  if (policyObjects) return out;
  for (const w of graph.nodes('workload')) {
    const proxies = (w.attrs.sidecars ?? []).filter((s) => MESH_PROXY.test(`${s.name} ${s.image}`));
    if (!proxies.length && !w.attrs.sidecar_injection) continue;
    out.push(draft({
      kind: 'infrastructure.mesh-sidecar-without-policy',
      title: `${w.name} carries a mesh sidecar but no mTLS or authorization policy is declared`,
      scope: scopeOf(w),
      key: w.id,
      evidence: [evidence(w.id, `sidecars ${proxies.map((p) => p.name).join(', ') || '(injected)'}; no PeerAuthentication/AuthorizationPolicy objects in the graph`, 'inferred', w.path)],
      measurements: { 'resource.owner_known': ownerKnown(graph, w.id) },
      why_accidental: 'The proxy costs CPU, memory and operational complexity; without policy it delivers none of the security or traffic features that justify it.',
      essential_considerations: ['Policies may be applied by the platform team outside this repository.', 'The mesh may be used for telemetry or traffic shifting only.', 'The adapter does not parse mesh custom resources, so absence is weak evidence.'],
      smallest_simplification: 'Either declare the intended mTLS (STRICT) and authorization policies, or - only with traffic and owner evidence - remove the sidecar; never leave encryption weaker than today.',
      invariants: [INV.security, INV.behaviour, 'Service-to-service traffic stays encrypted where it is today.'],
      risks: ['STRICT mTLS breaks clients outside the mesh.', 'Removing the sidecar drops encryption, retries and telemetry other teams rely on.'],
      verification: ['Inspect live mesh configuration read-only (istioctl analyze / linkerd check).', 'Roll out in PERMISSIVE first and confirm all traffic is mTLS before STRICT.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Policies revert from version control; sidecar removal needs a rollout.' },
      quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'medium' },
      factors: { benefit: 2, evidence: 0.35, reversibility: 0.8, blast: 3, cost: 3, uncertainty: 4 },
      uncertainties: ['Low confidence: policy objects not modelled by the adapter.'],
      alternatives: [{ id: 'declare-policy', summary: 'Declare mTLS and authorization policy explicitly.' }, { id: 'retire-sidecar', summary: 'Retire the sidecar after owner and traffic evidence.' }],
      patterns: ['anti-pattern.cargo-cult-service-mesh'],
    }));
  }
  return out;
});

// -------------------------------------------------------------------------------- Recovery

const backupsWithoutProtection = detector('backups-without-protection', ({ graph }) => {
  const out = [];
  for (const n of graph.nodes()) {
    if (!PROTECTED_NODE_TYPES.has(n.type) || n.attrs.data || !n.attrs.stateful) continue;
    const a = n.attrs;
    const preventDestroy = a.lifecycle?.prevent_destroy === true;
    const deletionProtection = a.deletion_protection === true;
    // Snapshots and vaults have no deletion_protection attribute; only prevent_destroy applies.
    const needsDp = ['database'].includes(n.type);
    if (preventDestroy && (!needsDp || deletionProtection)) continue;
    if (!needsDp && preventDestroy) continue;
    const gaps = [];
    if (needsDp && !deletionProtection) gaps.push(a.deletion_protection === false ? 'deletion_protection = false' : 'deletion_protection not set');
    if (!preventDestroy) gaps.push('no lifecycle prevent_destroy');
    if (a.skip_final_snapshot === true) gaps.push('skip_final_snapshot = true');
    if (a.backup_retention_period === 0) gaps.push('backup retention 0');
    out.push(draft({
      kind: 'infrastructure.backups-without-protection',
      title: `${n.name} (${n.type}) can be destroyed without a guard: ${gaps.join(', ')}`,
      scope: scopeOf(n),
      key: n.id,
      evidence: [evidence(n.id, gaps.join('; '), 'observed', n.path)],
      measurements: { 'backup.restore_tested': restoreTested(graph), 'resource.owner_known': ownerKnown(graph, n.id) },
      why_accidental: 'One mistaken apply, rename or replacement destroys the data-bearing resource and its only copies.',
      essential_considerations: ['Ephemeral, test or derived resources may be meant to be destroyed freely.', 'prevent_destroy blocks planned teardowns and blue/green replacements until it is lifted in a reviewed change.'],
      smallest_simplification: 'Set deletion protection and lifecycle prevent_destroy on the production data resource, and keep a final snapshot; lift them only in the reviewed change that retires it.',
      invariants: [INV.recovery, INV.owner, 'Intentional teardown remains possible through a reviewed, two-person change.'],
      risks: ['Enabling deletion protection is a recovery-posture change and needs a data-owner approval.', 'Pipelines that recreate the resource (blue/green) will fail until updated.', 'prevent_destroy turns a bad replace into a plan error, which is the intent.'],
      verification: ['Plan shows only the protection attribute change.', 'Confirm a recent snapshot exists and a restore has been tested.', 'Run destroy planning in a test workspace and confirm it is blocked.', NO_APPLY],
      recovery: { type: 'revert', notes: 'Protection settings can be lifted again in a reviewed change.' },
      blast_radius: 'moderate',
      quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
      factors: { benefit: 4, evidence: 0.75, reversibility: 0.9, blast: 2, cost: 1, uncertainty: 3 },
      uncertainties: ['Environment (production or not) is not visible; verify before applying.'],
      patterns: ['infrastructure.active-passive-recovery'],
    }));
  }
  return out;
});

export default [
  copyPastedStacks,
  oneUseWrapperModule,
  floatingVersions,
  localOrUnencryptedState,
  missingStateLocking,
  drift,
  destructivePlanChange,
  privilegeWideningPlan,
  publicExposure,
  iamWildcards,
  missingDisruptionBudget,
  missingProbes,
  missingResources,
  privilegedWorkloads,
  meshSidecarWithoutPolicy,
  longLivedKeys,
  backupsWithoutProtection,
];
