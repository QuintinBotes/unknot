# Monolith decomposition

`unknot decompose` answers one question for a backend or frontend monolith: given what the code, the data, the history and the ownership map show, is there a boundary worth drawing, and what is the least invasive way to draw it? "Leave it alone" is a valid answer and often the right one.

It is read-only for source. It builds a graph of how modules relate, proposes candidate boundaries, measures them, evaluates ten treatments against the measurements, and saves one recommendation per candidate under `.unknot/decompositions/DEC-xxxx.json`. A recommendation can then be turned into a campaign with `unknot plan --from DEC-xxxx`.

The research basis, with sources and the line between what is sourced and what is a Unknot heuristic, is in [docs/research/decomposition.md](research/decomposition.md). The design is spec §15A.

## The ladder

```
retain -> modularize in place -> extract module/package -> extract service or micro-frontend
```

This follows Fowler's MonolithFirst and Shopify's account of their modular monolith (research brief §2.1, §0): make the boundary real inside one process first, where it is cheap to move, and only add a network boundary when something concrete requires it. Each rung needs measured evidence; skipping one needs a recorded reason.

Static boundary evidence has limits. Shopify reported that a package with zero Packwerk violations could still fail when run in isolation (brief §0, item 9). So evidence gaps lower confidence, and unstable candidates are reported as uncertainty rather than silently chosen.

## Drivers

Splitting something has a cost, so it needs a reason. Unknot calls the reason a **driver**, from a closed list:

| Driver | Evidence that would substantiate it |
|---|---|
| `independent_deploy` | Deployables that release together; waits on a release train; co-change across team boundaries |
| `independent_scale` | Capabilities with different resource profiles in runtime metrics |
| `availability_isolation` | Incidents that propagate between capabilities; different SLOs |
| `security_isolation` | Different data classification or privilege per capability |
| `team_autonomy` | Two or more teams in one deployable, with merge contention |
| `technology_divergence` | A capability that needs a different runtime or framework |
| `build_time` | Build or test time dominated by unaffected areas |

Record drivers with `--driver <id>` (repeatable) or in `decomposition.drivers` in the config, with optional `scope`, `evidence`, `owner`, `source` and `quote`. To say where and in whose words a driver was stated, add `--driver-source <id>=<url or document>` and `--driver-quote <id>="<the sentence>"` (both repeatable, one per driver), or list them in a small JSON file, `--drivers-file drivers.json`, holding `[{"driver": "<id>", "source": "...", "quote": "..."}]` or `{"<id>": {"source": "...", "quote": "..."}}`; the file's drivers are recorded like `--driver`, and flags override the file. A value without `<id>=` still applies to every `--driver` given on that command line. Each record keeps `driver_provenance: [{ driver, source, quote }]`. When a record replaces an earlier one (a rerun after the members changed) or rewrites its own, a driver with neither a source nor a quote takes both from that earlier record, and the entry says so with `carried_from: "DEC-xxxx"`; words given now win. When a driver has no source or quote and none can be carried, the output starts with a notice that says so (`driver_provenance_missing` in `--json`). A source without a quote is stored as such (`quote: null`): a driver still needs the person's words. Unknot never infers a driver from the code and never picks one to make a treatment available. The `/unknot:decompose` skill tells Claude the same: a driver comes only from what you say.

With no driver, service extraction (T3) and micro-frontends (T7) are not offered. Retain, modularize in place (T1), extract module (T2) and the frontend modular monolith (T8) need no driver.

## The affinity graph

Boundary discovery works on a weighted graph over source modules (test files and placeholders excluded). The edge weight between modules a and b is

```
w(a,b) = structural x S(a,b) + data x D(a,b) + evolutionary x E(a,b) + semantic x M(a,b)
```

Each component is first scaled to the range 0 to 1 (divided by its largest value), so the weights mean what they say.

| Component | What it measures | Source |
|---|---|---|
| S, structural | Imports (weighted by number of imported names) and calls, rolled up to modules | Language adapters |
| D, data | Modules touching the same table; a write counts 1.0 and a read 0.5; tables touched by more than 40 modules are skipped as hubs | Database adapter, ORM and SQL facts |
| E, evolutionary | Git co-change degree between files. Commits touching more than `max_changeset` files (default 50) are ignored, and pairs sharing fewer than `min_shared_commits` (default 10) commits are dropped. Window: `history_days` (default 365) | `git log` |
| M, semantic | Overlap of domain words in paths and exported names, for modules already related or in the same directory | Paths and symbols |

Defaults are 0.35, 0.30, 0.25, 0.10. They are heuristics, they are configurable (`decomposition.weights`), and every recommendation lists the weights used. A fifth component, R (`weights.runtime`, default 0.25), couples services from imported traces: `RUNTIME_CALLS` between services link the services' entry modules (modules exposing endpoints under the service's `code_root`, else up to 20 modules), weighted log(1+calls). It is used only when traces exist.

## Candidates

Candidates are communities found by the Leiden algorithm on the affinity graph. They are then stress-tested:

- Leiden at five resolutions (0.5, 0.75, 1, 1.25, 1.5);
- label propagation as an independent algorithm;
- five trials with every edge weight randomly perturbed by up to 50%.

A candidate is **robust** only if at least `thresholds.robustness` (default 0.9) of its modules stay together across all of those runs. A non-robust candidate is still reported, its confidence is set to `low`, and the treatment selection treats an unstable boundary as a contraindication for extraction. Algorithms propose; they never authorize. Results are deterministic (a seeded random generator), so the same graph gives the same candidates.

The summary line shows the modularity Q of the partition and how many candidates were robust.

### Scope

`unknot decompose [scope...]` takes the same scope entries as every other command: a path, a glob anchored at the repository root (`src/**/*Billing*/**`), `ns:<namespace>` (modules whose declared namespace or package is that or below it) and `seed:<module or type>~N` (a module, a file name or a type it declares, plus everything within N import hops). Candidates are found among the modules in scope only. When the scope selects no module, or a seed is not found, nothing is written and the command warns (`scope "<entries>" matched 0 of <total> modules`, on stderr and in the text output). `--json` carries `scope: { entries, matched, total, unresolved }`.

### Stable ids

A record's fingerprint is the sha256 of the target, the sorted drivers and the sorted candidate module ids. A rerun that finds a record with the same fingerprint reuses its id and overwrites it, so running `decompose` again does not add records. A changed boundary or driver set is a new recommendation with a new id; when at least half of its members match an earlier record of the same target that no current boundary rewrites, it names that record in `supersedes` (with `supersedes_overlap`), and `list` shows the earlier one as replaced by it. Each record stores its `fingerprint`, the `graph_generation` it was computed on and its `scope`; `list` marks a record stale when the graph has been rebuilt since. It marks it superseded when it has no fingerprint (an older version wrote it, so no rerun overwrites it) or when its graph generation is older and a run since the rebuild has produced records again without it. `unknot decompose prune [--dry-run]` removes superseded records and lists them; a record named by a campaign or a slice (for example from `plan --from DEC-...`) is kept and reported as referenced.

`--dry-run` computes and prints but writes nothing and allocates no ids: it shows the existing id a real run would overwrite, or `new`.

### Names

A candidate is named after what most of it is: the deepest namespace (module attribute `namespace` or `package`) that a strict majority of its members share, with the members elsewhere noted, as in `Shop.Orders.Checkout (+1 from Shop.Notifications)`. Without a namespace majority, the deepest directory a strict majority share is used the same way. When nothing holds a majority (an even split), the name is the members' common prefix: the namespace, or the common directory prefix with its dominant child. Adding one outlier module to a rerun changes only the note, never the base name. `candidate.name_basis` says which. When two candidates in one run would share a name, the hub file is appended: `Shop.Catalog (hub ProductService.cs)`. `candidate.top_files` lists up to five members by fan-in.

### Reading the output

- `unknot decompose --summary` prints one line per candidate: id, name, size, treatment, confidence and the top reason the next more invasive treatment was rejected (`--summary --json` gives the same as an array).
- `unknot decompose list` shows the saved records (id, name, target, treatment, confidence, size, stale, superseded and why).
- `unknot decompose prune [--dry-run]` removes the superseded records and says which; records that a campaign or slice references stay.
- `unknot decompose show <DEC-id> [--json]` prints one record: metrics, favouring signals with their evidence, rejections, a readiness table and the gaps. `list` and `show` are subcommands only as the first positional.

### Metrics

Computed for each candidate. They are relative to your repository, not absolute grades, and each missing one is listed in `evidence_gaps` instead of being guessed.

| Metric (signal name) | Meaning | Needs |
|---|---|---|
| Size (`boundary.size`) | Modules in the candidate; flagged nano or mega outside `size_band` | graph |
| Interface count (`boundary.interface_count`) | Candidate modules used from outside | imports |
| Cohesion, coupling, stability (`boundary.cohesion`, `boundary.coupling`, `boundary.stability`) | Share of the affinity weight touching the candidate that stays inside, the share that leaves it, and how steadily its modules stay together under perturbation | affinity graph |
| Test code | Test code is never a candidate member. The census marks files in test projects as tests: directories named `*.Tests`, `*.UnitTests`, `*.IntegrationTests`, `*.FunctionalTests`, `*.Specs`, `*Tests`, a project file named like a test project (`*Tests.csproj`, `*Specs.csproj`), and anything under a project whose file references `Microsoft.NET.Test.Sdk`, xunit, NUnit or MSTest or sets `<IsTestProject>true` (each project file is read once). A re-map extracts a file again when its classification changes, even if its bytes did not | census |
| Folded siblings | A module outside the clustered members that only candidate members import, in a directory a member occupies or below one where the candidate has at least two members (never below the root or a top-level directory), is part of the candidate (repeated until none is left) so it does not count as a reverse dependency of its own owner. A whole small cluster that only the candidate uses joins it the same way and is no longer a candidate of its own. `candidate.folded_siblings` lists each with the reason | imports |
| Outbound dependencies (`boundary.outbound_dependencies`; `boundary.reverse_deps` until 0.3.0) | Imports from the candidate into the rest of the system, that is what the candidate depends on, without low-confidence edges (resolved only by namespace) and without imports into test modules. Those are reported as `boundary.reverse_deps_low_confidence` and `boundary.reverse_deps_test`; the record lists the ten most-imported targets in `candidate.outbound_dependency_targets` (`reverse_dependency_targets` until 0.3.0) so a reader can check. The value counts import edges, and it is the one treatment selection quotes in a rejection; the same imports counted by the distinct modules they reach are a separate metric, `boundary.outbound_dependency_modules`. A metric name has one value per record: every metric a treatment evaluation names equals the value in the candidate's `metrics` | imports |
| Internal imports, cycle size (`boundary.internal_imports`, `cycle.size`) | Dependency cycles that cross the boundary (they block extraction). `cycle.crossing_size` is the same number under a clearer name; a cycle wholly inside the candidate is `boundary.internal_cycle_size`, and its members, elementary cycles, edges to cut and declared-only edges are in `candidate.cycle_detail` | imports |
| Shared-table writers (`boundary.shared_table_writers`) | Tables written both inside and outside the candidate | table access facts |
| Cross-boundary joins (`boundary.cross_joins`) | Joins between tables owned by different candidates | table access facts |
| Cross-boundary transactions (`boundary.cross_transactions`) | Transactions spanning tables of different candidates | transaction facts |
| Co-change leak (`module.co_change_leak`) | Share of co-change weight that crosses the boundary | git history |
| Ownership alignment (`ownership.alignment`, `owners.count`) | Largest single-owner share of the candidate | CODEOWNERS or a catalog |
| Interceptable (`requests.interceptable`) | The candidate exposes routable entry points, or a traced service or endpoint whose `code_root` maps into it shows requests arriving | endpoint facts, imported traces |
| Tests (`tests.present`) | Tests that cover the candidate's modules | test facts |
| Cross-boundary calls per request (`boundary.calls_per_request_p95`) | Chattiness | imported traces |

If there are no table facts, the data metrics are omitted rather than set to zero. If there are no traces, chattiness is unknown.

An interceptable value of 0 means "no routable seam (HTTP route or queue entry) visible in this repository", not that none exists. A caller in another repository or a gateway would show an existing seam; the evidence gap says to import its traces (`evidence.traces`) or a catalog that names the endpoints (`evidence.catalogs`).

## Treatments

Ten treatments, each a pattern card in `patterns/decomposition/` with applicability signals, contraindications, a first safe slice, proof obligations and a recovery.

| ID | Treatment | Rejected when (examples) | First slice |
|---|---|---|---|
| T0 | Retain | Never; always valid | Document why, and what evidence would change the decision |
| T1 | Modularize in place | Nothing structural; missing tests only add a characterization step first | Boundary rules in warn mode, with a baseline of existing violations |
| T2 | Extract module or package | Cycle with the rest of the code; shared-table writers; no tests | A facade in front of the module; old paths delegate to it |
| T3 | Extract service (strangler fig) | No driver; requests cannot be intercepted; no traces; cross-boundary transactions without a saga design; shared-table writers; ownership alignment below 0.8; chatty boundary; many reverse dependencies; unstable boundary | An identity routing facade at 0% traffic, then shadow, then canary |
| T4 | Branch by abstraction | No stable interface can be defined | An interface plus an adapter that delegates to the current code |
| T5 | Parallel change | Consumers unknown; old and new cannot coexist | Expand only (additive) |
| T6 | Database decomposition | Strict atomicity with no saga; no reconciliation; no proven restore | Ownership annotation and a read-only view or wrapper; no data moves |
| T7 | Micro-frontend by route | No driver; one owner; heavy shared state; frequent cross-zone navigation; no per-app CI/CD | An identity reverse-proxy route, then one low-coupling route |
| T8 | Frontend modular monolith | A strong independent-deploy driver across teams (consider T7) | Layer or slice import rules in warn mode with a baseline |
| T9 | Backend for frontend | One client; identical requests; latency budget cannot absorb a hop | One read-only BFF endpoint for one screen |

The thresholds inside the cards (0.8 ownership, 0.2 co-change leak, 5 calls per request) are heuristics. The output labels them as such. The cards keep 0.8, 0.2 and 5 as defaults. `decomposition.thresholds.ownership_alignment`, `co_change_leak` and `chatty_calls_p95` override them (see [configuration.md](configuration.md#decomposition)).

### How a treatment is chosen

For each candidate:

1. Evaluate all treatments that apply to the target (backend: T0 to T6 and T9; frontend: T0, T2, T7, T8, T9) against the candidate's measured signals. A condition whose measurement does not exist yields `insufficient_evidence`, never a pass.
2. Discard contraindicated treatments, recording why. If tests are missing, behaviour-preserving treatments (T1, T2, T4, T5, T8) are not discarded; they get a `characterization` step in front.
3. Discard treatments that do not serve a recorded driver. T0, T1, T2 and T8 need none. T6 serves no driver by itself: it is the data prerequisite for T3.
4. Discard treatments with insufficient evidence.
5. Of what is left, prefer treatments that serve a recorded driver, and among those pick the least invasive: `T0 < T1 < T2 = T4 = T5 < T6 < T8 = T9 < T7 < T3`.
6. If T3 wins but the candidate has shared-table writers or cross joins, the sequence becomes T6 then T3, and T6 is the recommendation (data ownership before a network seam). If T6 is contraindicated, T3 is rejected and the next best wins.
7. If nothing fits and serves, the answer is T0 with a `retain_reason`. When a driver is recorded and evidence is missing, the recommendation also carries a preparation sequence (contracts, observability, ownership, whichever is missing). `unknot plan --from DEC-xxxx` then creates evidence-gathering slices (contract tests, correlation IDs and tracing, CODEOWNERS) instead of failing.

Every recommendation cites the favouring signals with measured values, lists every contraindication it checked, lists the rejected treatments with reasons, and lists the evidence gaps. Confidence is `high` only with at least two favouring signals and at most two evidence gaps, `medium` with one favouring signal or none needed (retain), and `low` for an unstable candidate. The spec asks for static evidence alone to cap extraction at `medium`; in practice the gaps keep it there, but the code does not enforce that cap separately.

What this means in practice in version 0.1.0:

- **Retain is common.** Candidates measure `module.consumers` (external modules importing the candidate), `contracts.present` (1 when an endpoint it serves is described by an OpenAPI or Pact file or declared by a typed HTTP client interface in the graph, or when one of its modules declares, consumes or imports such a client; 0 when it exposes endpoints and none qualifies; the routes and the number of clients per route are in the record, and `clients.count` is the number of distinct client interfaces), `ci.per_unit_pipeline` (when workflows exist: whether a workflow's path filters all lie inside the candidate's common directory) and `boundary.calls_per_request_p95` (from runtime call edges). Some inputs are still not measured: how the API clients differ (`clients.response_shape_variance`), clients outside the mapped repository, and navigation between frontend routes. A treatment that needs one of those comes back as `insufficient_evidence` and is not selected. Table facts (from the database adapter or SQL and ORM recognition) are needed before T2 can be considered at all, because shared-table writers is a hard contraindication that must be measured.
- Of the backend treatments, T0 and T1 are the ones you will most often see. T1 appears when there are dependency cycles or co-change across the boundary. For the frontend, T8 appears when there are cross-feature imports, layer violations or cycles.
- T3 needs imported traces, interceptable requests and a per-unit pipeline signal in addition to a driver. Without them it is contraindicated. This is deliberate: the card is conservative, not a bug in your repository.

## Execution rules a recommendation commits to

These are properties of the first slice and the slices after it, not options:

- Backend data follows a ladder: annotate ownership, then a read-only view or wrapper, then move cross-boundary joins into code behind a flag, then an owner-side store with change-data-capture or an outbox, then reconcile, then flip reads (shadow compare), then flip writes, then soak. Dropping legacy objects is its own irreversible slice, human-gated and critical risk.
- A strangler facade starts as identity routing with no behaviour change, proven by parity tests, before any traffic moves.
- Parallel-run experiments must be side-effect free or stubbed. Unknot generates scaffolding only.
- Frontend strangling goes route by route behind a reverse proxy or framework rewrite. The rollback is the route flip. Retiring the old route is a separate contraction slice.
- Every slice is additive and reversible, or marked `irreversible` with a human gate and a restore plan.

## Frontend

A module is treated as frontend if it is a `.jsx`, `.tsx`, `.vue` or `.svelte` file, renders a component, or is JavaScript or TypeScript in a conventional UI directory (`components`, `pages`, `views`, `features`, `widgets`, `routes`, `ui`, `frontend`, `web`, `client`) and not under `server`, `api` or `backend`.

What is recognised from source:

- Routes: Next.js app and pages routers, SvelteKit file routes, and route tables in React Router, Vue Router and Angular style.
- Feature-Sliced Design layers (`app`, `processes`, `pages`, `widgets`, `features`, `entities`, `shared`), and otherwise `features/`, `modules/` or `domains/` folders as feature units.
- Cross-feature imports; same-layer cross-slice imports and upward layer imports (violations).
- State stores (Redux, and similar by name) and how many route groups use each.

From routes Unknot builds each route's closure (modules reachable by imports, up to depth 6), treats modules used by at least half the routes as shared, and groups routes by their first path segment. Those groups become the vertical split candidates (`R-1`, `R-2`, ...). If no routes are recognised, affinity clustering supplies candidates and the gap is reported. Only vertical (route or domain) splits are proposed; a horizontal fragment split would need an owner per fragment, which Unknot reports as missing and does not invent.

Missing inputs are reported: team count when there are no ownership facts, and navigation between routes, which Unknot cannot know without analytics. Module Federation (`ModuleFederationPlugin`, `@module-federation` packages, `withModuleFederation`, `federation({...})`), single-spa `registerApplication` names and Next.js multi-zone rewrites to external hosts are recognised by text patterns at medium confidence, and the frontend detectors count Module Federation remotes and single-spa apps as frontend applications. Integration options (build-time packages, runtime federation, iframes, multi-zone, server-side composition, web components, edge composition) exist as pattern cards (`unknot pattern list --category frontend`) that you can consult, but `decompose` does not choose among them yet.

## Reading a DEC artifact

`.unknot/decompositions/DEC-xxxx.json` holds one recommendation. The schema is `schemas/decomposition-recommendation.schema.json`. The saved file also carries a few extra fields from the run (`evaluations`, `sequence`, `serves`).

| Field | How to read it |
|---|---|
| `target` | `backend` or `frontend` |
| `driver` | The drivers recorded for this run. Empty means no service extraction or micro-frontend was on offer. |
| `fingerprint`, `graph_generation`, `scope` | What the record was computed from; a rerun with the same fingerprint reuses the id. A record is stale when the graph generation has moved on. |
| `driver_provenance` | Per driver: `source` and `quote` as given (`null` when missing) |
| `candidate` | `id`, `name`, `name_basis`, `top_files`, `modules`, `robust`, the `metrics` that were measured (including cohesion, coupling and stability) and `reverse_dependency_targets`, `folded_siblings`, `owners` (owner, modules, share; with `unowned_modules`) and, for a candidate below the robustness threshold, `robustness_detail` (the runs that moved members: resolution, label propagation or a weight-perturbation trial with its seed, and the members that moved) |
| `treatment` | The recommendation (T0 to T9). With a data prerequisite, the first step of `sequence`. |
| `sequence` | Steps in order, for example `["characterization", "T1"]` or `["T6", "T3"]` |
| `favoring_signals` | Measured values that support the treatment. Each has `evidence` (up to 20 module or edge ids it was measured on, such as the members and closing edges of a cycle) and a `source` naming the metric and the graph generation |
| `selection_reason` | Non-retain records: why this treatment was chosen and why retaining was not |
| `retain_reason` | Retain (T0) records only: why the boundary is left alone |
| `readiness` | Per rejected treatment (at least T3, and T2 when present): each applicability signal, precondition and contraindication as `{ treatment, signal, value, op, threshold, met, missing_evidence }`. An unmeasured signal has `value: null` and says what evidence would measure it. `show` prints T2 and T3 as a table |
| `contraindications_checked` | Each check, its result (`pass`, `fail`, `unknown`) and the value |
| `rejected_treatments` | Every other treatment and the reason it was discarded. The reason leads with the predicates that failed (`signal=value (need op threshold)`), then the evidence that is missing; `failed_predicates` and `evidence_needed` hold the same as data |
| `drivers_not_served` | `{ driver, would_be_served_by, reason }` for a recorded driver the chosen treatment does not serve although a more invasive treatment would (modularizing in place does not give independent deployment), with why that treatment was rejected |
| `evidence_gaps` | What was not measured. Read these before trusting a recommendation. |
| `confidence` | `low`, `medium` or `high`. Low for unstable candidates. |
| `first_slice` | Exactly one: objective, the shape of the change, the pattern step, scope (every member module, with `include_total` and `truncated`), prerequisite |
| `proof_obligations` | Obligation kinds the slice will need |
| `recovery` | How the first slice is undone |
| `irreversible` | `false` for first slices |
| `retain_score` | 1 for retain; otherwise reduced by each favouring signal. A rough indication of how much the case for acting outweighs the case for waiting. |
| `heuristics_used` | The weights and thresholds in effect, labelled as heuristics |

One detail to be aware of: `contraindications_checked` for a treatment that needs tests is evaluated as if characterization tests existed (the sequence puts them first), so a "no tests" check can show `pass` while `candidate.metrics["tests.present"]` is 0. Trust the metric and the `sequence`.

## Worked example

A small repository with three modules (`orders`, `billing`, `catalog`) under `src/`, six files each, a `CODEOWNERS` file giving each directory to a different team, and git history. In `orders` and `billing`, files imported each other in a loop (`orders/f6 -> orders/h -> billing/g -> orders/f6`), and commits often touched both modules together.

```
$ unknot map
Mapped 22 files at 495d7e4ee1f6 -> 46 nodes, 108 edges (generation 4, 122 ms).
History: 69 commits, 10 co-change pairs (0 oversized commits ignored).

$ unknot decompose --driver team_autonomy
Targets: backend · drivers: team_autonomy
backend: 20 modules, modularity Q=0.5966, 1/3 candidates robust (weights are heuristics)

id        target   candidate    size  treatment  sequence             confidence
DEC-0013  backend  src/billing  7     T1         characterization→T1  low
DEC-0014  backend  src/catalog  6     T0         T0                   medium
DEC-0015  backend  src/orders   7     T1         characterization→T1  low
```

`catalog` has no cycles, no co-change across its boundary and one owner: nothing justifies acting, so Unknot retains it. `orders` and `billing` are tangled together, so modularizing in place is recommended, with tests first. Opening `DEC-0015.json`:

- `favoring_signals`: `cycle.size = 3`, measured, from the `cycles` applicability signal of the modularize-in-place card.
- `candidate.robust: false` and `confidence: "low"`: the boundary between `orders` and `billing` moves when weights are perturbed, which is what you would expect when two modules are this entangled. Unknot reports that rather than picking.
- `rejected_treatments`: T2 (extract module) is contraindicated because the candidate is in a dependency cycle with the rest of the code and has no covering tests; T3 (extract service) is contraindicated because the boundary is unstable, there is no interceptable seam and no traces; T4, T5 and T6 "do not serve the recorded driver" `team_autonomy`; T9 has insufficient evidence.
- `evidence_gaps`: no table access facts, no transaction facts, no runtime traces, and the signals the command does not measure yet.
- `first_slice`: "Introduce boundary rules for src/orders in warn mode with a baseline of existing violations." No source moves. Prerequisite: characterization tests that pin current behaviour.
- `proof_obligations`: `characterization`, `architecture-fitness`, `no-new-cycles`, `diff-budget`. `recovery: revert`.

Without `--driver team_autonomy`, the same repository gets T1 for the same two candidates, because T1 needs no driver. With no cycle and no co-change (before the loop was added), all three candidates came back as retain with "insufficient evidence" for T1 and T2 and the reason in `rejected_treatments`.

The next step is yours: `unknot plan "Put module boundaries around orders and billing" --from DEC-0015`. That creates a campaign whose slices wait for approval.

## What to do with a retain

A retain recommendation with `evidence_gaps` is information, not a refusal. The gaps tell you what would change the answer: import traces (`evidence.traces`) and database catalog data (`evidence.db_metadata`), add CODEOWNERS or a service catalog, record a driver if one is real, or add characterization tests. Re-run `map` and `decompose` after.
