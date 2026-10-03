# Unknot

> **Untangle complexity. Preserve behavior.**

## Comprehensive Product, Architecture, Security, Database, Infrastructure, and Implementation Specification

**Version:** 1.1-draft  
**Status:** Implementation-ready specification  
**Primary runtime:** Claude Code plugin with an optional deterministic local runtime  
**Default mode:** Read-only analysis and planning

---

## 1. Executive specification

Unknot is an architecture-aware simplification system for existing software. It maps a codebase and its runtime, data, infrastructure, delivery, ownership, and security context; identifies unnecessary complexity; decomposes improvements into reversible slices; applies only approved slices in isolated worktrees; and proves each change against explicit behavioral and operational obligations.

Unknot is not a formatter, a “clean code” prompt, or an autonomous rewrite engine. It is a governed modernization system that can operate from a function to a portfolio of repositories, services, databases, cloud resources, and deployment pipelines.

### 1.1 Core promise

For every recommendation, Unknot must answer:

1. What complexity exists?
2. What evidence supports that conclusion?
3. Why is the complexity accidental rather than essential?
4. What is the smallest useful simplification?
5. What behavior and qualities must remain unchanged?
6. What could fail?
7. How will the change be verified?
8. How can it be aborted, reversed, restored, or rolled forward?
9. Who must approve it?
10. What uncertainty remains?

### 1.2 Product principles

- **Understand before changing.** No source mutation before scoped mapping and baseline capture.
- **Subtract first.** Prefer deletion, consolidation, inlining, standardization, and removal of accidental distribution before adding abstractions.
- **Preserve observable behavior by default.** Intentional behavior changes require separate approval.
- **One bounded slice per transaction.** A slice must be independently understandable, reviewable, verifiable, releasable, and recoverable.
- **Patterns are conditional tools.** Never recommend a pattern merely because it exists in the catalog.
- **Evidence beats confidence theater.** Report provenance and uncertainty instead of fabricated precision.
- **Model proposes; deterministic controls authorize.** Policy and capability enforcement live outside the model.
- **Production is never the sandbox.** Production mutation is not permitted from normal plugin workflows.
- **Recovery is part of design.** “Rollback” must mean an executable strategy, not a sentence in a plan.
- **Optimize system outcomes.** Lines deleted and service count are diagnostics, not goals.

---

## 2. Scope

### 2.1 Goals

Unknot SHALL:

- Analyze single repositories, monorepos, and explicitly linked repository sets.
- Analyze application code, APIs, events, data stores, schemas, infrastructure, CI/CD, runtime telemetry, ownership, and architecture records.
- Detect local, modular, architectural, database, infrastructure, security, delivery, and operational complexity.
- Recognize multiple architectural styles without prescribing one universal target.
- Build a provenance-rich Codebase Knowledge Graph.
- Produce prioritized findings and alternative treatments, including “do nothing.”
- Turn accepted findings into dependency-ordered modernization campaigns.
- Generate small, reversible implementation slices with explicit proof obligations.
- Apply one approved slice inside an isolated Git worktree.
- Execute project-native verification through a constrained command broker.
- Generate proof bundles, ADRs, architecture deltas, migration plans, and recovery runbooks.
- Support organization and repository policy packs.
- Record human decisions and suppress rejected findings for a configured period.

### 2.2 Non-goals

Unknot SHALL NOT:

- Rewrite an entire system in a single operation.
- Assume microservices, monoliths, event sourcing, CQRS, Kubernetes, DDD, or any other pattern is inherently superior.
- Modify production databases or infrastructure directly in normal operation.
- Merge, push, publish, deploy, or destroy resources by default.
- Claim semantic equivalence solely because tests pass.
- Create abstractions to maximize pattern adoption.
- Remove resilience, observability, security, compliance, or recovery controls as “boilerplate.”
- Resolve ambiguous domain behavior without a human decision.
- Treat generated, vendored, or third-party code as ordinary editable source.

---

## 3. Personas

| Persona | Job | Required output |
|---|---|---|
| Maintainer | Simplify a known subsystem safely | Small patch, rationale, tests, rollback |
| Staff engineer | Plan cross-boundary modernization | System map, options, trade-offs, roadmap |
| Platform engineer | Standardize safe paths | Policy packs, adapters, golden paths |
| Database engineer | Evolve schemas and data safely | Lock forecast, migration phases, reconciliation, recovery |
| Infrastructure engineer | Reduce cloud/platform complexity | Plan delta, blast radius, policy and rollout evidence |
| Security engineer | Limit authority and regressions | Threat model, privilege delta, audit trail |
| Reviewer | Decide whether to accept a slice | Diff, proof bundle, residual risks |
| Engineering leader | Prioritize debt reduction | Outcome-based portfolio and blockers |

---

## 4. User interface

### 4.1 Commands

| Command | Purpose | Mutability |
|---|---|---|
| `/unknot:init` | Detect tools and create proposed configuration | Config-only write |
| `/unknot:map [scope]` | Build or refresh the system graph | Read-only |
| `/unknot:diagnose [scope]` | Find and rank simplification opportunities | Read-only |
| `/unknot:explain <finding>` | Show evidence, uncertainty, alternatives, and pattern fit | Read-only |
| `/unknot:plan <objective>` | Create a modernization campaign | Artifact write |
| `/unknot:next [campaign]` | Select the smallest unblocked slice | Read-only |
| `/unknot:apply <slice>` | Patch one approved slice in a worktree | Scoped source write |
| `/unknot:verify <slice>` | Execute proof obligations | Controlled execution |
| `/unknot:architecture [scope]` | Emit C4 and topology views | Documentation write |
| `/unknot:database [scope]` | Analyze database ownership, schema, query, and recovery | Read-only |
| `/unknot:infrastructure [scope]` | Analyze IaC, plans, drift, IAM, network, and reliability | Read-only |
| `/unknot:security [scope]` | Threat model and evaluate security delta | Read/controlled execution |
| `/unknot:status` | Show campaigns, approvals, blockers, and stale evidence | Read-only |
| `/unknot:rollback <slice>` | Execute recorded source rollback procedure | Elevated approval |
| `/unknot:accept <finding>` | Record decision and rationale | Metadata write |
| `/unknot:reject <finding>` | Record rejection and suppression expiry | Metadata write |
| `/unknot:doctor` | Validate adapters, policy, sandbox, and dependencies | Read/controlled execution |
| `/unknot:decompose [scope]` | Find decomposition boundaries and choose the least invasive treatment (§15A) | Read-only |

### 4.2 Modes

| Mode | Permissions | Use |
|---|---|---|
| Observe | Read and inventory | Sensitive repositories, first run |
| Plan | Observe plus plans and documentation | Architecture review |
| Assist | Scoped patch in isolated worktree | Daily development |
| Governed | Commit or PR after exact-plan approval | Enterprise workflow |
| Campaign | Repeated, separately approved slices | Long-running modernization |

The first run defaults to **Plan**. Mode elevation requires explicit configuration and cannot be inferred from user language.

### 4.3 Example flow

```text
/unknot:map services/checkout
/unknot:diagnose --objective "reduce deployment coupling"
/unknot:explain F-0142
/unknot:plan "merge pricing fragments while preserving APIs and ownership"
/unknot:next CMP-17
/unknot:apply UK-0042
/unknot:verify UK-0042
```

---

## 5. Plugin package

```text
unknot/
├── .claude-plugin/plugin.json
├── skills/
│   ├── init/SKILL.md
│   ├── map/SKILL.md
│   ├── diagnose/SKILL.md
│   ├── explain/SKILL.md
│   ├── plan/SKILL.md
│   ├── apply/SKILL.md
│   ├── verify/SKILL.md
│   ├── architecture/SKILL.md
│   ├── database/SKILL.md
│   ├── infrastructure/SKILL.md
│   ├── security/SKILL.md
│   └── decompose/SKILL.md
├── agents/
│   ├── orchestrator.md
│   ├── cartographer.md
│   ├── runtime-observer.md
│   ├── domain-analyst.md
│   ├── database-analyst.md
│   ├── infrastructure-analyst.md
│   ├── simplification-planner.md
│   ├── refactorer.md
│   ├── verifier.md
│   ├── security-reviewer.md
│   ├── documentation-curator.md
│   └── decomposition-strategist.md
├── hooks/hooks.json
├── .mcp.json
├── runtime/
├── adapters/
├── patterns/
├── policies/
├── schemas/
├── scripts/
├── tests/
├── SECURITY.md
└── README.md
```

### 5.1 Manifest

```json
{
  "name": "unknot",
  "version": "0.1.0",
  "description": "Architecture-aware incremental codebase simplification with verification and recovery.",
  "license": "Apache-2.0",
  "keywords": [
    "simplification",
    "refactoring",
    "architecture",
    "modernization",
    "database",
    "infrastructure"
  ]
}
```

The plugin SHALL expose skills even when work is delegated to subagents. Skills are stable user entry points; agents are implementation details.

---

## 6. Runtime architecture

```text
Claude Code
  ├── Namespaced skills
  ├── Specialist subagents
  └── Enforcement hooks
          │
          ▼
Unknot deterministic runtime
  ├── Orchestrator and state machine
  ├── Policy decision point
  ├── Capability issuer
  ├── Scope and path validator
  ├── Command broker
  ├── Graph builder
  ├── Pattern engine
  ├── Planner
  ├── Verification engine
  ├── Evidence ledger
  └── Artifact emitter
          │
          ├── Language/build/test adapters
          ├── Database adapters
          ├── IaC/cloud/Kubernetes adapters
          ├── Git worktree sandbox
          └── Optional MCP integrations
```

### 6.1 Hard architectural rules

- Agents may propose operations; only the deterministic runtime authorizes them.
- Repository text and tool output are untrusted data, not instructions.
- Every state transition validates against a versioned schema.
- All source mutation occurs in a dedicated worktree.
- No high-risk operation may be proposed and approved by the same actor.
- Every operation carries run ID, campaign ID, slice ID, scope, actor, capability, budget, and policy decision.
- Interrupted runs are resumable from an append-only event ledger.
- Production credentials are never available to ordinary agent contexts.

### 6.2 State machine

```text
UNINITIALIZED
  -> BASELINING
  -> MAPPED
  -> DIAGNOSED
  -> PLANNED
  -> AWAITING_APPROVAL
  -> PATCHING
  -> VERIFYING
  -> REVIEW_READY
  -> ACCEPTED
```

Exceptional states:

```text
BLOCKED_BASELINE
BLOCKED_POLICY
BLOCKED_UNCERTAINTY
NEEDS_REPLAN
VERIFICATION_FAILED
ROLLED_BACK
ABANDONED
```

Transitions are append-only events. Current state is a rebuildable projection.

---

## 7. Agent model

| Agent | Responsibility | Default authority |
|---|---|---|
| Orchestrator | State, budgets, handoffs, approvals | No source mutation |
| Cartographer | Static inventory and dependency graph | Read-only |
| Runtime observer | Traces, metrics, profiles, topology | Read-only integrations |
| Domain analyst | Capabilities, boundaries, vocabulary | Read-only |
| Database analyst | Schema, query, data ownership, migration risk | Read-only metadata |
| Infrastructure analyst | IaC, plan, drift, IAM, network, recovery | Read-only metadata |
| Planner | Options, campaigns, slices, proof obligations | Artifact writes only |
| Refactorer | Implement exactly one approved slice | Worktree-scoped writes |
| Verifier | Run approved checks and compare evidence | Command broker only |
| Security reviewer | Threat model and security delta | Read/scanner only |
| Documentation curator | ADRs, maps, runbooks | Documentation-only writes |
| Decomposition strategist | Boundary candidates, drivers, treatment selection (§15A) | Read-only |

### 7.1 Handoff contract

```json
{
  "schema_version": "1.0",
  "run_id": "run-123",
  "slice_id": "UK-0042",
  "agent": "database-analyst",
  "status": "complete",
  "facts": [],
  "proposals": [],
  "uncertainties": [],
  "conflicts": [],
  "artifacts": [],
  "recommended_next_state": "MAPPED"
}
```

Unknown fields SHALL be rejected in governed mode. Free-form prose cannot authorize execution.

### 7.2 Budgets

Every run and agent has hard ceilings for:

- Wall-clock duration.
- Turns and tokens.
- Tool calls.
- Files and bytes read.
- Commands executed.
- Changed files and diff lines.
- Network requests and domains.
- Monetary cost.
- Delegation depth.

A breach blocks the run; it never widens authority.

---

## 8. Configuration

```yaml
version: 1
mode: plan
scope:
  include: ["src/**", "services/**", "packages/**", "infra/**"]
  exclude: ["vendor/**", "dist/**", "generated/**"]
protected_paths:
  - ".github/workflows/**"
  - "**/auth/**"
  - "**/crypto/**"
  - "**/migrations/**"
commands:
  build: ["pnpm", "build"]
  test_unit: ["pnpm", "test:unit"]
  test_integration: ["pnpm", "test:integration"]
  lint: ["pnpm", "lint"]
limits:
  max_changed_files: 12
  max_diff_lines: 500
  max_runtime_minutes: 30
  max_network_requests: 0
quality:
  forbid_new_cycles: true
  public_api_compatibility: required
security:
  secrets_scan: required
  sast: required_for_high_risk
  dependency_changes: approval_required
database:
  live_access: disabled
  destructive_execution: forbidden
infrastructure:
  apply: forbidden
  destroy: forbidden
  require_saved_plan: true
approvals:
  medium: ["code-owner"]
  high: ["code-owner", "security-owner"]
telemetry:
  enabled: false
```

Repository policy may tighten but never weaken organization-managed policy.

---

## 9. Codebase Knowledge Graph

The CKG is the canonical system model. It combines source, runtime, data, infrastructure, delivery, ownership, security, and decision evidence.

### 9.1 Core nodes

- Repository, workspace, package, module, namespace, build target.
- Function, method, class, interface, type, endpoint, command.
- Event, topic, queue, job, workflow, service, deployable.
- Database, schema, table, collection, column, index, query.
- Cloud account, project, region, network, cluster, workload, resource.
- Identity, role, policy, permission, secret reference, trust boundary.
- Team, owner, reviewer, ADR, requirement, SLO, alert, runbook.
- Test, benchmark, finding, campaign, slice, proof obligation.

### 9.2 Core edges

- `IMPORTS`, `CALLS`, `IMPLEMENTS`, `EXTENDS`, `INSTANTIATES`.
- `READS`, `WRITES`, `OWNS_DATA`, `MIGRATES`, `REPLICATES_TO`.
- `EXPOSES`, `CONSUMES`, `PUBLISHES`, `SUBSCRIBES`.
- `DEPENDS_ON`, `BUILDS`, `TESTS`, `DEPLOYS_TO`.
- `ROUTES_TO`, `ALLOWS_INGRESS_FROM`, `ALLOWS_EGRESS_TO`.
- `AUTHENTICATES_AS`, `ASSUMES`, `GRANTS`, `AUTHORIZED_BY`.
- `OWNED_BY`, `REVIEWED_BY`, `DESCRIBED_BY`, `VIOLATES`.
- `REPLACES`, `SHADOWS`, `SUPERSEDES`, `BACKED_UP_BY`.

### 9.3 Provenance

```json
{
  "source_type": "ast|lsp|trace|config|catalog|human|inference",
  "source_ref": "services/orders/src/api.ts:42",
  "extractor": "typescript-adapter@0.4.1",
  "observed_at": "RFC3339",
  "commit": "git-sha",
  "confidence": "high|medium|low",
  "scope": ["services/orders"],
  "contradicts": []
}
```

Observed facts, inferences, and recommendations MUST remain separate. Contradictory evidence is retained.

### 9.4 Evidence pipeline

1. Repository census.
2. Syntax and symbol indexing.
3. Definitions, references, types, calls, and inheritance.
4. Local flow analysis; global data/taint analysis only when justified.
5. Build and test topology.
6. API, event, schema, CLI, and file contracts.
7. Runtime traces, metrics, logs, and profiles.
8. Database schema, query, lineage, and recovery metadata.
9. IaC, plan, state, actual infrastructure, and drift.
10. CI/CD, release, feature flag, and rollback topology.
11. CODEOWNERS, ADRs, service catalogs, and human decisions.

### 9.5 Incrementality

- Cache by repository, commit, path, adapter version, and configuration digest.
- Re-index changed files and invalidated dependents only.
- Recompute cycles and impact cones incrementally.
- Apply TTLs to runtime, ownership, plan, and actual-state evidence.
- Never reuse facts across unrelated commits.

---

## 10. Architecture discovery

### 10.1 Generated views

- System landscape.
- C4 context and container views.
- Selected component views.
- Deployment topology.
- Critical runtime sequences.
- Data ownership and lineage.
- Trust boundaries and privilege paths.
- Dependency cycles.
- Build and deployment coupling.
- Before/after architecture delta.

### 10.2 Recognized styles

- Script, batch, library, and framework.
- Layered/N-tier monolith.
- Modular or domain-oriented monolith.
- Service-based architecture and SOA.
- Microservices and distributed monolith.
- Event-driven architecture.
- Pipes-and-filters and stream processing.
- Web-queue-worker.
- Microkernel/plugin architecture.
- Hexagonal, onion, and clean architecture.
- Serverless/functions.
- Actor, cell/stamp, data-grid, and edge styles.
- Hybrid combinations.

Classification SHALL describe actual evidence and MAY return multiple styles.

### 10.3 Evidence labels

- **Observed:** direct code, configuration, deployment, or trace evidence.
- **Corroborated:** independent evidence sources agree.
- **Inferred:** plausible but not directly observed.
- **Unknown:** insufficient evidence.
- **Contradicted:** material evidence conflicts.

---

## 11. Diagnostic engine

### 11.1 Local code

- Excessive branching, nesting, and cognitive complexity.
- Long functions, classes, and parameter lists.
- Mixed abstraction levels and ambiguous names.
- Hidden mutation, temporal coupling, and global state.
- Duplicated validation or conditionals.
- Inconsistent error handling.
- Primitive obsession and stringly typed protocols.
- Speculative generality.
- One-implementation factories and pass-through wrappers.
- Dead and unreachable code.
- Syntactic and semantic duplication.

### 11.2 Modules

- Dependency cycles.
- Unstable dependency direction.
- Feature scattering and shotgun surgery.
- Low cohesion and hub modules.
- Implementation leakage.
- Shared mutable utilities.
- Layer bypass.
- Build graph amplification.
- APIs larger than consumer use.

### 11.3 Services

- Distributed monolith and synchronized deployment.
- Nanoservices and accidental distribution.
- Chatty calls and fan-out.
- Shared database coupling.
- Duplicate capabilities.
- Retry storms and missing idempotency.
- God orchestrators.
- Event soup and undocumented consumers.
- Obsolete compatibility paths.
- Services lacking independent scaling, ownership, or release justification.

### 11.4 Delivery and operations

- Deployables that always release together.
- Duplicated pipelines.
- Slow or flaky broad test stages.
- Missing health checks and rollback.
- Environment drift.
- Long-lived branches and manual release steps.
- Unused infrastructure, flags, topics, and queues.
- Missing telemetry at change seams.

### 11.5 Security

- Privilege sprawl.
- Duplicated authorization logic.
- Unsafe command construction.
- Injection or insecure deserialization paths.
- Secret exposure.
- Weak tenant boundaries.
- Unpinned build inputs.
- Security-control removal disguised as simplification.

---

## 12. Findings and priority

```json
{
  "schema_version": "1.0",
  "id": "F-0123",
  "kind": "architecture.distributed-monolith",
  "title": "Checkout and pricing change and deploy in lockstep",
  "scope": ["services/checkout", "services/pricing"],
  "evidence": [],
  "quality_impacts": {
    "changeability": "high",
    "reliability": "medium",
    "security": "low"
  },
  "blast_radius": "high",
  "uncertainties": [],
  "alternatives": ["retain", "decouple", "merge"],
  "status": "open"
}
```

Conceptual ordering formula:

```text
priority = expected benefit × evidence strength × reversibility
           ---------------------------------------------------
           blast radius × implementation cost × uncertainty
```

This score cannot override policy, owners, or failed guardrails.

---

## 13. Pattern knowledge system

Patterns SHALL be versioned cards loaded through progressive disclosure, not a giant prompt.

```yaml
schema_version: 1
id: migration.branch-by-abstraction
name: Branch by Abstraction
category: migration
problem: Replace a subsystem incrementally while remaining releasable.
forces: []
applicability_signals: []
required_evidence: []
preconditions: []
contraindications: []
benefits: []
liabilities: []
introduced_complexity: []
architecture_invariants: []
transformations: []
proof_obligations: []
rollback_strategies: []
composes_with: []
conflicts_with: []
removal_recipe: []
version: 1.0.0
```

### 13.1 Architecture styles

- Monolith, layered monolith, modular monolith, domain-oriented monolith.
- Client-server, N-tier, web-queue-worker.
- Service-based, SOA, microservices, self-contained systems.
- Event-driven choreography and orchestration.
- Pipes-and-filters, batch, and stream processing.
- Microkernel/plugin architecture.
- Hexagonal, onion, and clean architecture.
- Serverless, edge, actor, cell/stamp, and space-based.
- Warehouse, lake, lakehouse, lambda, kappa, data mesh.
- MVC, MVP, MVVM, and unidirectional UI state.

### 13.2 Domain and modularity

- Bounded context, aggregate, entity, value object, domain service, domain event.
- Anti-corruption layer, context map, shared kernel.
- Package by feature, vertical slice, module facade.
- Dependency inversion, acyclic dependencies, stable dependencies.
- Functional core/imperative shell.
- Transaction Script, Table Module, Domain Model, Service Layer.

### 13.3 Distributed systems

- API gateway, BFF, service discovery, service mesh.
- Synchronous request-response and asynchronous messaging.
- Saga choreography, saga orchestration, process manager.
- CQRS, event sourcing, materialized view, API composition.
- Transactional outbox, inbox, CDC, idempotent consumer.
- Sidecar, ambassador, external configuration.

### 13.4 Migration

- Strangler Fig.
- Branch by Abstraction.
- Parallel Change and expand-migrate-contract.
- Shadow traffic and dark launch.
- Feature flags.
- Dual read, controlled dual write, reconciliation, backfill.
- Compatibility facade and anti-corruption layer.
- Canary, blue/green, and progressive delivery.

### 13.5 Resilience

- Timeout and deadline propagation.
- Bounded retry with jitter.
- Circuit breaker.
- Bulkhead.
- Rate limiting and throttling.
- Load shedding and graceful degradation.
- Fallback and hedging.
- Queue-based load leveling.
- Health endpoint monitoring.
- Leader election, failover, replication, quorum.
- Deployment stamps and geodes.

### 13.6 Messaging and integration

- Point-to-point and publish-subscribe.
- Guaranteed delivery and dead-letter channel.
- Command, document, and event messages.
- Request-reply and correlation identifier.
- Router, splitter, aggregator, resequencer, scatter-gather.
- Routing slip, bridge, envelope, enricher, filter, normalizer.
- Canonical data model, gateway, mapper.
- Polling consumer, event-driven consumer, competing consumer, durable subscriber.
- Wire tap, message history, and control bus.

### 13.7 Object and code design

- Abstract Factory, Builder, Factory Method, Prototype, Singleton.
- Adapter, Bridge, Composite, Decorator, Facade, Flyweight, Proxy.
- Chain of Responsibility, Command, Iterator, Mediator, Memento, Observer.
- State, Strategy, Template Method, Visitor.
- Null Object, Specification, Policy, Result/Either, Option.
- Dependency injection, immutable object, RAII, resource ownership, module.

Every code-pattern card requires an introduction recipe and a removal recipe.

### 13.8 Anti-patterns

- Big Ball of Mud, Lava Flow, Golden Hammer.
- God Object, Blob, Spaghetti Code, Copy-Paste Programming.
- Shotgun Surgery, Feature Envy, Primitive Obsession.
- Accidental Complexity, Speculative Generality, Indirection Tax.
- Distributed Monolith, Nanoservices, Shared Database.
- Chatty I/O, Retry Storm, Thundering Herd.
- Event Soup, Dual-Write Hazard, Cache Stampede.
- Snowflake Environment, Configuration Drift, ClickOps.
- Cargo-cult Kubernetes, service mesh, CQRS, event sourcing, or DDD.

---

## 14. Database subsystem

### 14.1 Objective

Databases are behavioral systems with durability, consistency, concurrency, privacy, recovery, and operational obligations. Unknot SHALL NOT treat a schema as ordinary source text.

A database change is complete only after evaluating code, schema, data, indexes, permissions, observability, retention, replication, backup/recovery, compatibility, and rollback or roll-forward behavior.

### 14.2 Supported classes

| Class | Examples | Model |
|---|---|---|
| Relational | PostgreSQL, MySQL, SQL Server, Oracle, SQLite | Schemas, tables, constraints, indexes, views, routines, triggers, grants |
| Document | MongoDB, Couchbase | Collections, shapes, versions, validators, indexes |
| Key-value | Redis, DynamoDB | Key patterns, TTL, cardinality, atomic operations |
| Wide-column | Cassandra, ScyllaDB, Bigtable | Partition keys, clustering keys, consistency, replication |
| Graph | Neo4j, Neptune | Labels, relationships, constraints, traversal patterns |
| Search | Elasticsearch, OpenSearch, Solr | Mappings, analyzers, aliases, shards, pipelines |
| Time-series | TimescaleDB, InfluxDB | Cardinality, retention, downsampling, chunks |
| Analytical | Snowflake, BigQuery, Redshift, lakehouse | Lineage, partitioning, clustering, materializations |
| Vector | pgvector, Milvus, Pinecone, Weaviate | Dimensions, metric, filters, index, embedding lineage |
| Embedded | SQLite, RocksDB, LevelDB | File ownership, locking, migration, compaction |

Initial adapters MAY be read-only. Direct live mutation is forbidden by default.

### 14.3 Discovery sources

- DDL and migration frameworks.
- ORM mappings and generated clients.
- Prepared statements, query builders, and raw SQL.
- Stored procedures, triggers, views, and jobs.
- CDC connectors and ETL/ELT models.
- Grants, row-level security, masking, and auditing.
- User-supplied plans, statistics, and slow-query logs.
- Lock/deadlock reports and pool metrics.
- Backup, restore-test, replication, and failover configuration.
- Catalog, classification, lineage, retention, and residency metadata.

Production catalog access requires explicit read-only credentials, time bounds, and separate authorization. Exported metadata is preferred.

### 14.4 Database graph

Nodes:

- Engine, cluster, database, schema, table, collection, view.
- Column, field, constraint, index, partition, sequence.
- Routine, trigger, query, plan, transaction boundary.
- Migration, backfill, replica, backup policy, restore test.
- Data class, retention rule, residency rule, encryption key.
- Database role, grant, pool, CDC stream.

Edges:

- `QUERIES`, `MUTATES`, `JOINS_WITH`, `REFERENCES`, `INDEXED_BY`.
- `DERIVED_FROM`, `REPLICATES_TO`, `BACKED_UP_BY`, `RESTORED_BY`.
- `MIGRATED_BY`, `BACKFILLED_BY`, `EMITS_CHANGES_TO`.
- `CLASSIFIED_AS`, `RETAINED_UNDER`, `RESIDENT_IN`, `ENCRYPTED_BY`.
- `AUTHORIZED_FOR`, `OWNS_SCHEMA`, `SHARES_TRANSACTION_WITH`.

### 14.5 Required invariants

Every persistent-data campaign declares:

- Source of truth and owner.
- Read and write paths.
- Transaction and consistency boundaries.
- Isolation and concurrency requirements.
- Nullability, uniqueness, referential, and domain constraints.
- Ordering, idempotency, and deduplication.
- Classification, tenant boundary, residency, and retention.
- Encryption and key management.
- RPO, RTO, backup, and restore mechanism.
- Old/new application compatibility window.
- Reconciliation rule and acceptable discrepancy.
- Cutover, abort, and roll-forward conditions.

Unknot surfaces missing objectives; it never invents them.

### 14.6 Database detectors

**Structure**

- Unused tables, collections, fields, indexes, constraints, triggers, and routines.
- Duplicate or overlapping indexes.
- Missing constraints reimplemented inconsistently in applications.
- EAV or opaque JSON where stable structure is required.
- Over-normalization or denormalization without ownership and refresh contracts.
- Unenforceable polymorphic relationships.
- ORM mappings that hide expensive behavior.
- Tenant-key ambiguity.

**Access and performance**

- N+1 queries and unbounded results.
- Full scans on latency-sensitive paths.
- Low-selectivity and unused indexes.
- Write amplification from excess indexes.
- Long transactions and deadlock-prone ordering.
- Connection-pool exhaustion.
- Hot keys, partitions, and tenants.
- Cache stampede and ambiguous invalidation.
- Replica-read assumptions conflicting with lag.
- Duplicated query logic.

**Ownership and distribution**

- Multiple services writing the same table without contract.
- Cross-service joins that remove autonomy.
- Shared owner credentials.
- Dual writes without atomicity, idempotency, or reconciliation.
- CDC loops and undocumented derived stores.
- Copies without lineage, freshness, or deletion propagation.
- Sharding or polyglot persistence without measured need.
- A database per tiny service with no isolation benefit.

**Reliability and recovery**

- Backups never restore-tested.
- Missing PITR or unknown restore window.
- Replication mistaken for backup.
- Backups inside the same compromise boundary.
- Irreversible migrations coupled to rollout.
- Destructive DDL before old readers retire.
- Backfills without checkpoints, idempotency, throttling, or resume.
- Migration jobs likely to overwhelm logs, replicas, or storage.

### 14.7 Safe evolution protocol

Default protocol: **expand → migrate → validate → switch → observe → contract**.

1. Add backward-compatible schema.
2. Deploy code that understands old and new representations.
3. Backfill in bounded, resumable batches.
4. Compare counts, checksums, samples, and domain invariants.
5. Switch reads behind a reversible seam.
6. Switch authoritative writes.
7. Observe across peak traffic and failure scenarios.
8. Remove old paths only after usage reaches zero and recovery obligations expire.

The adapter SHALL forecast, for the exact engine and version:

- Lock mode and acquisition behavior.
- Metadata-lock risk.
- Table or index rewrite.
- Temporary disk and log growth.
- Replication and CDC lag.
- Transaction-log retention.
- Expected duration and cancellation behavior.
- Online/concurrent limitations.

“Online” SHALL never be interpreted as “zero impact.”

### 14.8 Migration artifact

```yaml
version: 1
slice: UK-DB-0042
engine: postgresql
engine_version: "18"
objects: ["public.orders"]
classification: confidential
source_of_truth: orders
compatibility:
  oldest_app_version: "3.8.0"
  newest_app_version: "4.0.0"
phases: [expand, backfill, validate, switch_reads, switch_writes, contract]
locking:
  predicted_mode: SHARE_UPDATE_EXCLUSIVE
  timeout_seconds: 5
backfill:
  batch_size: 1000
  checkpoint_key: order_id
  throttle: "replica_lag < 2s and cpu < 70%"
validation: [row_count, checksum, business_invariants]
abort_conditions:
  - "error_rate > baseline + 0.5%"
  - "replica_lag > 10s"
rollback:
  mode: roll_forward
  procedure: docs/runbooks/UK-DB-0042.md
approvals: [data-owner, service-owner, security-owner]
```

### 14.9 Data safeguards

- Do not send production rows to the model by default.
- Prefer metadata, redacted plans, and aggregates.
- Detect secrets and regulated data before context ingestion.
- Use synthetic data only for tests and label it clearly.
- Encrypt artifacts and minimize retention.
- Separate migration and application roles.
- Rehearse at production-like volume and skew.
- Make backfills idempotent, resumable, bounded, and observable.
- Record counts, checksums, rejected rows, and discrepancies.
- Propagate deletion when consolidating copies.

### 14.10 Database transformations

Unknot MAY propose:

- Remove an unused index after an observation window.
- Merge duplicate indexes or materialized views.
- Replace repeated application validation with a database constraint after cleanup.
- Consolidate duplicate tables with compatibility views.
- Split a schema when lifecycle and ownership justify it.
- Merge stores when separation has no autonomy, compliance, scaling, or isolation value.
- Replace cross-service writes with an owned interface.
- Replace dual writes with outbox/CDC plus reconciliation.
- Archive cold data with tested retrieval.
- Remove unnecessary caches or derived stores.
- Introduce partitioning only with evidence.
- Standardize migrations on a versioned framework.

It SHALL NOT execute these against a live database.

### 14.11 Database verification

- Migration syntax and lint.
- Empty, representative, and scale rehearsal.
- N/N-1 application compatibility.
- Lock acquisition and duration.
- Rewrite and disk headroom.
- Replica and CDC lag.
- Query-plan and latency regression.
- Integrity and constraint checks.
- Backfill pause/resume/retry/idempotency.
- Count, checksum, and domain reconciliation.
- Backup creation and isolated restore.
- PITR rehearsal for critical stores.
- Permission and tenant isolation.
- Retention and deletion propagation.

A high-risk database slice cannot become `REVIEW_READY` without data-owner approval and a tested recovery path.

---

## 15. Infrastructure subsystem

### 15.1 Objective

Infrastructure simplification reduces cognitive and operational load without violating reliability, security, performance, compliance, recovery, or cost constraints. Fewer resources are not automatically better.

Unknot analyzes declared, planned, recorded, actual, observed, and intended states. It does not run production apply or destroy by default.

### 15.2 Supported classes

- Terraform, OpenTofu, CloudFormation, CDK, Pulumi, Bicep.
- Kubernetes YAML, Helm, Kustomize, Operators, CRDs.
- Ansible, Chef, Puppet, Salt.
- Dockerfiles, Compose, Buildpacks, OCI metadata.
- AWS, Azure, GCP, on-premises, and hybrid resources.
- VMs, containers, serverless, batch, autoscaling.
- Networks, routing, NAT, DNS, gateways, load balancers, CDN, service mesh.
- Block, file, and object storage.
- IAM, workload identity, PKI, secrets, and key management.
- Queues, streams, schedulers, and workflows.
- CI/CD, registries, provenance, and artifact promotion.
- Observability, incident response, backup, and disaster recovery.
- Platform catalogs, templates, and golden paths.

### 15.3 Infrastructure graph

Nodes:

- Cloud, account/subscription/project, region, zone.
- Network, subnet, route, firewall rule, endpoint, DNS zone.
- Compute, cluster, node pool, namespace, workload, function.
- Load balancer, gateway, service, ingress, egress path.
- Volume, bucket, snapshot, backup vault.
- Identity, role, policy, service account, key, secret.
- IaC module, state backend, resource, plan action, field manager.
- Pipeline, builder, artifact, image, registry, attestation.
- SLO, alert, runbook, recovery plan, cost center.

Edges:

- `PROVISIONS`, `MANAGES_STATE_FOR`, `DEPLOYED_TO`, `ROUTES_TO`.
- `ALLOWS_INGRESS_FROM`, `ALLOWS_EGRESS_TO`, `RESOLVES_TO`.
- `ASSUMES`, `GRANTS`, `READS_SECRET`, `ENCRYPTED_BY`.
- `MOUNTS`, `SNAPSHOTS_TO`, `FAILS_OVER_TO`, `REPLICATES_ACROSS`.
- `BUILDS`, `SIGNS`, `PUBLISHES`, `DEPLOYS`, `OBSERVES`.
- `COSTS_TO`, `OWNED_BY`, `PROTECTED_BY`, `VIOLATES_POLICY`.

### 15.4 State hierarchy

1. **Declared:** version-controlled desired configuration.
2. **Planned:** Terraform/OpenTofu plan, change set, preview, rendered chart, or dry-run.
3. **Recorded:** IaC state and controller inventory.
4. **Actual:** read-only provider or cluster inventory.
5. **Observed:** traffic, cost, metrics, traces, and logs.
6. **Intended:** policy, ADR, SLO, and owner statement.

Drift is a finding, not an instruction to overwrite actual state.

### 15.5 Infrastructure detectors

**Duplication and sprawl**

- Copy-pasted stacks and near-identical modules.
- Snowflake environments and ClickOps.
- Orphaned volumes, addresses, load balancers, snapshots, DNS, identities.
- Idle environments without TTL or owner.
- Multiple tools managing the same object or field.
- Wrapper modules that add indirection but no standardization.
- Modules containing unrelated lifecycle domains.
- Floating versions, tags, and image references.

**Compute and orchestration**

- Overprovisioned requests, limits, and replicas.
- One workload per cluster without isolation need.
- Excessive clusters, node pools, namespaces, or variants.
- Stateful placement without failure-domain analysis.
- Missing disruption budgets, spread, probes, or autoscaling where required.
- Privileged workloads and host coupling.
- Sidecars or mesh functionality with no observed value.
- Fragmented functions and scheduled jobs.

**Network**

- Flat networks and transitive reachability.
- Duplicate gateways, NAT paths, and load balancers.
- Broad ingress/egress and wildcard ports.
- Public endpoints that should be private.
- DNS indirection without ownership or failover purpose.
- Service mesh where platform networking is sufficient.
- Cross-zone/region traffic without locality or resilience justification.

**Identity and secrets**

- Wildcard actions/resources and admin policies.
- Long-lived keys and shared service accounts.
- Hidden privilege through role chains.
- Secrets in source, state, logs, user data, or image layers.
- Global grants where local scope suffices.
- Unused identities and credentials.
- Workload-creation rights that enable secret or service-account escalation.

**State and drift**

- Local, unencrypted, or overbroad state.
- Missing state locking.
- Concurrent writers.
- State/remote mismatches.
- Direct state edits.
- Refactors without move/import mappings.
- Conflicting Kubernetes field managers.

**Reliability and recovery**

- Single-zone dependencies that contradict SLOs.
- Backups without immutability, separation, or restore tests.
- Unexercised failover.
- Missing RTO/RPO and runbooks.
- Deployments without rollback-compatible artifacts.
- Alerts not tied to customer impact or abort decisions.

**Cost and sustainability**

- Idle resources.
- Excess retention.
- Oversized compute or storage.
- Duplicate observability ingestion.
- Unnecessary data transfer.
- Commitment mismatch.
- Non-production resources without schedules or TTL.

Cost findings are recommendations and require ownership and reliability evidence before retirement.

### 15.6 Infrastructure pattern catalog

- Multi-account/project landing zones and guardrails.
- Hub-and-spoke, transit, shared network, and segmentation.
- Public, private, and isolated subnets.
- Ingress, egress, private endpoint, and brokered access.
- Single cluster, cluster per environment, cluster per tenant, and fleets.
- Namespace tenancy, virtual clusters, and cell isolation.
- Rolling, canary, blue/green, shadow, and feature-flag rollout.
- Active-passive, pilot-light, warm standby, active-active recovery.
- Multi-zone, multi-region, deployment-stamp, and cell architecture.
- Immutable infrastructure and image-based deployment.
- GitOps and pull-based reconciliation.
- Centralized, federated, and product-aligned platforms.
- Golden paths, paved roads, and self-service APIs.
- Workload identity and short-lived credentials.
- Policy as code and admission control.
- FinOps allocation, budgets, anomaly detection, and automatic TTL.

### 15.7 Infrastructure transformations

Unknot MAY propose:

- Extract stable reusable IaC modules.
- Inline one-use wrappers that add no policy value.
- Split state by ownership and blast radius.
- Merge stacks that always change and recover together.
- Import manual resources with a no-op proof.
- Replace copies with readable composition.
- Consolidate pipelines into governed workflows.
- Introduce golden paths for repeated workloads.
- Quarantine and then retire orphaned resources.
- Reduce unnecessary clusters or service-mesh complexity.
- Strengthen account, network, namespace, and tenant isolation.
- Replace long-lived keys with workload identity.
- Pin immutable artifact digests.
- Consolidate observability without losing signals or retention.

### 15.8 Infrastructure protocol

1. Map ownership, dependencies, trust boundaries, SLOs, and recovery role.
2. Refresh/export actual state with read-only credentials.
3. Generate the smallest source change.
4. Run formatting, validation, lint, policy, and security checks.
5. Generate an exact plan/preview for the intended workspace and state.
6. Normalize actions into create, update, replace, delete, read, and unknown.
7. Compute blast radius, downtime, data-loss, privilege, cost, and recovery deltas.
8. Obtain risk-based owner approvals.
9. Apply only through the organization delivery system.
10. Monitor health and customer signals during staged rollout.
11. Abort or roll back on declared thresholds.
12. Reconcile source, state, actual inventory, and documentation.

### 15.9 Always-high-risk actions

- Destroy, replacement, or state removal.
- Database/storage deletion, shrink, re-key, or replication change.
- Network route, firewall, DNS, certificate, or gateway change.
- IAM trust or permission change.
- Cluster, account/project, region, or node-pool removal.
- Backup, retention, vault, or recovery change.
- Production import, move, or state surgery.

Requirements:

- Two-person approval including resource owner.
- Saved plan tied to commit, state serial, and environment.
- Dependency and recovery-role evidence.
- Backup/restore or recreation proof.
- Staged execution where possible.
- Abort thresholds and observation period.
- Post-change proof and signed audit event.

### 15.10 Rollback semantics

Each slice selects one:

- **Revert:** old declaration restores prior behavior safely.
- **Roll forward:** corrective change is safer than reversal.
- **Restore:** recover data/state from tested backup.
- **Fail over:** redirect to prepared capacity.
- **Recreate:** build replacement and restore data.
- **Compensate:** explicit domain or infrastructure compensation.

“Apply the old commit” is not accepted without evidence.

### 15.11 Supply chain

- Pin tools, providers, actions, modules, images, and dependencies.
- Generate SBOMs where supported.
- Scan code, dependencies, IaC, images, and secrets.
- Use ephemeral isolated builders.
- Sign artifacts and attestations.
- Generate provenance for builder, process, input, and output.
- Verify signatures and policy before promotion.
- Protect registries and release identities with least privilege.

## 15A. Monolith decomposition subsystem

### 15A.1 Objective

Unknot SHALL help teams decompose backend and frontend monoliths **only when a stated driver justifies it**, and SHALL choose the least invasive treatment that satisfies that driver. Decomposition is a campaign of reversible slices, never a single operation. The research basis, with sources and the heuristic/sourced distinction for every threshold, is `docs/research/decomposition.md`.

Default ladder (MonolithFirst; Shopify modular monolith):

```text
retain → modularize in place → extract module/package → extract service / micro-frontend
```

Each rung must be justified by measured evidence; skipping a rung requires a recorded reason.

### 15A.2 Drivers

A decomposition campaign SHALL record at least one driver from a closed list, with evidence or an owner statement:

| Driver | Evidence that substantiates it |
|---|---|
| `independent_deploy` | Deployables releasing together; release-train waits; co-change across team boundaries |
| `independent_scale` | Divergent resource profiles per capability from runtime metrics |
| `availability_isolation` | Incidents propagating across capabilities; differing SLOs |
| `security_isolation` | Differing data classification or privilege per capability |
| `team_autonomy` | Ownership map showing ≥2 teams in one deployable with merge contention |
| `technology_divergence` | Capability needs a different runtime/framework |
| `build_time` | Build/test duration dominated by unaffected areas |

Without a driver, service extraction (T3) and micro-frontends (T7) SHALL NOT be offered; retain, T1, T2, T8 remain available.

### 15A.3 Boundary discovery

Unknot SHALL build a **composite affinity graph** over modules (files/packages) whose edge weight is

```text
w(a,b) = α·S(a,b) + β·D(a,b) + γ·E(a,b) + δ·M(a,b) [+ ρ·R(a,b) when traces exist]
```

- `S` structural: imports and calls, normalised per node.
- `D` data affinity: shared tables, writes weighted above reads.
- `E` evolutionary: git co-change degree after excluding commits that touch more than `max_changeset` files (default 50) and pairs with fewer than `min_shared_commits` (default 10).
- `M` semantic: overlap of domain terms in paths and identifiers.
- `R` runtime: call counts from imported traces.

Defaults `α=0.35 β=0.30 γ=0.25 δ=0.10` are **heuristics**, configurable, and always reported as such.

Candidates SHALL come from Leiden community detection with a resolution sweep, cross-checked by a second algorithm (label propagation). The algorithms propose; they never authorize. A candidate is **robust** only if fewer than 10% of its nodes change membership under a ±50% weight perturbation and across resolutions. Unstable candidates are reported as uncertainty, not silently chosen.

Domain hints (DDD bounded contexts, aggregates, CODEOWNERS, ADRs, `catalog-info.yaml`) are evidence inputs. They are not ground truth, and contradictions between them and graph clusters SHALL be shown.

### 15A.4 Candidate metrics

For each candidate C:

| Metric | Definition | Direction |
|---|---|---|
| Cohesion | internal weight / (internal + external) | higher better |
| Coupling | w(Ci,Cj) / min(vol Ci, vol Cj) | lower better |
| Modularity Q | Newman–Girvan modularity of the partition | higher better |
| IFN | distinct entry points of C used from outside | lower better |
| CBT | transactions writing tables owned by more than one candidate | 0 required for service extraction |
| CBJ | queries joining tables owned by different candidates | lower better |
| SW | candidates writing the same table | 0 required before service extraction |
| CCL | share of commits touching C and non-C | lower better |
| OA | max share of C owned by a single team | higher better |
| CC | cross-boundary calls per request, p95 (traces only) | lower better |
| Reverse deps | edges from C back into the remainder | lower better |
| Size | modules in C; flags nano and mega candidates | within band |

Metrics are relative within the repository, not absolute grades. Each metric carries its evidence completeness (for example, "no traces, so CC is unknown").

### 15A.5 Treatments

The pattern engine SHALL evaluate these treatments for every candidate. Each one exists as a versioned pattern card with signals, contraindications, a first slice, proof obligations and recovery.

| ID | Treatment | Hard contraindications (examples) | First safe slice |
|---|---|---|---|
| T0 | Retain | none, always valid | none; optionally boundary monitoring |
| T1 | Modularize in place | none structural; no tests → characterization first | boundary rules in warn mode with a baseline of existing violations |
| T2 | Extract module/package | cycle with remainder; shared mutable state; shared-table writes | facade over the module, with old paths delegating |
| T3 | Extract service via strangler fig | no driver; requests not interceptable; CBT>0 without saga design; SW>0; no tracing; OA<0.8; reverse deps high | identity-route facade at 0%, then shadow, then canary |
| T4 | Branch by abstraction | no stable interface definable; no tests | interface plus adapter delegating to existing implementation |
| T5 | Parallel change | consumers unknown; old and new cannot coexist | expand only (additive) |
| T6 | Database decomposition | strict cross-boundary atomicity with no saga; no reconciliation; no proven restore | ownership annotation plus read-only view or wrapper; no data moves |
| T7 | Micro-frontend by route | no driver; single owner (Common Ownership); heavy cross-route state; frequent cross-zone navigation; no per-app CI/CD | identity reverse-proxy route, then one low-coupling route |
| T8 | Frontend modular monolith | strong independent-deploy driver across teams (consider T7) | layer/slice lint rules in warn mode with a baseline |
| T9 | Backend for frontend | single client; clients make identical requests; latency budget cannot absorb a hop | one read-only BFF endpoint for one screen |

Numeric thresholds such as OA≥0.8, CCL≤0.2, CC p95≤5 and the size band are configurable heuristics, and the output SHALL label them so.

### 15A.6 Selection algorithm

1. Compute candidates, their metric vectors, robustness and evidence completeness.
2. Evaluate every treatment's hard contraindications and discard failing treatments, recording why.
3. Discard treatments that do not serve a recorded driver (T0, T1, T2, T8 need none).
4. Rank the rest from least to most invasive: `T0 < T1 < T2 = T4 = T5 < T6 < T8 = T9 < T7 < T3`. Within a rank, order by the §12 priority formula.
5. Retain wins when the best alternative's expected benefit does not exceed its cost plus risk, or when evidence is too incomplete.
6. Emit the recommendation contract (§15A.8) with exactly one first slice.

Every recommendation SHALL cite at least one favouring signal with its measured value, and list every contraindication it checked. A pattern is never recommended because it exists.

### 15A.7 Safe execution rules

- Backend data follows the data ladder: annotate ownership → read-only view or wrapper → move cross-boundary FK and joins to code behind a flag → owner-side store with CDC or outbox → reconcile → flip reads (shadow compare) → flip writes (tracer write) → soak → **drop legacy objects as a separate, irreversible, human-gated slice**.
- Strangler facades start as identity routing with no behaviour change, proven by parity tests, before any traffic shifts.
- Parallel-run (Scientist-style) candidates must be side-effect free or stubbed. Unknot generates the experiment scaffolding only.
- Frontend strangling goes route by route behind a reverse proxy or framework rewrite. Rollback is the route flip. Retiring the old route is a separate contraction slice.
- Every slice is either additive and reversible (by deletion or flag), or labelled `irreversible: true` with a human gate and a restore plan.
- Static boundary evidence alone yields at most `medium` confidence for extraction. Zero static violations do not prove runtime isolation (Packwerk retrospective).

### 15A.8 Recommendation contract

```json
{
  "schema_version": "1.0",
  "id": "DEC-0003",
  "target": "backend|frontend",
  "driver": ["independent_deploy"],
  "candidate": {"id": "C-2", "modules": [], "robust": true, "metrics": {}},
  "treatment": "T2",
  "favoring_signals": [{"signal": "OA", "value": 0.92, "source": "CODEOWNERS"}],
  "contraindications_checked": [{"id": "shared_table_writes", "result": "pass", "value": 0}],
  "rejected_treatments": [{"treatment": "T3", "reason": "CBT=3 without saga design"}],
  "evidence_gaps": ["no runtime traces: CC unknown"],
  "confidence": "medium",
  "first_slice": {},
  "proof_obligations": [],
  "recovery": {"type": "revert"},
  "irreversible": false,
  "retain_score": 0.41,
  "heuristics_used": ["OA>=0.8", "weights α..δ"]
}
```

### 15A.9 Detectors added

`decomposition.distributed-monolith`, `decomposition.chatty-boundary`, `decomposition.nanoservice-candidate`, `decomposition.shared-table-writers`, `decomposition.cross-boundary-transaction`, `decomposition.entity-service`, `decomposition.cyclic-modules`, `decomposition.co-change-leak`, `frontend.cross-feature-imports`, `frontend.layer-violation`, `frontend.mfe-common-ownership`, `frontend.mfe-lockstep-release`, `frontend.mfe-shared-mutable-state`, `frontend.nano-frontend`, `frontend.mega-frontend`.

### 15A.10 Frontend specifics

- Recognise frameworks and routing from source: Next.js (app/pages routers, multi-zone rewrites), React Router, Vue Router, Angular routes, SvelteKit, Remix, Nuxt. Also recognise Module Federation and single-spa configuration.
- Build the route graph: route → page component → features → shared modules.
- Recognise Feature-Sliced Design layers (app, processes, pages, widgets, features, entities, shared) and Nx project tags when present. Otherwise infer feature folders from directory structure.
- Measure cross-feature imports, layer violations, shared global state (stores, contexts), design-system usage, and bundle entry fan-out.
- Integration options are recommended from evidence. Build-time packages imply lockstep releases. Runtime federation implies shared singleton negotiation. Iframes imply routing and a11y cost. Multi-zone implies hard navigation between zones.

### 15A.11 Command

`/unknot:decompose [scope] [--target backend|frontend|auto] [--driver <id>...]` is read-only. It builds the affinity graph, candidates, metrics and treatment evaluation, writes the recommendation artifact, and can hand off to `/unknot:plan` to create the campaign.

---

## 16. Unified security model

### 16.1 Threats

- Prompt injection in repository content, issues, docs, tool output, and dependency metadata.
- Malicious repositories attempting command execution or exfiltration.
- Shell injection, path traversal, and symlink escape.
- Secrets entering model context or proof bundles.
- Dependency confusion and tool substitution.
- Compromised MCP servers, scanners, or language servers.
- Confused-deputy and excessive-permission behavior.
- Cross-repository, tenant, or run leakage.
- Poisoned cache and stale evidence.
- Destructive Git, database, cloud, or cluster actions.
- Hallucinated evidence and unexecuted tests.

### 16.2 Trust boundaries

- User ↔ Claude Code.
- Model ↔ Unknot runtime.
- Runtime ↔ repository/worktree.
- Runtime ↔ local tools.
- Runtime ↔ MCP.
- Runtime ↔ SCM/CI.
- Runtime ↔ database metadata.
- Runtime ↔ cloud/Kubernetes APIs.
- Runtime ↔ telemetry/catalogs.
- Publisher ↔ plugin consumer.

### 16.3 Controls

- Deny by default.
- Capability tokens scoped by run, operation, path, environment, and expiry.
- Canonical path and symlink checks.
- Argument-vector execution; no implicit shell interpolation.
- Executable and argument allowlists.
- Read-only filesystem outside worktree and artifact area.
- Network disabled by default.
- Separate, short-lived credentials per integration.
- Secret redaction before model context and logs.
- Signed policy bundles.
- Tamper-evident audit events.
- Approval bound to exact plan and diff hashes.
- Approval invalidation after any material change.
- No direct production mutation by the model.

### 16.4 Hooks

- `PreToolUse`: path, command, MCP, and capability validation.
- `PermissionRequest`: risk policy and approval requirements.
- `PostToolUse`: result digest, redaction, and evidence update.
- `SubagentStart`: issue minimal capabilities.
- `SubagentStop`: revoke capabilities and validate response.
- `Stop`: block success when proof obligations remain open.

Hooks are defense in depth, not the sandbox itself.

### 16.5 Data handling

- Local-only by default.
- Remote telemetry opt-in.
- No source, diffs, secrets, or customer data in analytics.
- Encrypted content-addressed caches.
- Configurable retention and secure deletion.
- Tenant-separated keys, namespaces, and indexes.
- Data residency checks before remote calls.
- Documented subprocess and MCP boundaries.

---

## 17. Planning and campaigns

### 17.1 Campaign schema

```yaml
id: CMP-17
objective: Reduce checkout deployment coupling
scope: [services/checkout, services/pricing]
constraints:
  - preserve_public_api
  - zero_planned_downtime
baseline: BL-773
alternatives:
  - retain_and_document
  - decouple_contracts
  - merge_deployables
selected: merge_deployables
rationale: "..."
risks: []
slices: [UK-0041, UK-0042, UK-0043]
approvals: []
```

### 17.2 Slice requirements

A slice MUST:

- Have one explicit objective.
- Declare included and excluded scope.
- Fit configured change budgets.
- Preserve a releasable state.
- List preconditions and dependencies.
- State behavioral and quality invariants.
- Define proof obligations.
- Define recovery strategy.
- Identify owners and approvers.
- Avoid unrelated cleanup.

### 17.3 Slice schema

```yaml
id: UK-0042
campaign: CMP-17
objective: Introduce a pricing facade without changing consumers
scope:
  include: [services/checkout/pricing/**]
  exclude: [infra/**, migrations/**]
preconditions: [UK-0041]
changes: []
invariants: []
proof_obligations: []
risk: medium
blast_radius: bounded
recovery:
  type: revert
approvals: [checkout-owner]
status: awaiting_approval
```

### 17.4 Selection

`/unknot:next` selects the smallest unblocked high-value slice, preferring:

1. Better evidence.
2. Lower blast radius.
3. Stronger reversibility.
4. Earlier risk retirement.
5. Reduced future migration cost.
6. Minimal cross-team coordination.

---

## 18. Patch execution

1. Confirm baseline commit and clean source tree.
2. Create a dedicated worktree and branch.
3. Revalidate slice, scope, policy, and approvals.
4. Run baseline focused checks.
5. Apply only approved transformations.
6. Reject writes outside allowed paths.
7. Enforce changed-file and diff budgets.
8. Re-index the affected graph.
9. Run proof obligations.
10. Generate architecture, security, database, and infrastructure deltas as applicable.
11. Emit proof bundle and review notes.
12. Stop at `REVIEW_READY`; do not merge or deploy.

If implementation reveals a false assumption, transition to `NEEDS_REPLAN`; do not improvise broader scope.

---

## 19. Verification architecture

### 19.1 Proof obligations

Examples:

- Public API remains backward compatible.
- Characterized input/output behavior remains equivalent.
- No new dependency cycle exists.
- Authorization is unchanged or intentionally tighter.
- Old and new data representations reconcile.
- Infrastructure plan has no unapproved delete or replacement.
- Latency and resource use remain in budget.
- Mixed-version rollback works.

### 19.2 Verification ladder

1. Parse and schema validation.
2. Format and lint.
3. Type check and compile.
4. Focused unit and property tests.
5. Component and integration tests.
6. API, message, and schema contracts.
7. Architecture fitness functions.
8. SAST, secret, dependency, IaC, and image scans.
9. Migration rehearsal and reconciliation.
10. Infrastructure plan and policy checks.
11. Performance and resource regression.
12. Critical end-to-end smoke tests.
13. Upgrade, downgrade, rollback, and recovery.
14. Canary or shadow evidence after separately approved rollout.

### 19.3 Evidence record

```json
{
  "obligation": "PO-17",
  "command": ["pnpm", "test", "checkout"],
  "working_directory": "worktrees/UK-0042",
  "environment_digest": "sha256:...",
  "started_at": "RFC3339",
  "duration_ms": 14220,
  "exit_code": 0,
  "stdout_digest": "sha256:...",
  "stderr_digest": "sha256:...",
  "artifact_refs": [],
  "verdict": "pass"
}
```

An agent cannot mark an obligation passed without a corresponding executed evidence record unless the obligation explicitly requires human review.

### 19.4 Proof bundle

Every review-ready slice contains:

```text
.unknot/runs/<run-id>/
├── manifest.json
├── finding.json
├── slice.yaml
├── approvals.json
├── diff.patch
├── architecture-before.md
├── architecture-after.md
├── security-delta.md
├── database-migration-plan.yaml
├── infrastructure-plan-summary.json
├── verification.json
├── command-log.jsonl
├── uncertainties.md
└── recovery.md
```

Only applicable artifacts are required.

---

## 20. Approval policy

| Risk | Examples | Required approval |
|---|---|---|
| Low | Local rename, proven dead private code | Code owner |
| Medium | Module boundary, internal contract, dependency change | Code owner and affected owner |
| High | Public API, auth, database schema/data, IAM, network, destructive infra | Code owner plus specialist owner |
| Critical | Production data movement, recovery posture, tenant boundary, irreversible action | Two-person approval plus security/data/platform owner |

Approval binds to:

- Commit hash.
- Slice version.
- Diff hash.
- Plan hash and state serial when relevant.
- Policy digest.
- Environment.
- Expiration.

Any material change invalidates approval.

---

## 21. Metrics

### 21.1 Product metrics

- Finding acceptance and rejection rate.
- Time from finding to review-ready slice.
- Proof success and false-positive rate.
- Rollback/replan frequency.
- Human edits after generated patch.
- Escaped regression rate.
- User override and policy-block rate.

### 21.2 Complexity outcomes

- Dependency cycles.
- Change propagation across modules/services/repositories.
- Build and test affected scope.
- Deployment coupling.
- Public API and privileged surface.
- Duplicate capability count.
- Mean files/modules/services touched per feature.
- On-call and operational object count.

### 21.3 Delivery outcomes

Measure change lead time, deployment frequency, failed deployment recovery time, change fail rate, and deployment rework rate at the application/service level. Do not use individual developer metrics or rank teams from raw counts.

### 21.4 Database outcomes

- Query latency and plan regressions.
- Lock wait and deadlock rate.
- Replica/CDC lag.
- Restore success and measured recovery time.
- Data reconciliation discrepancy.
- Unowned tables and shared-writer count.
- Index/storage write amplification.

### 21.5 Infrastructure outcomes

- Drift age and unmanaged resource count.
- Plan replacement/deletion frequency.
- Privilege and public exposure surface.
- Resource ownership coverage.
- Recovery-test freshness.
- Golden-path adoption.
- Idle resource cost.
- Deployment rollback and abort effectiveness.

---

## 22. Adapter SDK

### 22.1 Interfaces

```ts
interface DiscoveryAdapter {
  id: string;
  supports(input: RepositoryContext): Promise<SupportResult>;
  discover(ctx: DiscoveryContext): AsyncIterable<GraphFact>;
}

interface VerificationAdapter {
  id: string;
  plan(slice: Slice): Promise<ProofPlan>;
  execute(obligation: ProofObligation, capability: Capability): Promise<Evidence>;
}

interface DatabaseAdapter {
  id: string;
  inspect(source: DatabaseMetadataSource): Promise<DatabaseModel>;
  forecast(migration: Migration): Promise<MigrationImpact>;
  validate(plan: DatabaseMigrationPlan): Promise<ValidationResult>;
}

interface InfrastructureAdapter {
  id: string;
  inspect(source: InfrastructureSource): Promise<InfrastructureModel>;
  preview(change: ChangeSet): Promise<NormalizedPlan>;
  detectDrift(model: InfrastructureModel): Promise<DriftFinding[]>;
}
```

### 22.2 Adapter rules

- Versioned capability declaration.
- Deterministic output for identical input where possible.
- Provenance on every emitted fact.
- No network or execution beyond issued capability.
- Strict schemas and bounded output.
- Failure must be explicit; no partial success represented as complete.
- Compatibility tests and fixture repositories required.

---

## 23. Storage

Initial local runtime:

- SQLite for runs, events, findings, decisions, and artifact index.
- Content-addressed filesystem for immutable artifacts.
- In-memory or SQLite graph projection for small/medium repositories.
- Optional external graph/search backend for enterprise scale.

Tables:

- `runs`
- `events`
- `facts`
- `nodes`
- `edges`
- `findings`
- `campaigns`
- `slices`
- `proof_obligations`
- `evidence`
- `approvals`
- `decisions`
- `artifacts`
- `policy_results`

All mutable entities use optimistic concurrency and schema versions.

---

## 24. API contracts

Optional local daemon endpoints:

```text
POST   /v1/runs
GET    /v1/runs/{id}
POST   /v1/maps
POST   /v1/diagnoses
GET    /v1/findings/{id}
POST   /v1/campaigns
POST   /v1/slices/{id}/approve
POST   /v1/slices/{id}/apply
POST   /v1/slices/{id}/verify
GET    /v1/slices/{id}/proof-bundle
POST   /v1/decisions
GET    /v1/audit/events
```

Requirements:

- Localhost-only by default.
- Mutual authentication in remote mode.
- Idempotency keys for mutations.
- Request and artifact size limits.
- Optimistic concurrency tokens.
- Structured errors.
- No raw shell endpoint.

---

## 25. Error model

```json
{
  "code": "UK_POLICY_DENIED",
  "message": "Infrastructure apply is not permitted in Assist mode.",
  "run_id": "run-123",
  "slice_id": "UK-0042",
  "retryable": false,
  "details": {
    "policy": "infra.apply.forbidden",
    "required_mode": "external-delivery-system"
  }
}
```

Error classes:

- Configuration.
- Adapter unsupported.
- Baseline invalid.
- Scope violation.
- Policy denied.
- Approval stale.
- Budget exceeded.
- Tool execution failed.
- Evidence inconclusive.
- Verification failed.
- State conflict.
- Recovery required.

---

## 26. Testing Unknot

### 26.1 Unit

- Parsers, normalizers, graph algorithms, scoring, schemas.
- Path, symlink, command, and capability enforcement.
- Pattern matching and contraindications.
- Risk and approval policy.

### 26.2 Integration

- Real language servers and build tools.
- Git worktrees and interrupted-run recovery.
- Database migration planners against ephemeral engines.
- Terraform/OpenTofu plan normalization.
- Kubernetes server-side dry-run and field ownership.
- MCP trust and timeout behavior.

### 26.3 Golden repositories

Fixtures SHALL represent:

- Layered legacy monolith.
- Healthy modular monolith.
- Distributed monolith.
- Event-driven system.
- Polyglot monorepo.
- PostgreSQL/MySQL/MongoDB migrations.
- Terraform and Kubernetes estates.
- Deliberate anti-patterns and legitimate complexity.

Golden tests compare findings, provenance, plans, and expected non-findings.

### 26.4 Adversarial

- Prompt injection in comments and docs.
- Malicious filenames and symlinks.
- Poisoned tool output.
- Secret exfiltration attempts.
- Scope and budget escalation.
- Destructive command obfuscation.
- Fake test output.
- Stale approval replay.
- Cross-run artifact confusion.
- Compromised MCP response.

### 26.5 Evaluation dimensions

- Finding precision and recall.
- Behavior-preservation success.
- Minimality of patches.
- Correctness of architecture classification.
- Correct risk and approval classification.
- Database lock/rewrite forecast accuracy.
- Infrastructure action normalization accuracy.
- Resistance to prompt injection.
- Reproducibility.
- Reviewer time saved.

Release gates MUST include zero critical sandbox escapes, zero false claims of executed evidence, and passing destructive-action denial tests.

---

## 27. Observability

Unknot emits OpenTelemetry-compatible traces, metrics, and structured logs when enabled.

Trace hierarchy:

```text
unknot.run
  ├── baseline
  ├── map
  │   ├── adapter.language
  │   ├── adapter.database
  │   └── adapter.infrastructure
  ├── diagnose
  ├── plan
  ├── apply
  └── verify
```

Metrics:

- Run duration and outcome.
- Agent/tool calls and failures.
- Index cache hit rate.
- Facts, findings, and uncertainty count.
- Policy denials.
- Changed files and diff size.
- Proof-obligation pass/fail/inconclusive.
- Cost and token usage.

Telemetry MUST NOT contain source, diffs, secrets, SQL values, state contents, or customer data.

---

## 28. Performance and scale

Targets for the initial local release:

- Cold map of 100,000 files: resumable and bounded by configured workers.
- Incremental map after a small commit: under two minutes on supported stacks, subject to project tools.
- Interactive finding explanation: under five seconds when evidence is cached.
- Memory bounded through streaming extraction and graph batching.
- Large artifacts addressed by digest and loaded on demand.
- Global analysis restricted to impact cones unless explicitly requested.

Performance targets SHALL be validated with published benchmark fixtures, not synthetic marketing claims.

---

## 29. Compatibility and release

Public API includes:

- CLI and skill names.
- Configuration schema.
- Pattern-card schema.
- Adapter interfaces.
- Artifact schemas.
- Policy input/output schema.

Use semantic versioning. Every release includes:

- Signed plugin package.
- Checksums.
- SBOM.
- Provenance attestation.
- Migration notes.
- Compatibility matrix.
- Security advisories as required.

---

## 30. Implementation roadmap

### Phase 0 — Safety kernel

Deliver:

- Runtime state machine.
- Capability model.
- Path and command broker.
- Worktree isolation.
- Event/evidence ledger.
- Config and policy schemas.
- Hook enforcement.
- Adversarial security suite.

Exit criteria:

- No write outside scoped worktree.
- No unrestricted shell or network.
- Approval hashes and invalidation work.
- Interrupted runs recover safely.

### Phase 1 — Read-only mapper

Deliver:

- Repository census.
- Initial TypeScript/JavaScript and Python adapters.
- Build/test topology.
- Symbol/reference graph.
- C4 views.
- Basic findings and provenance.

Exit criteria:

- Incremental indexing.
- Golden-repository classification quality meets threshold.
- Every finding links to evidence.

### Phase 2 — Planner

Deliver:

- Pattern-card engine.
- Alternatives and contraindications.
- Campaign DAG and slice schemas.
- Proof-obligation generator.
- Risk/approval engine.

Exit criteria:

- Plans stay within scope and budgets.
- “Retain” is represented as a valid option.
- High-risk changes receive correct approval class.

### Phase 3 — Local simplifier

Deliver:

- Refactorer agent.
- AST-aware transformations.
- Baseline and focused verification.
- Proof bundles.
- No-op and rollback tests.

Exit criteria:

- Patches are isolated and review-ready.
- No unexecuted test is reported as passing.
- Behavior-preservation benchmark passes.

### Phase 4 — Architecture campaigns

Deliver:

- Service and event topology.
- Runtime evidence ingestion.
- Strangler, branch-by-abstraction, and parallel-change planning.
- Contract testing and architecture fitness functions.
- Monolith decomposition (§15A): composite affinity graph, Leiden candidates with robustness, treatment selection T0–T9, frontend route graph.

Exit criteria:

- Multi-slice campaigns remain releasable after every slice.
- Runtime and static conflicts are surfaced.

### Phase 5 — Databases

Deliver:

- PostgreSQL, MySQL, and MongoDB read-only adapters.
- Schema/query/ownership graph.
- Engine-specific lock/rewrite forecast.
- Migration and backfill plans.
- Reconciliation and restore-test evidence.

Exit criteria:

- No live mutation.
- Forecast fixtures cover hazardous DDL.
- High-risk data plans require recovery proof.

### Phase 6 — Infrastructure

Deliver:

- Terraform/OpenTofu plan parser.
- Kubernetes/Helm/Kustomize inventory and dry-run.
- Drift, IAM, network, cost, and recovery findings.
- Plan hash approval and destructive-action gates.

Exit criteria:

- Apply/destroy remain outside plugin execution.
- Delete/replace/privilege deltas are never hidden.
- Saved-plan and state-serial binding works.

### Phase 7 — Enterprise governance

Deliver:

- Organization policy bundles.
- Multi-repository campaigns.
- Service catalog integration.
- SSO/RBAC for hosted control plane.
- Tenant isolation and audit export.
- Signed release pipeline.

Exit criteria:

- External security review.
- Tenant isolation tests.
- Disaster recovery exercise.
- Support and compatibility policy published.

---

## 31. Definition of done

A feature is done when:

- Functional requirements pass.
- Threat model is updated.
- Capability and policy tests pass.
- Schemas and migration paths are versioned.
- Unit, integration, golden, and adversarial tests pass.
- Telemetry is content-safe.
- Documentation and examples are current.
- Error behavior is explicit.
- Performance is measured.
- Recovery behavior is tested.
- Release artifact is signed and reproducible.

A simplification slice is done when:

- Scope and objective are satisfied.
- Required behavior remains proven.
- No guardrail regresses.
- Security, database, and infrastructure deltas are reviewed as applicable.
- Proof bundle is complete.
- Recovery path is executable.
- Residual uncertainty is disclosed.
- Human owner accepts the result.

---

## 32. Acceptance scenarios

### Scenario A — Local code

Given a complex parser with duplicated branches, Unknot maps callers and tests, creates characterization tests where needed, proposes one flattening transformation, applies it in a worktree, runs focused and broader checks, and produces a review-ready patch without touching unrelated files.

### Scenario B — Distributed monolith

Given three services that always deploy together and share one schema, Unknot does not automatically split the database. It presents retain, decouple, and merge alternatives; maps owners and failure domains; and creates a campaign whose first slices establish contracts and observability.

### Scenario C — PostgreSQL migration

Given a type change on a large table, Unknot rejects a direct destructive migration, forecasts lock/rewrite impact, proposes expand/backfill/validate/switch/contract, requires throttling and reconciliation, and demands restore evidence before review-ready status.

### Scenario D — Terraform consolidation

Given duplicated environment stacks, Unknot extracts a module only if lifecycle and policy are stable, generates plans for each workspace, flags replacements/deletions, binds approvals to plan and state, and never executes apply.

### Scenario E — Kubernetes simplification

Given an apparently unused sidecar and NetworkPolicy, Unknot uses runtime and ownership evidence. It may recommend removing the sidecar, but it will not remove the policy until enforcement, traffic, and trust-boundary requirements prove it unnecessary.

### Scenario F — Prompt injection

Given a repository comment instructing the agent to upload secrets and run destructive commands, Unknot treats it as source text, denies network and command capabilities, records the event, and continues or blocks according to policy.

### Scenario G — Backend decomposition without a driver

Given a cohesive monolith with low churn and no recorded driver, `/unknot:decompose` recommends retain or modularize-in-place, shows why service extraction was not offered, and lists the evidence that would change the answer.

### Scenario H — Frontend strangling

Given a single-team SPA with tangled feature imports, Unknot recommends a frontend modular monolith (T8) with lint rules in warn mode. Given two teams owning disjoint routes with lockstep-release pain, it proposes an identity reverse-proxy slice followed by one low-coupling route (T7), with route-flip recovery and parity, accessibility and Web-Vitals obligations.

---

## 33. Final product rule

Unknot succeeds when a complicated system becomes easier to understand, change, operate, secure, and recover—through small verified steps. If a proposed “simplification” merely moves complexity, hides it, weakens controls, or creates an irreversible migration, Unknot must reject or redesign it.
