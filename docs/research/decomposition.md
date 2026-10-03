# Safe Monolith Decomposition: Research Brief for Unknot

Compiled 2026-10-03. Every non-obvious claim is followed by a source URL with publication/last-update year in parentheses. Tags used throughout:

- **[SRC]** = stated in a fetched or searched source (URL given).
- **[HEUR]** = Unknot heuristic proposed here. NOT sourced; must be exposed as configurable and reported as heuristic.
- **[KNOWN-UNVERIFIED]** = well-known in the literature, but I did not retrieve the primary text in this session (access blocked or not fetched). Treat as needing verification before it becomes normative.

Principles mapped throughout: subtract first; patterns conditional; "retain" always valid; evidence + uncertainty reported; every slice has proof obligations + recovery; no production mutation.

---

## 0. Executive conclusions (for the spec author)

1. Default recommendation order must be: **retain -> modularize in place (enforced boundaries) -> extract package/module -> extract service**. Fowler's MonolithFirst and Shopify's modular-monolith experience both support making the in-process boundary the proving ground before any network boundary. (https://martinfowler.com/bliki/MonolithFirst.html, 2015; https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity, 2019)
2. "Extract service" is gated by hard contraindications: shared transactional data, chatty cross-boundary calls, no observability, no contract tests, no independent-deploy need, no owning team. Absent a stated driver (team autonomy, independent scaling, differing availability/security, release cadence), the system should recommend modularize-in-place or retain.
3. Boundary discovery signals are three independent graphs: structural (imports/calls), data (tables read/written, FKs, transactions), evolutionary (co-change). Literature says static+dynamic+evolutionary are rarely combined, which is a gap and an opportunity. (https://arxiv.org/html/2601.23141v1, 2026)
4. Metrics with published formulas exist for structural modularity (SM), interface number (IFN), inter-partition communication (ICP), non-extreme distribution (NED), business-context purity (BCP). Published *thresholds* are almost absent; the only sourced one is NED's "5-20 classes" band. All other thresholds below are [HEUR].
5. Data decomposition is the dominant risk. Newman's patterns (CDC, tracer write, split table, move FK to code) and Microsoft's ETL->CDC->validate->cutover sequence define the safe slices; rollback becomes expensive only once legacy objects are dropped, so "drop legacy objects" is its own, last, deliberately gated slice. (https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig, updated 2026)
6. Frontend: modular frontend monolith (enforced layer/slice boundaries) is the default; micro-frontends require team-autonomy evidence. A 2024 anti-pattern catalog explicitly lists "Micro Frontend as the Goal", "Nano Frontend", "Common Ownership". (https://arxiv.org/html/2411.19472v1, 2024)
7. For route-by-route frontend strangling, a reverse proxy or framework multi-zone rewrite is the lowest-risk integration; hard navigation between zones is the known cost. (https://nextjs.org/docs/app/guides/multi-zones, 2026)
8. Every slice should be expressed as one of a small set of reversible patterns: expand/migrate/contract (parallel change), abstraction + dual implementation (branch by abstraction), routing facade (strangler), shadow comparison (parallel run). (https://martinfowler.com/bliki/ParallelChange.html, 2014; https://martinfowler.com/bliki/BranchByAbstraction.html, 2014)
9. Static boundary checkers are necessary but not sufficient: Shopify reports a package with zero Packwerk violations can still crash in isolation, and no longer treats Packwerk as the primary modularization solution. Unknot must pair static evidence with runtime/test evidence. (https://railsatscale.com/2024-01-26-a-packwerk-retrospective/, 2024)
10. Change coupling is "neither good nor bad"; it must be compared against intended architecture, not blindly minimized. (https://docs.enterprise.codescene.io/versions/4.5.0/guides/technical/change-coupling.html, ~2023)

---

## 1. Source register (with years)

| Source | Year | Used for |
|---|---|---|
| Fowler, MonolithFirst | 2015 | when not to decompose |
| Fowler, StranglerFigApplication | 2024 (orig. 2001/2004) | strangler activities |
| Fowler, ParallelChange | 2014 | expand/migrate/contract |
| Fowler, BranchByAbstraction | 2014 | abstraction-based swap |
| Dehghani, "How to break a Monolith into Microservices" (martinfowler.com) | 2018 | extraction order |
| Jackson, "Micro Frontends" (martinfowler.com) | 2019 | frontend integration options |
| Newman, *Monolith to Microservices* (O'Reilly) | 2019 | DB decomposition patterns (book page only; chapter fetch blocked) |
| Microsoft Azure Architecture Center: Identify microservice boundaries | 2022 (upd. 2025) | boundary validation criteria |
| Microsoft: Strangler Fig | upd. 2026 | facade, DB example, when not to use |
| Microsoft: Anti-Corruption Layer | upd. 2026 | ACL |
| Microsoft: Backends for Frontends | 2025 | BFF |
| AWS Prescriptive Guidance: strangler fig | n.d. (current) | transform/coexist/eliminate |
| Shopify Eng: Deconstructing the Monolith | 2019 | modular monolith |
| Shopify / Rails at Scale: Packwerk retrospective | 2024 | limits of static boundary tools |
| Spring Modulith reference | 2022-2025 | module verification |
| Nx: enforce module boundaries | current | tag constraints |
| Feature-Sliced Design docs | current | frontend layering |
| Next.js multi-zones | 2026 | route-based micro-frontend |
| Module Federation docs | current | runtime sharing |
| Kula/Mono2Micro (Kalia et al.) | 2021 | runtime-trace partitioning, metrics |
| Gysel et al., Service Cutter (ESOCC) | 2016 | coupling criteria, graph clustering |
| Comparative evaluation of decomposition frameworks (arXiv 2601.23141) | 2026 | SM/IFN/ICP/NED, HDBScan result |
| Micro-frontend anti-pattern catalog (arXiv 2411.19472, ICSE 2025) | 2024 | frontend anti-patterns |
| CodeScene docs (Tornhill) | ~2023 | change coupling |
| GitHub Scientist coverage (SD Times) | 2016 | parallel run |
| Prime Video monitoring write-up (secondary coverage) | 2023 | when microservices hurt |

---

## 2. Part A: Backend monolith decomposition

### 2.1 When NOT to decompose (and the modular-monolith alternative)

**Source claims**
- Nearly all successful microservice stories began as a monolith that grew too big; microservice-first systems often ended in trouble. Boundaries are hard to get right upfront and cheaper to move inside a monolith. Recommended: a carefully designed modular monolith, extract at the edges, coarse-grained first. Applies strongly unless the team has prior microservice experience. (https://martinfowler.com/bliki/MonolithFirst.html, 2015)
- Shopify chose a modular monolith: single deployable, "strictly enforced boundaries between different domains"; rejected microservices for multiple pipelines, per-service infrastructure overhead, network latency, and coordination cost for large refactors. They regrouped ~6,000 classes into domain components and built "Wedge" to count boundary violations via tracepoints in CI. (https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity, 2019)
- Microsoft's strangler fig page lists explicit non-fit conditions: requests cannot be intercepted; no access to legacy source code; small system where replacing whole is simple; need to decommission quickly. (https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig, 2026)
- Reverse case: Prime Video's audio/video monitoring moved from distributed serverless microservices back to a monolith, reporting >90% infrastructure cost reduction (secondary coverage; primary was the Prime Video tech blog, not fetched). (https://www.networkworld.com/article/3697737/6-lessons-from-the-amazon-prime-video-serverless-vs-monolith-flap.html, 2023). Use as an illustration that the cost of a network hop is workload-dependent, not as a general rule.
- Azure boundary guidance: if splitting two services makes them chatty, "it might be a symptom that these functions belong in the same service". Data-consistency needs sometimes justify keeping functionality together. (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022)

**Modular-monolith enforcement tooling (evidence the alternative is practical)**
- Packwerk: dependency, privacy (public API only), visibility checks, plus experimental layer/architecture checker. (https://shopify.engineering/enforcing-modularity-rails-apps-packwerk, ~2020)
- Spring Modulith `ApplicationModules.verify()`: module graph must be a DAG; access only through module API package; optional `allowedDependencies`; recommends application events instead of cross-module bean dependencies. (https://docs.spring.io/spring-modulith/reference/2.0/verification.html, 2025)
- Nx tag-based constraints (`scope:shared` may depend only on `scope:shared`, etc.), enforced via ESLint-type rules. (https://nx.dev/docs/features/enforce-module-boundaries, current)

**Caveat from practice**: Packwerk retrospective: static analysis cannot see dynamically loaded constants; gives no guidance on resolving violations; "a package with zero violations may still crash when run in isolation"; developers group by naming rather than dependency reality; no longer seen as a primary modularization solution. (https://railsatscale.com/2024-01-26-a-packwerk-retrospective/, 2024)

**Unknot rule candidates (derived)**
- R-NOEXTRACT-1 [HEUR derived from sources]: If no independent-deployment/scaling/ownership driver is recorded, service extraction is not offered; offer modularize-in-place or retain.
- R-NOEXTRACT-2: If the candidate boundary has cross-boundary write transactions on shared tables, block extraction at the service level (see 2.5).
- Retain is the correct output when: the module is cohesive, low churn, single owner, no measured pain. [HEUR]

### 2.2 Boundary discovery

**Inputs available in the Unknot graph and published analogues**

| Signal | Unknot graph source | Published analogue |
|---|---|---|
| Structural coupling | imports, calls | static class dependency graph (Mono2Micro "natural seams": minimal class containment dependencies) (https://www.ibm.com/docs/SS7H9Y/doc/m2m_1_overview.html, ~2021) |
| Dynamic / business-logic coupling | runtime traces | Mono2Micro "business logic partitioning" from use-case runtime traces, features DCR/ICR/DCP/ICP (https://ar5iv.labs.arxiv.org/html/2107.09698, 2021) |
| Data affinity | tables read/written | Service Cutter criteria in the Cohesiveness/Constraints categories (16 criteria in 4 groups: Cohesiveness, Compatibility, Constraints, Communications) (https://hal.archives-ouvertes.fr/hal-01638590, 2016) |
| Evolutionary coupling | git co-change | CodeScene temporal/change coupling: degree of coupling, average revisions, max changeset size (https://docs.enterprise.codescene.io/versions/3.1.0/guides/technical/temporal-coupling.html, ~2021) |
| Team ownership | owners | Team Topologies / Conway (see 2.2.3) |
| Domain semantics | names, docs | DDD bounded contexts; aggregates as microservice candidates (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022) |

#### 2.2.1 DDD-based candidate generation (Microsoft)
1. Start with a bounded context; a service should not span more than one.
2. Aggregates are good candidates: derived from business needs, high functional cohesion, persistence boundary, loosely coupled.
3. Domain services (stateless cross-aggregate operations) can be candidates.
4. Then apply non-functional factors (team size, data types, tech, scale, availability, security) which may split or merge.
5. Validate: single responsibility; no chatty calls; buildable by a small team; no co-deployment interdependencies; independent evolution; boundaries avoid data-consistency problems. When unsure, go coarse-grained; splitting later is easier than merging. (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022)
Unknot: these six validation criteria become the pass/fail checklist on every candidate (see 6.4).

#### 2.2.2 Change coupling (Tornhill / CodeScene)
- Two modules are temporally coupled if modified in the same commit, by the same programmer within a window, or referencing the same ticket ID. Metrics: Degree of Coupling (how often files change together, example "74% of the time"), Average Revisions (filters couples that pass a minimum, to avoid files merely created together), and a max-changeset threshold to avoid distortion from large reorganizations. (https://docs.enterprise.codescene.io/versions/2.7.0/guides/technical/temporal-coupling.html, ~2020)
- CodeScene's example configuration: minimum commits 10, max changeset size 50 files; the docs say defaults are "typically good enough" but do not publish fixed default numbers for degree of coupling. (https://docs.enterprise.codescene.io/versions/3.1.0/guides/technical/temporal-coupling.html, ~2021)
- Interpretation rule: "Change coupling in itself is neither good nor bad"; compare actual logical dependencies with architectural principles. (https://docs.enterprise.codescene.io/versions/4.5.0/guides/technical/change-coupling.html, ~2023)
- Unknot defaults [HEUR]: ignore commits touching >50 files (matches CodeScene's example, not a mandated default); require >=10 shared commits; flag cross-boundary pairs with degree >=50%; always attach commit counts and time window as evidence. Cross-boundary co-change between a candidate and the rest is a *contraindication* for extraction (the extracted unit would need lockstep releases), whereas intra-boundary co-change is expected.
- Co-change across repositories/time-windows ("logical changesets", ticket IDs) is supported by CodeScene with lower thresholds; useful when squashed commits hide coupling. (https://docs.enterprise.codescene.io/versions/2.7.0/guides/technical/temporal-coupling.html, ~2020)

#### 2.2.3 Team ownership and Conway
- Conway's law and cognitive load underpin Team Topologies; teams should be sized to cognitive load, stream-aligned teams preferred, and the inverse Conway maneuver designs architecture first then aligns team boundaries. (Team Topologies, Skelton and Pais, 2019; secondary summary: https://blog.octo.com/how-to-deal-with-an-inverse-conway-maneuver-a-talk-by-romain-vailleux-at-duck-conf-2021/, 2021) [KNOWN-UNVERIFIED for primary text]
- Microsoft: team structure influences whether to mediate between contexts; if the other context's team is hard to reach, an intermediary can mitigate cross-team communication cost. (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022)
- Unknot: compute Ownership Alignment (see 6.2). A candidate boundary owned by >1 team is a contraindication for service extraction (shared ownership = coordination) but may favour modularize-in-place.

#### 2.2.4 Automated clustering (algorithms)
- Service Cutter: represents coupling info as an undirected weighted graph, finds and scores dense clusters, uses 16 coupling criteria; validated on two sample apps with "most (but not all)" scenarios giving appropriate cuts. (https://hal.archives-ouvertes.fr/hal-01638590, 2016) Its clustering algorithms (Girvan-Newman, epidemic label propagation) and criterion weighting priorities are [KNOWN-UNVERIFIED]; the fetch of the paper was blocked.
- Mono2Micro: hierarchical clustering over runtime-call features from business use cases; two outputs (business-logic partitioning vs natural-seams partitioning); outperformed baselines on BCP and NED, competitive on ICP/IFN, weaker on SM vs Bunch/MEM, and "high SM correlated with extreme distributions". (https://ar5iv.labs.arxiv.org/html/2107.09698, 2021)
- 2026 comparative evaluation across 4 benchmark systems (JPetStore, AcmeAir, DayTrader, Plants): HDBScan gave "most consistently balanced decompositions"; a-BMSC and Mono2Micro second tier. A systematic review found no methods combining static, dynamic, and evolutionary data and no standard metrics/datasets/baselines. (https://arxiv.org/html/2601.23141v1, 2026; review of 35 papers: https://pure.ul.ie/en/publications/decomposition-of-monolith-applications-into-microservices-archite/, ~2023)
- Louvain/Leiden: maximize modularity; Leiden guarantees well-connected communities whereas Louvain may return internally disconnected ones. Community detection is already used for decomposition and package refactoring. (https://arxiv.org/pdf/2102.04710, 2021; Leiden: Traag et al., Sci. Reports 2019 [KNOWN-UNVERIFIED]; networkx impl: https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.community.leiden.leiden_partitions.html)
- Unknot recommendation [HEUR]: run Leiden (resolution sweep) on a composite weighted graph (6.1), plus an alternative density-based result (HDBScan on embedding of the same adjacency) and report only clusters that are stable across algorithms and across resolution; report instability as uncertainty rather than choosing silently. Algorithms propose candidates; they never authorize a slice. Cluster stability as a confidence signal is [HEUR].

### 2.3 Extraction order

**Sourced guidance (Dehghani, 2018)**: start with simple, decoupled edge services needing no client changes to build operational muscle; prefer candidates that won't depend back on the monolith (reverse dependencies block independent release); extract "sticky" leaky concepts (e.g., web session) early; focus on high-change, high-value capabilities identified via commit analysis and roadmap; most legacy code should be rewritten rather than lifted unless it carries high IP and clear domain concepts; start macro then go micro; each step must include decoupling, redirecting all consumers, and retiring old paths. (https://martinfowler.com/articles/break-monolith-into-microservices.html, 2018)

**Microsoft strangler guidance**: high-ROI replacements before low-ROI ones is a cost advantage of the pattern. (https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig, 2026)

**"By capability, not by layer"**: the aggregate/bounded-context approach (2.2.1) implies vertical slices; Microsoft ties services to business aggregates, not "technical concerns such as data access or messaging". (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022) Entity services/technical-layer services are anti-patterns (2.7).

**Unknot ordering heuristic [HEUR]**: rank by value-at-risk-adjusted ease:
`priority = (churn_share * pain_evidence) / (1 + inbound_reverse_deps + cross_boundary_data_edges + unowned_flag)`; surface the top 3 but always include "retain" with its own score, and present the least-coupled edge candidate as the "first practice slice" if no operational maturity evidence (CI/CD, tracing) exists. This formula is not published.

### 2.4 Data decomposition patterns

Newman's chapter 4 (database decomposition) covers patterns including Change Data Capture, Tracer Write, Split Table, Move Foreign-Key Relationship to Code (confirmed via search summary of the book's chapter listing: https://www.oreilly.com/library/view/monolith-to-microservices/9781492047834/ch04.html, 2019; direct fetch returned 403). The list below combines that with my knowledge of the book [KNOWN-UNVERIFIED for items not in the search summary].

| Pattern | What it does | Favoring signals | Contraindications | Reversibility |
|---|---|---|---|---|
| Shared database (kept deliberately) | Several modules/services share schema | static read-only reference data; early stage | write contention, schema change coordination | n/a (status quo) |
| Database view | Expose a read-only view as the contract; hide table structure | module needs read-only access to another's data | needs writes; view engine/perf limits | high (drop view) |
| Database wrapping service | Put a service in front of the schema as the sole access path | schema too tangled to split now | adds a hop | high |
| Database-as-a-service interface | Read-only reporting DB populated from owner | reporting/read heavy consumers | consumers need current writes | high |
| Change data ownership | Move ownership of a table to the service that logically owns it; other side calls API | clear owner by write-set | many writers across boundary | medium |
| Synchronize data in application | Dual-write/read then switch; migrate with both stores in sync | bounded data volume | no reconciliation tooling | medium; reconcile |
| Tracer write | New service becomes source of truth incrementally for one entity/slice while old remains | need low-risk incremental ownership shift | no consistent sync mechanism | medium |
| Split table | Split table by owner columns | one table serving two domains | single-row cross-domain transaction | low after contraction |
| Move FK relationship to code | Drop DB FK across boundary; enforce referential integrity via service calls/events | FK crosses boundary | joins on hot path; need atomic integrity | low after FK drop |
| CDC / outbox | Stream changes from legacy DB log/outbox to new store | legacy unmodifiable; need sync | log not accessible; high write volume without ordering guarantees | high until cutover |

Sources for the facts above that are directly sourced: Newman pattern names (O'Reilly listing, 2019); FK-to-code semantic (queries joining the tables must be reimplemented as explicit inter-service calls) from the search summary of the book (https://www.oreilly.com/library/view/monolith-to-microservices/9781492047834/ch04.html, 2019).

**Microsoft's strangler-for-database sequence (sourced, 2026)**: (1) new service handles requests but still reads/writes the monolith DB for its domain tables; (2) introduce isolated domain DB, ETL initial load, CDC sync; legacy still reads/writes monolith DB, new system writes to domain DB; validate consistency before cutover; (3) domain DB becomes system of record; remove legacy tables/procs/sync. Rollback is possible during phase 2 and start of phase 3; after removing legacy objects, rollback requires restoring objects and replaying changes, "significantly increases effort and risk", so treat removal as a deliberate final step. For database-centric legacy (logic in stored procedures), triggers or CDC can emit messages to new services without app changes. (https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig, 2026)

**Unknot data-slice ladder [HEUR, composed from the above]**
1. Make ownership explicit (annotate tables with owner from write-set).
2. Add read-only view / wrapping interface for cross-boundary reads.
3. Replace cross-boundary joins by API/in-process calls (move FK to code) behind a flag.
4. Introduce owner-side data store alongside; CDC/outbox sync; reconcile.
5. Flip reads (shadow compare), then writes (tracer write).
6. Observe through a soak period.
7. Final, separate, human-gated slice: drop legacy tables/columns (irreversible; label as such).
Slice 7 must never be bundled with another slice. "No production mutation" applies: Unknot produces migration scripts, reconciliation queries and runbooks for review; it does not run them against production.

### 2.5 Transactional boundaries
- Azure guidance: boundaries should avoid data-consistency problems; strong consistency is sometimes a reason to group functionality, but eventual consistency strategies often make decomposition worthwhile. (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022)
- Unknot signal: count of transactions (from traces, or from static analysis of transaction scopes) that write tables owned by >1 candidate = **cross-boundary transaction count (CBT)**. CBT>0 on a hot path blocks service extraction until a saga/outbox design is explicit. Threshold "any >0 blocks service extraction; advisory for in-process modularization" is [HEUR].

### 2.6 Migration patterns

| Pattern | Definition (source) | Notes for Unknot |
|---|---|---|
| Strangler fig w/ routing facade | Facade (proxy) routes requests to legacy or new; shift incrementally; decommission legacy; remove facade. Four phases in Microsoft doc. AWS: transform, coexist, eliminate; HTTP proxy at the monolith perimeter; keep monolith for rollback. (https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig, 2026; https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-decomposing-monoliths/strangler-fig.md, current) | Facade must not become SPOF/bottleneck; keep it with the migration; plan reverse calls (legacy needs new) via ACL. Fowler (2024): four activities: clarify outcomes, identify component boundaries, deliver incrementally, enable organizational change; transitional architecture is deliberate waste. (https://martinfowler.com/bliki/StranglerFigApplication.html, 2024) |
| Branch by abstraction | Abstraction layer; migrate clients onto it; build new implementation (optionally flagged); swap; cleanup. (https://martinfowler.com/bliki/BranchByAbstraction.html, 2014) | Use when the seam is *inside* the process (no routable request). |
| Parallel change (expand/migrate/contract) | Expand interface to support old+new; migrate clients incrementally; contract by removing old. Migrate is longest for external clients. (https://martinfowler.com/bliki/ParallelChange.html, 2014) | Used for schema, API, and event-contract changes. |
| Parallel run / shadow (Scientist) | Experiment wrapper: control (old) result returned, candidate (new) run, results compared; order randomized; used by GitHub for permission code rewrite, search cluster switch, query optimization. (https://sdtimes.com/code/github-library-allows-developers-to-rewrite-critical-code/, 2016) | Side-effects: candidate must be side-effect free or stubbed [HEUR]. Prod mutation caution: Unknot only generates the experiment scaffolding. |
| Dark launch / feature flags / canary | Feature flags are mentioned by Fowler as an option during branch-by-abstraction; Next.js docs show flag-based routing during migration via proxy. (https://nextjs.org/docs/app/guides/multi-zones, 2026) Canary/dark launch definitions: [KNOWN-UNVERIFIED] general practice. | Flag = recovery lever; require flag removal slice (contract). |
| Anti-corruption layer | Translation layer so one subsystem's semantics don't leak into another; adds latency and an extra component; keep translation-only (no business rules); input validation; correlation IDs; decide if permanent or retired. Not suitable when systems share semantics. (https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer, 2026) | Needed when new code must call legacy or legacy must call new during coexistence. |

### 2.7 Safety: proof obligations (generic)
Published support for each obligation:
- **Observability before split**: ACL doc calls for correlation IDs and structured logging; strangler doc requires the facade not to be a bottleneck/SPOF (monitoring implied). (above URLs)
- **Contract tests**: Pact (consumer-driven contracts) [KNOWN-UNVERIFIED in this session; https://docs.pact.io/].
- **Characterization tests**: Feathers, *Working Effectively with Legacy Code*, 2004 [KNOWN-UNVERIFIED]. Branch-by-abstraction explicitly includes improving test coverage while migrating clients. (https://martinfowler.com/bliki/BranchByAbstraction.html, 2014)
- **Parallel-run equivalence**: Scientist (2016).
- **Idempotency & reconciliation**: required for CDC/dual-write; Microsoft says validate consistency between both DBs before cutover. (https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig, 2026)
- **Rollback**: see 2.4 on rollback cost; AWS keeps monolith as rollback during coexist. 

### 2.8 Backend anti-patterns (detectable signals)

| Anti-pattern | Signal Unknot can compute | Source |
|---|---|---|
| Distributed monolith | services require co-deployment; cross-boundary co-change high; synchronous call cycles | Azure criterion "no interdependencies that require two or more services to be deployed together" (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022) |
| Chatty calls | calls per request across boundary (ICP/runtime-call share) | same; ICP metric (https://arxiv.org/html/2601.23141v1, 2026) |
| Nanoservices | many tiny candidates; NED outside 5-20 classes band; interface count low-value | NED band (https://arxiv.org/html/2601.23141v1, 2026); frontend analogue "Nano Frontend" (https://arxiv.org/html/2411.19472v1, 2024) |
| Shared-DB coupling | >1 candidate writes same table | Newman database patterns (2019); Microsoft DB example |
| Entity services | candidate = one table/entity CRUD with no behaviour; technical layer split | Microsoft: aggregates from business requirements not technical concerns (2022) |
| Cyclic dependencies | SCC in module graph | Spring Modulith requires DAG (2025) |

---

## 3. Part B: Frontend monolith decomposition

### 3.1 Modular frontend monolith vs micro-frontends

**Modular frontend monolith (default)**
- Feature-Sliced Design: layers App -> Processes -> Pages -> Widgets -> Features -> Entities -> Shared; slices by business domain; segments (ui, api, model, lib, config); rule: modules may import only from layers strictly below; same-layer cross-slice imports prevented. Not suitable for backend, libraries, or when the architecture "doesn't cause trouble". (https://feature-sliced.design/docs/get-started/overview, current)
- Nx tags enforce allowed dependency directions via lint rules; language-agnostic conformance is a paid tier. (https://nx.dev/docs/features/enforce-module-boundaries, current)
- Other enforcers: eslint-plugin-boundaries, dependency-cruiser [KNOWN-UNVERIFIED; names only].

**Micro-frontends**
- Fowler/Jackson (2019) integration options: server-side template composition (simple, needs caching); build-time packages (lockstep release, "not recommended"); iframes (strong isolation, awkward routing/deep-linking/responsive); runtime JavaScript (most flexible, the author's default); Web Components (standards-aligned, more ceremony). (https://martinfowler.com/articles/micro-frontends.html, 2019)
- Next.js Multi-Zones: separate apps each serving a path set under one domain; same-zone navigation is soft, cross-zone is hard navigation (full page load); paths must be unique per zone; use `<a>` not `<Link>` across zones; `assetPrefix` avoids static-asset collisions; routing via rewrites (lowest latency) or proxy with feature flags for migrations; zones may use different frameworks; share code via monorepo or npm packages; Server Actions need `allowedOrigins`. (https://nextjs.org/docs/app/guides/multi-zones, 2026)
- Module Federation (v2): decentralize JavaScript apps and share code across apps; dependency reuse; runtime plugin system and manifest. (https://module-federation.io/guide/start/index.html, current). Singleton/version negotiation details were not available in the fetched page [KNOWN-UNVERIFIED].
- single-spa: not retrieved (redirect not followed). [KNOWN-UNVERIFIED]

### 3.2 Split strategies
- **Vertical (by route/domain)**: one team owns a route set end-to-end; fits multi-zones and reverse-proxy strangling. Pages frequently visited together should be in the same zone to avoid hard navigations. (https://nextjs.org/docs/app/guides/multi-zones, 2026)
- **Horizontal (by fragment on one page)**: multiple MFEs compose one screen; creates the "Hub-like Dependency" risk (single screen integrating many MFEs = central point of failure) and "Knot" risk. (https://arxiv.org/html/2411.19472v1, 2024)
- Unknot default [HEUR]: only propose vertical splits; horizontal fragments need explicit justification (independent owners for fragments on the same page).

### 3.3 Integration options decision matrix

| Option | Favors | Costs |
|---|---|---|
| Build-time packages | shared design-system/components; same release train | lockstep releases (Jackson 2019) |
| Server-side composition / ESI | content-heavy, cacheable fragments | caching complexity (Jackson 2019) |
| Edge composition | latency-sensitive routing | operational complexity [KNOWN-UNVERIFIED] |
| Runtime JS (Module Federation / Native Federation) | independent deploys, tight integration | shared-dependency negotiation, version skew [KNOWN-UNVERIFIED in detail] |
| Web Components | framework heterogeneity | ceremony (Jackson 2019) |
| iframes | hard isolation (third party/legacy) | routing, deep link, a11y, responsive (Jackson 2019) |
| Multi-zone / reverse proxy routes | route-level strangling | hard navigation, shared state/auth across origins (Next.js 2026) |

### 3.4 Trade-offs Unknot must check
- **Bundle duplication / shared singletons**: React/ReactDOM duplicated per MFE; example figures ~45 KB + ~140 KB gzipped each, 400-500 KB redundant across three MFEs (blog-grade source, treat as illustrative): https://reliasoftware.com/blog/react-micro-frontend-best-practices (undated). Signal: sum of per-route bundle sizes vs baseline; budget regression gate [HEUR thresholds].
- **Design system / accessibility consistency**: shared package versioning; a11y regression tests per route [HEUR].
- **Cross-app state, auth/session**: with multi-zones on one domain, cookies can be shared; Server Actions need allowed origins. (Next.js 2026) Session = a "sticky" concept to isolate early (Dehghani 2018 analogue).
- **Routing/deep links**: iframes problematic; multi-zones hard navigation. 
- **Performance budgets**: Core Web Vitals per route before/after [KNOWN-UNVERIFIED as a standard; HEUR as gate].

### 3.5 Strangling a frontend route by route
Sequence (derived from strangler doc and Next.js multi-zones):
1. Put reverse proxy/rewrite layer in front of the existing frontend (identity routing, no behavior change). Verify parity.
2. Stand up new app for one low-coupling route; assets prefixed to avoid collisions.
3. Route the path to the new app by rewrite; use a feature flag in proxy for percentage/cohort rollout. (https://nextjs.org/docs/app/guides/multi-zones, 2026)
4. Compare via visual/functional parity tests; rollback = flip the route back.
5. Retire the old route code (contract).

### 3.6 When micro-frontends are an anti-pattern
From the 2024 ICSE-track catalog of 12 anti-patterns: Cyclic Dependency, Knot, Hub-like Dependency, Nano Frontend, Mega Frontend, Micro Frontend Greedy (no clear domain boundaries), No CI/CD, No Versioning, Lack of Skeleton, Common Ownership (one team owns all MFEs), Golden Hammer, **Micro Frontend as the Goal** (adopting without sufficient complexity or team capacity). (https://arxiv.org/html/2411.19472v1, 2024) Practitioner heuristic "only when 5+ teams or daily deploys justify it" (https://commerce.nearform.com/blog/2024/when-and-why-to-use-micro-frontend-architecture, 2024) is an opinion, not a research threshold; Unknot should treat team count as evidence, not a gate [HEUR].
Detectable signals: single owner across all MFEs; shared mutable global state across MFEs; version lockstep (all MFEs deploy together in CI history); MFE import cycles.

### 3.7 BFF
Microsoft: BFF = separate backend per frontend interface; suitable when a shared backend needs heavy customization for several clients or a different language fits one UI; not suitable if interfaces make the same requests or only one interface exists; consider GraphQL with frontend resolvers or an API gateway as alternatives; keep only client-specific logic; code duplication is a trade-off; extra hop = latency. (https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends, 2025) Original: Newman, https://samnewman.io/patterns/architectural/bff/ (page not fetched; 404 on my catalog attempt).

---

## 4. Part C: Automatic pattern selection

### 4.1 Candidate-boundary scoring metrics

All formulas below use a partition P = {C1..Cm} of modules (files/classes) in a candidate decomposition; G = weighted graph.

**Published metrics**

| Metric | Formula (source) | Direction | Threshold |
|---|---|---|---|
| Structural modularity SM | `SM = (1/M) Σ scoh_i − (1/(M(M−1)/2)) Σ scop_ij` (cohesion avg minus pairwise coupling avg) (https://arxiv.org/html/2601.23141v1, 2026; https://ar5iv.labs.arxiv.org/html/2107.09698, 2021) | higher better | none published |
| Interface number IFN | `IFN = (1/N) Σ ifn_i` average interfaces per service | lower better | none published |
| Inter-partition communication ICP | `icp_ij = c_ij / Σ c_ij` share of runtime calls between partitions | lower better | none published |
| Non-extreme distribution NED | proportion of services outside "non-extreme" size; non-extreme = 5-20 classes (2026 paper); lower is better in the 2021 definition (NED = 1 − Σ n_k/|N|) | lower better | 5-20 classes band (sourced) |
| Business context purity BCP | average entropy of business use cases per partition | lower better | none |
| Newman-Girvan modularity Q | `Q = (1/2m) Σ_ij [A_ij − k_i k_j/2m] δ(c_i,c_j)` (standard; Newman and Girvan 2004) [KNOWN-UNVERIFIED in session] | higher better | none; Q>0.3 as "significant" is folklore, unsourced here |
Note the 2026 paper's NED sentence is internally inconsistent in the extracted text (defined as `1−Σn_k/|N|` with 5-20 classes non-extreme); flag when implementing and define Unknot's own: `NED_u = fraction of partitions with size outside [5,20] modules`, lower is better, with band scaled to repo granularity [HEUR]. Mono2Micro found "high SM correlated with extreme distributions", so SM must not be optimized alone. (https://ar5iv.labs.arxiv.org/html/2107.09698, 2021)

**Unknot composite (all [HEUR]; weights NOT published)**
- Edge weight: `w(a,b) = α·S(a,b) + β·D(a,b) + γ·E(a,b) + δ·M(a,b)` with S structural (import/call count, normalized), D data affinity (shared tables, weighted write>read), E evolutionary (co-change degree, after changeset-size filter), M semantic (name/docstring/domain-term similarity).
- Suggested starting weights: α=0.35, β=0.30, γ=0.25, δ=0.10. Not published anywhere I found; Service Cutter instead lets users set per-criterion priorities and 16 criteria (Gysel 2016); Mono2Micro uses runtime-call features only (2021). Therefore: expose weights, run a sensitivity sweep (±50%) and report the boundary as "robust" only if membership changes for <10% of nodes [HEUR].
- Cohesion of a cluster: `coh(C) = internal_weight(C) / (internal_weight(C) + external_weight(C))` (conductance complement). Coupling between clusters: `cpl(Ci,Cj)= w(Ci,Cj)/min(vol(Ci),vol(Cj))`.
- Cross-boundary transactions CBT, cross-boundary joins CBJ (queries joining tables owned by different clusters), shared-table writers SW (clusters writing the same table), interface count IFN (distinct public entry points consumed from outside), call chattiness CC (cross-boundary calls per request from traces, p95), co-change leak CCL (share of commits touching candidate and non-candidate), ownership alignment OA: `OA = max_t (files_owned_by_team_t ∩ C)/|C|` weighted by commits.
- Hard-gate thresholds (all [HEUR]): service extraction requires CBT_hot = 0 (or saga plan), SW = 0 after data ladder step 3, CC p95 ≤ ~5 cross-boundary calls per user request, CCL ≤ 0.2 over trailing 6 months, OA ≥ 0.8, and candidate size within 5-20 modules (the only sourced numeric, from the NED definition, and it is about classes in benchmark Java apps, not a universal guideline).

### 4.2 Decision table

Legend: Signals favor (F); Contraindications (X, hard unless marked soft); Evidence required (E); First safe slice (S); Proof obligations (P); Recovery (R). All numeric thresholds are [HEUR] unless a source is given.

#### T0. Retain / do nothing
- F: high cohesion (low external weight share), low churn, single owner, no incident/latency/merge-conflict pain, no stated driver; boundary-scores unstable across algorithms; Prime-Video-style case where network cost dominates.
- X: none (always valid). It must outrank others when the best candidate's expected benefit < slice cost + risk.
- E: score card showing why no candidate beats status quo; metric deltas expected from alternatives.
- S: none; optionally "add boundary monitoring" (CI report) only.
- P: n/a. R: n/a.
- Source basis: MonolithFirst (2015); FSD: adopt only when "current architecture is causing trouble" (current).

#### T1. Modularize in place / modular monolith
- F: cycles in module graph (SCC), cross-module private access, high structural coupling but strong domain cohesion; co-change within teams; shared DB acceptable; need clearer ownership; services contraindicated (below).
- X (hard): none by structure; soft: no test coverage -> first add characterization tests.
- E: import graph, SCC list, violation counts (Wedge/Packwerk-style), owners.
- S: add enforcement in warn-only mode with a baseline of existing violations ("todo file"); then block new violations. (Packwerk practice: CI prevents regression of decoupling progress, 2024.)
- P: build+tests green; violation count monotonically non-increasing; no runtime-behavior change; DAG at module level (Spring Modulith 2025).
- R: revert config commit; baseline unchanged. Beware static blind spots: add runtime check (dynamic loading, reflection) per Packwerk retrospective.

#### T2. Extract module / package (still one deploy)
- F: candidate with public surface <= small API, low CCL, single owner, reusable by multiple consumers; need independent versioning/testing, not independent deploy.
- X: cyclic dependency to rest; shared mutable global state; write-sharing on tables (resolve first).
- E: interface count, consumer list, dependency direction.
- S: move code behind a facade interface (branch by abstraction step 1); keep old paths delegating.
- P: all consumers go through the facade (grep/graph proof); tests; dependency direction lint.
- R: delegate back/revert move; facade stays.

#### T3. Extract service via strangler fig
- F: stated independent-deploy/scale/availability/security driver; high-churn+high-value capability (Dehghani 2018); aggregate with persistence boundary; ownership OA high; observability and CI/CD present; request interception possible (HTTP/queue entry).
- X (hard): requests cannot be intercepted; no source access to legacy; CBT_hot>0 without saga design; shared-table writers; >N reverse calls from new service to monolith (Dehghani: reverse deps prohibit independent release); no tracing; ownership unclear; a reason-less extraction ("goal as the service"); system small enough to replace whole (Microsoft 2026).
- E: traces for call counts and latency, data ownership map, co-change leak, team map, SLO baselines.
- S: identity-route facade with 0% traffic -> shadow (parallel run) -> 1% canary; or, for data-light capability, read-only endpoint first.
- P: contract tests (consumer-driven), parallel-run diff rate under agreed epsilon with sampled diffs reviewed, p95 latency delta within budget, error budget unchanged, idempotent handlers, reconciliation job for any replicated data.
- R: flip route weight to 0 (monolith retained untouched until contraction slice); data: stay on dual-write/CDC until validated; drop legacy only in final gated slice.

#### T4. Branch by abstraction
- F: seam inside the process (no routable request); replacing a library/data layer/internal subsystem; many internal callers.
- X: no stable interface can be defined (fan-in high with divergent usage), no tests.
- E: caller list, usage variance, call graph.
- S: introduce interface + adapter delegating to the existing implementation; migrate callers one batch at a time.
- P: characterization tests green on both implementations; flag default = old.
- R: toggle flag/old supplier; contraction is separate.
- Source: https://martinfowler.com/bliki/BranchByAbstraction.html (2014).

#### T5. Parallel change (expand/migrate/contract)
- F: changing a signature, schema column, event payload, or API with many/external consumers; need zero-downtime.
- X: consumers unknown or unreachable (then keep expand indefinitely and report as uncertainty); cannot run old+new simultaneously.
- E: consumer inventory (graph in-edges, API gateway logs, schema usage).
- S: expand only (additive change).
- P: old consumers unaffected (tests/contract), telemetry shows old path usage trending to zero before contract.
- R: contract not executed; expand is additive and can be removed.
- Source: https://martinfowler.com/bliki/ParallelChange.html (2014).

#### T6. Database decomposition steps
- F: shared tables written by multiple candidates; cross-boundary joins; need data ownership before service extraction.
- X: cross-boundary multi-table transactions with strict atomicity and no saga option; no reconciliation tooling; no backup/restore proven; absent DB observability.
- E: table x module read/write matrix, FK graph crossing boundary, transaction scopes.
- S: step 1-2 of ladder (ownership annotation, read-only view/wrapper) - no data moves.
- P: reconciliation query shows 0 diff; query plans/latency checked for replaced joins; idempotent sync.
- R: drop view / stop sync; before legacy drop, switch back; after drop, restore+replay (costly: Microsoft 2026).

#### T7. Micro-frontend by route (vertical)
- F: >=2 teams owning disjoint route sets; independent release need; routes rarely navigated between (low cross-route navigation frequency); different framework/upgrade cadence per area; build time pain.
- X: heavy cross-route shared state; frequent cross-zone navigation (hard navigation cost); single owner (Common Ownership anti-pattern); no CI/CD per app; session/auth not shareable; perf budget can't absorb duplicated runtime.
- E: route graph, navigation transition counts (analytics), ownership per route directory, bundle composition, build-time stats.
- S: reverse-proxy identity routing, then one low-coupling route.
- P: visual/functional parity, a11y checks, Web-Vitals budget, auth continuity test.
- R: rewrite rule back to the monolith (instant).
- Sources: Next.js (2026); anti-patterns (2024).

#### T8. Frontend modular monolith
- F: single deploy acceptable; feature folders tangled; imports cross features; design-system drift; one or few teams.
- X: strong need for independent deploys across teams (then T7); not frontend (FSD n/a for libraries).
- E: import graph per layer, cycle list, feature ownership.
- S: introduce layer/slice lint rules in warn mode with baseline.
- P: no cycles; lint passes; bundle size unchanged +-X%.
- R: revert lint config.
- Sources: FSD (current); Nx (current).

#### T9. BFF
- F: multiple distinct clients (web/mobile) with divergent data shapes; shared backend churn from competing frontends; chatty client-side aggregation; frontend team wants release autonomy.
- X: single client; clients make same requests; GraphQL with frontend resolvers already; extra hop unaffordable for latency SLO.
- E: client x endpoint matrix, response-shape variance, aggregated call counts per screen.
- S: one read-only BFF endpoint for one screen proxying existing APIs.
- P: response parity with existing composition, p95 delta, auth propagation.
- R: client flag back to direct calls.
- Source: Microsoft BFF (2025).

### 4.3 Selection algorithm (proposed)

1. Compute candidates (Leiden + stability), plus "retain" baseline.
2. For each candidate compute metric vector (4.1) with confidence (data completeness: traces present? git depth? owners known?).
3. Apply hard contraindications per treatment; discard.
4. Rank remaining treatments by *least invasive that satisfies a stated driver*: retain < T1 < T2/T4/T5 < T6 < T8/T9 < T7 < T3. [HEUR; reflects "subtract first" and MonolithFirst.]
5. Emit one slice, its proof obligations (from the table), a recovery plan and the uncertainty statement: which signals are missing (e.g., "no runtime traces: dynamic coupling unknown; ICP not computable").
6. Never recommend a pattern because it exists: each recommendation must cite at least one *favoring signal with measured value* and list contraindications checked.

### 4.4 Evidence completeness and uncertainty
- Static only: label confidence "low" for service extraction (Packwerk retrospective: static analysis misses dynamic constructs; zero violations does not imply runtime isolation, 2024).
- No git history shallow clone: evolutionary coupling unavailable.
- Mono2Micro results show runtime traces improve business alignment; quality "depends on quantity and quality of data gathered" (https://developer.ibm.com/tutorials/transform-monolithic-java-applications-into-microservices-with-the-power-of-ai/, ~2021; IBM docs).
- Literature gap: no standard datasets/baselines (2026): report all metrics as relative comparisons within the repo, not absolute grades.

---

## 5. Per-slice proof-obligation catalog (reusable)

| Obligation | When | Evidence artifact |
|---|---|---|
| Characterization tests pass pre/post | any behavior-preserving move | test run log |
| Consumer-driven contract tests | API/event boundary | Pact verification (docs.pact.io) |
| Boundary lint passes with non-regressing baseline | T1/T2/T8 | lint report |
| Parallel-run diff within epsilon | T3/T4/T6 | experiment report (Scientist style) |
| Latency/error SLO unchanged | T3/T7/T9 | metrics before/after |
| Reconciliation = 0 diff | T6 | recon query output |
| Idempotency demonstrated | CDC/outbox/dual write | replay test |
| Old-path usage ~0 before contract | T5/T4 | telemetry |
| Rollback rehearsed | T3/T6/T7 | runbook + dry-run in non-prod |

Recovery rule: each slice is either (a) additive and reversible by deletion/flag, or (b) explicitly labeled "irreversible" with human gate and a restore plan. Irreversible = dropping legacy tables, removing the old route, deleting the facade. Microsoft explicitly treats legacy-object removal as a deliberate final step. (https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig, 2026)

---

## 6. Graph-model implications for Unknot

### 6.1 Edge types and weights
- imports/calls (structural, directed), reads/writes (module->table; writes weigh more [HEUR]), co-change (undirected, filtered), same-owner, shared-term (semantic), runtime-call (traces), route->component, deploy-unit membership (CI/deploy topology).
### 6.2 Derived node/cluster attributes
- churn, owner entropy, CBT, CBJ, SW, IFN, CC, CCL, OA, cycle membership, cluster stability.
### 6.3 Output contract per recommendation
`{treatment, candidate, favoring signals[value,source], contraindications_checked[], evidence_gaps[], confidence, first_slice, proof_obligations[], recovery, irreversible:boolean, retain_score}`.
### 6.4 Candidate validation checklist (from Microsoft's 6 criteria)
single responsibility; no chatty calls; team-sized; no co-deploy dependency; independent evolution; consistency preserved. (https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries, 2022)

---

## 7. Claims I could not source / verify in this session

1. Service Cutter's specific clustering algorithms (Girvan-Newman, epidemic label propagation) and criterion weight scheme/defaults (paper fetch blocked).
2. Newman *Monolith to Microservices* pattern descriptions beyond the chapter pattern names (chapter pages 403/404); the pattern table's content for shared DB/view/wrapper/DBaaS/sync-in-application is from my background knowledge.
3. Pact, Feathers characterization tests, canary and dark-launch definitions, Team Topologies primary text (only secondary summaries).
4. single-spa, Module Federation singleton/version negotiation, Native Federation, eslint-plugin-boundaries, dependency-cruiser, ESI/edge composition details.
5. Newman-Girvan modularity formula and Leiden paper (cited from memory); Q>0.3 folklore.
6. All edge-weight values (0.35/0.30/0.25/0.10), hard-gate thresholds (CC p95 <=5, CCL <=0.2, OA >=0.8, sensitivity <10%), 5-team/daily-deploy micro-frontend rule (blog opinion), bundle-size gates: Unknot heuristics, not published.
7. The 5-20-class "non-extreme" band came from a 2026 preprint's summary; extracted formula for NED appears inconsistent with the band; verify against the original Mono2Micro paper before codifying.
8. No published default thresholds exist for CodeScene degree-of-coupling; only an example (10 commits, 50-file changeset).
9. Microsoft BFF/Newman BFF page, AWS micro-frontend guidance, Google Cloud guidance, Pact docs, Scientist's GitHub blog (primary) were not retrieved.
