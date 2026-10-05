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

Record drivers with `--driver <id>` (repeatable) or in `decomposition.drivers` in the config, with optional `scope`, `evidence` and `owner`. Unknot never infers a driver from the code and never picks one to make a treatment available. The `/unknot:decompose` skill tells Claude the same: a driver comes only from what you say.

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

Defaults are 0.35, 0.30, 0.25, 0.10. They are heuristics, they are configurable (`decomposition.weights`), and every recommendation lists the weights used. A fifth component for runtime call counts is reserved in the config (`weights.runtime`) but is not part of the graph in this version.

## Candidates

Candidates are communities found by the Leiden algorithm on the affinity graph. They are then stress-tested:

- Leiden at five resolutions (0.5, 0.75, 1, 1.25, 1.5);
- label propagation as an independent algorithm;
- five trials with every edge weight randomly perturbed by up to 50%.

A candidate is **robust** only if at least `thresholds.robustness` (default 0.9) of its modules stay together across all of those runs. A non-robust candidate is still reported, its confidence is set to `low`, and the treatment selection treats an unstable boundary as a contraindication for extraction. Algorithms propose; they never authorize. Results are deterministic (a seeded random generator), so the same graph gives the same candidates.

The summary line shows the modularity Q of the partition and how many candidates were robust.

Candidate names are the longest common directory of their modules, so two candidates can share a name. Check the module list in the DEC file.

### Metrics

Computed for each candidate. They are relative to your repository, not absolute grades, and each missing one is listed in `evidence_gaps` instead of being guessed.

| Metric (signal name) | Meaning | Needs |
|---|---|---|
| Size (`boundary.size`) | Modules in the candidate; flagged nano or mega outside `size_band` | graph |
| Interface count (`boundary.interface_count`) | Candidate modules used from outside | imports |
| Reverse dependencies (`boundary.reverse_deps`) | Imports from the candidate back into the rest | imports |
| Internal imports, cycle size (`boundary.internal_imports`, `cycle.size`) | Dependency cycles that cross the boundary (they block extraction) | imports |
| Shared-table writers (`boundary.shared_table_writers`) | Tables written both inside and outside the candidate | table access facts |
| Cross-boundary joins (`boundary.cross_joins`) | Joins between tables owned by different candidates | table access facts |
| Cross-boundary transactions (`boundary.cross_transactions`) | Transactions spanning tables of different candidates | transaction facts |
| Co-change leak (`module.co_change_leak`) | Share of co-change weight that crosses the boundary | git history |
| Ownership alignment (`ownership.alignment`, `owners.count`) | Largest single-owner share of the candidate | CODEOWNERS or a catalog |
| Interceptable (`requests.interceptable`) | The candidate exposes routable entry points | endpoint facts |
| Tests (`tests.present`) | Tests that cover the candidate's modules | test facts |
| Cross-boundary calls per request (`boundary.calls_per_request_p95`) | Chattiness | imported traces |

If there are no table facts, the data metrics are omitted rather than set to zero. If there are no traces, chattiness is unknown.

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

The thresholds inside the cards (0.8 ownership, 0.2 co-change leak, 5 calls per request) are heuristics. The output labels them as such. At present the pattern cards hold these values themselves; changing the `decomposition.thresholds` entries for ownership and chatty calls does not change a card's decision (see [configuration.md](configuration.md#decomposition)).

### How a treatment is chosen

For each candidate:

1. Evaluate all treatments that apply to the target (backend: T0 to T6 and T9; frontend: T0, T2, T7, T8, T9) against the candidate's measured signals. A condition whose measurement does not exist yields `insufficient_evidence`, never a pass.
2. Discard contraindicated treatments, recording why. If tests are missing, behaviour-preserving treatments (T1, T2, T4, T5, T8) are not discarded; they get a `characterization` step in front.
3. Discard treatments that do not serve a recorded driver. T0, T1, T2 and T8 need none. T6 serves no driver by itself: it is the data prerequisite for T3.
4. Discard treatments with insufficient evidence.
5. Of what is left, prefer treatments that serve a recorded driver, and among those pick the least invasive: `T0 < T1 < T2 = T4 = T5 < T6 < T8 = T9 < T7 < T3`.
6. If T3 wins but the candidate has shared-table writers or cross joins, the sequence becomes T6 then T3, and T6 is the recommendation (data ownership before a network seam). If T6 is contraindicated, T3 is rejected and the next best wins.
7. If nothing fits and serves, the answer is T0 with a `retain_reason`.

Every recommendation cites the favouring signals with measured values, lists every contraindication it checked, lists the rejected treatments with reasons, and lists the evidence gaps. Confidence is `high` only with at least two favouring signals and at most two evidence gaps, `medium` with one favouring signal or none needed (retain), and `low` for an unstable candidate. The spec asks for static evidence alone to cap extraction at `medium`; in practice the gaps keep it there, but the code does not enforce that cap separately.

What this means in practice in version 0.1.0:

- **Retain is common.** Several inputs that the cards ask for are not yet measured by the command: the number of consumers of a module, whether contracts exist, how many API clients and how they differ, navigation between frontend routes, whether each unit has its own pipeline. A treatment that needs one of those comes back as `insufficient_evidence` and is not selected. Table facts (from the database adapter or SQL and ORM recognition) are needed before T2 can be considered at all, because shared-table writers is a hard contraindication that must be measured.
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

Missing inputs are reported: team count when there are no ownership facts, and navigation between routes, which Unknot cannot know without analytics. Module Federation and single-spa configuration are not recognised in this version, and integration options (build-time packages, runtime federation, iframes, multi-zone, server-side composition, web components, edge composition) exist as pattern cards (`unknot pattern list --category frontend`) that you can consult, but `decompose` does not choose among them yet.

## Reading a DEC artifact

`.unknot/decompositions/DEC-xxxx.json` holds one recommendation. The schema is `schemas/decomposition-recommendation.schema.json`. The saved file also carries a few extra fields from the run (`evaluations`, `sequence`, `serves`, `retain_reason`).

| Field | How to read it |
|---|---|
| `target` | `backend` or `frontend` |
| `driver` | The drivers recorded for this run. Empty means no service extraction or micro-frontend was on offer. |
| `candidate` | `id`, `name`, `modules`, `robust`, and the `metrics` that were measured |
| `treatment` | The recommendation (T0 to T9). With a data prerequisite, the first step of `sequence`. |
| `sequence` | Steps in order, for example `["characterization", "T1"]` or `["T6", "T3"]` |
| `favoring_signals` | Measured values that support the treatment, with their source |
| `contraindications_checked` | Each check, its result (`pass`, `fail`, `unknown`) and the value |
| `rejected_treatments` | Every other treatment and the reason it was discarded |
| `evidence_gaps` | What was not measured. Read these before trusting a recommendation. |
| `confidence` | `low`, `medium` or `high`. Low for unstable candidates. |
| `first_slice` | Exactly one: objective, the shape of the change, the pattern step, scope, prerequisite |
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
