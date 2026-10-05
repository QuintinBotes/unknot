# Command reference

Every Unknot capability is a subcommand of the `unknot` CLI (`bin/unknot` in the plugin). The `/unknot:*` skills in Claude Code call the same CLI. Run `unknot help` for the list and `unknot --version` for the version.

## Conventions

**Arguments and flags.** `--flag value` and `--flag=value` both work. A flag with no following value, or followed by another `--flag`, is `true`. Because of that, put `--json` after positional arguments: `unknot diagnose src --json`, not `unknot diagnose --json src` (which would read `src` as the value of `--json`). Repeat a flag to collect several values where noted (`--driver`).

**Global flags.**

| Flag | Meaning |
|---|---|
| `--json` | Machine-readable output where the command supports it (marked below). Errors are then printed to stdout as `{"error": {...}}`. |
| `--cwd <dir>` | Open the project containing this directory instead of the current directory. |

Some commands (`explain`, `slice`, `config show`, `graph stats|node`, `pattern show|fit`) always print JSON.

**Where the project is.** Unknot walks up from the working directory to the nearest `.unknot/` (and treats a path inside `.unknot/worktrees/<id>` as belonging to its parent project). `UNKNOT_HOME` overrides where per-user secrets live (default `~/.config/unknot`).

**Output is redacted.** Credential-shaped values in anything the CLI prints are replaced with `[REDACTED:<kind>]`.

**Errors.** On failure the CLI prints `unknot <command>: <CODE>: <message>` to stderr, or with `--json` an object like:

```json
{"error": {"code": "UK_POLICY_DENIED", "class": "policy-denied", "message": "...", "run_id": null, "slice_id": null, "retryable": false, "details": {}}}
```

Codes: `UK_CONFIG_INVALID`, `UK_SCHEMA_INVALID`, `UK_NOT_FOUND`, `UK_NOT_INITIALIZED`, `UK_ADAPTER_UNSUPPORTED`, `UK_BASELINE_INVALID`, `UK_SCOPE_VIOLATION`, `UK_POLICY_DENIED`, `UK_APPROVAL_REQUIRED`, `UK_APPROVAL_STALE`, `UK_BUDGET_EXCEEDED`, `UK_TOOL_FAILED`, `UK_EVIDENCE_INCONCLUSIVE`, `UK_VERIFICATION_FAILED`, `UK_STATE_CONFLICT`, `UK_RECOVERY_REQUIRED`, `UK_INTEGRITY`. Set `UNKNOT_DEBUG=1` to print stack traces.

**Exit codes.**

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Error, or a command whose job is to report a verdict found a bad one: `verify` not reaching `REVIEW_READY`, `exec` not passing, `doctor` with a failed check, `policy verify` on an invalid policy. |
| 2 | Unknown command, or missing or unknown subcommand for `audit`, `backup`, `graph`, `learn`, `pattern`, `policy`, `workspace`. |
| 3 | `UK_POLICY_DENIED` or `UK_APPROVAL_REQUIRED`: policy refused the operation, or approvals are missing. |
| 4 | Integrity failure: `audit verify` found a broken ledger, or `backup verify` found an invalid archive. |

**Human-only commands.** Two mechanisms keep commands out of an agent's hands.

1. *TTY check inside the command.* `approve`, `attest`, `keys generate`, `config accept`, `cli install|uninstall`, `run end`, `policy keygen`, `policy sign` and `gc --shred` refuse unless stdin and stdout are a terminal and `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` are unset. Secrets (passphrases, confirmations) are read from `/dev/tty`.
2. *Shell rule.* While Claude Code runs a command through its Bash tool, the command rules refuse the verbs `approve`, `attest`, `keys`, `config` (all subcommands, including `show` and `diff`), `run`, `policy`, `gc`, `daemon`, `backup` and `audit`. Run these in your own terminal. `backup`, `audit`, `daemon`, `policy verify|effective|trust`, `gc` without `--shred` and `config show|diff` have no TTY check of their own, so a script or CI job you control can run them.

## Command summary

| Command | Mutability | Human-only | Skill |
|---|---|---|---|
| `init` | Writes `.unknot/` and `config.proposed.yaml` | no | `/unknot:init` |
| `map` | Writes Unknot state | no | `/unknot:map` |
| `diagnose` | Writes findings to state | no | `/unknot:diagnose` |
| `explain` | Read-only | no | `/unknot:explain` |
| `decompose` | Writes `.unknot/decompositions/*.json` | no | `/unknot:decompose` |
| `plan` | Writes campaign and slice files | no | `/unknot:plan` |
| `next` | Read-only | no | `/unknot:next` |
| `apply` | Creates a worktree and branch; edits happen there | no | `/unknot:apply` |
| `verify` | Runs sandboxed commands; writes run artifacts | no | `/unknot:verify` |
| `architecture` | Writes docs (plan mode and above) | no | `/unknot:architecture` |
| `database` | Read-only | no | `/unknot:database` |
| `infrastructure` | Read-only | no | `/unknot:infrastructure` |
| `security` | Read-only | no | `/unknot:security` |
| `status` | Read-only | no | `/unknot:status` |
| `rollback` | Removes a worktree, or creates a revert branch | no | `/unknot:rollback` |
| `accept`, `reject` | Appends to `.unknot/decisions.jsonl` | only via a person's prompt | `/unknot:accept`, `/unknot:reject` |
| `doctor` | Read-only | no | `/unknot:doctor` |
| `cli` | `install` and `uninstall` write or remove a launcher outside the project | install/uninstall yes (TTY check) | none |
| `learn` | `propose` writes `config.proposed.yaml` | no | `/unknot:learn` |
| `exec` | Runs a configured command in the sandbox | no | none |
| `pattern`, `graph`, `slice` | Read-only | no | none |
| `approve` | Records a signed approval | yes | none |
| `attest` | Records a signed human attestation | yes | none |
| `keys` | Creates an approver key | yes | none |
| `config` | `accept` replaces the config | `accept` yes; all subcommands blocked from an agent's shell | none |
| `run` | `end` ends a run | `end` yes; all subcommands blocked from an agent's shell | none |
| `audit` | Read-only export or verification | yes (from an agent's shell) | none |
| `policy` | Keys, signing, trust | yes (from an agent's shell) | none |
| `backup` | Writes or restores archives | yes (from an agent's shell) | none |
| `gc` | Deletes old runs and cache; `--shred` destroys keys | yes (from an agent's shell) | none |
| `daemon` | Serves a local API | yes (from an agent's shell) | none |
| `workspace` | Maps linked repositories | no | none |

## Setup and configuration

### `unknot init`

Detects build, test and lint commands from `package.json`, Python, Go, Cargo, Maven, Gradle and Makefile projects (it reads files and runs nothing), creates `.unknot/`, and writes `.unknot/config.proposed.yaml` with `mode: plan` (nothing is activated; a read-only assessment needs nothing more). Records a `config.proposed` ledger event. It says what `.unknot/` is for and whether git already ignores it. Flag: `--json` (proposal, detected commands and `state_dir: { path, ignored, exclude_line }`).

### `unknot config show | diff | accept`

- `show`: effective configuration, digest, acceptance state, notice, sources, org policy bundles and adjustments. Always JSON.
- `diff`: prints the current file and the proposal (or, with no proposal, the current file) for review.
- `accept` (human): prints the proposal, asks you to type its mode, then moves `config.proposed.yaml` to `config.yaml` and records its digest and text as accepted. Run it again after any hand edit of `config.yaml`; until then only tightening edits apply. See [configuration.md](configuration.md).

### `unknot keys generate <name>` (human)

Prompts for a passphrase twice (minimum 8 characters), writes an Ed25519 key pair under `$UNKNOT_HOME/approvers/` (private key encrypted, mode 0600), and prints the `approvers:` block to paste into the config. The name must match `^[A-Za-z0-9._-]{1,64}$`.

### `unknot policy keygen <name> | sign <file> --key <name> | trust <dir> --key <name> | verify <dir> | effective`

Organization policy bundles. `keygen` and `sign` are human-only (passphrase at least 12 characters). `verify` exits 1 if the signature or content is invalid. `effective` prints the effective config and what org policy changed; accepts `--json`. See [configuration.md](configuration.md#organization-policy).

### `unknot cli status | install | uninstall [--dir <dir>]`

Reaches the CLI from a normal terminal. `status` prints the CLI path, the launcher location and whether its directory is on `PATH`. `install` (human) writes a small launcher (default `~/.local/bin/unknot`) that runs the newest installed plugin version, or the checkout it was installed from, with the same arguments, stdio and exit code; it refuses to overwrite a file it did not write. `uninstall` (human) removes it only if unknot wrote it. On Windows both print instructions instead.

### `unknot doctor`

Checks the Node version, OS sandbox, git, python3, helm, kustomize, terraform, tofu, semgrep and gitleaks; and, in an initialised project, config acceptance, the effective config, org policy signatures, the ledger chain and signatures, the CLI path, launcher and `PATH`, registered approvers, adapters and the hook error log. Prints `ok`, warning, failure or info lines. Exit 1 if any check failed. Missing optional tools and a missing sandbox are warnings or info, not failures. Flag: `--json`.

## Understanding the system

### `unknot map [scope...]`

Builds or refreshes the graph. Scope arguments are path prefixes. Unchanged files are served from a cache keyed by content, adapter version and config digest.

| Flag | Meaning |
|---|---|
| `--adapter a,b` | Run only these adapters. |
| `--no-history` | Skip git history (co-change facts). |
| `--json` | Summary as JSON. |

Prints file, node and edge counts, cache use, history size, adapters that were unavailable, and any extraction failures (a partial map says `PARTIAL`).

### `unknot diagnose [scope...]`

Runs the detectors, ranks open findings, and reconciles them with earlier runs (a finding no longer seen is marked resolved).

| Flag | Meaning |
|---|---|
| `--objective "text"` | Boosts findings in categories the objective mentions (for example "database", "deployment coupling", "monolith"). |
| `--only a,b` | Run only these detectors. |
| `--limit N` | Rows to show (default 25). |
| `--json` | Stats, detector errors and findings. |

Detector problems are listed, not hidden.

### `unknot explain <F-id>`

Prints a finding as JSON keyed by the ten questions: `1_what`, `2_evidence` (each item with its provenance), `3_why_accidental`, `4_smallest_simplification`, `5_invariants`, `6_what_could_fail`, `7_verification`, `8_recovery`, `9_approvers`, `10_uncertainty`; plus alternatives, pattern fit, priority factors, measurements, thresholds and earlier decisions.

### `unknot decompose [scope...]`, `decompose list`, `decompose show <DEC-id>`

See [decomposition.md](decomposition.md). Scope entries are paths, globs, `ns:<namespace>` or `seed:<module or type>~N`, as for every command; a scope that matches nothing writes no records and says so. A candidate that comes back unchanged (same target, drivers and members) keeps its DEC id. `list` shows the saved records (stale when the graph changed since); `show` prints one with its metrics, evidence, rejections and readiness table.

| Flag | Meaning |
|---|---|
| `--target backend\|frontend\|auto` | Default `auto`: backend if there are at least two non-frontend modules, frontend if at least two frontend modules. |
| `--driver <id>` | Record a driver for this run. Repeatable. Drivers in `decomposition.drivers` are always included. |
| `--driver-source <url or document>`, `--driver-quote "<sentence>"` | Where the person's driver comes from, recorded as `driver_provenance`. |
| `--summary` | One line per candidate: id, name, size, treatment, confidence, and why the next more invasive treatment was rejected. |
| `--dry-run` | Compute and print; write no records and allocate no ids. |
| `--json`, `--full` | JSON summary; `--full` adds per-recommendation details. |

### `unknot architecture [scope...]`

Writes C4-style views, a style classification and (if the graph has one) a Structurizr DSL file to `.unknot/docs/architecture/` as Markdown. In `observe` mode it prints the pages and writes nothing. Flags: `--out <dir>` (inside the repository, not a credential path), `--max-nodes N` (default 60), `--container <id>`, `--json`. Fails with `UK_BASELINE_INVALID` if the graph is empty.

### `unknot database [scope...]`, `unknot infrastructure [scope...]`, `unknot security [scope | slice-id]`

Read-only reports built from the graph. `database`: engines, migrations by framework, tables and writers, shared-writer tables, hazardous migrations with lock forecasts, catalog evidence age, and required invariants (listed as declared or missing; Unknot never invents one). `infrastructure`: declared resources, state backends, imported plans, drift, public exposure, IAM wildcards, and which layers of the state hierarchy are present. `security`: the threat checklist from spec §16.1 with evidence or "none in graph", secret findings (kind and location only), privilege paths, trust boundaries; given a slice id, also that slice's security delta. All accept `--json`.

### `unknot graph stats | nodes [type] | node <id> | edges | cycles | hubs | neighbourhood`

Queries the graph. Flag `--limit N` (default 50) applies to every listing; a flag that needs a value and has none is an error. `--json` for all but `stats` and `node`, which always print JSON. `node` includes provenance of each fact. Wherever an id is expected a module path works (`src/x.cs` for `module:src/x.cs`).

- `edges [TYPE] [--type T[,T2]] [--from <id|path>] [--to <id|path>]`: edges filtered by type, source and target.
- `cycles [EDGE] [scope...]`: strongly connected components over one edge type (default `IMPORTS`), computed on the in-scope subgraph. Every member is listed; each component then shows its elementary cycles (shortest first, at most `--limit`), and the edges to cut (a small greedy set whose removal leaves no cycle, declared-only edges first). An edge held only by an injected member that is never used is marked `(declared only: <module> member <Name> is never used)`. `--json` is a list of `{size, members, cycles, cycles_truncated, cut}`.
- `hubs [EDGE] [--type T1,T2] [--within] [scope...]`: top fan-in and fan-out over the union of the edge types (default `IMPORTS`). Only in-scope modules are ranked; fan-in counts sources anywhere, or only in-scope ones with `--within`.
- `neighbourhood <id|path|TypeName> [--depth N] [--type T,...]`: the subgraph around a node, depth 1 to 3 (default 1).

Scope entries are the same everywhere: a path prefix, a glob, `ns:Namespace` or `seed:Name~N`. A scope that matches nothing prints a warning. Table cells cap at 60 characters, ids are never cut.

The MCP tools take the same filters: `graph_query` lists nodes by `type`, edges by `edge_type`, or one node's edges with `id` plus `edge_type`/`direction`; results are compact unless `full: true`, default limit 50 (at most 200), and a result over about 40 KB is cut with `truncated: true` and a hint. `graph_hubs` takes `edge_types`, `scope` and `within`; `graph_neighbourhood` takes the same byte cap.

### `unknot pattern list [--category c] [--treatment T] | show <id> | fit <id> --signals '<json>'`

Lists, shows or evaluates pattern cards against signals you supply. `fit` returns `fits`, `contraindicated`, `not_applicable` or `insufficient_evidence`, with reasons.

### `unknot status`

Mode, config acceptance, the active run, whether the graph is stale relative to `HEAD`, finding counts, campaigns, slices, blockers (blocked, `NEEDS_REPLAN`, `VERIFICATION_FAILED`), slices awaiting approval, open obligations and stale evidence (expired runtime facts, expired approvals). Flag: `--json`.

### `unknot workspace list | map [--no-history] | graph`

For explicitly linked repositories in `workspace.repositories`. See [operations.md](operations.md). `--json` supported.

## Deciding and planning

### `unknot accept <F-id> --rationale "..."` and `unknot reject <F-id> --rationale "..." [--days N]`

Record a human decision. `reject` suppresses the finding for `--days` (default `suppression.default_reject_days`, 90). Decisions are appended to `.unknot/decisions.jsonl` and feed the [learning loop](learning.md). From a terminal they are attributed to you. From Claude Code they are accepted only inside a run started by you typing `/unknot:accept F-0001 ...` (or reject) with that finding id; an agent cannot record one on its own. `--json` supported.

### `unknot plan "<objective>" [--from DEC-xxxx | --findings F-1,F-2 | --proposal file.json] [--scope a,b]`

Creates a campaign and its slices. Needs mode `plan` or higher. The runtime, not the planner, assigns each slice's risk, required approvers and proof obligations; a proposal can add obligations but not remove them. Every slice starts `AWAITING_APPROVAL`. `unknot plan show <CMP-id>` prints a campaign and its slices. `--json` supported.

### `unknot next [campaign]`

Selects the smallest unblocked, highest-value slice and says why; lists other ready slices and blocked ones. `--json` supported.

### `unknot slice <id>`

A slice with its obligations, approvals, worktree, baseline and diff hash. JSON.

## Approving, applying, verifying

### `unknot approve <slice> --role <role> --as <approver> [--stage plan|change|rollback]` (human)

Shows the objective, risk, required roles, scope, commit or diff hash, policy digest and expiry. You type the slice id to confirm, then the approver key's passphrase. Records an Ed25519 signature over that binding. Stage defaults from the slice state: `plan` while awaiting approval, `change` when `REVIEW_READY`, `rollback` when `ACCEPTED`. When the `change` stage is fully approved the slice becomes `ACCEPTED`; in `governed` or `campaign` mode Unknot also commits in the slice worktree. It never pushes or merges. A high or critical slice cannot be approved by the person who proposed it.

### `unknot approve --lane <LN-id> --as <approver> [--role <role>]` (human)

Approves the changes of every slice of a lane that is `REVIEW_READY`, one change approval per slice bound to its own diff, with one confirmation and one passphrase. Read `unknot lane review <LN-id>` first.

### `unknot lane approve <CMP-id> --as <approver> [--kinds deletion,tests] [--max-files N] [--max-lines N] [--expires 72h]` (human), `lane status [LN-id | CMP-id]`, `lane review <LN-id>`, `lane revoke <LN-id> [--reason "..."]` (human)

A lane is one signed plan approval for the low-risk slices of a campaign: low risk, one required role, no protected paths. `approve` lists what it covers and what it leaves out, then signs it; inside it the agent applies and verifies covered slices without asking per slice (`/unknot:lane`), and `apply finish` refuses a patch that is not deletion-only or test-only within the caps (defaults: both kinds, 5 files, 60 lines, never above the configured limits). `status` shows each lane, whether it is still valid and the state of its slices; `review` prints the diffs of its slices that are ready for review. A replanned slice, a configuration change, expiry or `revoke` ends coverage. See [security-model.md](security-model.md#approvals).

### `unknot apply <slice> [start | finish | replan | abandon] [--reason "..."]`

- `start` (default): needs mode `assist` or higher, no uncommitted changes to tracked files in the main checkout (untracked files and `.unknot/` are ignored), satisfied preconditions, and a fully approved plan. A plan approval is bound to the commit at `HEAD` when you approved, so a new commit between `approve` and `apply` makes it stale and you approve again. Creates the worktree and branch from the approved commit, runs `commands.test_unit` there as a baseline (it must pass; with none configured, behaviour preservation will need human attestation), and moves the slice to `PATCHING`. Edits are then confined to that worktree and the slice scope by the hooks.
- `finish`: stages the patch, enforces the diff budget, binds the diff hash, moves to `VERIFYING`.
- `replan --reason`: an assumption was wrong; back to planning, approvals invalidated.
- `abandon`: discards the worktree and branch.

Exit 3 with `UK_APPROVAL_REQUIRED` lists missing roles and stale approvals.

### `unknot verify <slice>`

Executes the slice's proof obligations: built-in checks (scope, diff budget, parse, secrets, cycles, API, complexity) and configured commands through the broker. Obligations that need a person are listed as waiting. If all pass the slice becomes `REVIEW_READY` and a proof bundle is written under `.unknot/runs/<run-id>/`. Exit 0 only for `REVIEW_READY`. `--json` supported.

### `unknot attest <PO-id> --result pass|fail --note "..." --as <approver>` (human)

Signs a human-review obligation (for example "data owner confirms a tested restore exists"). Then run `unknot verify <slice>` again.

### `unknot exec <name> [args...] [--slice <id>]`

Runs `commands.<name>` through the broker as recorded evidence: no shell, minimal environment, sandbox, output digests. Extra arguments must match `[A-Za-z0-9_./:@,+=-]+` and may not start with `--require`, `--loader` or `--import`. With `--slice`, runs in that slice's worktree. Exit 0 only on a pass. `--json` supported.

### `unknot rollback <slice>`

For a slice in `PATCHING`, `VERIFICATION_FAILED` or `REVIEW_READY`: marks it `ROLLED_BACK` and removes the worktree and branch. For an `ACCEPTED` slice: needs a rollback-stage approval, recovery type `revert`, and a commit whose message starts with `<slice-id>:` reachable from `HEAD`; creates `unknot/<slice>-rollback` in a new worktree with `git revert`. Nothing is pushed.

### `unknot run start <command> | end [id] | show [id]`

Run lifecycle. Hooks enforce policy only while a run is active, and only in the session that started it. Normally `/unknot:` commands start and end runs for you; a read-only command's run left open by an interrupted turn ends with your next message. `end` is human-only because ending a run lifts enforcement; `start` and `show` are blocked from an agent's shell too. Flags: `--slice <id>`, `--supersede`, `--outcome <text>`, `--json`.

## Learning

### `unknot learn report | propose`

`report` (default): product metrics, complexity outcomes and per-detector calibration. `propose`: writes threshold proposals to `config.proposed.yaml`. See [learning.md](learning.md). `report` accepts `--json`.

## State, audit and operations

### `unknot audit verify | export [--out file] [--after seq] [--limit N]`

`verify` (default) walks the ledger checking hash chain and signatures; exit 4 and the first broken event if it fails. It verifies against the audit public key in `$UNKNOT_HOME`; if the database copy differs it reports LEDGER UNTRUSTED and exits 4, and if there is no key in `$UNKNOT_HOME` it falls back to the database copy and names the `anchor` in the output. `unknot doctor` flags a mismatch and warns when the key is missing. `export` writes NDJSON, with a header line holding the audit public key, so an auditor can verify offline. Human-only from an agent's shell.

### `unknot backup create <file> | verify <file> | restore <file> --to <empty-dir>` `[--passphrase-file <file>]`

Encrypted, authenticated backup of Unknot state. The project key directory is not included. The passphrase comes from the terminal or from a mode-0600 file of at least 12 characters, never from argv or the environment. `verify` exits 4 if invalid. See [operations.md](operations.md).

### `unknot gc [--dry-run] | gc --shred`

`gc` applies `retention.runs` and `retention.cache`, keeping anything referenced by an unfinished slice. `--shred` (human) destroys the project's key directory after you type the project id; every cached artifact becomes unreadable. It cannot be undone.

### `unknot daemon [--port N]`

Starts the optional local API on `daemon.listen` (default `127.0.0.1:7433`). Prints the URL and the bearer token file path, never the token. No endpoint approves. See `runtime/daemon/README.md`.

## Slice states

```
AWAITING_APPROVAL -> PATCHING -> VERIFYING -> REVIEW_READY -> ACCEPTED
```

with `NEEDS_REPLAN`, `BLOCKED_POLICY`, `BLOCKED_UNCERTAINTY`, `VERIFICATION_FAILED`, `ROLLED_BACK` and `ABANDONED` as exceptional states. Transitions and guards are in [concepts.md](concepts.md#campaigns-slices-and-the-state-machine).
