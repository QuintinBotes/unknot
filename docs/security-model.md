# Security model

This page describes what Unknot enforces and where. It is written to match the code; the limitations are in [SECURITY.md](../SECURITY.md) and you should read both.

The principle is that the model proposes and deterministic code authorizes. Repository text and tool output are data. Nothing the model reads can grant it authority.

## Layers

| Layer | What it does | Strength |
|---|---|---|
| Hooks and the policy decision point (PDP) | Decide each tool call Claude Code reports | Defense in depth. Active only during an Unknot run, except for always-on rules. |
| Static shell analysis | Decides which Bash commands the model may issue | Fail-closed allowlist. Not a sandbox. |
| Capability tokens and agent profiles | Limit each subagent | Enforced by the PDP. |
| Command broker | The only way Unknot executes anything | No shell, allowlisted tools, minimal environment, limits. |
| OS sandbox | Confines brokered commands | Real isolation where available (macOS, Linux with bubblewrap). |
| Approvals | Gate patching and acceptance on signed human decisions | Cryptographic. |
| Ledger | Records what happened | Tamper-evident. |

## Runs and when hooks apply

A **run** is one invocation of an Unknot command with its mode, scope, budget and policy digest fixed at start. Typing `/unknot:<command>` starts one (a `UserPromptSubmit` hook does it). While a run is active, hooks enforce the full policy. When none is active, only the always-on rules below apply, so installing the plugin does not change sessions that are not using it. A run is ended by the `Stop` hook, or by a human (`unknot run end`). A run governs only the session that started it: a parallel conversation in the same repository is not inside that command, so only the always-on rules apply to it, and it cannot end the run either. A read-only command's run (map, diagnose, decompose and the other commands that write nothing) left open by an interrupted turn ends with the next message in its session. A run that can write (apply, rollback) left active by a crash stays enforced and is reported at the next `SessionStart`. The agent cannot end a run during its turn: that is what keeps an analysis turn read-only even if the code it reads contains instructions. For the same reason nothing may outlive a run: background commands, wake-ups, monitors, cron and remote triggers are refused while one is active.

Hooks installed by the plugin (`hooks/hooks.json`):

| Event | What Unknot does |
|---|---|
| `UserPromptSubmit` | Starts a run for `/unknot:<command>`; the finding, slice, campaign and decomposition ids you typed become the run scope. |
| `PreToolUse` | Runs always-on rules, then the PDP. A deny stops the call. Charges the tool-call budget. |
| `PermissionRequest` | Makes the same decision, so a permission dialog cannot be used to get around a deny. |
| `PostToolUse` | Records a digest of the result; detects credential-like values and prompt-injection markers and adds a reminder that the content is data; checks the diff budget after edits in a worktree. |
| `SubagentStart` | Issues a capability token for the agent type and tells the agent what it allows. |
| `SubagentStop` | Revokes the capability; requires a valid handoff report. |
| `Stop` | Refuses to let the session finish while a slice is `PATCHING` or has open obligations. |
| `SessionStart` | Reports interrupted runs, slices needing attention, and approvals waiting. |

If a hook throws, the error is logged to `.unknot/state/hook-errors.log` and, in an initialised project, mutating tools (edit, write, Bash, web, agents, MCP) are denied until `unknot doctor` passes. Credential paths are denied too. Plain reads stay allowed. Hook decisions are stored in the `policy_results` table; denials are also written to the ledger.

## Always-on rules

These apply whenever the project is initialised, with or without a run:

- Reading or writing anything under the Unknot home (`$UNKNOT_HOME`, else `~/.config/unknot`) is denied: approver keys, policy keys, project keys.
- Writing `.unknot/config.yaml`, `.unknot/decisions.jsonl`, `.unknot/.gitignore`, `.unknot/state/`, `cas/`, `runs/`, `campaigns/`, `slices/`, `telemetry/` or `decompositions/` is denied. These change only through the CLI. Matching is case-insensitive.
- A Bash command that invokes `unknot approve|keys|config accept|run end|policy sign|shred|unlock` is denied.
- A Bash command that mentions `.unknot` must itself pass the read-only shell rules; scripts and interpreters pointed at `.unknot/state`, and `UNKNOT_HOME=` assignments, are denied. `rm`, `mv`, `cp`, `tee`, `truncate`, `chmod`, `chown`, `ln`, `touch`, `dd`, `install` and `rsync` on state paths are denied.

## The decision table

Inside a run, each tool call is translated to an operation and decided. Decisions are `allow` or `deny`, with reasons and the ids of the policies that produced them. Nothing is "ask" at this layer.

| Operation (tools) | Allowed when | Denied when |
|---|---|---|
| `inert` (TodoWrite, Task*, AskUserQuestion, ToolSearch, Skill, plan mode, and similar) | Always | |
| `fs.read` (Read, Grep, Glob, LS) | The agent's profile allows reads; the path is inside the project or the plugin directory; the path is not credential-shaped | Outside the project (`scope.read_outside`); credential-shaped such as `.env`, keys, `.ssh` (`secrets.read`) |
| `fs.write` (Edit, Write, MultiEdit, NotebookEdit) | See write rules below | See write rules below |
| `exec` (Bash) | The command parses completely, every command in it is on the read-only list, there are no file-writing redirects, and every path it names is inside the project (`exec.read_only`) | Anything else: builds, tests, installs, interpreters, `curl`, computed command names, privilege wrappers, unparseable input (`exec.shell`) |
| `net` (WebFetch, WebSearch) | `limits.max_network_requests` is above 0 and the domain is in `network.allowed_domains` | Otherwise (`network.disabled`, `network.domain`); each allowed call is charged to the budget |
| `mcp` (MCP tools) | The server is Unknot's own, or is listed in `mcp.allowed_servers` | Any other server |
| `agent.spawn` (Task, Agent) | Delegation depth is within `limits.max_delegation_depth` | Deeper than that |
| `unknown` (any tool Unknot does not recognise) | Never | Always: deny by default |

### Write rules

Checked in this order, for every path:

1. No path: deny.
2. Outside the project: deny. Symlinks are resolved first (`resolveInside`), so a link to `/etc` is outside.
3. `.git` internals: deny.
4. Credential-shaped path: deny.
5. Documentation paths (`docs/architecture/**`, `docs/adr/**`, `docs/decisions/**`, `docs/runbooks/**`, `.unknot/docs/**`): allowed to the `documentation-curator` agent, or to a main-session `plan` or `architecture` run, when mode is `plan` or above.
6. Anything else needs a profile that may write source (the `refactorer` agent, or the main session of an `apply` run). Otherwise deny.
7. Mode below `assist`: deny.
8. There must be a slice in `PATCHING` with a worktree. Otherwise deny.
9. The path must be inside that slice's worktree, not the main checkout.
10. Not `.git` or `.unknot` inside the worktree.
11. Inside the slice's declared include scope and outside its exclude scope.
12. Not generated, vendored or in `scope.exclude`.
13. A protected path is allowed only if the slice names it without `**` and is high or critical risk.
14. If a capability is present, it must cover the path.

### Agent profiles

Each Unknot agent gets the least privilege its job needs. An agent type that is not one of ours (general-purpose, Explore, another plugin's) gets read-only while a run is active.

| Profile | Operations | Writes |
|---|---|---|
| `orchestrator` | read, Unknot CLI | none |
| `cartographer`, `runtime-observer`, `domain-analyst`, `database-analyst`, `infrastructure-analyst`, `decomposition-strategist` | read, Unknot read tools | none |
| `security-reviewer` | read, Unknot read and scan | none |
| `simplification-planner` | read, Unknot read and plan | none |
| `verifier` | read, Unknot read and verify | none |
| `refactorer` | read, write, Unknot read | slice worktree and scope only |
| `documentation-curator` | read, write, Unknot read | documentation paths only |
| any other agent | read | none |

A capability is an HMAC-signed grant (run, agent, operations, write globs, expiry, 2 hours by default) that must also exist unrevoked in the store, so neither a forged nor a replayed token works. It is issued at `SubagentStart` and revoked at `SubagentStop`.

### Shell analysis

`runtime/core/shell.mjs` parses the command without executing it (quoting, pipelines, lists, subshells, `$(...)`, redirects, here-documents, wrappers such as `env`, `xargs`, `time`). If it cannot determine what will run, the command is denied. For what it can parse:

- Allowed executables are a fixed read-only set (`ls`, `cat`, `grep`, `rg`, `head`, `wc`, `jq`, `diff`, `sha256sum` and similar), `find` without `-exec`/`-delete`/`-fprint*`, `sed -n` with print-only scripts, `git` with a read-only subcommand and only harmless global options, and the Unknot CLI by the plugin's own path.
- Flags that turn a read-only tool into an executor or writer are refused (`rg --pre`, `sort -o`, `date -s`, `git -c`, `git --output`, `xxd -r`, and so on).
- Only a handful of environment assignments may precede a command (`LC_ALL`, `LANG`, `TZ`, `NO_COLOR`, `TERM`, `COLUMNS`). `GIT_*`, `PAGER`, `LD_*`, `NODE_OPTIONS` are not.
- `sudo`, `doas`, `su` and similar are never allowed, even wrapped.
- Redirects that write files are denied. A computed command name or argument is denied.
- Globs that could match credential files (`*.env`, `*key*`, `*.pem`) are denied.
- `unknot` must resolve to this plugin's CLI, and the human-only verbs are refused even after leading flags. The first `unknot` on `PATH` counts when it is this plugin's own `bin/unknot`, another installed version of the same plugin beside it in the plugin cache (a running session keeps the previous version's directory on `PATH` after an update), or the `unknot cli install` shim for this installation, outside the project under analysis. Anything else first on `PATH`, including a copy of the shim inside the repository, is refused, and the refusal names the file.
- Outside a run, a command that mentions `.unknot` must pass these rules, except a line made only of `cat`, `echo` or `printf` writing to literal files, or of plain `cp` copies: for those only the program, the redirect targets and the copy's destination may not name `.unknot`.

Everything that builds, tests, installs or changes state is reached through `unknot verify` or `unknot exec`, which use the broker.

## The command broker

`runtime/broker/broker.mjs` is the only code that spawns processes for Unknot.

- **No shell.** Commands are argument vectors passed to `spawn` with `shell: false`. NUL bytes are rejected.
- **Two origins.** `internal` commands (the runtime's own use of `git`, `terraform`, `helm`, `kustomize`, `kubectl`, `python3`, `node`, `semgrep`, `gitleaks`, `trivy`, `osv-scanner`) are checked against per-tool rules; `configured` commands come from `config.commands`, written by a human and run as declared.
- **Per-tool rules for internal use.** `terraform` and `tofu`: only `version`, `validate`, `fmt`, `show`, `graph`, `providers`; `apply`, `destroy`, `import`, `state`, `taint`, `refresh` and others are forbidden by name. `kubectl`: only `version`, `kustomize`, `apply`, `create`, `diff`, and `apply`/`create` only with `--dry-run=client|server` on every occurrence. `helm`: `template`, `lint`, `show`, `version`, `dependency list`. `kustomize`: `build`, `version`. `git push` is never run. Flags that execute programs (`--post-renderer`, `--enable-exec`, `--plugin`) are refused.
- **No repository-supplied tools.** An internal command must be a bare name or live in a system bin directory, and if it resolves to a path inside the repository it is refused, so a committed `./git` or `terraform` cannot be substituted.
- **Organization blocklist.** `forbid_executables` in org policy.
- **Working directory** must be inside the project.
- **Network** is off unless the caller asks and `limits.max_network_requests` is above 0.
- **Minimal environment.** Only `PATH`, locale, `USER`, `LOGNAME`, a set of toolchain variables (`JAVA_HOME`, `GOPATH`, `CARGO_HOME`, `NVM_DIR`, `PNPM_HOME`, `VIRTUAL_ENV`, and similar), plus `HOME`, `TERM=dumb`, `CI=1`, `NO_COLOR=1`, `UNKNOT_SANDBOXED=1` and a private `TMPDIR`. No tokens, cloud credentials, `DATABASE_URL`, `GITHUB_*` and so on. Any variable that looks like a credential is refused outright if a caller tries to pass it.
- **Private temp directory** outside the project, removed afterwards.
- **Limits.** A timeout (120 seconds for internal tools; `limits.max_runtime_minutes` for configured commands), the process group is killed on expiry, and at most 16 MiB of each stream is kept. Digests cover the complete output even when it is truncated.
- **Evidence.** Every execution appends `exec.started` and `exec.finished` ledger events and an evidence record to the run's `command-log.jsonl`. Output blobs are stored encrypted in the content-addressed store. Tails returned to the model are redacted.

## The OS sandbox

`runtime/broker/sandbox.mjs` wraps brokered commands where it can. `unknot doctor` reports which kind is in use.

| Platform | Mechanism | Writes allowed | Network | Hidden from the process |
|---|---|---|---|---|
| macOS | `sandbox-exec` with a generated profile (`(allow default)` then deny writes and network) | The worktree, the run directory, a private temp directory, `/dev`, system temp | Denied. Unix sockets only inside the run's own directories (the worktree, run directory and private temp), so test runners can talk to their workers but not to the Docker API, tmux or other local control sockets | Credential and agent directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.terraform.d`, `~/.m2`, `~/.cargo/credentials*`, `~/.orbstack`, keychains and similar, plus `$CLAUDE_CONFIG_DIR`), credential files (`~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.pgpass`, `~/.my.cnf`, `~/.boto`, `~/.s3cfg`), and the Unknot home: read and write denied |
| Linux | `bwrap` (bubblewrap), if installed | The same set, bind-mounted | Network, IPC, PID and UTS namespaces unshared; `/run` and `/var/run` (Docker, D-Bus, systemd sockets) replaced by empty tmpfs mounts | The same set, replaced by empty tmpfs mounts or `/dev/null` |
| Other | None | Whatever the user can write | Whatever the user has | Nothing |

When a command runs in a slice worktree, the main checkout is hidden as well: only the worktree, the main checkout's `.git` (which the worktree's git needs) and the dependency directories the worktree links to (`node_modules`, `.venv`, `venv`, `vendor/bundle`) stay readable. The directories between the checkout root and the worktree can be listed, so path resolution works, but files in the main checkout (an untracked `.env`, notes) cannot be read. A command that runs in the main checkout itself, such as discovery during `map`, keeps it readable.

Loopback is blocked by default as well. Test suites that start servers on 127.0.0.1 need `security.sandbox_loopback: true`; on macOS that opens loopback as a whole (any local TCP service, such as a database without a password, becomes reachable), on Linux each command gets a private loopback. The macOS sandbox also cannot execute setuid programs such as `ps`, so tests that inspect processes fail there; when a baseline fails for either reason, `unknot apply` says so.

With no sandbox, the command runs unwrapped and the evidence record says `sandbox: none`. Set `security.require_os_sandbox: true` (or have org policy set it) to make that a refusal instead. The sandbox confines writes and network; the process can still read the filesystem outside the main checkout and the hidden paths, for example toolchains and system files.

## Runs and slices

A run is bound to at most one slice at a time. Only a run started for slice work (`apply`, `verify`, `rollback`) can take on a slice, and when the person typed slice ids the run may take on only those. A command's write ceiling bounds every actor in its run, subagents included: source changes need an `apply` or `rollback` run, and documentation writes need a planning command. A slice that is ready for review goes back to patching only when a person names it (`/unknot:apply UK-…`). In `mode: campaign` a run may move to the next slice of the same campaign once the current one is settled.

## Approvals

An approval is a signature, not a flag in a database.

**Registration.** Approvers are registered in the accepted configuration with a name, roles and an Ed25519 public key (`unknot keys generate`). Org policy can add approvers and, with `approvers_locked`, replace the repository's.

**Binding.** When you approve, Unknot builds this binding and signs a canonical form of it together with your role and name:

| Field | Meaning |
|---|---|
| `commit` | The commit the plan was made against (plan stage), or the slice baseline (change stage) |
| `slice_id`, `slice_version`, `slice_digest` | The slice and a digest of its approvable content (everything except lifecycle fields) |
| `diff_hash` | The staged diff (change and rollback stages) |
| `plan_hash`, `state_serial` | The saved infrastructure plan and state serial, when relevant |
| `policy_digest` | The digest of the effective configuration and org policy |
| `environment` | `local` unless the slice names one |
| `stage` | `plan`, `change` or `rollback` |
| `expires_at` | Now plus `approvals.expiry` (default 72 hours) |

**Checking.** Whenever an approval is used (`apply start`, the change transition, `rollback`), Unknot recomputes the current binding and compares every field, re-verifies the signature against the approver's registered key, and checks expiry and that the approver still exists and still holds the role. A mismatch makes the approval stale, and the reasons are listed (`diff_hash changed`, `expired`, `approver no longer registered`). Going back to `PATCHING` revokes all of a slice's approvals.

**Who must approve.** The slice's risk selects roles from `approvals.<risk>`; `specialist-owner` expands to security, data or platform owners according to what the slice touches. Each role needs a valid approval from someone holding it. Critical risk also needs at least two different approvers. A high or critical slice cannot be approved by the person recorded as having proposed it.

**Lanes.** A lane is one signed plan approval for the low-risk part of a campaign (`unknot lane approve <CMP-id>`, human only, same terminal, confirmation and passphrase as `approve`). It covers the slices that are low risk, need a single role and touch no protected path, and it binds their ids and plan digests, the policy digest, the allowed patch shapes (`deletion`: the patch adds no line; `tests`: it changes only test files), a cap on files and lines no larger than the configured limits, and an expiry. Inside a lane the agent may start a covered slice without a per-slice plan approval; `apply finish` refuses a patch that does not fit the lane. A replanned slice, a configuration change, expiry or `unknot lane revoke` ends coverage, and the signature is re-verified against the approver's registered key on every use. A lane never approves a change: lane slices stop at `REVIEW_READY`, and `unknot approve --lane <LN-id>` records a normal change approval for each of them, bound to its own diff, after the person reviews them (`unknot lane review`).

**Human only.** `unknot approve` checks for an interactive terminal, prints the summary, asks you to type the slice id, and reads the passphrase of your key from `/dev/tty`. The passphrase is never passed to the runtime beyond unlocking the key for that call. Agents have no TTY, the shell rules refuse the verb, and the daemon's approve endpoint always returns 403.

## The ledger

Every state transition, policy denial, approval, capability issue, command execution, budget breach and similar is an event in an append-only table:

```
event = { id, type, run_id, campaign_id, slice_id, actor, capability_id,
          scope, budget, policy_decision, payload, at, prev_hash }
hash  = sha256(canonical JSON of event)      (covers prev_hash)
sig   = Ed25519(project audit key, hash)
```

The first event links to `sha256:genesis`. `actor` is `human:`, `model:`, `runtime:`, `hook:`, `daemon:` or `ci:` plus a name; a person at a terminal is `human:<user>`, an agent's shell is `model:main`, a CI job is `ci:pipeline`. Current state in the rest of the database is a projection that can be rebuilt from events.

`unknot audit verify` recomputes every hash and link and checks every signature, and reports the first broken event. `unknot audit export` writes NDJSON with the audit public key in a header, so an auditor can verify offline. The audit private key is in `<home>/projects/<project-id>/audit.pem`. See the limits in [SECURITY.md](../SECURITY.md#limitations): the ledger detects edits, and `verify` checks against the public key in `$UNKNOT_HOME` rather than the copy in the database (a differing copy reports LEDGER UNTRUSTED, exit 4; with no key in `$UNKNOT_HOME` it falls back to the database copy and says so). Anyone holding the private key can re-sign.

Artifacts (command output, patches) are stored by SHA-256 of their plaintext and encrypted with AES-256-GCM under a per-project key. Reading one re-hashes it. Deleting the project key directory (`gc --shred`) makes them unrecoverable.

## Secrets and untrusted text

- Credential-shaped paths (`.env*`, private keys, `.ssh`, cloud credential files, token files) cannot be read or written by the model during a run.
- Output printed by the CLI, written to proof bundles and generated documentation, and returned from brokered commands to the model passes through `redact`, which replaces known token formats and `KEY=value` assignments with `[REDACTED:<kind>]`. Add patterns with `security.redact_patterns`.
- The security adapter records secret findings as kind and location only, never the value or the text near it.
- Telemetry carries only counts, durations, ids and states. Attribute keys outside an allowlist are dropped, strings are redacted and truncated, and paths and error messages are never exported.
- `PostToolUse` looks at what tools returned for text addressed to an AI, requests to exfiltrate, `curl | sh`, destructive commands and claims of pre-approval. A hit is recorded as an `injection.suspected` event and the model is reminded that the content is data. This is a nudge and a record, not the control.

## The optional daemon

`unknot daemon` exposes the library functions behind the CLI over HTTP. Local mode binds loopback only, requires a bearer token from a mode-0600 file, checks `Host`, sends no CORS headers, and rate-limits. Remote mode requires mutual TLS and OIDC tokens with offline signature checks, role mapping and tenant separation. No endpoint approves, and no endpoint runs a shell. Details and the threat table are in `runtime/daemon/README.md`.
