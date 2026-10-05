# Configuration

Repository configuration lives in `.unknot/config.yaml` and is validated against `schemas/config.schema.json`. Unknown top-level keys are rejected. `.unknot/config.yaml` is meant to be committed. `unknot init` writes a proposal to `.unknot/config.proposed.yaml` (git-ignored), and a human turns it into the real thing with `unknot config accept`.

`unknot config show` prints the effective configuration (defaults, then your file, then organization policy), the config digest, whether the file is accepted, and what organization policy changed. `unknot policy effective` prints the same as YAML.

## Acceptance

A configuration can raise Unknot's authority: a higher mode, registered approvers, commands that run in the sandbox. So a config file is not trusted just because it is on disk.

| State | When | What is honoured |
|---|---|---|
| `none` | No `config.yaml` | Built-in defaults. |
| `accepted` | The file's digest equals the digest a human recorded with `unknot config accept` | The whole file. |
| `unaccepted` | A `config.yaml` exists but nobody has ever accepted one | The file, with `approvers` emptied and any mode above `plan` forced to `plan`. |
| `changed` | The file differs from the accepted snapshot | The accepted snapshot, plus only the parts of the new file that tighten policy. |

For `changed`, Unknot keeps the accepted text in force. It applies the new file as if it were organization policy (see "Tighten-only merge" below), after removing `approvers`, `commands`, `adapters`, `detectors` and `evidence`. So an edit that lowers the mode, shrinks a limit, adds a protected path or requires a stricter scan takes effect at once. An edit that raises the mode, loosens a limit, adds an approver or changes a command waits. Keys with no tighten rule (for example `daemon`, `workspace`, `database.engines`, `infrastructure.plans`, `suppression`, `decomposition`) are ignored until accepted. Commands print a notice on stderr when the file is `unaccepted` or `changed`, and `unknot doctor` and `unknot status` show it.

`unknot config accept` requires a human at an interactive terminal. It shows the proposal (or the current file if there is no proposal), and you must type the mode back. It then records the digest and text of what you accepted and writes a `config.accepted` ledger event. `unknot config diff` shows current versus proposed and is safe for anyone to run.

The effective configuration digest is part of every approval's binding. Any change to the effective configuration, including a tightening, invalidates existing approvals, and they have to be given again.

## Organization policy

An organization can ship policy that repositories may only tighten.

Location: an `org-policy.yaml` in a managed directory (`/Library/Application Support/Unknot` on macOS, `/etc/unknot` on Linux, `%ProgramData%\Unknot` on Windows) and/or in the user's Unknot home (`$UNKNOT_HOME`, else `$XDG_CONFIG_HOME/unknot`, else `~/.config/unknot`). The managed directory is applied first. Neither location can be redirected by an environment variable except the user home.

Signing: if the directory has a `trusted-keys/` folder of PEM public keys, `org-policy.yaml.sig` must hold a base64 Ed25519 signature over the exact file bytes from one of them. A bad or missing signature is an integrity error and stops every command, not a warning. A directory with no `trusted-keys/` is loaded unsigned (`unknot doctor` warns).

```sh
unknot policy keygen release-2026                        # human, passphrase >= 12 chars
unknot policy sign org-policy.yaml --key release-2026    # human; validates the policy first
unknot policy trust <dir> --key release-2026             # copies the public key into <dir>/trusted-keys/
unknot policy verify <dir>                               # same check as startup
unknot policy effective                                  # what applies here, and what policy overrode
```

An org policy may use any repository key plus three organization-only keys:

| Key | Type | Meaning |
|---|---|---|
| `max_mode` | one of the five modes | Ceiling on `mode`. |
| `approvers_locked` | boolean | When true, only the approvers defined by org policy exist; repository `approvers` are discarded. |
| `forbid_executables` | list of bare executable names | The broker refuses to run these (`/` and `\` not allowed in names). |

Unknown top-level keys in an org policy are rejected at signing time so a typo cannot silently weaken it.

### Tighten-only merge

The effective config is defaults, then the accepted repository config, then each org bundle in turn. Each key has one rule. A repository value that policy overrides is reported by `unknot config show` under `adjustments`.

| Key | Rule |
|---|---|
| `mode` and `max_mode` | The lower mode wins. |
| `scope.include` | Intersection by exact string. An empty repository list takes the org list. A disjoint result becomes a pattern that matches nothing. |
| `scope.exclude`, `protected_paths`, `generated_paths`, `security.redact_patterns` | Union. |
| `limits.<name>` | Numeric limits only; the smaller value wins (a repository `null` means unlimited, so the org value applies). |
| `quality.forbid_new_cycles` | Org `true` forces `true`. |
| `quality.max_complexity_increase` | Smaller value wins. |
| `security.require_os_sandbox`, `infrastructure.require_saved_plan` | Org `true` forces `true`. |
| `quality.public_api_compatibility` | Stricter wins: `advisory` < `required`. |
| `security.secrets_scan` | `off` < `optional` < `required`. |
| `security.sast` | `off` < `optional` < `required_for_high_risk` < `required`. |
| `security.dependency_changes` | `allowed` < `approval_required` < `forbidden`. |
| `database.live_access` | `read_only_metadata` < `disabled`. |
| `approvals.low`, `.medium`, `.high`, `.critical` | Union of roles. |
| `approvals.critical_min_approvers` | Larger wins. |
| `approvals.expiry` | Shorter wins. |
| `approvers` | Org entries are laid over the repository's (org wins on a name clash). With `approvers_locked`, only org entries remain. |
| `mcp.allowed_servers`, `network.allowed_domains` | Intersection: a server or domain must appear in both lists. |
| `telemetry.enabled` | Org `false` forces `false`. |
| `retention.runs`, `retention.cache` | Shorter wins. |
| `forbid_executables` | Union. |

Keys that have no rule in this table are not constrained by organization policy in this version: a value set for them in an org bundle (for example `commands`, `decomposition`, `daemon`) has no effect. `database.destructive_execution`, `infrastructure.apply` and `infrastructure.destroy` accept only `forbidden` in the schema, so no config can loosen them.

## Reference

Durations are a number and a unit: `ms`, `s`, `m`, `h`, `d`, `w` (`72h`, `30d`). "Default" is the built-in value from `runtime/policy/defaults.mjs`.

### Top level

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | required | Schema version. |
| `mode` | `observe`, `plan`, `assist`, `governed`, `campaign` | `plan` | Authority level. See below. |
| `scope.include` | list of globs | `[]` | Repository paths in scope. Empty means everything. |
| `scope.exclude` | list of globs | `vendor/**`, `node_modules/**`, `dist/**`, `build/**`, `generated/**`, `**/node_modules/**`, `.git/**`, `.unknot/**` | Paths never mapped or edited. |
| `protected_paths` | list of globs | `.github/workflows/**`, `**/auth/**`, `**/crypto/**`, `**/migrations/**` | A slice may change these only if it names them explicitly (without `**`) and is high or critical risk. Any slice touching them is classified high. |
| `generated_paths` | list of globs | `[]` | Treated as generated: never edited as source. `**/vendor/**`, `**/node_modules/**` and `**/dist/**` are always treated this way inside a worktree. |
| `commands` | map of name to argument list | `{}` | Project commands run through the broker. See below. |
| `limits` | map | see below | Budgets. |
| `quality` | map | see below | Quality gates. |
| `security` | map | see below | Scans and redaction. |
| `database` | map | see below | Database analysis settings. |
| `infrastructure` | map | see below | Infrastructure analysis settings. |
| `approvals` | map | see below | Who must approve at each risk level. |
| `approvers` | map | `{}` | Registered approvers and their public keys. |
| `evidence` | map | all empty | Files of imported runtime, data and infrastructure evidence. |
| `adapters` | map of id to options | `{}` | Per-adapter options. `enabled: false` disables an adapter. |
| `detectors` | map of id to options | `{}` | Per-detector options. `enabled: false` disables a detector. |
| `decomposition` | map | see below | Monolith decomposition tuning and drivers. |
| `mcp.allowed_servers` | list of strings | `[]` | Other MCP servers the model may call during a run. Unknot's own server is always allowed. |
| `network.allowed_domains` | list of strings | `[]` | Domains `WebFetch` may reach (`*.example.com` allowed). Also needs `limits.max_network_requests` above 0. |
| `telemetry` | map | see below | Opt-in telemetry. |
| `retention` | map | see below | How long runs and cache are kept. |
| `suppression.default_reject_days` | integer >= 1 | `90` | Days a rejected finding stays suppressed. |
| `workspace.repositories` | list of `{name, path, remote?}` | `[]` | Explicitly linked repositories. Each path must be a git root, distinct from the others. |
| `daemon` | map | see below | Optional local API daemon. |

### Modes

| Mode | Effect |
|---|---|
| `observe` | Read and inventory only. `plan` and `architecture` writes are refused (`architecture` prints instead). |
| `plan` | Plans, campaigns and architecture documents. No source changes. |
| `assist` | A patch of one approved slice inside its worktree. Minimum mode for `apply`, `verify` and `rollback` runs. |
| `governed` | As `assist`, and approving the change commits it on the slice branch. Never merges or pushes. |
| `campaign` | Ranked above `governed`. No code path distinguishes it from `governed` yet. |

The first run defaults to `plan`. Mode never rises because of what you say to Claude.

### `commands`

A map from a lowercase name (`^[a-z][a-z0-9_]*$`) to an argument vector (list of strings, at least one). No shell is involved, so `["npm", "test"]`, not `"npm test && foo"`. The runtime uses these names:

| Name | Used for |
|---|---|
| `test_unit` | Baseline check before a patch; the `unit` and `characterization` obligations. |
| `test_integration` | `integration` obligation on medium and higher risk slices. |
| `lint`, `typecheck`, `build` | Matching obligations. |
| `sast` | `security-scan` obligation, when `security.sast` requires it. |
| `contract`, `performance` | Obligations for treatments T3, T5, T7, T9 (contract) and T3, T6, T7 (performance). |
| `migration_rehearsal` | `migration-rehearsal` obligation on database slices. |
| `iac_validate` | IaC validation on infrastructure slices. |

Any other name can be run by hand with `unknot exec <name> [args]`. If an obligation needs a command you have not configured, it becomes a human-attestation obligation and says so. `unknot init` detects `build`, `test_unit`, `test_integration`, `lint`, `typecheck` and `format_check` from `package.json`, Python, Go, Cargo, Maven, Gradle and Makefile projects. It reads files and runs nothing.

### `limits`

`null` means no limit.

| Key | Default | Meaning |
|---|---|---|
| `max_changed_files` | 12 | Files a slice may change. |
| `max_diff_lines` | 500 | Added plus removed lines a slice may change. |
| `max_runtime_minutes` | 30 | Timeout for each brokered command. |
| `max_network_requests` | 0 | 0 disables network for the model and for brokered commands. |
| `max_files_read` | 50000 | Files the model may read in a run. |
| `max_bytes_read` | 536870912 | Bytes the model may read in a run. |
| `max_file_bytes` | 2097152 | Largest file read when mapping. |
| `max_commands` | 200 | Brokered commands per run. |
| `max_tool_calls` | 3000 | Tool calls per run. |
| `max_delegation_depth` | 2 | Subagent nesting. |
| `max_turns`, `max_tokens`, `max_cost_usd` | `null` | Accepted and stored in the run budget. In this version no code charges these counters, so they are not enforced. |
| `workers` | `null` | Worker threads for mapping; `null` picks a default. |

A breach is recorded in the ledger and blocks the operation and the run. There is no "ask for more".

### `quality`

| Key | Type, default | Meaning |
|---|---|---|
| `forbid_new_cycles` | boolean, `true` | The `no-new-cycles` obligation. |
| `public_api_compatibility` | `required` or `advisory`, `required` | The `api-compatibility` obligation: exported symbols and endpoints of touched modules must be unchanged or only added to. |
| `max_complexity_increase` | number, `0` | Permitted rise in complexity of touched functions (`architecture-fitness`). |

### `security`

| Key | Type, default | Meaning |
|---|---|---|
| `secrets_scan` | `required`, `optional`, `off`; `required` | Adds the `secrets-scan` obligation (no credential-like values in the diff) unless `off`. |
| `sast` | `required`, `required_for_high_risk`, `optional`, `off`; `required_for_high_risk` | Adds a `security-scan` obligation. With a `sast` command it runs; without one it becomes a human review. |
| `dependency_changes` | `allowed`, `approval_required`, `forbidden`; `approval_required` | Accepted and tightened by org policy, but no code reads it yet. Dependency manifest changes are always classified medium risk or higher, whatever this says. `forbidden` does not block anything in this version. |
| `require_os_sandbox` | boolean, `false` | Refuse to run brokered commands when no OS sandbox is available. |
| `redact_patterns` | list of regex sources, `[]` | Extra patterns redacted from output, logs and bundles. |

### `database`

| Key | Type, default | Meaning |
|---|---|---|
| `live_access` | `disabled` or `read_only_metadata`, `disabled` | Reserved. Unknot has no database connection in this version; catalog data comes from `evidence.db_metadata`. |
| `destructive_execution` | `forbidden` only | Cannot be loosened. |
| `engines` | list of `{id, engine, version?, metadata_export?, dsn_env?, owner?, classification?}` | Declare databases. `engine` is one of `postgresql`, `mysql`, `mariadb`, `sqlserver`, `oracle`, `sqlite`, `mongodb`, `redis`, `dynamodb`, `cassandra`, `other`. `dsn_env` must be an upper-case environment variable name. |

### `infrastructure`

| Key | Type, default | Meaning |
|---|---|---|
| `apply`, `destroy` | `forbidden` only | Cannot be loosened. |
| `require_saved_plan` | boolean, `true` | Infrastructure slices are judged against a saved plan, not a live one. |
| `plans` | list of `{workspace, environment?, plan_json?, state_json?, tool?}` | Saved plans and state exports. `tool` is `terraform`, `opentofu`, `cloudformation`, `pulumi`, `bicep`, `kubernetes`, `helm` or `kustomize`. |

### `approvals` and `approvers`

| Key | Default | Meaning |
|---|---|---|
| `approvals.low` | `[code-owner]` | Roles that must approve a low-risk slice. |
| `approvals.medium` | `[code-owner, affected-owner]` | |
| `approvals.high` | `[code-owner, specialist-owner]` | `specialist-owner` expands to the slice's specialist roles (`security-owner`, `data-owner`, `platform-owner`); with none identified, `security-owner`. |
| `approvals.critical` | `[code-owner, specialist-owner]` | Also needs at least `critical_min_approvers` different people. |
| `approvals.critical_min_approvers` | `2` (minimum 2) | |
| `approvals.expiry` | `72h` | How long an approval stays valid. |

Role names are lowercase words with hyphens. A role in `approvals` is satisfied only by an approver who holds it.

```yaml
approvers:
  alice:
    roles: [code-owner, affected-owner]
    teams: [checkout]               # optional
    paths: ["services/checkout/**"] # optional
    public_key: |
      -----BEGIN PUBLIC KEY-----
      ...
      -----END PUBLIC KEY-----
```

`unknot keys generate <name>` prints this block. `roles` and `public_key` are required; names match `^[A-Za-z0-9._-]{1,64}$`. `teams` and `paths` are recorded but not used in approval checks in this version.

`unknot init` proposes `approvals.medium: [code-owner]` and `approvals.high: [code-owner, security-owner]`, which differ from the built-in defaults above because the proposal is merged over the defaults. Read the proposal before accepting.

### `evidence`

Lists of file paths inside the repository, imported when mapping. Unknot never fetches these itself; you export them. Paths are checked for escape and credential names.

| Key | Content |
|---|---|
| `traces` | Exported distributed traces. |
| `metrics`, `profiles` | Exported metrics and profiles. |
| `catalogs` | Service catalog exports. |
| `db_metadata` | PostgreSQL catalog JSON, `pg_stat_statements`, `EXPLAIN (FORMAT JSON)` plans. See `adapters/database/README.md`. |
| `slow_query_logs` | Slow query logs. |
| `infra_plans`, `infra_state`, `infra_inventory` | Terraform plan JSON, state, actual-resource inventory. |

Runtime-derived facts carry an expiry; `unknot status` reports expired ones as stale evidence.

### `adapters` and `detectors`

Each is a map from an id to an options object. `adapters.<id>.enabled: false` stops that adapter. Adapter ids: `javascript`, `python`, `generic`, `quality`, `database`, `iac`, `k8s`, `delivery`, `contracts`, `ownership`, `runtime`, `security`. `detectors.<id>.enabled: false` stops a detector. Other options are the detector's thresholds. The local-code detectors read these:

| Detector | Option (default) |
|---|---|
| `local.long-function` | `lines` (80), `component_lines` (150) |
| `local.complex-function` | `cyclomatic` (15), `cognitive` (20) |
| `local.deep-nesting` | `max_nesting` (4) |
| `local.long-parameter-list` | `params` (6) |
| `local.large-class` | `methods` (20), `lines` (500) |
| `local.large-module` | `sloc` (1000) |
| `local.duplicated-code` | `min_lines` (20), `min_similarity` (0.4) |

These are heuristics and each finding says so in its `thresholds`. `unknot learn propose` writes changes to them (see [learning.md](learning.md)).

### `decomposition`

| Key | Default | Meaning |
|---|---|---|
| `weights.structural` | 0.35 | Weight of imports and calls in the affinity graph. |
| `weights.data` | 0.30 | Shared tables, writes over reads. |
| `weights.evolutionary` | 0.25 | Git co-change. |
| `weights.semantic` | 0.10 | Shared domain terms in paths and identifiers. |
| `weights.runtime` | 0.25 | Reserved for call counts from imported traces. Accepted, but the affinity graph does not include a runtime component in this version. |
| `min_shared_commits` | 10 | Minimum commits two files must share to count as co-changing. |
| `max_changeset` | 50 | Commits touching more files than this are ignored for co-change. |
| `history_days` | 365 | Git history window. |
| `size_band` | `[5, 20]` | Modules per candidate considered neither nano nor mega. |
| `thresholds.ownership_alignment` | 0.8 | Share of a candidate owned by one team. Listed in the output, but the pattern cards compare against a fixed 0.8; changing this does not change the decision yet. |
| `thresholds.co_change_leak` | 0.2 | Maximum share of commits crossing the boundary. Used by the `decomposition.co-change-leak` detector; the pattern cards use a fixed 0.2. |
| `thresholds.chatty_calls_p95` | 5 | Maximum cross-boundary calls per request. Listed in the output; the pattern cards use a fixed 5. |
| `thresholds.robustness` | 0.9 | Share of a candidate's modules that must keep their membership under perturbation. Used. |
| `drivers` | `[]` | Recorded decomposition drivers: list of `{id, scope?, evidence?, owner?}`. `id` is one of `independent_deploy`, `independent_scale`, `availability_isolation`, `security_isolation`, `team_autonomy`, `technology_divergence`, `build_time`. |

All of these are heuristics, not measured facts, and the output lists the ones it used. See [decomposition.md](decomposition.md).

### `telemetry`, `retention`, `daemon`

| Key | Default | Meaning |
|---|---|---|
| `telemetry.enabled` | `false` | OpenTelemetry-compatible export. |
| `telemetry.exporter` | `file` | `file` writes OTLP/JSON lines to `.unknot/telemetry/`; `otlp` posts to `endpoint`. |
| `telemetry.endpoint` | `null` | Used by `otlp` only, and only if its host is in `network.allowed_domains`. |
| `retention.runs` | `30d` | Run directories older than this are removed by `unknot gc`. |
| `retention.cache` | `30d` | Cached artifacts older than this are removed by `unknot gc`. |
| `daemon.listen` | `127.0.0.1:7433` | Local mode accepts loopback addresses only. |
| `daemon.mode` | `local` | `remote` needs `tls {cert, key, client_ca}`, `oidc {issuer, audience, jwks_file, role_claim, role_map}` and `tenants`. |

Telemetry never contains source, diffs, secrets, SQL values or paths; see [release.md](release.md).

## Examples

These are starting points. Replace the placeholder keys with output from `unknot keys generate`.

### TypeScript monorepo (pnpm)

```yaml
version: 1
mode: plan
scope:
  include: ["apps/**", "packages/**"]
  exclude: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/*.generated.ts"]
protected_paths:
  - ".github/workflows/**"
  - "packages/auth/**"
  - "**/migrations/**"
generated_paths: ["packages/api-client/src/generated/**"]
commands:
  build: ["pnpm", "build"]
  typecheck: ["pnpm", "typecheck"]
  lint: ["pnpm", "lint"]
  test_unit: ["pnpm", "test:unit"]
  test_integration: ["pnpm", "test:integration"]
limits:
  max_changed_files: 10
  max_diff_lines: 400
quality:
  forbid_new_cycles: true
  public_api_compatibility: required
approvals:
  medium: [code-owner]
  high: [code-owner, security-owner]
approvers:
  alice:
    roles: [code-owner]
    public_key: |
      -----BEGIN PUBLIC KEY-----
      (from unknot keys generate alice)
      -----END PUBLIC KEY-----
decomposition:
  drivers:
    - { id: team_autonomy, evidence: "checkout and search teams share apps/web", owner: alice }
detectors:
  local.long-function: { component_lines: 200 }
```

### Python service

```yaml
version: 1
mode: plan
scope:
  exclude: ["**/.venv/**", "**/__pycache__/**", "build/**", "dist/**"]
protected_paths: ["**/migrations/**", "alembic/**", "**/auth/**"]
commands:
  lint: ["ruff", "check", "."]
  typecheck: ["mypy", "."]
  test_unit: ["python3", "-m", "pytest", "-q", "tests/unit"]
  test_integration: ["python3", "-m", "pytest", "-q", "tests/integration"]
security:
  sast: required_for_high_risk
database:
  engines:
    - { id: main, engine: postgresql, version: "16", owner: payments-team }
evidence:
  db_metadata: ["ops/exports/pg_catalog.json", "ops/exports/pg_stat_statements.csv"]
approvers:
  bob:
    roles: [code-owner, data-owner]
    public_key: |
      -----BEGIN PUBLIC KEY-----
      (from unknot keys generate bob)
      -----END PUBLIC KEY-----
```

### Terraform repository

```yaml
version: 1
mode: plan
scope:
  include: ["infra/**", "modules/**"]
protected_paths:
  - "**/*.tfstate*"
  - "infra/iam/**"
  - "infra/network/**"
commands:
  iac_validate: ["terraform", "-chdir=infra/envs/staging", "validate"]
infrastructure:
  require_saved_plan: true
  plans:
    - workspace: staging
      environment: staging
      tool: terraform
      plan_json: ops/plans/staging.plan.json
      state_json: ops/plans/staging.state.json
security:
  require_os_sandbox: true
approvals:
  high: [code-owner, platform-owner]
  critical: [code-owner, platform-owner, security-owner]
  critical_min_approvers: 2
  expiry: 24h
approvers:
  carol:
    roles: [code-owner, platform-owner]
    public_key: |
      -----BEGIN PUBLIC KEY-----
      (from unknot keys generate carol)
      -----END PUBLIC KEY-----
```

Unknot never runs `terraform plan`, `apply` or `destroy`. Produce the saved plan JSON yourself (for example `terraform show -json plan.out > ops/plans/staging.plan.json`) and list it under `infrastructure.plans`. The broker allows only `version`, `validate`, `fmt`, `show`, `graph` and `providers` for `terraform` when Unknot drives it.
