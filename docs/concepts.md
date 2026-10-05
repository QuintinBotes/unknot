# Concepts

This page explains the objects Unknot works with and how they fit together. Command syntax is in [commands.md](commands.md); safety mechanisms are in [security-model.md](security-model.md).

## The pipeline

```
map -> diagnose -> explain -> (decompose) -> plan -> approve -> apply -> verify -> approve change
```

Each step produces something the next one consumes: a graph, findings, a campaign of slices, a patch in a worktree, evidence, a proof bundle, an approval. Nothing skips a step, and a human decision gates the two steps that matter most: starting a patch and accepting its result.

## The graph and provenance

`unknot map` builds a graph of the repository from adapters (see [adapters.md](adapters.md)). Nodes are things: modules, functions, classes, endpoints, tables, columns, migrations, topics, deployables, cloud resources, workloads, roles, owners, tests, decisions. Node ids are `<type>:<key>`, for example `module:src/billing/b1.js`, `function:src/a.ts#parse`, `table:public.orders`, `endpoint:GET /orders/:id`. Edges are relationships: `IMPORTS`, `CALLS`, `EXPOSES`, `READS`, `WRITES`, `QUERIES`, `MUTATES`, `MIGRATES`, `OWNED_BY`, `DEPENDS_ON`, `TESTS`, `CO_CHANGES` and so on. `unknot graph stats` lists the types present in your repository.

Every fact behind a node or edge carries provenance:

| Field | Meaning |
|---|---|
| `source_type` | `ast`, `lsp`, `trace`, `config`, `catalog`, `human`, `inference` or `vcs` |
| `source_ref` | Where it was seen, as `path:line` |
| `extractor` | The adapter and version, for example `javascript@0.1.0` |
| `commit` | The commit it was observed at |
| `observed_at` | When |
| `confidence` | `high`, `medium` or `low` |

Observed facts, inferences and recommendations stay separate. Heuristic extraction (framework conventions, regex-read DSLs, guessed topic names) says so with `medium` or `low` confidence and `inference` as the source. Runtime and plan evidence expires.

Evidence in findings and reports carries one of five labels:

| Label | Meaning |
|---|---|
| Observed | Direct code, configuration, deployment or trace evidence. |
| Corroborated | Independent evidence sources agree. |
| Inferred | Plausible but not directly observed. |
| Unknown | Not enough evidence. |
| Contradicted | Material evidence conflicts. Both sides are kept. |

The map is incremental: per-file extraction is cached by file content, adapter version and configuration digest. Facts are never reused across unrelated commits. `unknot status` tells you when the graph is stale relative to `HEAD`.

## Findings and the ten questions

A finding is a detector's claim that some complexity is worth removing. Detectors read the graph, never write, never run commands, and never decide priority, approvals or status; the engine does. The detectors are grouped as `local` (long, complex or deeply nested functions, large classes and modules, dead code, duplicated code, speculative generality), `module` (dependency cycles, hubs, layer bypass, shotgun surgery), `service` (distributed monolith, chatty calls, nanoservices, shared databases, event soup), `delivery`, `security`, `database`, `infrastructure`, `decomposition` and `frontend`. Run `unknot diagnose --json` to see the kinds in your repository.

Every finding must answer ten questions, or say it cannot. `unknot explain F-id` prints them:

1. What complexity exists?
2. What evidence supports that? (each item with its provenance)
3. Why is it accidental rather than essential? (and what might make it essential)
4. What is the smallest useful simplification?
5. What behaviour and qualities must remain unchanged?
6. What could fail?
7. How will it be verified?
8. How can it be aborted, reversed or restored?
9. Who must approve it?
10. What uncertainty remains?

Findings always list alternatives, and "retain" is always one of them. A finding has a stable fingerprint, so the same problem keeps the same `F-` id across runs. If a later run no longer sees it, it is marked resolved. Statuses: `open`, `accepted`, `rejected`, `suppressed`, `resolved`, `stale`.

Thresholds behind findings (80 lines, cyclomatic 15, and so on) are heuristics. Each finding lists the thresholds it used and labels them. Absence of references is never presented as proof of unreachability; a dead-code finding says that dynamic imports and framework conventions are invisible.

### Priority

Findings are ranked by

```
priority = benefit x evidence x reversibility
           ----------------------------------
           blast radius x cost x uncertainty
```

Benefit, blast, cost and uncertainty are each scored 1 to 5 by the detector; evidence and reversibility are 0 to 1. The score orders the list. It does not override policy, owners, approvals or failed guardrails. If you pass `--objective`, findings in categories the objective mentions are boosted by 1.5. Per-detector calibration from your accept and reject decisions multiplies the rank within bounds (see [learning.md](learning.md)); the underlying priority is unchanged so it stays comparable between runs.

### Accept and reject

`accept` records that a finding is real and will be left as it is; `reject` records that it is not worth acting on and suppresses it for a number of days (default 90). The fingerprint carries the suppression across runs. Both need a person, and both feed calibration.

## Pattern fit

Patterns are conditional tools. Each of the 265 pattern cards under `patterns/` is a YAML file with the problem it addresses, applicability signals, preconditions, contraindications, benefits, liabilities, the complexity it introduces, invariants, transformations, proof obligations, rollback strategies and a removal recipe. Conditions with a `predicate` over a named measurement (for example `boundary.shared_table_writers > 0`) are evaluated mechanically against what was measured:

| Fit | Meaning |
|---|---|
| `fits` | At least one applicability signal is true and nothing contradicts it. |
| `contraindicated` | A hard contraindication is true, or a precondition is false. |
| `not_applicable` | No applicability signal is true. |
| `insufficient_evidence` | A needed measurement does not exist. This is never treated as a pass. |

A card is never recommended because it exists. `unknot pattern fit <id> --signals '{...}'` lets you try one by hand. See `patterns/README.md` for the signal vocabulary and the card schema.

## Campaigns, slices and the state machine

A **campaign** is an objective with its alternatives, the selected approach and a rationale, and an ordered set of **slices**. A **slice** is the unit of change and approval. It must have one objective; declared include and exclude scope; preconditions on other slices; invariants; proof obligations; a recovery type; a risk class; and change budgets (defaults 12 files, 500 diff lines). It must leave the system in a releasable state and carry no unrelated cleanup.

The runtime classifies risk and takes control of what must be proven:

| Risk | Typical triggers | Required approval |
|---|---|---|
| low | Local rename; code with no inbound references | Code owner |
| medium | Module boundary or internal contract; dependency manifest change; infrastructure declaration; treatments T1, T2, T4, T5, T8 | Code owner and affected owner |
| high | Public API; auth or crypto paths; database schema; IAM or network change; plan deletes or replaces resources; protected paths; treatments T3, T6, T7, T9 | Code owner and a specialist owner (security, data or platform) |
| critical | Production data movement; recovery posture (backup, retention, replication); tenant boundary; any irreversible step | As high, and at least two different people |

Classification only raises risk. A planner can declare a higher risk, but nothing a slice says about itself lowers it.

Slice states and the legal moves between them:

```
AWAITING_APPROVAL -> PATCHING -> VERIFYING -> REVIEW_READY -> ACCEPTED
```

| State | Meaning |
|---|---|
| `AWAITING_APPROVAL` | Planned. A human approval of the exact plan is needed before apply. |
| `PATCHING` | A worktree exists; edits are confined to it and the slice scope. |
| `VERIFYING` | The patch is staged and its hash is bound; obligations are being run. |
| `REVIEW_READY` | All obligations passed or were attested. Waiting for a human to approve the change. |
| `ACCEPTED` | Change approved. Unknot does not merge or push. |
| `VERIFICATION_FAILED` | An obligation failed. May go back to `PATCHING`, be replanned, rolled back or abandoned. |
| `NEEDS_REPLAN` | An assumption was false. Never widen scope; replan. |
| `BLOCKED_POLICY`, `BLOCKED_UNCERTAINTY`, `BLOCKED_BASELINE` | Waiting on a policy fix, evidence, or a failing baseline. |
| `ROLLED_BACK`, `ABANDONED` | Discarded or reverted; `ABANDONED` is terminal. |

A project also has a baseline lifecycle (`UNINITIALIZED`, `BASELINING`, `MAPPED`, `DIAGNOSED`, `PLANNED`) that the same table covers. Transitions are append-only ledger events; the current state is a projection of them. Every transition has guards (for example `approval.plan`) evaluated by the state machine itself, so no code path moves a slice without them. Going from `REVIEW_READY` back to `PATCHING` (changes requested) revokes the change approvals, because they described a diff that no longer exists.

`unknot next` picks among ready slices in this order: better evidence, then smaller blast radius, then easier recovery, then risk-retiring slices (characterization first), then more dependants, then fewer owners to coordinate, then smaller scope, then id.

## Proof obligations and evidence

An obligation is something that must be true before a slice is accepted. The runtime generates them from what the slice touches. A planner can add more but cannot remove any.

| Kind | Source |
|---|---|
| `scope-check`, `diff-budget`, `parse`, `secrets-scan`, `no-new-cycles`, `api-compatibility`, `architecture-fitness` | Built-in checks over the worktree and the re-mapped graph |
| `lint`, `typecheck`, `unit`, `integration`, `contract`, `security-scan`, `migration-rehearsal`, `performance` | Your configured commands, run through the broker |
| `characterization` | Tests that pin current behaviour, passing before and after |
| `infra-plan` | The saved plan has no unapproved delete or replace and matches the approved plan hash |
| `reconciliation`, `rollback-rehearsal`, `human-review` | A human attestation |

If an obligation would run a command that is not configured (for example no `test_unit`), it becomes a human obligation and says so. It is never silently skipped, and it is never auto-passed.

An obligation's status is `open`, `pass`, `fail`, `inconclusive` or `waived`. It can become `pass` only through an evidence record from a command the runtime executed, or a signed attestation. An evidence record contains:

| Field | Meaning |
|---|---|
| `command`, `working_directory` | Exactly what ran and where |
| `environment_digest`, `sandbox` | The environment keys and which OS sandbox (or none) |
| `started_at`, `duration_ms`, `exit_code`, `timed_out`, `truncated` | What happened |
| `stdout_digest`, `stderr_digest` | SHA-256 of the complete output (even if only the first 16 MiB is kept) |
| `diff_hash` | The diff the check ran against |
| `verdict` | `pass`, `fail` or `inconclusive` (timeout, missing tool, no exit code) |

Before a patch, the baseline `test_unit` runs against the unmodified worktree and must pass, because a passing result after a change proves nothing about preservation if it was already failing.

Tests passing is evidence, not proof of equivalence. Unknot reports what was and was not covered, and the bundle lists residual uncertainties.

## Proof bundles

When all obligations are settled `unknot verify` writes `.unknot/runs/<run-id>/`, with only the applicable files:

| File | Content |
|---|---|
| `manifest.json` | SHA-256 and size of each file, so the bundle can be checked later |
| `finding.json` | The findings or decomposition records the slice came from |
| `slice.yaml` | The slice as approved, with its state |
| `approvals.json` | Who approved what, with key fingerprints and bindings |
| `diff.patch` | The exact diff, whose hash the approval binds |
| `architecture-before.md`, `architecture-after.md` | Import neighbourhood of the changed files |
| `security-delta.md` | Security obligations and their status |
| `database-migration-plan.yaml` | For database slices |
| `infrastructure-plan-summary.json` | For infrastructure slices |
| `verification.json` | Every obligation and its status |
| `command-log.jsonl` | Every brokered command's evidence record |
| `uncertainties.md` | What is still not known |
| `recovery.md` | How to undo it |

All of it passes through the redactor. Review the bundle before approving the change.

## Recovery types

"Rollback" must be an executable strategy, not a sentence. A slice declares one:

| Type | Meaning | What Unknot does |
|---|---|---|
| `revert` | Undo by reverting the change | Before acceptance: `rollback` deletes the worktree and branch. After: `rollback` prepares a `git revert` branch (needs a rollback-stage approval). |
| `roll_forward` | Reverting is not the safe path | Recovery is a new corrective slice in the same campaign. Default for treatments T3 and T6. |
| `restore` | Restore from backup | Requires a tested restore on record before acceptance. |
| `fail_over` | Switch to prepared capacity | Declared in the slice; executed by you. |
| `recreate` | Recreate the resource and its data | Declared in the slice; executed by you. |
| `compensate` | Domain or infrastructure compensation | Declared in the slice; executed by you. |

Only `revert` is executed by `unknot rollback`. For the others it refuses and points at `recovery.md` in the bundle. Irreversible steps (for example dropping legacy data after a decomposition) must be separate, labelled `irreversible`, classified critical, and gated by two people.
