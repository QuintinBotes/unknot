# Roadmap to production grade

Unknot works today on real repositories, and the [dogfood log](dogfood/README.md) records what
that looked like. Production use on large codebases needs seven things it does not have in full
yet, numbered as in the roadmap issue [#16], plus [precise guardrails](#precise-guardrails), which
that issue does not track. None of them is specific to one language or framework. The first
proving ground was a large .NET monolith, but every item below is written for any language,
framework, forge and observability stack, with a plug-in point where those differ.

Each item says where Unknot is today on `main` (with the file, command or closed issue behind it,
and the open issues for what is left), what production grade means, how a new language or
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

**Today.**

- JavaScript and TypeScript are parsed into syntax trees by Unknot's own parser, and Python by
  CPython's `ast`.
- Any language with a SCIP index is read at the semantic tier: Unknot imports an `index.scip`
  you made, or, with `adapters.scip.run: true`, runs a maintained indexer through the broker
  ([#54]; [adapters.md](adapters.md#semantic-facts-from-a-scip-index)). A file the index covers
  has `parse_quality: semantic`, and `map` reports the files per quality.
- Without an index, the other languages (C#, Java, Kotlin, Scala, Go, Rust, Ruby, PHP, Swift,
  Dart, C, C++) are read lexically: type references are matched by name within the declared
  build graph, and a map whose dominant language is read lexically reports `partial`
  (`runtime/graph/builder.mjs`).
- A direct Roslyn adapter is not planned ([#29], closed): scip-dotnet builds C# through Roslyn, and
  its index is the semantic route for .NET.
- Container registrations, ORM mappings, HTTP operations and messaging channels are recognised
  by table-driven rules shared by every language (`adapters/language/di-ops.mjs`,
  `orm-maps.mjs`, `http-ops.mjs`, `messaging-ops.mjs`).
- One architecture written in C#, Java, Python, TypeScript and Go
  (`tests/golden/equivalent-architecture.test.mjs`) maps to the same unit dependencies, route,
  table and container binding in each; what a tier cannot see is named in the test.

**Next.** Measure what the semantic tier gains: nopCommerce with a scip-dotnet index against the
lexical run ([#233]). Read container property injection as injected members ([#230]).

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
| C#, F#, VB | scip-dotnet (builds through Roslyn; no direct Roslyn adapter, [#29]) |
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

**Done when** the top languages of the reference corpus (item 6) map at the semantic tier, the
same architecture fixture written in several languages gives equivalent graphs, and the
`partial` cap lifts only where the semantic tier ran.

## 2. A system view: repositories and the contracts between them

**Today.**

- Workspaces link repositories explicitly and combine their graphs (`unknot workspace map`,
  [operations.md](operations.md#2-multi-repository-workspaces)). The contracts adapter reads
  OpenAPI, AsyncAPI, GraphQL, protobuf, Avro and Pact.
- Typed HTTP clients are read as client operations, whatever the library (Refit, Feign, Retrofit
  and Nest are examples; `adapters/language/http-ops.mjs`), and so are message producers and
  consumers (`adapters/language/messaging-ops.mjs`). A workspace map links a client route to the
  endpoint that serves it, and a consumer to the publisher's channel, across repositories ([#30]).
- After a workspace map, decompose counts those links as a seam and names the calling and
  serving repositories, labelled with the time of the map; a repository mapped again after it
  gets a stale-evidence gap ([#44], `tests/unit/enterprise/workspace-decompose.test.mjs`). Without
  a workspace map, a caller in another repository is still invisible, and decompose says "no
  seam visible in this repository".

**Next.** Report version skew between a consumer's operation and its provider ([#234]). The
two-repository fixture covers one language pair, TypeScript to TypeScript; a C# client calling a
Java service is the second ([#236]).

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

**Today.** Runtime and data evidence is imported from files you export:
- OTLP, Jaeger and Zipkin traces;
- call volumes, latency and errors per caller and callee (`unknot import runtime`, [#36]);
- Prometheus text and HTTP API responses;
- catalogs, database metadata, slow-query logs, and query statistics from PostgreSQL
  `pg_stat_statements`, SQL Server Query Store and MySQL `performance_schema`;
- delivery history: deployment rows per deployable unit (`unknot import deliveries`);
- infrastructure plans and state.

Facts carry their source, window and an expiry. `unknot status` lists expired ones as stale, and
decompose stops using them. Recipes for exporting from
hosted observability vendors are in [runtime-evidence.md](runtime-evidence.md).

**Next.** There is no connector yet; the first is a read-only OTLP trace query through the broker,
with a host allowlist and recorded freshness ([#241]). Decompose readiness does not show the age of
its evidence, and expired evidence is dropped instead of lowering confidence ([#239]).

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

**Today.** Phases 1 to 3 of [forge-approvals.md](forge-approvals.md) are built, on GitHub:

- `unknot pr <slice>` opens a draft pull request for a verified slice, with the review summary
  from the proof bundle ([#151]).
- With `approvals.via: forge` or `both`, `unknot pr` also posts the signed binding, and reviews by
  code owners or mapped teams on the bound head count as approvals; `unknot approvals <slice>`
  shows which count and why ([#152]). The default
  stays `local`: signatures with personal Ed25519 keys, typed at a local terminal.
- A slice's command obligations can run in GitHub Actions through the pinned
  `.github/workflows/unknot-verify.yml`, and `unknot verify --from-ci <pr>` records the attested
  result ([#153]). Otherwise verification runs on the developer's machine in an OS sandbox.
- State (campaigns, slices, the ledger) still lives in each clone, and GitHub is the only forge.

**Next.** A shared campaign ledger on a git ref, with signed append-only events and a two-actor
conflict test ([#242]), and GitLab merge request approvals behind the same forge interface ([#243]).

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

## 5. One fact store that every command reads

**Today.** `map` writes one graph and stores derived facts with it, once per graph generation:
strongly connected components (`scc`, `scc_strict`), declared-only dependencies
(`declared_only`), the public surface (`public_surface`), test code (`test_code`) and ownership
(`ownership`) (`runtime/graph/derived.mjs`). `graph cycles`, `diagnose`, `decompose`, the MCP
tools and the API check read them. Before that, the commands disagreed: an edge marked as
removable produced no finding, and the API check would have failed the change the graph
recommended. The cross-command consistency check (`scripts/consistency.mjs`) runs weekly over the
quick corpus (`.github/workflows/quality.yml`) and gates every release on it ([#154],
[release.md](release.md)).

**Next.** Run the release consistency gate over every corpus repository that is not marked large
([#244]), and store layers as a derived fact, checked by the suite ([#245]).

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

## 6. Published accuracy, release channels and migrations

**Today.**
- A pinned corpus of 13 public repositories in seven languages (`scripts/corpus.json`), with
  labels in `corpus/labels/`, gives precision, factual accuracy and seeded recall per detector
  and language (`scripts/accuracy.mjs`, [accuracy.md](accuracy.md)). After 0.4.0: 20% precision
  and 95% factual accuracy on 216 labelled findings. `quality.yml` runs it weekly and compares
  with the previous run, but no number gates anything yet.
- Golden scenario tests run in CI, and a live-session suite drives real Claude Code sessions on
  three pinned public repositories (`scripts/live-suite.json`).
- Releases are signed and attested, and publish only when their gates pass on the tagged commit:
  tests and a restore drill, upgrade in place from the last five releases with a planned,
  approved and applied slice carried across, the consistency check, and the 10k benchmark ([#154],
  [release.md](release.md)).
- Channels: a release tag advances `stable`; `main` is `beta`
  ([release.md](release.md#channels)).
- The store changes only through named, ordered migrations (`runtime/state/migrations.mjs`), and
  saved records through upgrade steps
  ([operations.md](operations.md#5-upgrades-and-stored-shapes)). Extraction caches are keyed so
  that adapter or classification changes refresh them.

**Next.** Put the accuracy table in the release notes ([#246]), fail a release on an unexplained
per-detector precision or recall drop ([#247]), and add a large, labelled C# application monolith to
the corpus ([#248]).

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

## 7. Proven scale with incremental re-mapping

**Today.** `docs/benchmarks.md` measures generated five-language tiers of 10k, 50k and
250k files: at 50k a cold map takes about 50 to 80 seconds, a re-map with nothing changed about
1 and a re-map after ten changed files about 9 to 12; at 250k a cold map took about 20 minutes
on a loaded machine, and after delta projection a re-map there takes 365 s with nothing changed
and 379 s after ten changed files. On real repositories, a 30,800-file C# monolith maps cold in
about 2 minutes, re-maps with no change in under a second and after a one-file edit in 23 to 27
seconds, with a 2.75 GiB store; nopCommerce re-maps after a one-file edit in under 5 seconds.
Extraction, derived facts and the generic, clone and ownership linkers are incremental ([#88],
[#145]); the JavaScript and Python linkers still re-link the whole repository. Releases are gated
on the 10k tier (a no-change re-map at most a tenth of the cold map, a ten-file re-map at most
half); a ten-file re-map still costs more than twice a no-change one.

**Next.** Make a small re-map proportional to the change, with projection and the JavaScript and
Python linkers following only what changed, and shrink the store ([#145], in progress). Map
within a fixed memory budget, benchmarked at 250k ([#249]).

**Production grade.**

- Benchmarks at 50,000, 250,000 and 1,000,000 files across several languages and the semantic
  tier, published with each release: time, memory and store size.
- Re-mapping proportional to the change: a changed file re-links only what depends on it, and
  derived facts (item 5) are updated incrementally. Semantic adapters use their indexers'
  incremental modes.
- Bounded memory: streaming extraction and linking, so a large repository needs no more memory
  than a fixed budget.
- Scoped maps that stay consistent with a full map of the same repository.

**Done when** the published benchmarks include the 250,000-file tier, and re-mapping after a
ten-file change there takes seconds, not minutes.

## Precise guardrails

This is not an item of [#16], so it has no number.

**Today.** Hooks decide by parsed write targets for most commands
([security-model.md](security-model.md)). A narrower fallback still refuses some commands just
for naming `.unknot`. A run applies only to the session and turn that started it ([#32]), and
outside runs only the always-on protections apply. Refusals give a reason, though not always the
rule and the way forward.

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

## Order of work

1. **Trust what exists:** item 5 and the precise guardrails, then the corpus, accuracy and
   migration parts of item 6. Making today's conclusions consistent and measured comes before
   adding new ones. *Done:* derived facts, the consistency suite and its release gate on the
   quick corpus; the pinned corpus with published accuracy; ordered migrations and upgrade tests
   from the last five releases; release channels. *Open:* [#244], [#245], [#246], [#247], [#248].
2. **Depth:** item 1, starting with the SCIP importer (one piece of work, many languages) and
   the dependency-injection and data-access packs, measured on the corpus. *Done:* the SCIP
   importer and brokered indexers ([#54]), the container and ORM rules. *Open:* [#230], [#233].
3. **Breadth:** item 2 (contracts across repositories), then item 3 (evidence connectors).
   *Done:* typed clients and workspace links ([#30]), cross-repository seams in decompose ([#44]),
   file imports with expiry ([#36]). *Open:* [#234], [#236], [#239], [#241].
4. **Organisation:** item 4 (forge approvals, CI verification, shared state). *Done:* draft pull
   requests, code-owner approvals and attested CI verification on GitHub ([#151], [#152], [#153]).
   *Open:* [#242], [#243].
5. **Throughout:** item 7. Every step above adds a benchmark tier, not just a feature. *Done:*
   the 10k, 50k and 250k tiers, delta projection and the 10k release gate. *Open:* [#145], [#249].

## Adding a language or a framework

The same checklist applies at every step:

1. Lexical facts first, so the language is mapped at all, reported at its tier.
2. Syntax tree or semantic facts through an adapter or an index importer, behind the same fact
   schema.
3. Framework packs for its dependency injection, data access, routes and messaging.
4. Fixtures for each pack, and at least one repository in the reference corpus with ground
   truth.
5. A published precision figure before the tier is advertised.

[#16]: https://github.com/QuintinBotes/unknot/issues/16
[#29]: https://github.com/QuintinBotes/unknot/issues/29
[#30]: https://github.com/QuintinBotes/unknot/issues/30
[#32]: https://github.com/QuintinBotes/unknot/issues/32
[#36]: https://github.com/QuintinBotes/unknot/issues/36
[#44]: https://github.com/QuintinBotes/unknot/issues/44
[#54]: https://github.com/QuintinBotes/unknot/issues/54
[#88]: https://github.com/QuintinBotes/unknot/issues/88
[#145]: https://github.com/QuintinBotes/unknot/issues/145
[#151]: https://github.com/QuintinBotes/unknot/issues/151
[#152]: https://github.com/QuintinBotes/unknot/issues/152
[#153]: https://github.com/QuintinBotes/unknot/issues/153
[#154]: https://github.com/QuintinBotes/unknot/issues/154
[#230]: https://github.com/QuintinBotes/unknot/issues/230
[#233]: https://github.com/QuintinBotes/unknot/issues/233
[#234]: https://github.com/QuintinBotes/unknot/issues/234
[#236]: https://github.com/QuintinBotes/unknot/issues/236
[#239]: https://github.com/QuintinBotes/unknot/issues/239
[#241]: https://github.com/QuintinBotes/unknot/issues/241
[#242]: https://github.com/QuintinBotes/unknot/issues/242
[#243]: https://github.com/QuintinBotes/unknot/issues/243
[#244]: https://github.com/QuintinBotes/unknot/issues/244
[#245]: https://github.com/QuintinBotes/unknot/issues/245
[#246]: https://github.com/QuintinBotes/unknot/issues/246
[#247]: https://github.com/QuintinBotes/unknot/issues/247
[#248]: https://github.com/QuintinBotes/unknot/issues/248
[#249]: https://github.com/QuintinBotes/unknot/issues/249
