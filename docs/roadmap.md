# Roadmap to production grade

Unknot works today on real repositories, and the [dogfood log](dogfood/README.md) records what
that looked like. Production use on large codebases needs eight things it does not have yet.
None of them is specific to one language or framework. The first proving ground was a large
.NET monolith, but every item below is written for any language, framework, forge and
observability stack, with a plug-in point where those differ.

Each item says where Unknot is today, what production grade means, how a new language or
framework plugs in, and how we will know it is done.

## Principle: report how well each part of the code is understood

Everything Unknot concludes is only as good as the facts under it, and the quality of those
facts differs by language. Every fact already carries provenance and confidence. The map should
also report, per language and per framework, which tier produced it:

| Tier | Source | What it can see |
|---|---|---|
| Lexical | Tokens and patterns | Declarations, names, imports by text |
| Syntax tree | The language's own parser | Structure, nesting, exact spans |
| Semantic | The compiler or its analysis service | Resolved types, overloads, calls, generics, implicit imports, generated code |

Confidence caps, `partial` status and the wording of findings follow the tier. A finding about
code read lexically says so; one about code read semantically does not need to.

## 1. Compiler-grade understanding for every language

**Today.** JavaScript and TypeScript are parsed into syntax trees by Unknot's own parser, and
Python by CPython's `ast`. Every other language (C#, Java, Kotlin, Scala, Go, Rust, Ruby, PHP,
Swift, C, C++) is read lexically. Type references are matched by name (for C# at type level
since 0.1.11), and a map whose dominant language is read lexically reports `partial`.
Dependency injection, ORM mappings and routes are recognised by framework-specific patterns
where someone wrote them.

**Production grade.**

- A *semantic adapter* contract: an optional extractor per language that runs the language's own
  analysis through the broker (sandboxed, no network) and emits the same facts the lexical
  adapters do (definitions, references, calls, inheritance, implementations) at the semantic
  tier.
- The generic route first: an importer for [SCIP](https://github.com/sourcegraph/scip) (and
  LSIF) indexes. Maintained indexers already exist for most languages, so one importer lifts
  many of them at once. Native adapters come next, for languages without a good indexer or
  where Unknot needs more than an index holds.

| Language | Indexer or compiler service |
|---|---|
| C#, F#, VB | Roslyn, scip-dotnet |
| Java, Scala, Kotlin | scip-java, javac/JDT, Kotlin Analysis API |
| TypeScript, JavaScript | scip-typescript, tsc language service |
| Python | scip-python, pyright |
| Go | scip-go, go/packages with go/types |
| Rust | rust-analyzer |
| Ruby | scip-ruby, Sorbet, Prism |
| PHP | PHPStan, nikic/php-parser |
| C, C++ | scip-clang, clangd with compile_commands.json |
| Swift | SourceKit-LSP |

- Framework semantics as packs, separate from the language: declarative rules plus small hooks,
  each with fixtures and a measured precision. The same pack covers every language the framework
  supports.
  - **Dependency injection:** constructor, property, attribute and field injection, container
    registrations, lifetimes. Covers ASP.NET Core, Autofac, Unity, Spring, Guice, Dagger,
    NestJS, Angular, InversifyJS, FastAPI `Depends`, Django, Laravel, Symfony and Rails
    autoloading.
  - **Data access:** entity-to-table mappings, repositories, raw SQL and query builders. Covers
    EF Core, JPA/Hibernate, MyBatis, SQLAlchemy, Django ORM, ActiveRecord, Prisma, TypeORM,
    Sequelize, Drizzle, GORM, sqlc, Doctrine, Eloquent, Diesel and SeaORM.
  - **Routes and handlers:** ASP.NET, Spring MVC, JAX-RS, Express, Nest, Fastify, FastAPI,
    Flask, Django, Rails, Laravel, Gin, Echo, Axum, Actix and Vapor.
  - **Messaging:** producers and consumers for Kafka, RabbitMQ, SQS/SNS, Azure Service Bus,
    Google Pub/Sub and NATS, including the typed client libraries of each framework.
- A language or framework the packs do not cover still works at the lower tier and is reported
  as such, never silently.

**Done when** the top languages of the reference corpus (item 7) map at the semantic tier, the
same architecture fixture written in several languages gives equivalent graphs, and the
`partial` cap lifts only where the semantic tier ran.

## 2. A system view: repositories and the contracts between them

**Today.** Workspaces link repositories explicitly and combine their graphs. The contracts
adapter reads OpenAPI, AsyncAPI, GraphQL, protobuf, Avro and Pact. Decomposition counts a seam
when the candidate exposes a route or a contract in the same repository, or when traces show
calls into it. A caller in another repository is invisible to a single-repository decompose,
which therefore says "no seam visible in this repository".

**Production grade.**

- Consumer-side extraction, so that a call from one repository can be matched to a provider in
  another:
  - generated and declarative HTTP clients (OpenAPI generators, Refit, Feign, Retrofit, NSwag,
    Kiota);
  - gRPC and GraphQL stubs;
  - hand-written HTTP wrappers recognised by the framework packs;
  - message producers and consumers.
- Contract matching across a workspace: provider and consumer of the same operation or topic
  are linked, version skew is reported, and decomposition reads those links as evidence of an
  existing seam, naming the repository it is in.
- Contract registries as evidence sources: Pact brokers, schema registries, API catalogs and
  service catalogs (Backstage and similar).

**Done when** a two-repository fixture (a provider, and a consumer calling it through a typed
client) turns the extraction evaluation from "no seam visible" into "seam exists: consumer X
calls operation Y". The same fixture must pass in at least two language pairs.

## 3. Decision evidence from running systems, with freshness

**Today.** Runtime and data evidence is imported from files:
- OTLP, Jaeger and Zipkin traces;
- Prometheus text and HTTP API responses;
- catalogs, database metadata and slow-query logs;
- infrastructure plans and state.

Facts carry an expiry, and expired ones are reported as stale. Recipes for exporting from
hosted observability vendors are in [runtime-evidence.md](runtime-evidence.md).

**Production grade.**

- Read-only connectors, run through the broker with credentials the person configures and
  network limited to the listed hosts:
  - **Database statistics:** who writes and reads which tables, and which writes share a
    transaction. Sources: SQL Server Query Store, PostgreSQL `pg_stat_statements`, MySQL and
    MariaDB `performance_schema`, Oracle AWR, MongoDB profiler.
  - **Traces and metrics:** any OpenTelemetry-compatible backend, plus the query APIs of hosted
    vendors (Coralogix, Datadog, Grafana Cloud, Honeycomb, New Relic and others) through one
    vendor-neutral interface.
  - **Delivery history:** deployment frequency, change failure rate, lead time per deployable
    unit, from the CI/CD system.
- Every fact records its source, its window and when it was collected. Decisions show the age
  of their evidence, and stale evidence lowers confidence instead of silently counting.

**Done when** a decomposition record's readiness table shows measured runtime and data signals
with their age, and the same candidate's confidence drops when that evidence expires.

## 4. Fit with the governance teams already use

**Today.** Approvals are signatures with personal Ed25519 keys, typed at a local terminal.
Verification runs on the developer's machine in an OS sandbox. State (campaigns, slices, the
ledger) lives in each clone. Lanes reduce the number of approvals, but not where they happen.

**Production grade.**

- **The forge as the approval surface.** On GitHub, GitLab, Bitbucket and Azure DevOps:
  - a slice opens as a draft pull request;
  - approval roles map to code owners and teams;
  - an approval is a review by the right owners on the exact diff;
  - the binding (diff hash, plan digest, policy digest) is recorded in the PR and the ledger.
  Local keys remain for single developers and air-gapped use.
- **Verification in CI.** Proof obligations run as CI jobs (GitHub Actions, GitLab CI, Azure
  Pipelines, Jenkins, Buildkite and others). Their results come back signed (in-toto or SLSA
  attestations) and are checked like local evidence.
- **Shared campaign state.** Several people and agents can work in one campaign at the same
  time, through a small service or a ledger kept in the repository. Concurrent work is handled
  explicitly, and every actor has an identity from the forge or single sign-on.

**Done when** a campaign is approved and verified entirely through pull request reviews and CI
on one forge, the ledger holds the same bindings it holds today, and a second forge passes the
same test.

## 5. Precise guardrails

**Today.** Hooks decide by parsed write targets for most commands. A narrower fallback still
refuses some commands just for naming `.unknot`. A run applies only to the session and turn
that started it, and outside runs only the always-on protections apply. Refusals give a reason,
though not always the rule and the way forward.

**Production grade.**

- Every decision is made on what a command would actually write or run, never on a substring.
  Commands that cannot be analysed are refused with that reason.
- Every refusal names its rule, what matched, and the next step. Refusals are counted locally,
  and optionally reported, so false positives can be found and fixed.
- Nothing outside Unknot's own commands is affected outside a run: other tools, other MCP
  servers and other sessions behave exactly as without the plugin.
- A policy test corpus for each shell and operating system covers both directions: known
  bypasses, and legitimate commands taken from real sessions.

**Done when** the live-session suite shows no refusal outside a run other than a write to
Unknot's own state, and every refusal message has a rule id, a reason and a next step.

## 6. One fact store that every command reads

**Today.** `map` writes one graph, but some conclusions are recomputed per command:
- cycles in `graph cycles`;
- cycle findings in `diagnose`;
- the public surface in the API-compatibility check;
- test classification in the census and in the adapters.

They have disagreed. An edge marked as removable produced no finding, and the API check would
have failed the change the graph recommended.

**Production grade.**

- Derived facts are computed once per graph generation and stored with their provenance:
  - strongly connected components and the edges that break them;
  - declared-only dependencies;
  - public surface and test code;
  - ownership and layers.
- Every command reads those facts rather than recomputing them.
- A cross-command consistency suite runs in CI on the reference corpus:
  - every cycle `graph cycles` reports has a finding or a recorded suppression;
  - every removal a finding recommends passes the API check unless the finding says it will
    not;
  - every test file is test code everywhere.

**Done when** that suite runs on every release over the whole corpus and finds no disagreement.

## 7. Published accuracy, release channels and migrations

**Today.**
- Accuracy has been audited by hand on samples (round 8: 75% of findings true, 5% factually
  wrong), and golden scenario tests run in CI.
- A live-session suite drives real Claude Code sessions on three pinned public repositories.
- Releases are signed and attested.
- The state store is at schema version 1 with additive changes, and extraction caches are keyed
  so that adapter or classification changes refresh them.

**Production grade.**

- A reference corpus of public repositories chosen to cover:
  - languages and architecture styles: large monoliths in at least C#, Java, Python, Ruby,
    PHP, Go and TypeScript, plus service fleets and frontends;
  - the framework packs from item 1.
  Each repository is pinned to a commit and carries labelled ground truth for findings, cycles
  and boundaries.
- Precision and recall per detector, language and release, published with each release. A
  regression blocks the release unless it is explained.
- Release channels: `beta` and `stable` in the plugin marketplace. `beta` goes out first.
- Explicit, tested migrations of the store and of saved records between versions. Every
  release runs upgrade-in-place tests from the previous releases on an already-mapped
  repository, not only on fresh clones, which hid a stale-cache bug once.

**Done when** each release note carries the accuracy table, the upgrade tests from the last
five releases pass, and the corpus includes a large monolith in each of the languages above.

## 8. Proven scale with incremental re-mapping

**Today.** A cold map of a 6,700-file repository takes about 10 seconds, and a re-map with
nothing changed about 4. Extraction is cached per file and resumable. The specification
targets 100,000 files, but the measured benchmark goes only to that same small fixture.

**Production grade.**

- Benchmarks at 50,000, 250,000 and 1,000,000 files across several languages and the semantic
  tier, published with each release: time, memory and store size.
- Re-mapping proportional to the change: a changed file re-links only what depends on it, and
  derived facts (item 6) are updated incrementally. Semantic adapters use their indexers'
  incremental modes.
- Bounded memory: streaming extraction and linking, so a large repository needs no more memory
  than a fixed budget.
- Scoped maps that stay consistent with a full map of the same repository.

**Done when** the published benchmarks include the 250,000-file tier, and re-mapping after a
ten-file change there takes seconds, not minutes.

## Order of work

1. **Trust what exists:** items 6 and 5, then the corpus, accuracy and migration parts of
   item 7. Making today's conclusions consistent and measured comes before adding new ones.
2. **Depth:** item 1, starting with the SCIP importer (one piece of work, many languages) and
   the dependency-injection and data-access packs, measured on the corpus.
3. **Breadth:** item 2 (contracts across repositories), then item 3 (evidence connectors).
4. **Organisation:** item 4 (forge approvals, CI verification, shared state).
5. **Throughout:** item 8. Every step above adds a benchmark tier, not just a feature.

## Adding a language or a framework

The same checklist applies at every step:

1. Lexical facts first, so the language is mapped at all, reported at its tier.
2. Syntax tree or semantic facts through an adapter or an index importer, behind the same fact
   schema.
3. Framework packs for its dependency injection, data access, routes and messaging.
4. Fixtures for each pack, and at least one repository in the reference corpus with ground
   truth.
5. A published precision figure before the tier is advertised.
