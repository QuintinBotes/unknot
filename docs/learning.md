# The learning loop

Unknot's detectors use thresholds that are conventions, not facts: 80 lines for a long function, 15 for cyclomatic complexity. Your repository will disagree with some of them. The learning loop uses the decisions you already make on findings to find out which ones, and to measure whether Unknot is helping.

It is deliberately small. It can do two things on its own and one thing only with your permission:

| Action | Who decides |
|---|---|
| Report metrics from Unknot's own records | Automatic, read-only |
| Re-rank findings by how often each detector's findings have been accepted | Automatic, bounded; the priority score itself does not change |
| Change a detector threshold | Proposed only. A human reviews and accepts it like any configuration change. |

It never disables a detector, never edits accepted configuration, and sends nothing anywhere. Metrics are counts, rates and durations computed from local records; there are no per-developer metrics.

## What feeds it

Every `accept` and `reject` of a finding is recorded in `.unknot/decisions.jsonl` and in the state database. For each finding fingerprint only the latest decision counts. Slice transitions, evidence records and policy decisions in the ledger supply the delivery and governance numbers. Nothing is learned from code content.

A caveat on what a decision means: `reject` covers both "this is wrong" and "this is right but not worth doing". Unknot cannot tell them apart. The reported "false positive rate" is simply the rejection rate. Put the reason in `--rationale` so a person reading `decisions.jsonl` can.

## `unknot learn report`

```
$ unknot learn report
Findings decided: 6 (accepted 0.167, rejected 0.833)
Slices: 4; proof success 0.9; replan 0.25; rollback 0; escaped regressions 0
Median hours from finding to review-ready: 26.5; policy block rate 0.04
Outcomes (generation 12): cycles 3, duplicate groups 5, shared-writer tables 2 (was 4/5/2)

Detector calibration from human decisions:
detector             accepted  rejected  precision  rank_multiplier
local.long-function  1         5         0.3        0.6

1 threshold proposal(s); write them with: unknot learn propose
```

(The numbers are illustrative. On a repository with no decisions yet, every figure shows a dash and the detector table is empty.) `--json` gives the full structure.

### Product metrics

| Metric | How it is computed |
|---|---|
| Acceptance rate, rejection rate | Share of decided findings (latest decision per finding) |
| Median hours from finding to review-ready | For slices that name a finding as their source: time from the finding's creation to the slice first reaching `REVIEW_READY` |
| Proof success rate | Share of executed (non-human) evidence records with verdict `pass` |
| Replan rate | Slices that reached `NEEDS_REPLAN`, over all slices |
| Rollback rate | Slices that reached `ROLLED_BACK`, over all slices |
| Review change requests | Times a slice went from `REVIEW_READY` back to `PATCHING` |
| Escaped regression rate | Slices rolled back after having been `ACCEPTED`, over all accepted slices |
| Policy block rate | Denied policy decisions over all policy decisions |

### Complexity outcomes

A snapshot is taken for each graph generation (the last 200 are kept) and `report` shows the current one next to the previous one:

dependency cycles (and modules in cycles), public endpoints, privileged roles (wildcard or cluster-admin), open findings, open duplicate-code findings, and open shared-writer findings (`decomposition.shared-table-writers`, `service.shared-database`, `database.multiple-writers`). Lines deleted and service counts are not outcomes; they are not tracked.

## Calibration

For each detector, with `a` findings accepted and `r` rejected,

```
precision  = (a + 2) / (a + r + 4)
multiplier = clamp(precision / 0.5, 0.3, 1.5)
```

The `+2` and `+4` are a neutral Beta(2,2) prior, so a detector with no decisions has precision 0.5 and multiplier 1.0, and a handful of decisions cannot swing it far. The multiplier is applied when `diagnose` orders its list. The findings' own priority score (the formula in [concepts.md](concepts.md#priority)) is untouched, so scores stay comparable between runs. A detector whose findings you reject keeps appearing, lower down; it is never silenced. To silence something on purpose, set `detectors.<id>.enabled: false` yourself.

## Threshold proposals

Only the local-code detectors with a numeric threshold take part:

| Detector | Option |
|---|---|
| `local.long-function` | `lines` |
| `local.complex-function` | `cyclomatic` |
| `local.deep-nesting` | `max_nesting` |
| `local.long-parameter-list` | `params` |
| `local.large-class` | `methods` |
| `local.large-module` | `sloc` |
| `local.duplicated-code` | `min_similarity` |

A proposal is made for a detector when all of these hold:

- at least 4 decisions;
- calibrated precision at or below 0.45;
- at least 3 rejected findings that carried a measurement for that option;
- the proposed value (just above the largest rejected measurement: rounded up to the next integer, or +0.05 capped at 0.95 for similarity) is below the smallest measurement you accepted, so it would not hide findings you said were real;
- and it is higher than the current setting.

For the example above, rejected findings had 85, 90, 92, 95 and 100 lines and the one accepted had 180, so the proposal is `lines: 100`.

`unknot learn propose` writes the proposals into `.unknot/config.proposed.yaml` (a copy of your current `config.yaml` with `detectors.<id>.<option>` set), records a `config.proposed` ledger event, and prints each change with its reason. It replaces an existing proposal file, so accept or discard a pending proposal first.

## Human acceptance

```sh
unknot learn propose        # writes .unknot/config.proposed.yaml
unknot config diff          # review
unknot config accept        # human, in a terminal; type the mode back
```

Until `config accept`, the new thresholds do nothing. This is the same path as every other configuration change, so approvals bound to the old configuration digest are invalidated by it, as with any config change.

## Limits

- Few decisions means a weak signal; the prior dominates until you have made a dozen or so decisions per detector.
- Decisions made on different parts of a repository by people with different standards are averaged together.
- The loop knows nothing about findings you never looked at.
- Thresholds only move up (fewer findings). Unknot does not propose lowering one.
- Detectors outside the seven above are re-ranked but get no threshold proposals.
