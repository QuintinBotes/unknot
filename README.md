# Unknot

> Untangle complexity. Preserve behavior.

Unknot is a Claude Code plugin for simplifying existing codebases under governance. It maps a repository (code, data, infrastructure, delivery, ownership), finds accidental complexity, proposes the smallest change that would remove it, applies one approved change at a time in an isolated git worktree, and proves the result with commands it ran itself. A person approves each step.

It is not a formatter, a "clean code" prompt, or an autonomous rewrite engine. The model proposes. A deterministic runtime decides what is allowed, runs the checks, and records what happened.

## Why

Asking a coding agent to "refactor this" gives you a large diff and a claim that tests pass. You then have to work out whether the claim is true, whether anything outside the intended area changed, and how to undo it. Unknot is built around the questions a reviewer would ask:

- What is the complexity, and what evidence says so?
- Why is it accidental and not essential?
- What is the smallest useful change, and what must stay the same?
- How is it verified, how is it reversed, and who has to sign off?
- What is still uncertain?

Every finding answers those ten questions or says it cannot. See [docs/concepts.md](docs/concepts.md).

## Install

From the author's catalog:

```sh
claude plugin marketplace add QuintinBotes/claude-plugins
claude plugin install unknot@quintinbotes
```

Or directly from this repository:

```sh
claude plugin marketplace add QuintinBotes/unknot
claude plugin install unknot@unknot
```

The plugin ships a `bin/unknot` CLI. While the plugin is enabled, Claude Code puts it on `PATH` for the Bash tool. To use it from your own terminal (you need to, for approvals), run it by its path inside the plugin directory, or put that directory on your `PATH`.

### Requirements

| Requirement | Notes |
|---|---|
| Node.js 22.13 or later | Required. No npm dependencies. `unknot doctor` checks the version (it needs `node:sqlite`). |
| git | Required. Worktree isolation, the file census and change history depend on it. |
| python3 | Optional. Used for Python AST extraction; without it Python files use a lexical fallback. |
| helm, kustomize | Optional. Render charts and overlays when present; a missing renderer is recorded as a gap. |
| terraform (or tofu) | Optional. Used only for read-only commands such as `validate`, `show`, `graph`. |
| gitleaks, semgrep | Optional. Extra evidence when installed and switched on in the config (`adapters.security`); see [docs/adapters.md](docs/adapters.md). Built-in secret redaction does not depend on them. |
| OS sandbox | macOS: `sandbox-exec` (ships with the OS). Linux: `bwrap` (bubblewrap). Other platforms: none; see [SECURITY.md](SECURITY.md). |

Linux and macOS are supported and tested in CI. Windows is not tested; use WSL2. Details in [COMPATIBILITY.md](COMPATIBILITY.md).

## Quickstart

Run these in your repository. Steps marked (human) must be done by you in a real terminal, not by Claude; the runtime refuses them from an agent.

1. `/unknot:init`. Detects your build, test and lint commands and writes `.unknot/config.proposed.yaml`. Nothing else changes.
2. (human) Review the proposal: `unknot config diff`.
3. (human) Create an approver key: `unknot keys generate <name>`. It prompts for a passphrase and prints an `approvers:` block with your public key. Add that block to the proposed config, with the roles you hold (for example `code-owner`).
4. (human) Set `mode: assist` in the proposal if you intend to apply patches (the default, `plan`, cannot). Then `unknot config accept`, and type the mode back to confirm. Until you do this, the config is not honoured beyond plan mode with no approvers. Do this before approving anything: approvals bind the configuration digest, so a later config change makes them stale.
5. `/unknot:map`. Builds the graph.
6. `/unknot:diagnose`. Ranked findings. Add `--objective "reduce deployment coupling"` to bias the ranking.
7. `/unknot:explain F-0001`. Evidence, uncertainty, alternatives, pattern fit.
8. `/unknot:decompose` if the question is whether to split a monolith. See [docs/decomposition.md](docs/decomposition.md).
9. `/unknot:plan "<objective>" --findings F-0001,F-0002` (or `--from DEC-0003`). Creates a campaign of slices, each waiting for approval.
10. (human) Approve the exact plan: `unknot approve UK-0001 --role code-owner --as <name>`. The approval is bound to the current `HEAD`, so do not commit before `apply`.
11. `/unknot:apply UK-0001`. Edits happen only in the slice's worktree.
12. `/unknot:verify UK-0001`. Runs the proof obligations and writes a proof bundle.
13. (human) Read the bundle and the diff, then approve the change: `unknot approve UK-0001 --role code-owner --as <name>`. The slice becomes `ACCEPTED`. Unknot does not merge or push. You open the pull request from the slice branch.

If an assumption in the plan turns out wrong, `/unknot:apply UK-0001 replan` returns the slice to planning. `/unknot:rollback UK-0001` discards an unaccepted slice, or prepares a revert branch for an accepted one.

## Commands

| Command | Purpose | Writes |
|---|---|---|
| `/unknot:init` | Detect tools, propose configuration | `.unknot/config.proposed.yaml` |
| `/unknot:map [scope]` | Build or refresh the system graph | Unknot state only |
| `/unknot:diagnose [scope]` | Find and rank simplification opportunities | Findings in state |
| `/unknot:explain <F-id>` | Evidence, uncertainty, alternatives, pattern fit | None |
| `/unknot:decompose [scope]` | Find decomposition boundaries, pick the least invasive treatment | `.unknot/decompositions/` |
| `/unknot:plan "<objective>"` | Create a campaign of slices | Campaign and slice files |
| `/unknot:next [campaign]` | Select the smallest unblocked slice | None |
| `/unknot:apply <slice>` | Patch one approved slice in its worktree | Worktree only |
| `/unknot:verify <slice>` | Run proof obligations, emit a proof bundle | Run artifacts |
| `/unknot:architecture [scope]` | C4 and topology views, style classification | `.unknot/docs/architecture/` (plan mode or above) |
| `/unknot:database [scope]` | Ownership, schema, migration hazards, recovery | None |
| `/unknot:infrastructure [scope]` | IaC, plans, drift, IAM, network exposure | None |
| `/unknot:security [scope or slice]` | Threat checklist; security delta of a slice | None |
| `/unknot:status` | Mode, campaigns, slices, approvals, blockers, stale evidence | None |
| `/unknot:rollback <slice>` | Discard a patch, or prepare a revert branch | Worktree and branch |
| `/unknot:accept <F-id>` | Record that a finding is accepted as is | `.unknot/decisions.jsonl` |
| `/unknot:reject <F-id>` | Record rejection and suppress for N days | `.unknot/decisions.jsonl` |
| `/unknot:learn [report\|propose]` | Metrics, detector calibration, threshold proposals | `config.proposed.yaml` (propose) |
| `/unknot:doctor` | Validate sandbox, ledger, config, adapters, tools | None |

Commands meant for a person at a terminal (`approve`, `attest`, `keys`, `config accept`, `run end`, `policy keygen|sign`, `gc --shred`) check for a TTY, and an agent's shell is also barred from `backup`, `audit`, `daemon`, `policy`, `gc`, `config` and `run`. None of them has a skill. Full reference: [docs/commands.md](docs/commands.md).

## Modes

| Mode | What it permits |
|---|---|
| `observe` | Read and inventory. No documentation or plan writes. |
| `plan` (default) | Observe, plus plans, campaigns and architecture documents. |
| `assist` | Plan, plus scoped patches in an isolated worktree for approved slices. |
| `governed` | Assist, plus a commit on the slice branch once the change is approved. |
| `campaign` | Ranked above `governed`. Like `governed`, but a run may move on to the next slice of the same campaign once the current slice is settled. Each slice still needs its own approved plan. In every other mode a run handles one slice. |

A mode higher than `plan` takes effect only after a human accepts the configuration. A config change made by anyone else (an agent, a merge, a script) can lower the mode but cannot raise it. Mode and every other key: [docs/configuration.md](docs/configuration.md).

## What Unknot never does

From the product spec (§2.2) and the code:

- Rewrite a system in one operation. A slice has a file and diff budget (defaults: 12 files, 500 lines).
- Assume microservices, a monolith, event sourcing, Kubernetes or any pattern is better by default. "Retain" is always an option and often wins.
- Modify production databases or infrastructure. There is no database connection and no `terraform apply`, `destroy`, or `kubectl` without a dry run. Database and cloud facts come from exports you supply.
- Merge, push, publish, deploy or destroy anything. It stops at a reviewable branch.
- Claim behaviour is preserved because tests passed. It records what ran and what did not, and asks a human to attest what cannot be executed.
- Create abstractions to fit a pattern, or remove resilience, observability, security or recovery controls as "boilerplate".
- Settle ambiguous domain behaviour without a person.
- Edit generated, vendored or third-party code as ordinary source.
- Approve its own work. Approvals require a person at a terminal with a passphrase-protected key.
- Send source, diffs or secrets anywhere. Telemetry is off by default and carries only counts and ids when on.

## Evidence

Every fact in the graph carries provenance: where it was seen (`path:line`), which extractor produced it and at what version, which commit, and a confidence. Facts are labelled observed, corroborated, inferred, unknown or contradicted, and contradictions are kept. A finding cites these facts. A proof obligation is satisfied only by an evidence record from a command the runtime ran (argument vector, working directory, exit code, output digests, sandbox used), or by a signed human attestation. The model cannot mark an obligation passed. At the end of verification the runtime writes a proof bundle: the diff, the approvals, every command and its result, the residual uncertainties and the recovery procedure. See [docs/concepts.md](docs/concepts.md).

## Approvals

Approval is an Ed25519 signature by a registered approver over a binding of the exact thing approved: commit, slice content digest, diff hash, policy digest, environment and expiry (default 72 hours). Change anything material and the old signature no longer matches. Risk sets who must sign: low needs a code owner; medium adds an affected owner; high adds a specialist owner (security, data or platform); critical needs two different people. Approval commands refuse to run without an interactive terminal, and an agent's shell has none. See [docs/security-model.md](docs/security-model.md).

## The learning loop

Your accept and reject decisions on findings are the feedback. `unknot learn report` computes, per detector, how often its findings are accepted and re-ranks that detector up or down within bounds. When you keep rejecting findings just above a size threshold, `unknot learn propose` writes a higher threshold to `.unknot/config.proposed.yaml`. It never edits accepted configuration, never disables a detector, and a human has to accept the proposal like any other config change. See [docs/learning.md](docs/learning.md).

## Documentation

- [docs/README.md](docs/README.md): index
- [docs/concepts.md](docs/concepts.md): graph, findings, campaigns, proof
- [docs/commands.md](docs/commands.md): every CLI command
- [docs/configuration.md](docs/configuration.md): every config key, acceptance rules, org policy
- [docs/security-model.md](docs/security-model.md): policy decisions, broker, sandbox, approvals, ledger
- [docs/decomposition.md](docs/decomposition.md): monolith decomposition
- [docs/learning.md](docs/learning.md): metrics and calibration
- [docs/adapters.md](docs/adapters.md): what is understood, at what confidence
- [docs/runtime-evidence.md](docs/runtime-evidence.md): export traces and metrics from a hosted observability vendor
- [docs/faq.md](docs/faq.md)
- [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [COMPATIBILITY.md](COMPATIBILITY.md), [CHANGELOG.md](CHANGELOG.md)
- Design: [docs/spec.md](docs/spec.md), [docs/research/decomposition.md](docs/research/decomposition.md), [docs/operations.md](docs/operations.md), [docs/release.md](docs/release.md), [docs/benchmarks.md](docs/benchmarks.md)

Version 0.1.0 is pre-release. Minor releases before 1.0 may break compatibility; breaking changes are listed in the changelog.

License: Apache-2.0.
