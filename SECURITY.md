# Security policy

## Supported versions

| Version | Supported |
|---|---|
| Latest minor release | Security and bug fixes |
| Previous minor release | Security fixes only, for 90 days after the newer minor is published |
| Older | Not supported |

Unknot is at 0.1.0. Before 1.0, minor releases may include breaking changes (see [COMPATIBILITY.md](COMPATIBILITY.md)). A change that makes a previously permissive security behaviour stricter is treated as a patch-level fix.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository: <https://github.com/QuintinBotes/unknot/security/advisories/new> (the "Report a vulnerability" button on the Security tab of `QuintinBotes/unknot`). Do not open a public issue for a security problem.

Useful reports include: the Unknot version (`unknot --version`), OS and Node version, `unknot doctor` output, and the smallest repository or command sequence that reproduces the problem. Reports about any of the following are in scope:

- a way for model-issued actions to write outside a slice's worktree or scope, or to modify Unknot's state, configuration or keys
- a way for an agent to approve, accept configuration, end a run, or otherwise act as a human
- a shell command that the command rules allow but that writes files, runs programs, or reads outside the project
- a path-traversal or symlink escape
- credentials reaching model context, logs, proof bundles or telemetry
- a brokered command running with credentials, network, or write access it should not have
- a ledger edit that `unknot audit verify` does not detect
- a flaw in policy bundle, backup, or daemon authentication

Advisories are published as GitHub Security Advisories and listed in [CHANGELOG.md](CHANGELOG.md) under the fixing release. Release artifacts carry checksums, an SBOM and Sigstore provenance; see [docs/release.md](docs/release.md).

## Threat model summary

Unknot runs next to a language model that reads untrusted text: source files, comments, issue text, dependency metadata, tool output. The threats it is designed against (spec §16.1):

- prompt injection in repository content and tool output
- malicious repositories that try to run commands or exfiltrate data
- shell injection, path traversal and symlink escape
- secrets entering model context, logs or proof bundles
- tool substitution (a repository-supplied binary named like a trusted tool)
- compromised MCP servers, scanners or language servers
- over-broad agent permissions and confused-deputy behaviour
- cross-run and cross-project leakage; poisoned or stale evidence
- destructive git, database, cloud or cluster actions
- hallucinated evidence and tests that were claimed but never run

The core design rule is that the model proposes and deterministic code authorizes. Repository text and tool output are treated as data and never as instructions. The model's authority comes only from the policy decision point (PDP), the capability it was issued, and the run it is in.

Trust boundaries: user and Claude Code; model and Unknot runtime; runtime and repository; runtime and local tools; runtime and MCP servers; runtime and the optional daemon. Unknot has no connection to databases, clouds, clusters, or source-control hosts.

## Controls and where they live

| Control | Where |
|---|---|
| Deny by default for unknown tools and operations | `runtime/policy/pdp.mjs` (`decide`, `tool.unknown`) |
| Hooks on every tool call, subagent start and stop, and stop | `hooks/hooks.json`, `runtime/hooks/handlers.mjs` |
| Hook failure blocks mutating tools in an initialised project | `runtime/hooks/main.mjs` |
| Canonical path and symlink checks | `runtime/core/paths.mjs`, `runtime/policy/pdp.mjs` |
| Unknot state, config, decisions and key directory not writable or readable by agents | `alwaysOn` in `runtime/policy/pdp.mjs` |
| Credential-looking paths not readable or writable | `isSecretPath` in `runtime/core/paths.mjs`, used by the PDP |
| Static shell analysis: read-only allowlist, no redirects to files, no computed commands, no privilege wrappers | `runtime/core/shell.mjs`, `runtime/policy/commands.mjs` |
| Human-only subcommands (`approve`, `attest`, `keys`, `config accept`, `run end`, `policy`, `gc`, `backup`, `audit`, `daemon`) | `HUMAN_ONLY_SUBCOMMANDS` in `runtime/policy/commands.mjs`; `requireHumanTTY` in `runtime/cli/util.mjs` |
| Capability tokens per subagent, HMAC-signed, issued on `SubagentStart`, revoked on `SubagentStop` | `runtime/policy/capability.mjs` |
| Least-privilege profile per agent type; unknown agents get read-only | `PROFILES` in `runtime/policy/capability.mjs` |
| Budgets (tool calls, files and bytes read, commands, network requests, delegation depth) | `runtime/policy/budget.mjs`, `runtime/policy/pdp.mjs` |
| Command broker: argument vectors, no shell, per-tool argument rules, minimal environment, timeouts, output caps | `runtime/broker/broker.mjs` |
| OS sandbox for brokered commands: write confinement, no network, credential directories hidden | `runtime/broker/sandbox.mjs` |
| Secret redaction before output, logs, bundles and tool-result notes | `runtime/core/redact.mjs`; `output` in `runtime/cli/util.mjs` |
| Prompt-injection markers recorded and the model reminded that content is data | `runtime/core/injection.mjs`, `onPostToolUse` |
| Approvals: Ed25519 signature over commit, slice digest, diff hash, policy digest, environment, expiry | `runtime/policy/approvals.mjs` |
| Risk classification only ever raises risk | `runtime/policy/risk.mjs` |
| Configuration honoured only after human acceptance; unaccepted changes may only tighten | `runtime/policy/config.mjs` |
| Organization policy: signed bundles, tighten-only merge | `runtime/policy/config.mjs`, `runtime/policy/merge.mjs`, `runtime/enterprise/policy-bundle.mjs` |
| Append-only event ledger, hash-chained and signed | `runtime/state/ledger.mjs` |
| Encrypted content-addressed artifact cache (AES-256-GCM) | `runtime/state/cas.mjs`, `runtime/core/keys.mjs` |
| Source changes only in a dedicated worktree, only for an approved slice, only inside slice scope | `runtime/apply/`, `decideWrite` in `runtime/policy/pdp.mjs` |
| Stop hook refuses success while a slice is patching or has open obligations | `onStop` in `runtime/hooks/handlers.mjs` |
| Telemetry off by default; attribute allowlist; no content | `runtime/telemetry/otel.mjs` |
| Daemon: loopback only, bearer token, no approval endpoint | `runtime/daemon/` |

Detail for each is in [docs/security-model.md](docs/security-model.md).

## Limitations

These are real, and you should weigh them before pointing Unknot at a sensitive repository.

**Hooks are defense in depth, not a sandbox.** They run in Claude Code's process model and can only allow or deny the tool calls Claude Code reports to them. They enforce the full policy (scope, mode, slice worktree, read-only shell) only while an Unknot run is active, which starts when you type a `/unknot:` command. Outside a run, only the always-on rules apply: Unknot's own state and config files, the key directory, and the human-only commands. Installing the plugin does not change sessions that are not using it, by design.

**If a hook crashes**, mutating tools (edit, write, Bash, web, agents, MCP) are denied in an initialised project until `unknot doctor` passes. Reads stay allowed so you can investigate. In a project that was never initialised, hooks do nothing.

**Static shell analysis is fail-closed, not a sandbox.** Commands the parser cannot fully analyse are denied. Allowed commands are a fixed read-only set (plus read-only git subcommands, `sed -n` with print-only scripts, and the Unknot CLI). This blocks known ways to turn a read into an execution (`find -exec`, `sort -o`, `git -c`, `rg --pre`), but it is a list. A tool or flag combination missing from the review could slip through. Adversarial tests live in `tests/adversarial/`. Anything that builds, tests or installs goes through the broker.

**The OS sandbox is not available everywhere.** macOS uses `sandbox-exec` (which Apple has deprecated but still ships). Linux uses `bwrap` if installed. Elsewhere there is none. With no sandbox, brokered commands run without confinement (a test suite from your repository is code that runs), and `unknot doctor` reports it as a warning. Set `security.require_os_sandbox: true` to refuse to run brokered commands without one. Even where a sandbox exists, it confines writes and network; it does not make most of the filesystem unreadable. It hides the usual credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, and others) and the Unknot home directory, and relies on having no network to stop exfiltration.

**Project commands are yours.** The commands in `config.commands` (`npm test`, `make lint`) are human-authored and run as declared, without a shell, inside the sandbox where there is one. They execute repository code. The trust decision is the human acceptance of the configuration. Once a config has been accepted, `commands`, approvers, adapters, detectors and evidence sources from later unaccepted edits are ignored. A config file that was never accepted is capped at plan mode with no approvers, but its `commands` are still read, so review `.unknot/config.yaml` in a freshly cloned repository before running anything that executes configured commands (`unknot exec`, `unknot verify`).

**The ledger is tamper-evident, not tamper-proof.** Each event's hash covers the previous event's hash and is signed with a per-project key. Editing or deleting a row breaks the chain, and `unknot audit verify` shows where. The signing key lives in the Unknot home directory (`$UNKNOT_HOME`, else `~/.config/unknot`) as the same user. Someone with that account can rewrite history and re-sign it, and truncating the tail leaves a shorter valid chain unless you have recorded the head hash elsewhere. `unknot audit verify` checks signatures against the audit public key in `$UNKNOT_HOME`, not the copy in the state database. If the database copy differs it reports LEDGER UNTRUSTED and exits 4. If no key exists in `$UNKNOT_HOME` (for example after a restore on another machine) it falls back to the database copy and says so (`anchor`), and in that case someone who can write the database can replace the key and the chain together. `unknot doctor` flags a mismatch and warns when the key is missing. To rely on the ledger, export it with `unknot audit export` to storage that you control, and keep the public key from the export header (or the fingerprint of `$UNKNOT_HOME/projects/<id>/audit.pem`) somewhere else to compare against.

**Output a tool already returned cannot be unread.** `PostToolUse` cannot rewrite a result that Claude Code has already given the model. It records a secret or injection detection and adds a reminder. Reads of credential-shaped paths (`.env`, keys, `.ssh`) are denied before they happen, but a secret sitting in an ordinary source file is returned like any other text. Unknot's own CLI output is redacted before printing. Redaction is pattern-based and misses secrets that do not look like secrets.

**Injection detection is heuristic.** Marker patterns record likely attempts and nudge the model. They are not what protects you. What protects you is that text never authorizes anything and every action passes the PDP.

**The human boundary rests on a terminal and a passphrase.** The commands that sign or change authority (`approve`, `attest`, `keys generate`, `config accept`, `run end`, `policy keygen|sign`, `gc --shred`) require an interactive TTY, refuse when `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` is set, and read passphrases from `/dev/tty`. The environment-variable check is not evidence on its own (a process can unset variables), and a program that allocates a pseudo-terminal could satisfy the TTY check, so the hooks also refuse these verbs in the model's shell: all of them during a run, and `approve`, `keys`, `config accept`, `run end`, `policy sign` and `gc --shred` even when no run is active. The signing key is encrypted. The passphrase is the real barrier; an agent that cannot supply it cannot sign. Approver and policy-signing passphrases are your responsibility (minimum 8 and 12 characters respectively).

**Approval is only as good as the review.** The signature proves who approved which diff and plan. It does not prove they read the proof bundle.

**Configuration acceptance is the root of trust.** Whoever can run `unknot config accept` at a terminal as you can register approvers and raise the mode. Organization policy can lock approvers (`approvers_locked`) and cap the mode (`max_mode`).

**Organization policy without trusted keys is accepted unsigned.** A policy directory that has a `trusted-keys/` directory requires a valid signature. One without it is loaded as-is; `unknot policy verify` and `unknot doctor` warn. Managed locations (`/Library/Application Support/Unknot`, `/etc/unknot`) should be writable only by administrators.

**Backups exclude keys.** `unknot backup` does not include the project key directory (`<home>/projects/<project-id>/`: audit, cache and capability keys), approver keys, or policy signing keys. A restore without the key directory recovers the database, ledger, config and plans, but the artifact cache stays unreadable. Escrow those keys separately. See [docs/operations.md](docs/operations.md).

**Detection quality is bounded.** Adapters are static and deliberately powerless. Dynamic imports, reflection, runtime-computed SQL, and generated code are largely invisible, and findings say so. A clean `diagnose` does not mean a clean system.

**Windows is not tested.** Use WSL2.

**No independent audit.** Unknot has not had a third-party security review.
