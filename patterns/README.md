# Pattern cards

One YAML file per pattern (spec §13), validated by `schemas/pattern-card.schema.json`.
Cards are loaded by progressive disclosure: the engine reads the index (id, name,
category, problem) and opens a card only when a finding or candidate makes it relevant.
A card is a conditional tool, never a recommendation by itself.

Layout: `patterns/<category>/<id-suffix>.yaml`, where `id` is `<category>.<kebab-name>`
(e.g. `migration.branch-by-abstraction` → `patterns/migration/branch-by-abstraction.yaml`).

## Machine-evaluable conditions

`applicability_signals`, `preconditions` and `contraindications` are lists of
`{ id, description, predicate?, hard? }`. When `predicate` is present the fit engine
evaluates it against the measured signals for the finding or candidate:

```yaml
contraindications:
  - id: shared-table-writers
    description: Another boundary writes the same tables.
    predicate: { metric: boundary.shared_table_writers, op: '>', value: 0 }
    hard: true
```

A predicate whose metric was not measured yields `insufficient_evidence`, never pass.
A true hard contraindication makes the card `contraindicated`. Conditions without a
predicate are shown to the human as checklist items.

## Signal vocabulary

Only these metric names may appear in predicates. Values are numbers; booleans are 0/1.

| Metric | Meaning |
|---|---|
| `function.lines`, `function.cyclomatic`, `function.cognitive`, `function.params`, `function.max_nesting` | Size and complexity of the function in scope |
| `class.methods`, `class.fields`, `class.lines` | Class size |
| `module.loc`, `module.fan_in`, `module.fan_out`, `module.instability`, `module.public_exports`, `module.consumers` | Module structure (consumers = distinct importing modules) |
| `module.churn`, `module.co_change_leak` | Commits in window; share of commits that also touch other boundaries |
| `symbol.references` | Inbound references (0 = unreferenced) |
| `interface.implementations`, `factory.products`, `wrapper.passthrough_ratio`, `abstraction.layers` | Indirection measures |
| `duplication.similarity`, `duplication.instances` | Clone similarity (0–1) and count |
| `cycle.size`, `layer.violations` | Dependency cycle size; layer rule violations |
| `owners.count`, `ownership.alignment` | Distinct owning teams; max single-team share (0–1) |
| `tests.present`, `tests.characterization` | Tests covering scope (count); characterization tests exist (0/1) |
| `contracts.present` | API/event/schema contracts exist for the boundary (0/1) |
| `traces.available`, `metrics.available` | Runtime evidence imported (0/1) |
| `boundary.calls_per_request_p95`, `boundary.cross_transactions`, `boundary.cross_joins`, `boundary.shared_table_writers`, `boundary.reverse_deps`, `boundary.interface_count`, `boundary.size`, `boundary.robust` | Decomposition candidate metrics (spec §15A.4) |
| `requests.interceptable` | Traffic for the capability passes a routable seam (HTTP/queue entry) (0/1) |
| `service.count`, `service.deploy_coupling`, `service.scaling_divergence`, `service.fan_out_p95` | Services in scope; share of releases deployed together; CV of load; downstream services per request |
| `ci.per_unit_pipeline`, `ci.present` | Independent pipeline per deployable; any CI (0/1) |
| `team.count` | Teams owning code in scope |
| `driver.independent_deploy`, `driver.independent_scale`, `driver.availability_isolation`, `driver.security_isolation`, `driver.team_autonomy`, `driver.technology_divergence`, `driver.build_time` | Recorded decomposition drivers (0/1) |
| `driver.any` | 1 when at least one decomposition driver is recorded for the scope |
| `frontend.routes`, `frontend.cross_route_navigation`, `frontend.shared_state_stores`, `frontend.cross_feature_imports`, `frontend.teams` | Frontend route graph and coupling; `cross_route_navigation` is the 0–1 share of navigations that would cross a proposed split |
| `clients.count`, `clients.response_shape_variance` | Distinct API clients; how differently they consume responses (0–1) |
| `data.reconciliation_tooling`, `data.idempotency`, `backup.restore_tested`, `table.writers`, `table.rows`, `index.scans`, `index.duplicates` | Data safety and usage |
| `migration.irreversible`, `migration.locks_exclusive` | Migration hazards (0/1) |
| `plan.deletes`, `plan.replaces`, `iam.wildcards`, `network.public_ingress`, `resource.owner_known` | Infrastructure plan and posture |
| `messaging.consumers_known`, `messaging.dlq`, `retry.bounded`, `timeout.present` | Messaging and resilience properties |
