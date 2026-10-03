// Security detectors (spec §11.5, §15.11, §16.1). They report where controls are weak
// and how to strengthen or consolidate them. Per spec §2.2 a security finding is never
// "simplified away": no smallest_simplification or alternative here removes a control.
//
// Secrets: the only inputs are kinds and line numbers recorded by the security adapter.
// A value is never available to these detectors, and titles carry kind and location only.

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$/i;
const AUTH_PACKAGE = /(^|\/)(auth|authn|authz|authorization|authentication|security|iam|permissions?|policy|policies|rbac|acl)(\/|\.|$)/i;
const AUTHZ_NAME = /authori[sz]e|checkPermission|check_permission|hasRole|has_role|canAccess|can_access|isAdmin|is_admin/i;

const COMMAND = new Set(['exec-nonliteral', 'spawn-shell', 'shell_true', 'os_system', 'os_popen']);
const INJECTION = new Set(['eval', 'exec', 'new-function', 'vm-run', 'inner-html', 'dangerously-set-inner-html', 'document-write', 'sql-interpolation', 'sql_injection']);
const DESERIAL = new Set(['pickle_load', 'marshal_load', 'yaml_unsafe_load']);

const sortedUniq = (xs) => [...new Set(xs)].sort();
const byId = (a, b) => (a.id < b.id ? -1 : 1);
const isTest = (n) => n.attrs?.is_test === true || TEST_PATH.test(n.path ?? '');
const src = (n) => n.provenance?.[0]?.source_ref ?? null;

function draft(o) {
  return {
    quality_impacts: { changeability: 'low', reliability: 'low', security: 'high' },
    blast_radius: 'bounded',
    recovery: { type: 'revert', notes: 'Hardening changes are reverted by restoring the previous revision; the original control stays in place meanwhile.' },
    uncertainties: [],
    ...o,
  };
}

const secretExposure = {
  id: 'security.secret-exposure',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.secret-exposure'],
  detect({ graph: g }) {
    return g.nodes('file').filter((f) => Array.isArray(f.attrs.secrets) && f.attrs.secrets.length).sort(byId).map((f) => {
      const kinds = sortedUniq(f.attrs.secrets.map((s) => s.kind));
      const lines = f.attrs.secrets.map((s) => s.line).filter((l) => Number.isInteger(l)).sort((a, b) => a - b);
      return draft({
        kind: 'security.secret-exposure',
        title: `Secret-like value (${kinds.join(', ')}) at ${f.path ?? f.name}${lines.length ? `:${lines.slice(0, 3).join(',')}` : ''}`,
        scope: [f.path ?? f.name],
        key: `file:${f.id}`,
        evidence: f.attrs.secrets.slice(0, 10).map((s) => ({ ref: f.id, label: 'observed', summary: `${s.kind} detected`, source_ref: `${f.path ?? f.name}:${s.line ?? 1}` })),
        measurements: { 'secrets.count': f.attrs.secrets.length },
        thresholds: { allowed: 0 },
        why_accidental: 'A credential in the repository is readable by everyone with access, and by history, forks and CI logs.',
        essential_considerations: ['It may be a public key, test fixture or documented placeholder (detection is pattern based)'],
        smallest_simplification: 'Rotate the credential, load it from a secret manager or environment at runtime, and add a pre-commit secret scan. Do not just delete the line; history still holds it.',
        invariants: ['The service keeps authenticating to the same provider with a new credential', 'No secret value is written to logs, findings or proof bundles'],
        risks: ['Rotation can interrupt dependents that still use the old value'],
        verification: ['Secret scan reports zero hits for the file', 'The old credential is revoked at the provider'],
        blast_radius: 'moderate',
        recovery: { type: 'roll_forward', notes: 'A leaked secret cannot be un-leaked; recover by rotating and revoking.' },
        factors: { benefit: 5, evidence: 0.7, reversibility: 0.4, blast: 3, cost: 2, uncertainty: 2 },
        uncertainties: ['Pattern and entropy based; placeholders and test keys can match', 'Whether the value was ever live is unknown'],
        alternatives: [
          { id: 'retain', summary: 'Accept as a non-secret (test value or public key) with a recorded owner and a scan allowlist entry.' },
          { id: 'rotate-and-externalise', summary: 'Rotate, revoke, and read the value from a secret manager.' },
        ],
        patterns: ['infrastructure.workload-identity'],
      });
    });
  },
};

function signalFinding(g, kind, label, set, extra) {
  const out = [];
  for (const m of g.nodes('module').filter((n) => !isTest(n)).sort(byId)) {
    const sigs = (m.attrs.security_signals ?? []).filter((s) => set.has(s.kind));
    if (!sigs.length) continue;
    const kinds = sortedUniq(sigs.map((s) => s.kind));
    out.push(draft({
      kind,
      title: `${m.path}: ${label} (${kinds.join(', ')})`,
      scope: [m.path],
      key: `module:${m.id}`,
      evidence: sigs.slice(0, 10).map((s) => ({ ref: m.id, label: 'observed', summary: `${s.kind}${s.detail ? `: ${String(s.detail).slice(0, 120)}` : ''}`, source_ref: `${m.path}:${s.line ?? 1}` })),
      measurements: { 'security.signals': sigs.length },
      thresholds: { allowed: 0 },
      ...extra,
      uncertainties: ['Static pattern match: input may be constant or validated upstream', 'Data flow from untrusted input is not traced'],
    }));
  }
  return out;
}

const unsafeCommand = {
  id: 'security.unsafe-command-construction',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.unsafe-command-construction'],
  detect({ graph: g }) {
    return signalFinding(g, 'security.unsafe-command-construction', 'command built from non-literal input or run through a shell', COMMAND, {
      why_accidental: 'Building a shell command from variable text lets input become extra commands.',
      essential_considerations: ['Developer tooling that runs trusted arguments may be acceptable'],
      smallest_simplification: 'Pass the executable and arguments as an array without a shell, validate the arguments against an allowlist, and keep any existing input validation.',
      invariants: ['The same command runs for valid input', 'Existing validation and logging remain'],
      risks: ['Callers relying on shell expansion or pipes need explicit handling'],
      verification: ['Test with arguments containing spaces, quotes and `;` and assert they stay literal'],
      factors: { benefit: 4, evidence: 0.6, reversibility: 0.85, blast: 2, cost: 2, uncertainty: 3 },
      alternatives: [{ id: 'retain', summary: 'Accept with a documented reason if the input is constant.' }, { id: 'argv-no-shell', summary: 'Use an argv array and no shell, with allowlisted arguments.' }],
      patterns: ['infrastructure.policy-as-code'],
    });
  },
};

const injection = {
  id: 'security.injection-risk',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.injection-risk'],
  detect({ graph: g }) {
    return signalFinding(g, 'security.injection-risk', 'dynamic code, HTML or SQL assembled from variable text', INJECTION, {
      why_accidental: 'Interpolating values into code, markup or queries lets crafted input change their meaning.',
      essential_considerations: ['Sanitised HTML or an allow-listed identifier can make the pattern safe'],
      smallest_simplification: 'Use parameterised queries, a sanitising renderer or a safe parser at the flagged site, and keep existing escaping and validation in place.',
      invariants: ['Output for benign input is unchanged', 'Existing escaping and validation remain'],
      risks: ['Sanitising may strip markup a feature depends on'],
      verification: ['Add a test with a hostile payload for each flagged site'],
      factors: { benefit: 4, evidence: 0.55, reversibility: 0.85, blast: 2, cost: 2, uncertainty: 3 },
      alternatives: [{ id: 'retain', summary: 'Accept with a documented reason where the input is constant or already sanitised.' }, { id: 'parameterise', summary: 'Use parameterised queries or a sanitising renderer.' }],
      patterns: [],
    });
  },
};

const deserialization = {
  id: 'security.unsafe-deserialization',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.unsafe-deserialization'],
  detect({ graph: g }) {
    return signalFinding(g, 'security.unsafe-deserialization', 'unsafe deserialization', DESERIAL, {
      why_accidental: 'pickle, marshal and non-safe YAML loaders execute code embedded in the data.',
      essential_considerations: ['Data produced and consumed by the same trusted process is lower risk'],
      smallest_simplification: 'Switch to a data-only format (JSON) or the safe loader at the flagged site and add integrity checking (signing) where the data crosses a trust boundary.',
      invariants: ['The data shape read stays the same', 'Integrity checks are added, none removed'],
      risks: ['Stored data in the old format needs a one-time migration'],
      verification: ['Load a crafted payload in a test and assert it is rejected'],
      factors: { benefit: 4, evidence: 0.65, reversibility: 0.7, blast: 2, cost: 2, uncertainty: 3 },
      alternatives: [{ id: 'retain', summary: 'Accept with a documented trust boundary and signed inputs.' }, { id: 'safe-format', summary: 'Use JSON or a safe loader.' }],
      patterns: [],
    });
  },
};

const privilegeSprawl = {
  id: 'security.privilege-sprawl',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.privilege-sprawl'],
  detect({ graph: g }) {
    const out = [];
    const reasonsOf = (a) => {
      const r = [];
      if (a.wildcard_verbs) r.push('wildcard verbs');
      if (a.wildcard_resources) r.push('wildcard resources');
      if (a.cluster_admin) r.push('cluster-admin');
      if (a.pods_exec) r.push('pods/exec');
      if (a.workload_create) r.push('workload create');
      if (a.escalate || a.bind || a.impersonate) r.push('escalate/bind/impersonate');
      if (a.secrets_read && a.kind === 'ClusterRole') r.push('cluster-wide secrets read');
      if (Array.isArray(a.wildcard_actions) && a.wildcard_actions.length) r.push(`wildcard actions ${a.wildcard_actions.slice(0, 3).join(' ')}`);
      if (a.admin === true) r.push('administrator access');
      return r;
    };
    const candidates = ['role', 'policy', 'resource'].flatMap((t) => g.nodes(t)).sort(byId);
    for (const n of candidates) {
      if (n.attrs.builtin && !g.in(n.id, 'ASSUMES').length) continue; // an unbound built-in role grants nothing
      const reasons = reasonsOf(n.attrs);
      if (!reasons.length) continue;
      const assumed = g.in(n.id, 'ASSUMES').map((e) => g.node(e.from)?.name).filter(Boolean).sort();
      const wild = (n.attrs.wildcard_actions?.length ?? 0) + (n.attrs.wildcard_verbs ? 1 : 0) + (n.attrs.wildcard_resources ? 1 : 0);
      out.push(draft({
        kind: 'security.privilege-sprawl',
        title: `${n.name} grants ${reasons.join(', ')}${assumed.length ? ` to ${assumed.join(', ')}` : ''}`,
        scope: [n.path ?? n.id],
        key: `grant:${n.id}`,
        evidence: [{ ref: n.id, label: 'observed', summary: reasons.join('; '), source_ref: src(n) }],
        measurements: { 'iam.wildcards': wild, 'iam.admin': n.attrs.cluster_admin || n.attrs.admin ? 1 : 0 },
        thresholds: { wildcards_allowed: 0 },
        why_accidental: 'Broad grants widen the damage of any compromised workload or credential beyond what the workload actually calls.',
        essential_considerations: ['Platform operators and controllers legitimately need broad access', 'Bootstrap roles may be temporary'],
        smallest_simplification: 'Replace wildcards with the exact verbs and resources observed in use, and bind the narrowed role to the same subjects. Keep audit logging on.',
        invariants: ['Every call the workload makes today is still permitted', 'No new principal gains access'],
        risks: ['A forgotten rarely-used call starts failing; use audit logs or access analyzer to find it first'],
        verification: ['Run the workload suite under the narrowed role', 'Review audit logs for denied calls over a full cycle'],
        blast_radius: 'moderate',
        factors: { benefit: 4, evidence: 0.8, reversibility: 0.8, blast: 3, cost: 2, uncertainty: 2 },
        uncertainties: ['Actual usage of the permission is not known without audit logs', ...(n.attrs.builtin ? ['Built-in role resolved by name'] : [])],
        alternatives: [{ id: 'retain', summary: 'Keep the grant with a documented owner, justification and review date.' }, { id: 'least-privilege', summary: 'Narrow to observed verbs and resources.' }, { id: 'policy-as-code', summary: 'Add a policy check that blocks new wildcards.' }],
        patterns: ['infrastructure.workload-identity', 'infrastructure.policy-as-code'],
      }));
    }
    return out;
  },
};

const unpinned = {
  id: 'security.unpinned-build-inputs',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.unpinned-build-inputs'],
  detect({ graph: g }) {
    const out = [];
    const base = (o) => draft({
      kind: 'security.unpinned-build-inputs',
      thresholds: { pinned_required: true },
      why_accidental: 'A mutable tag or branch lets the upstream owner, or anyone who takes it over, change what your build runs.',
      essential_considerations: ['First-party or internal references may be intentionally floating'],
      invariants: ['The build resolves to the same content it resolves to today'],
      risks: ['Pinned references need an automated update bot to avoid going stale'],
      verification: ['Build passes with the pinned reference', 'An update bot is configured'],
      factors: { benefit: 3, evidence: 0.85, reversibility: 0.95, blast: 2, cost: 1, uncertainty: 2 },
      alternatives: [{ id: 'retain', summary: 'Keep floating and accept the supply-chain risk with an owner.' }, { id: 'pin', summary: 'Pin to an immutable reference and add an update bot.' }],
      patterns: ['infrastructure.pin-artifact-digests'],
      ...o,
    });

    // CI dependencies (GitHub Actions and other CI ecosystems): edges carry `pinned`.
    const byPath = new Map();
    for (const e of g.edges('DEPENDS_ON')) {
      if (e.attrs.pinned !== false || !e.to.startsWith('dependency:')) continue;
      const dep = g.node(e.to);
      const from = g.node(e.from);
      if (!dep || !from || dep.attrs.local) continue;
      const wf = from.type === 'job' ? g.node(from.attrs.workflow) : from;
      const key = wf?.path ?? from.path ?? from.id;
      if (!byPath.has(key)) byPath.set(key, { wf: wf ?? from, deps: new Map() });
      byPath.get(key).deps.set(dep.id, `${dep.name.replace(/^gha:/, '')}@${e.attrs.ref ?? '?'}`);
    }
    for (const [path, { wf, deps }] of [...byPath].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const list = [...deps.values()].sort();
      out.push(base({
        title: `${path} uses ${list.length} unpinned CI reference(s): ${list.slice(0, 3).join(', ')}${list.length > 3 ? ', ...' : ''}`,
        scope: [path],
        key: `ci:${path}`,
        evidence: [...deps.keys()].sort().slice(0, 10).map((d) => ({ ref: d, label: 'observed', summary: `Referenced by tag or branch, not a commit SHA: ${deps.get(d)}`, source_ref: path })),
        measurements: { 'ci.present': 1, 'pinning.unpinned': list.length },
        smallest_simplification: 'Pin each reference to its full commit SHA (keeping the version as a comment) and let an update bot propose bumps.',
        blast_radius: 'local',
        uncertainties: ['Pin state is read from the reference string; organisation allow-lists may already restrict sources'],
        _wf: wf,
      }));
    }

    for (const img of g.nodes('image').filter((n) => n.attrs.kind === 'Dockerfile' && n.attrs.unpinned_bases > 0).sort(byId)) {
      const latest = img.attrs.latest_bases ?? [];
      out.push(base({
        title: `${img.path} builds from ${img.attrs.unpinned_bases} base image(s) not pinned to a digest${latest.length ? ` (${latest.length} on latest/untagged)` : ''}`,
        scope: [img.path],
        key: `dockerfile:${img.id}`,
        evidence: [{ ref: img.id, label: 'observed', summary: `${img.attrs.unpinned_bases} unpinned base stage(s)`, source_ref: img.path }],
        measurements: { 'pinning.unpinned': img.attrs.unpinned_bases },
        smallest_simplification: 'Pin base images by digest (name:tag@sha256:...) and let an update bot refresh them.',
        blast_radius: 'bounded',
        uncertainties: ['A private registry may enforce immutable tags'],
      }));
    }

    for (const w of g.nodes('workload').sort(byId)) {
      const bad = (w.attrs.containers ?? []).filter((c) => c.image_pinned === false);
      if (!bad.length) continue;
      out.push(base({
        title: `${w.attrs.kind ?? 'workload'} ${w.name} runs ${bad.length} image(s) not pinned to a digest${bad.some((c) => c.image_tag_latest || c.image_untagged) ? ' (latest or untagged)' : ''}`,
        scope: [w.path ?? w.id],
        key: `workload:${w.id}`,
        evidence: bad.slice(0, 5).map((c) => ({ ref: w.id, label: 'observed', summary: `Container ${c.name || '(unnamed)'} uses a mutable image reference`, source_ref: src(w) })),
        measurements: { 'pinning.unpinned': bad.length },
        smallest_simplification: 'Reference images by digest in the manifest (or enforce it through an admission policy) and keep the human-readable tag in a comment.',
        blast_radius: 'bounded',
        uncertainties: ['An admission controller or Kustomize image transformer may pin at deploy time'],
      }));
    }

    for (const m of g.nodes('iac_module').filter((n) => n.attrs.remote && n.attrs.pinned === 'unpinned').sort(byId)) {
      out.push(base({
        title: `IaC module ${m.name} is not pinned to a version or ref`,
        scope: [m.path ?? m.id],
        key: `iac-module:${m.id}`,
        evidence: [{ ref: m.id, label: 'observed', summary: 'Remote module with no version or ref', source_ref: src(m) }],
        measurements: { 'pinning.unpinned': 1 },
        smallest_simplification: 'Pin the module to an exact version or a git commit ref.',
        blast_radius: 'bounded',
        uncertainties: ['A lock file or registry mirror may fix the version elsewhere'],
      }));
    }
    for (const d of g.nodes('dependency').filter((n) => n.attrs.kind === 'provider' && n.attrs.pinned === 'unpinned').sort(byId)) {
      out.push(base({
        title: `IaC provider ${d.attrs.provider} has no version constraint`,
        scope: [d.path ?? d.id],
        key: `iac-provider:${d.id}`,
        evidence: [{ ref: d.id, label: 'observed', summary: 'No version constraint for the provider', source_ref: src(d) }],
        measurements: { 'pinning.unpinned': 1 },
        smallest_simplification: 'Add a version constraint (~>) and commit the dependency lock file.',
        blast_radius: 'bounded',
        uncertainties: ['A committed .terraform.lock.hcl may already pin the exact version'],
      }));
    }
    return out.map(({ _wf, ...d }) => d);
  },
};

const dangerousTrigger = {
  id: 'security.dangerous-ci-trigger',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.dangerous-ci-trigger'],
  detect({ graph: g }) {
    return g.nodes('workflow').filter((w) => (w.attrs.dangerous_patterns ?? []).includes('pull_request_target_checkout_pr_head')).sort(byId).map((w) => draft({
      kind: 'security.dangerous-ci-trigger',
      title: `${w.path} runs untrusted pull request code with pull_request_target`,
      scope: [w.path],
      key: `workflow:${w.id}`,
      evidence: [{ ref: w.id, label: 'observed', summary: 'pull_request_target trigger checks out the PR head', source_ref: w.path }],
      measurements: { 'ci.present': 1 },
      thresholds: { allowed: 0 },
      why_accidental: 'pull_request_target runs with repository secrets and a write token; checking out the PR head then executes attacker-controlled code with them.',
      essential_considerations: ['Labelling or comment workflows need this trigger, but must not run PR code'],
      smallest_simplification: 'Split the workflow: build and test the PR code under `pull_request` (no secrets), and keep any privileged step in a separate workflow that does not check out the PR head. Keep reviewer gating.',
      invariants: ['PR checks still run on every PR', 'Privileged steps still require maintainer approval'],
      risks: ['Fork PRs lose access to secrets they never should have had'],
      verification: ['A fork PR runs the unprivileged workflow only', 'Secrets are absent from the PR-code job'],
      quality_impacts: { changeability: 'low', reliability: 'low', security: 'high' },
      blast_radius: 'moderate',
      factors: { benefit: 5, evidence: 0.85, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 2 },
      uncertainties: ['Mitigations such as required approval of fork workflows may exist in repository settings'],
      alternatives: [{ id: 'retain', summary: 'Keep the trigger with approval-gated environments and a documented reason.' }, { id: 'split-workflows', summary: 'Separate unprivileged PR checks from privileged follow-up.' }],
      patterns: ['infrastructure.policy-as-code'],
    }));
  },
};

const duplicatedAuthorization = {
  id: 'security.duplicated-authorization',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.duplicated-authorization'],
  detect({ graph: g }) {
    const byModule = new Map();
    for (const f of [...g.nodes('function'), ...g.nodes('method')]) {
      if (!f.path || isTest(f) || AUTH_PACKAGE.test(f.path)) continue;
      const name = String(f.name).split(/[#.]/).pop();
      if (!AUTHZ_NAME.test(name)) continue;
      if (!byModule.has(f.path)) byModule.set(f.path, []);
      byModule.get(f.path).push(f);
    }
    if (byModule.size < 3) return [];
    const paths = [...byModule.keys()].sort();
    return [draft({
      kind: 'security.duplicated-authorization',
      title: `Authorization checks are re-implemented in ${paths.length} modules outside an auth package`,
      scope: paths,
      key: 'authorization-functions',
      evidence: paths.slice(0, 10).map((p) => ({ ref: byModule.get(p)[0].id, label: 'inferred', summary: `Defines ${byModule.get(p).map((f) => String(f.name).split(/[#.]/).pop()).join(', ')}`, source_ref: p })),
      measurements: { 'duplication.instances': paths.length },
      thresholds: { min_modules: 3, name_based_inference: true },
      why_accidental: 'Scattered permission checks diverge, so one gets fixed or tightened and the others do not.',
      essential_considerations: ['Resource-specific checks (ownership of a record) legitimately live beside the data'],
      smallest_simplification: 'Introduce one shared authorization module, move the checks behind it one call site at a time, and keep every existing check active until its replacement is tested.',
      invariants: ['Each call site denies exactly what it denies today', 'No check is removed before its replacement passes tests'],
      risks: ['Subtle differences between copies are lost if merged carelessly'],
      verification: ['A table-driven authorization test passes before and after for every call site'],
      blast_radius: 'moderate',
      factors: { benefit: 3, evidence: 0.3, reversibility: 0.8, blast: 3, cost: 3, uncertainty: 4 },
      uncertainties: ['Low confidence: judged only from function names', 'Function bodies are not compared'],
      alternatives: [{ id: 'retain', summary: 'Keep local checks and add tests that pin their behaviour.' }, { id: 'central-policy', summary: 'Consolidate behind a shared policy module.' }],
      patterns: ['infrastructure.policy-as-code'],
    })];
  },
};

const scannerFindings = {
  id: 'security.scanner-findings',
  version: '1.0.0',
  category: 'security',
  kinds: ['security.scanner-findings'],
  detect({ graph: g }) {
    const SEV = { critical: 5, high: 4, medium: 3, low: 2 };
    return g.nodes('file').filter((f) => Array.isArray(f.attrs.scanner_findings) && f.attrs.scanner_findings.length).sort(byId).map((f) => {
      const list = f.attrs.scanner_findings;
      const top = Math.max(...list.map((s) => SEV[String(s.severity).toLowerCase()] ?? 3));
      const tools = sortedUniq(list.map((s) => s.tool));
      return draft({
        kind: 'security.scanner-findings',
        title: `${tools.join(', ')} reported ${list.length} issue(s) in ${f.path ?? f.name}`,
        scope: [f.path ?? f.name],
        key: `file:${f.id}`,
        evidence: list.slice(0, 10).map((s) => ({ ref: f.id, label: 'observed', summary: `${s.tool} ${s.rule} (${s.severity ?? 'unrated'})`, source_ref: `${f.path ?? f.name}:${s.line ?? 1}` })),
        measurements: { 'scanner.findings': list.length },
        thresholds: { allowed: 0 },
        why_accidental: 'An external scanner flagged the file; the rule list is the evidence, not this tool.',
        essential_considerations: ['Scanner rules produce false positives; triage each rule'],
        smallest_simplification: 'Fix each flagged site as the rule describes, or suppress a rule only with a recorded justification. Never disable the scanner.',
        invariants: ['The scanner stays enabled in CI'],
        risks: ['A fix can change behaviour; add a test first'],
        verification: ['Re-run the same scanner and confirm the rule no longer fires'],
        blast_radius: 'local',
        factors: { benefit: top, evidence: 0.6, reversibility: 0.85, blast: 1, cost: 2, uncertainty: 2 },
        uncertainties: ['Severity and exploitability come from the scanner and are unverified'],
        alternatives: [{ id: 'retain', summary: 'Accept each finding with a recorded justification and expiry.' }, { id: 'fix', summary: 'Remediate per the rule guidance.' }],
        patterns: [],
      });
    });
  },
};

export default [
  secretExposure, unsafeCommand, injection, deserialization, privilegeSprawl,
  unpinned, dangerousTrigger, duplicatedAuthorization, scannerFindings,
];
