# Dogfooding log

Unknot was run against real repositories before release, and every problem it showed was
recorded here, fixed, and re-measured. Repositories were cloned to temporary directories
first; no original checkout was opened for writing. The harness is reproducible:

```bash
node scripts/dogfood.mjs --out /tmp/unknot-dogfood/<round> <repo-path>...
```

It maps, re-maps (cache path), diagnoses, decomposes and classifies architecture styles for
each repository and writes one JSON report per repository plus a summary.

## Repositories

| Repository | Files analysed | Languages | Why it was chosen |
|---|---|---|---|
| circuit-breaker | 52 | JavaScript (ESM) | Small, zero-dependency, real test suite (139 tests) |
| warden | 788 | TypeScript monorepo | Many packages, CI, Dockerfiles |
| tervin | 998 | TSX + Rust | Frontend-heavy, lexically parsed language |
| fullstack-app | 304 | Python + TypeScript | FastAPI backend, React routes, Dockerfiles |
| forge | 1,987 | Python + TSX + YAML | Largest; packages, services, many contracts |
| js-monorepo | 213 of 18,557 | JS/TS | Scale check (most files are committed `node_modules`, correctly excluded) |
| nopCommerce (public) | 6,741 (3,659 C#) | C# with a little JavaScript | A .NET monolith with its solution below the root (`src/`), central build files and Entity Framework mappings |

## Feedback items

| ID | Round | What happened | Fix | Evidence after |
|---|---|---|---|---|
| FB1 | 1 | 73 of 112 secret findings on forge were placeholders in `.env.example`, CI service URLs and fixtures; `token = secrets.token_urlsafe(32)` matched as a secret | Assignment secrets need a literal value (no calls, member chains or templates); placeholder URL passwords ignored; example/test/docs/CI paths report only high-confidence token formats | forge 112 → 24 |
| FB2 | 1 | Duplicated-code dominated by `__init__.py` barrels (imports and `__all__`); one finding per pair | Barrel files skipped; thresholds 20 lines / 0.4 similarity; one finding per clone group | forge 878 → 52 |
| FB3 | 1 | FastAPI handlers with injected dependencies flagged as long parameter lists | Endpoint handlers and decorated framework entry points skipped; threshold 6 | — |
| FB4 | 1 | App-layer modules importing library packages flagged as misplaced | Misplacement judged by who imports a module, not what it imports | — |
| FB5 | 1 | 2,318 dead-code findings on tervin: Rust (same-file call resolution only), JSX components, hooks, closures returned for `Depends()` | Lexically parsed languages excluded; components, hooks, handlers and closures exempt; any call by name anywhere counts; one finding per module | tervin 2,318 → 22 |
| FB6 | 1 | `decompose` crashed whenever a favouring signal existed (schema field mismatch) | Signal shape fixed | decompose completes on all repos |
| FB7 | 1 | Re-map slower than cold map (forge 83 s vs 22 s): discovery re-ran gitleaks and chart rendering, history re-ran `git log` | Discovery and history cached by content keys; external scanners opt-in during mapping | forge re-map 83 s → 2.8 s |
| FB8 | 2 | 269 of 545 tervin findings were long React components (JSX markup inflates lines) | Component threshold 150 lines (functions 80) | — |
| FB9 | 2 | A Dockerfile "built from image `app.core.database`": a Python `from … import` inside a BuildKit heredoc was read as `FROM` | Heredocs parsed; only real Dockerfile instructions accepted | false positive gone |
| FB10 | 3 | circuit-breaker's suite passed alone (139/139) but failed under Unknot | Brokered commands get a private `TMPDIR` outside the project (tests created scratch git repos nested inside the analysed repo) | baseline and verification pass in the sandbox |
| FB11 | 3 | An unreachable `return finish();` in circuit-breaker was found by reading the code, not by Unknot | Unreachable-code detection in the JS/TS and Python adapters plus a detector | flags exactly circuit-breaker `diffHash` line 334; no others on forge or fullstack-app |
| FB12 | 3 | Worktree paths printed as `/private/var/…` for clones under `/var` on macOS | Kept by design: Unknot prints the realpath it uses for containment checks, so what is shown is what is enforced | — |
| FB13 | live | In a real Claude Code session `unknot diagnose` was denied: hooks resolved `unknot` on their own PATH, which lacks plugin `bin/` directories | Bare `unknot` resolves to the plugin CLI unless another `unknot` shadows it on PATH | live session runs `/unknot:diagnose` |
| FB14 | 4 | Most long-parameter-list findings on forge were keyword-only, defaulted Python parameters (injection seams, client settings) | Python adapter reports required parameters; the detector measures positional plus required keyword-only parameters, and still flags very long lists | default settings: forge 107 → 35, fullstack-app 11 → 0 |
| FB15 | 6 | Eleven functions in a dispatch table (`COMMANDS.check`, called as `COMMANDS[name](…)`) reported as having no callers | The JS/TS adapter records how often an object-literal member's owner is used; a used owner makes its members reachable | circuit-breaker 1 → 0 such findings |
| FB16 | 6 | Entry points reported as "imported by nothing": Claude Code hook scripts named in `hooks.json`, shell scripts, a CI-run Python checker, a k6 load script | A wiring adapter links files that configuration names by path (`REFERENCES` edges); scripts and empty modules are exempt | dead-code findings: circuit-breaker 12 → 0, forge 27 → 13, tervin 13 → 3; every removed one checked by hand as a false positive |
| FB17 | 9 | Spot check of the functions the new data-line discount stopped flagging: log messages and toast texts passed to multi-line calls counted as data | Values directly inside a call's parentheses are arguments, not data | 433 per-function findings on five repositories became 322: 111 duplicates merged into one finding per function, 14 functions no longer flagged, each checked by hand (seeders, mock scenarios, translation tables, config and response literals) |
| FB18 | 9 | Change workflow on a uv workspace: editable installs pointed the slice worktree's tests at the main checkout's unchanged code, which the sandbox hides | Editable install paths are remapped to the worktree through PYTHONPATH | forge's Python package: ACCEPTED, 201 tests passing in the sandbox |
| FB19 | 9 | A live apply session followed a standing instruction to delegate reviews to an external agent; the hook refused the shell call and the session stopped without patching | The slice is written only by the refactorer or the session; a hook denial means adapt, not stop | tervin's Rust crate: ACCEPTED with the refactorer agent |
| FB20 | 9 | A project inside the Claude config directory (a background job's scratch space) was unreadable in the sandbox: Python extraction fell back to lexical reading, and the cached fallback hid the notice from later maps | The project's working set is put back after the secret rules (nested secrets stay hidden); a degraded batch is not cached | click cloned into job scratch: AST extraction, no notice, 46 findings instead of 42 |
| FB21 | 9 | Live-session suite on public repositories: cargo failed the baseline in every crate without `[workspace]` (the hidden `Cargo.toml` above the worktree read as "not permitted"); staging failed where `.gitignore` lists `node_modules` without a slash | The main checkout's tracked top-level files are readable from a worktree; linked directories git ignores get no exclude pathspec | termcolor and picomatch: ACCEPTED |
| FB22 | 9 | A finalize migration that drops the old column after add and backfill migrations was told to split into expand/contract | The contract step of an expand/backfill sequence is recognised and advised as such, ranked lower | the audited finding reworded, priority 0.02 |
| FB23 | 10 | `init` on a .NET repository with its solution under `src/` detected no commands and gave no notes; pipelines kept in a subdirectory and central build files were not protected | Solutions found up to three levels down; commands named in AGENTS.md, CLAUDE.md or CONTRIBUTING.md listed as hints, never copied; a note says why when nothing is detected; Azure DevOps pipelines anywhere, `Directory.Build.*`, `Directory.Packages.props`, `global.json` and `NuGet.config` proposed as protected; NuGet manifests count as dependency changes | nopCommerce: `dotnet build` and `dotnet test` on `src/NopCommerce.sln`, the other solution noted, six build files protected |
| FB24 | 10 | C# `using X;` linked a file to every file of namespace X (identical fan-in across a whole namespace), while classes referencing each other in the same namespace had no edge | Type-level resolution: an edge only to files declaring a type the file mentions, through its own namespace, usings, global usings, aliases, `using static` and qualified names; a dependency held only by an injected member that is never used is marked | nopCommerce edges 177,223 → 44,334, cold map 64 s → 8.6 s; hubs no longer tied; module findings 609 → 37, decomposition findings 899 → 284 |
| FB25 | 10 | A cycle that closed only through an injected member nobody used was reported as a design problem | Such a cycle says so ("closes only through the unused member …: remove it") and ranks lower; a cycle that survives without those edges is reported as before, listing them | 2 declared-only edges on nopCommerce, both checked by hand; none of its 7 cycles depends on one |
| FB26 | 10 | `map` said `complete` for a repository whose dominant language was read lexically, and a narrow scope hid the root CODEOWNERS from the ownership adapter | Per-language coverage in the summary; `partial` with the reason under `unavailable` when the dominant language has no dedicated adapter; ownership files at the root are read under any scope | nopCommerce: `partial`, "no dedicated adapter for csharp (3528 of 3552 source files)"; a scoped map links 77 files to their owner |
| FB27 | 10 | `decompose` matched scope by literal prefix (a glob `map` accepted selected nothing, silently), saved new DEC ids on every run, named candidates after the common path prefix, and dropped cohesion, coupling and the evidence behind its signals | One scope language for every command (paths, globs, `ns:`, `seed:<x>~N`) with a warning when it matches nothing; stable ids from a fingerprint of target, drivers and members; `list`, `show`, `--dry-run`, `--summary`; names from the dominant namespace with the hub file on collisions; metrics, evidence ids, a selection reason, driver provenance and a readiness table in each record | nopCommerce: three runs give the same 32 ids; a glob, a namespace and a seed scope each give named candidates; an empty scope writes nothing and says so |
| FB28 | 10 | Graph tools ignored `--type`/`--limit`, cut ids in tables, returned whole nodes without a size cap over MCP, ranked hubs on one edge type, and ignored scope | Filters honoured, compact results by default with a cap of about 40 KB and a hint to narrow, hubs over several edge types, scoped hubs and cycles, `graph neighbourhood` | broad MCP queries on nopCommerce stay under 40 KB |
| FB29 | 10 | The hook refused a heredoc that appended notes to a markdown file because the text mentioned `.unknot` | A mention counts only where a program could act on it: arguments of programs other than plain printers, redirect targets, assignments, heredocs fed to programs or expanded | the heredoc passes; heredocs into interpreters, substitutions, `xargs` and variables pointing at `.unknot` stay refused |
| FB30 | 10 | Agents copied the literal run id from the handoff example; an agent that reported through `submit_handoff` was still blocked for a missing block | The active run is stamped into every handoff (a different claim is kept as a warning); `submit_handoff` outside a run is refused; a tool hand-back counts | unit tests on both paths |
| FB31 | 10 | A read-only command's run left open by an interrupted turn kept restricting later turns, and a parallel session in the same repository | A run governs only the session that started it; a read-only run left open ends with the next message; denials say how long they last. The agent still cannot end a run mid-turn, which keeps analysis turns read-only against instructions in the code they read | hook tests for both sessions |
| FB32 | 10 | First run: the model could not run `init`; the Quickstart did not say a read-only assessment needs no keys or approvals; a human-only step run through Claude Code's `!` prefix was refused as if an agent ran it; outside Claude Code `unknot` was not on PATH and the installed path changes with every version | `init` is model-invocable (it only writes a proposal); a read-only track in the Quickstart; the refusal names the missing terminal; hand-offs print how to reach the CLI, and `unknot cli install` adds a stable command that runs the newest installed version | unit tests for the messages and the shim |
| FB33 | 10 | Even a two-line, test-covered deletion needed about six human actions | Lanes: a person signs one plan approval for a campaign's low-risk slices; the agent applies and verifies those whose patch only deletes code or only changes tests, within a cap; changes are still accepted by a person, together | an end-to-end test: an added line leaves the lane and is refused, a deletion is applied, verified and accepted with a person's signature |
| FB34 | 10 | Runtime evidence kept in a hosted observability service had no route into Unknot, and a Prometheus HTTP API response parsed to nothing | The Prometheus HTTP API JSON format is accepted; `docs/runtime-evidence.md` gives export recipes | unit test; vendor commands not run against live accounts |
| FB35 | 11 | `init` proposed `dotnet test` on the solution while the repository's AGENTS.md, which it quoted, says not to; it also scanned agent worktrees inside the checkout and repeated one note per pipeline folder | A command the guidance forbids is not proposed (the sentence is quoted, test projects are listed instead); nested checkouts and `.claude/` are skipped; one note per proposed path | unit tests |
| FB36 | 11 | Once same-namespace references linked, a candidate became one large strongly connected component: the cycle that mattered was no longer named, members were cut after eight, the record said `cycle.size: 0` beside a large internal cycle, and the declared-only marker showed nowhere | Components broken into elementary cycles and edges to cut, every member listed, the marker shown on edges, cycle detail in the record; three declared-only forms that were missed are caught | nopCommerce: 7 components, the largest (6 modules) has 3 elementary cycles closed by 1 edge |
| FB37 | 11 | Records from 0.1.10 stayed listed beside current ones; the one-line rejection of a treatment named only missing evidence while two predicates failed; a driver met for extraction was silently absent from the chosen treatment; test files were candidate members | Superseded records marked, `decompose prune`; failed predicates first; `drivers_not_served` with reasons; .NET test projects are test code; same-folder siblings used only by a candidate are folded in; owners, de-duplicated evidence and the run that broke a boundary are recorded | nopCommerce: 29 more test files recognised, none in a candidate |
| FB38 | 11 | The first `unknot cli install` instruction always failed (`unknot` is not on PATH before the install), and the fallback repeated the same command twice | The full path comes first until the shim is installed; the install is offered once | unit tests |
| FB39 | 11 | Recording which perturbation broke a boundary re-ran the whole clustering sweep for every fragile candidate: decompose on nopCommerce took 56 s instead of 5 s | The sweep records it while measuring stability | 3.8 s |
| FB40 | 11 | After upgrading, helper files of a test project were still decomposition candidate members, although the new rules made them test code | The per-file extraction cache was keyed on content, adapter version and options but not on the census classification, so unchanged files kept their old `is_test`; the classification is now part of the key. Test projects are also recognised by their project file name or `<IsTestProject>` | a unit test that turns a project into a test project without touching the file; the first re-map after upgrading re-extracts once, the next is fully cached |
| FB41 | 11 | Files in a subfolder used only by a candidate stayed outside it and were its main reverse-dependency targets | Folding reaches below a directory where the candidate has several members, and absorbs a whole cluster used only by it | unit tests |
| FB42 | 11 | A record whose members changed got a new id, and a reader comparing versions lost the thread | The new record names the one it replaces | unit tests |
| FB43 | 11 | Building with Unknot: the cheapest change it knew of (delete an injected member nobody uses) was marked in the graph but produced no finding to plan from, and the API check would have failed its removal | A finding per unused injected member; the marking is checked across the repository; removing such a public member passes the API check with a note | nopCommerce: 2 findings, both confirmed by hand; one planned into a low-risk, lane-eligible one-file slice |
| FB44 | 11 | Commands naming `.unknot` were still refused after the fix in round 10: once the person installed the `unknot` shim, or after an update inside a running session, the first `unknot` on PATH was not the plugin's exact path, and the refusal showed only the generic reason | The shim and sibling versions of the plugin count as its CLI, a look-alike in the project does not; a plain copy out of `.unknot` is allowed; refusals give the real reason | adversarial and unit tests |
| FB45 | 11 | A one-file deletion came out medium risk with no reason given, so it could not go in a lane and nobody could see why | Plans and slice views give the risk reasons, the roles and lane eligibility | unit tests; the nopCommerce slice reads "low: no risk factor found; lane: eligible" |
| FB46 | 11 | The accepted configuration still lacked the commands a later `init` found, and nothing said so; re-running `init` would have proposed a default config that, accepted, resets the mode and drops approvers | `init` proposes the accepted configuration plus what is new; `status` and `doctor` report a waiting proposal | an end-to-end test of the proposal and the notice |

## Round summaries

**Round 1** (5 repositories): every map completed; findings were noisy (tervin 2,980, forge
1,999) and three defects surfaced (FB6, FB7, and the noise items FB1–FB5).

**Round 2**: findings fell to circuit-breaker 30, warden 150, tervin 545, fullstack-app 125,
forge 528; cold maps 0.3–9.3 s, re-maps 0.1–2.8 s; decompose completed everywhere and, on
forge, recommended modularize-in-place (T1) for `apps/api` while retaining the rest without
a recorded driver.

**Round 3** — the full governed write path on a clone of circuit-breaker: a slice planned
from a real finding was refused without approval, approved with a passphrase-locked
approver key, patched in a worktree (writes to the main checkout denied, worktree edits
allowed), staged, and verified by nine obligations — scope, diff budget, parse, secrets,
no new cycles, API compatibility, complexity, and the project's own 139 tests run twice in
the macOS sandbox — then bundled and accepted. The main checkout was untouched.

**Live session** — Claude Code headless (`claude -p --plugin-dir`, permissions bypassed on
purpose): during `/unknot:diagnose` the hooks denied editing source, writing
`.unknot/config.yaml`, reading `~/.ssh/id_rsa`, running `npm test`, and self-approval; the
ledger recorded each denial and flagged the prompt-injection comment in the repository as
`injection.suspected`; the chain verified.

**Round 4** — the learning loop on forge: five reviewed decisions on long-parameter-list
findings (three rejected as idiomatic keyword-only lists, two accepted) gave a calibrated
precision of 0.44; Unknot proposed raising the threshold to 9 (above the largest rejected
value, below the smallest accepted one); after the proposal was accepted like a human
would, open findings of that kind went from 107 to 20 and the accepted findings stayed
visible. The pattern behind the rejections became FB14, a detector fix for everyone.

**Round 5** — re-measured after FB11 and FB14 with default settings: forge 418 open
findings (from 1,999 in round 1), fullstack-app 113 (from 329), circuit-breaker 31 (from 55),
zero detector errors, cold map of forge 9.5 s and re-map 2.6 s.

**Round 6** — after the security-review fixes, on five repositories: every map complete with
no extraction failures and no detector errors; open findings forge 366, tervin 470, warden
139, fullstack-app 111, circuit-breaker 18. The round found FB15 and FB16, fixed in the same
round and re-measured.

**Round 7, a measured audit** — five further repositories (Django with React, Angular/Ionic
with Android Java, a TypeScript library, React with Supabase SQL migrations, FastAPI with
React Native), mapped and diagnosed through the harness and through 25 live Claude Code
sessions with the installed plugin. A stratified random sample of 100 findings (20 per
repository, every finding kind represented) was checked against the source by independent
reviewers and re-checked by hand where a fix depended on it: 51 true, 14 factually wrong, 35
true but not worth flagging. The fixes (0.1.5) kept 50 of the 51 true findings and removed 36
of the 49 false ones; the 13 left are threshold judgements (a 7-parameter recursive helper, a
class one method over the limit, a context module that is a hub by design) and stay. A second
review of every finding that changed on the five earlier repositories found 74 removals
correct and 2 wrong (stale copies of a main module, now handled), and 20 of 22 new findings
invalid (structural Protocols, now excluded). Two of the live sessions lost their map to a CLI
crash when output was piped into `head` (fixed), and the full write path on the TypeScript
library showed that its tests need loopback and run `ps`, which the macOS sandbox refuses
(now explained, and loopback is an opt-in setting). Rerun with loopback on and those four
test files excluded, it completed end to end through live sessions: a slice planned from a
real finding and approved, a refactorer agent editing only in the worktree, the project's
2,604 unit tests and its TypeScript typecheck passing in the sandbox, all ten proof
obligations passing, the change approved and ACCEPTED, the main checkout untouched and the
signed ledger intact. That run also found linked `node_modules` being staged into the patch
(fixed in 0.1.6).

**Round 8, an unbiased re-check** — eleven repositories with 0.1.6: every map complete, no
extraction failures, no detector errors. A fresh simple random sample of 110 findings (ten per
repository, so the mix is what a user sees) was checked against the source: 83 true (75%), 5
factually wrong (5%), 22 true but not worth flagging (20%). The five wrong ones are fixed in
0.1.7. Most of the 22 are matters of taste: long but simple UI components, framework
boilerplate that looks alike (Redux slices, ORM models), data-heavy functions and classes, and
values just over a threshold; an earlier audit judged some of the same components the other
way, so these are left as they are. Live sessions with the installed plugin turned up one more
crash (a Python extractor exiting early), fixed in 0.1.7.

**Round 9, live sessions and the change workflow across languages** — the precision work from
round 8 landed (one finding per function, a data-literal discount, Rust inline test modules
excluded), and a spot check of everything it stopped flagging found one more over-eager rule
(FB17). The Linux sandbox ran on real bubblewrap in CI for the first time and turned up four
faults the macOS-only runs could not: a bind of `/private/tmp`, hidden paths that did not exist,
projects under `/tmp`, and signal exits reported as codes. The change workflow then ran end to
end through live sessions on a uv workspace (FB18), a Rust crate (FB19) and, with a new
live-session suite that installs the plugin as a user would, on three pinned public
repositories in Python, JavaScript and Rust (FB20, FB21). The final suite run before 0.1.10:
fifteen read-only sessions and three change workflows, all passing, every slice ACCEPTED with
only its planned file staged, for $3.45 of model usage. The suite now runs nightly in CI.

**Round 10, first-run usability and .NET** — a first-run review, done the way a new user would
(an agent asked to use Unknot, the person doing only the human steps), covered everything from
the first command to the change workflow (FB23–FB34). Every problem that depends on the code
was reproduced and re-measured on nopCommerce, a public .NET monolith: there, released 0.1.10
detected no commands, reported `complete`, gave an identical fan-in to every file of a
namespace, and returned nothing for a glob scope. The
largest fix is C# resolution by type rather than by namespace, which cut nopCommerce's edges by
three quarters and its cold map from 64 to 8.6 seconds, and removed most module and
decomposition findings, which came from the false edges. Two requests were answered
differently from how they were asked: the agent still cannot end a run during its turn (FB31),
and lanes (FB33) never approve a change, only the plan.

**Round 11, the same review on 0.1.11** — the fixes from round 10 held (agent-run `init`, stable
records, the refusal of `cli install` from an agent), and the second pass found the next layer
(FB35–FB39): guidance that forbids a command, cycles too big to act on once the C# graph was
complete, and records that read wrong. Re-measuring found a regression the unit tests could not:
the new robustness detail made decompose twelve times slower on a large repository (FB39),
fixed before release.

**Round 12, the review again on 0.1.13** — everything from round 11 held except one item, and the
reason it failed was worth more than the item: a cache that outlived a change in classification
(FB40). The fresh clones used to re-measure every round had hidden it; this round's re-measure
upgrades a mapped clone in place instead.

**Round 13, a first build attempt on 0.1.13** — moving from assessment to changing code found the
seams between features rather than bugs inside them: the graph knew the safest change but
diagnose did not offer it (FB43), the hook fix from round 10 failed once the person followed
Unknot's own advice and installed the CLI shim (FB44), risk came without reasons (FB45), and
re-running `init` could have undone an accepted configuration (FB46).

## What the loop does not do

It never accepts its own proposals, never disables a detector, and never treats repository
text as feedback. Calibration changes ranking; thresholds change only through
`config.proposed.yaml` and a person running `unknot config accept`.
