// Built-in defaults (spec §8). A repository config is layered on these, and organization
// policy is then applied on top with tighten-only semantics (see merge.mjs).

export const MODES = Object.freeze(['observe', 'plan', 'assist', 'governed', 'campaign']);
export const modeRank = (m) => MODES.indexOf(m);

export const RISKS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const riskRank = (r) => RISKS.indexOf(r);

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  mode: 'plan',
  scope: {
    include: [],
    exclude: ['vendor/**', 'node_modules/**', 'dist/**', 'build/**', 'generated/**', '**/node_modules/**', '.git/**', '.unknot/**'],
  },
  // CI definitions and git hooks run with the project's credentials or on developers'
  // machines, so every CI system the delivery adapter parses is protected, not only GitHub's.
  protected_paths: ['.github/workflows/**', '.gitlab-ci.yml', '.gitlab/ci/**', '.circleci/**', 'azure-pipelines.yml', '**/Jenkinsfile', '.buildkite/**', 'bitbucket-pipelines.yml', '.husky/**', '.githooks/**', '**/auth/**', '**/crypto/**', '**/migrations/**'],
  generated_paths: [],
  commands: {},
  limits: {
    max_changed_files: 12,
    max_diff_lines: 500,
    max_runtime_minutes: 30,
    max_network_requests: 0,
    max_files_read: 50000,
    max_bytes_read: 536870912,
    max_file_bytes: 2097152,
    max_commands: 200,
    max_tool_calls: 3000,
    max_delegation_depth: 2,
    max_turns: null,
    max_tokens: null,
    max_cost_usd: null,
    pricing: null,
    workers: null,
  },
  quality: { forbid_new_cycles: true, public_api_compatibility: 'required', max_complexity_increase: 0 },
  security: {
    secrets_scan: 'required',
    sast: 'required_for_high_risk',
    dependency_changes: 'approval_required',
    require_os_sandbox: false,
    redact_patterns: [],
  },
  database: { live_access: 'disabled', destructive_execution: 'forbidden', engines: [] },
  infrastructure: { apply: 'forbidden', destroy: 'forbidden', require_saved_plan: true, plans: [] },
  approvals: {
    low: ['code-owner'],
    medium: ['code-owner', 'affected-owner'],
    high: ['code-owner', 'specialist-owner'],
    critical: ['code-owner', 'specialist-owner'],
    critical_min_approvers: 2,
    expiry: '72h',
  },
  approvers: {},
  evidence: {
    traces: [],
    metrics: [],
    profiles: [],
    catalogs: [],
    db_metadata: [],
    slow_query_logs: [],
    infra_plans: [],
    infra_state: [],
    infra_inventory: [],
  },
  adapters: {},
  detectors: {},
  decomposition: {
    weights: { structural: 0.35, data: 0.3, evolutionary: 0.25, semantic: 0.1, runtime: 0.25 },
    min_shared_commits: 10,
    max_changeset: 50,
    history_days: 365,
    history_min_commits: 1000,
    size_band: [5, 20],
    thresholds: { ownership_alignment: 0.8, co_change_leak: 0.2, chatty_calls_p95: 5, robustness: 0.9 },
    drivers: [],
  },
  mcp: { allowed_servers: [] },
  network: { allowed_domains: [] },
  telemetry: { enabled: false, exporter: 'file', endpoint: null },
  retention: { runs: '30d', cache: '30d' },
  suppression: { default_reject_days: 90 },
  workspace: { repositories: [] },
  daemon: { listen: '127.0.0.1:7433', mode: 'local' },
});

// Severity ladders used by the tighten-only merge: later entries are stricter.
export const LADDERS = Object.freeze({
  'quality.public_api_compatibility': ['advisory', 'required'],
  'security.secrets_scan': ['off', 'optional', 'required'],
  'security.sast': ['off', 'optional', 'required_for_high_risk', 'required'],
  'security.dependency_changes': ['allowed', 'approval_required', 'forbidden'],
  'database.live_access': ['read_only_metadata', 'disabled'],
  'database.destructive_execution': ['forbidden'],
  'infrastructure.apply': ['forbidden'],
  'infrastructure.destroy': ['forbidden'],
});
