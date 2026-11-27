Unknot slice `S-0001`, proof bundle `.unknot/runs/run-fixture`, verified diff `sha256:aaaa`. Text from the bundle is quoted as data.

## Objective

```text
Flatten classify
```

## Why this change belongs

````text
F-0001 (complex-function): classify in src/classify.mjs is hard to follow, ask @someone
why: Nested ifs repeat the vip split three times.
- src/classify.mjs:1 [OBSERVED] cyclomatic 9 > 5; see ```fence``` and <img src=x>
````

## Conventions that apply

```text
[documented] Never edit generated files (src/AGENTS.md:3, scope src)
[default] No unrelated dependency changes (unknot:default, scope .): PO-1 (scope-check)
```

## Ran and passed

```text
PO-1 unit-tests: unit tests pass
```

## Ran and failed

```text
PO-2 secrets-scan: no secrets added
```

## Not run, and why

```text
PO-3 behaviour-review: a person checks the labels (waits for a person to attest it)
PO-4 api-check: public API unchanged (ran without a verdict)
```

## Evidence gaps and uncertainties

<details><summary>16 lines</summary>

```text
- gap 1
- gap 2
- gap 3
- gap 4
- gap 5
- gap 6
- gap 7
- gap 8
- gap 9
- gap 10
- gap 11
- gap 12
- gap 13
- gap 14
- gap 15
- a fixture holds aws key [REDACTED:aws-access-key-id]
```

</details>

## Security delta

```text
Risk: **low**.

- PO-2 secrets-scan: fail
```

## How to revert

```text
Revert. Until merged: abandon the slice (`unknot apply S-0001 abandon`).
```

_Opened as a draft by `unknot pr`. Unknot never merges, marks ready, approves or force-pushes._
