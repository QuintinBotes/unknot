# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[semantic versioning](https://semver.org/); see `COMPATIBILITY.md` for what counts as public API.

## [Unreleased]

### Fixed

- A member access whose receiver has a declared type outside the mapped files (`ctx.X` where `ctx` is a `ShopContext` declared elsewhere) no longer counts as a possible use of a same-named injected member on a mapped type, unless that type is the declaring type or related to it by name or inheritance; the member is reported as unused (#19). Only receivers with no declared type at all (call results, `var x = Make()`, lambda parameters) keep the name-only, lowered-confidence path, and the edge now names the files holding them (`possible_receivers`). Generic adapter 0.1.5.
- A slice planned from a finding that a re-map no longer reports is shown as stale in `unknot status`, `unknot slice` and the MCP `slice_get` and `status` tools, naming the finding; its state and approvals are untouched (#19).
- Upgrading in place no longer locks a running session out of its shell (#18). `schema_version` in the store now names the oldest release that can use it, and migrations that only add something (like 0.2.0's fact digest) leave it alone, so hooks of 0.1.12 to 0.2.0 keep working once a newer CLI has opened the store; a store a 0.2.0 CLI raised is lowered again. A future migration older releases cannot live with waits while their hooks ran in the project in the last 15 minutes, and says to reload plugins. Hooks that find a store newer than themselves still run reads and read-only commands, refuse the rest, and name the fix: reload plugins or start a new session.
- The `unknot` shim runs the CLI of the plugin version the session loaded (its `bin` is on the session's PATH), not the newest installed; `unknot cli install` updates an older shim. `unknot doctor` warns when a session's hooks run another release than the CLI, or when the shim predates this.
- The upgrade test runs each earlier release's hook against the store after the current CLI has opened it.

## [0.2.0] - 2026-10-06

### Added

- Identifier-like string constants (metric names, configuration keys, routes, roles, queue names) are graph nodes: `constant:<value>` with an inferred `subkind`, `DEFINES` edges from where a string or key is defined and `REFERENCES` edges from where it is used, directly or through its constant's name (`literals` adapter). Prose and log messages are not indexed; per-file and per-repository caps give a notice; `map` and `status` report the count. `unknot search` and `search_text` answer exact and prefix matches from these nodes and say whether the graph or a scan answered (`--scan` forces the scan).
- Store migrations are ordered and named (`runtime/state/migrations.mjs`), recorded in `meta`, and run in one transaction on open; a store newer than the runtime is refused.
- Saved decomposition records, and slice and campaign bodies shown by tools, are upgraded on read when an older release wrote them (`runtime/state/upgrade.mjs`).
- `scripts/upgrade-test.mjs` and the `upgrade from previous releases` CI job map a fixture project with each of the last five releases and upgrade it in place with the current checkout.
- Repository guidance (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Copilot and Cursor rules, `CONTRIBUTING.md`) is read nearest-first and can only tighten policy: a path it forbids becomes a protected path, recorded with its source.
- Derived graph facts (components, declared-only edges, public surface, test code, ownership) are computed once per map and read by every command, and a consistency suite checks that commands agree.
- Release channels: `main` is beta (the repository's own marketplace); a release tag advances the `stable` branch, which the catalog entry pins.
- Accuracy harness (`scripts/accuracy.mjs`, `docs/accuracy.md`): a pinned corpus of public repositories in seven languages, stratified precision per finding kind and language against labels, and recall of seeded defects.
- Benchmark tiers of 50k, 250k and 1m generated files in five languages, with per-phase timings, peak memory and store size (`docs/benchmarks.md`).
- `unknot search <text>` and the `search_text` MCP tool: where a string is defined, what references it (one hop through constants) and who owns those files.
- C# member accesses resolve their receiver's declared type (fields, properties, parameters, locals, `new`, casts, patterns, `foreach`), so a same-named member on another type no longer hides an unused one; resolved calls become module-level `CALLS` edges with a count (#9, #12).
- `unknot graph edges <node> --direction in|out|both`; `unknot graph nodes --name/--path`; `graph neighbourhood` counts edges per relation (#12).
- `unknot graph cycles --max-cycles N|all` (default 50; `all` lists up to 5,000), a notice when the cap is hit, and cut candidates on every listed cycle, ranked by how many listed cycles each edge is in (#13).
- `unknot map --branch-ok <branch>`: the map warns when the mapped checkout is not the default branch, is behind it or its upstream, is a detached HEAD or has uncommitted changes, and `status` repeats it (#11).
- `unknot policy denials`: recent refusals with their rule and next step.

### Changed

- `boundary.outbound_dependencies` (and `_test`, `_low_confidence`) and `outbound_dependency_targets` name what a candidate depends on; the `reverse_deps*` metrics and `reverse_dependency_targets` remain as deprecated aliases until 0.3.0 (#15).
- Refusals name the rule, the operand and its role (the copy destination, the redirect target, the rm operand) and the next step, and the precise check runs before the general one (#8).
- The read budget counts each file once, however many adapters read it, and a map of a repository above it stops before reading anything, naming the setting. Defaults: 250,000 files, 4 GiB.
- `duplicated-authorization` needs the same check shape (a call or annotation with a quoted role or permission) in three or more modules outside an auth package; matching names alone no longer count.
- Imports of a whole package (Go, Java wildcards, Swift) are marked `package_level` and are not fan-in of each file in the package, so hub findings are about files.
- A re-map writes only the facts, nodes and edges that changed (a content digest per fact, migration `facts-digest`); with nothing changed the store is not written and the generation stays. Derived facts are recomputed only when the graph changed. A fact's `observed_at`, `commit_sha` and `generation` now record when it last changed.
- Components above 50 modules or 400 edges get their cut from an ordering in linear time (declared-only edges first, then the Eades-Lin-Smyth heuristic); the derived record says `cut_heuristic`, and `cut_minimal: false` when the work budget ran out. Smaller components keep the greedy search.

### Fixed

- `supersedes` links the newest record of a chain and never makes a loop when a boundary changes back (#14).
- Commands that mention `.unknot` are allowed when the plugin path changed after an update or the CLI shim is used, and a plain `cp` that only reads from `.unknot` is allowed (#8).
- Extraction results reach the graph in file order, not worker completion order, so repeated maps give identical facts and findings.
- Python files reach the AST extractor in parts of at most 300 files or about 1.5 MB. A large repository's extractor output was cut at the 16 MiB command output limit and later files were read lexically without a notice, hiding dead code; a part that times out is now retried once with twice the time, and only a part that fails again is read lexically, with a notice giving the count.
- TypeScript `import type` / `export type … from` and Python imports under `if TYPE_CHECKING:` are marked `type_only` and no longer close dependency cycles.
- Vendored files are recognised by their header (a `/*!` licence banner, emscripten output) and more vendored directories, and are no longer analysed as project code.
- `.vue` single-file components: their `<script>` and `<script setup>` blocks are read, so the modules they import are no longer reported as unused.

### Known gaps

- Go repositories get no hub findings until imports are matched to the files whose symbols are used.
- Constant sub-kinds are heuristic and labelled inferred.
- Java receiver types are not resolved yet, so unused injected members are found for C# only.

## [0.1.15] - 2026-10-06

Fixes from a first attempt to build with Unknot on 0.1.13.

### Added

- `diagnose` reports an injected member that is never used (`code.unused-injected-member`): one
  finding per such member, scoped to its file, naming the member and the type it holds, ranked
  higher when it closes cycles. It plans into a one-file, low-risk deletion slice that a lane can
  cover.
- `plan`, `plan show`, `unknot slice` and the `slice_get` tool say why a slice has its risk, who
  must approve it, and whether a lane could cover it (`lane: not eligible (medium risk; ...)`).
- `status` and `doctor` say when a newer configuration proposal is waiting for a person.

### Changed

- The declared-only marking of a C# member is checked across the repository: a public member
  that another file reaches is no longer "unused". Removing a public member that is unused in
  the repository passes the API-compatibility obligation with a note in the proof bundle
  ("public but unused in this repository; consumers outside it are not visible").
- With a configuration already accepted, `init` proposes that configuration plus what is newly
  detected (commands, protected paths), keeping its mode and approvers, and writes nothing when
  nothing is new. Before, re-running `init` proposed a fresh default, which accepted would have
  reset the mode to plan and dropped the approvers.
- The C# adapter keeps the identifiers each file uses for the repository-wide check: a cold map
  of a 3,600-file .NET repository takes about 10% longer and its state about 9% more space.

### Fixed

- Agent commands that mention `.unknot` were refused when the first `unknot` on PATH was not
  this plugin's exact install path: after an update inside a running session (PATH still names
  the previous version) or once the `unknot cli install` shim is installed. Both now count as the
  plugin's CLI; a look-alike inside the project still does not, and the refusal names the file.
- A plain `cp` that only reads from `.unknot` (copying a proposal out) is not refused; only a
  copy's destination counts as written.

## [0.1.14] - 2026-10-06

Fixes from a third review run, on 0.1.13.

### Fixed

- A re-map extracts a file again when the census classifies it differently, even if its bytes
  did not change. Before, files that newer rules (or a new test `.csproj`) make test code kept
  their cached `is_test: false`, so test helpers stayed decomposition candidate members after an
  upgrade. The first map after upgrading re-extracts every file once.
- A project file named like a test project (`*Tests.csproj`, `*Specs.csproj`) or setting
  `<IsTestProject>true` marks its directory as test code, also when the test SDK arrives through
  shared build files rather than the project's own references.

### Changed

- Sibling folding reaches below a directory where the candidate has at least two members (never
  below the root or a top-level directory), and a whole small cluster used only by one candidate
  joins it instead of standing as a candidate of its own.
- A decomposition record whose members changed, and so its id, names the record it replaces
  (`supersedes`, `supersedes_overlap`); `decompose list` shows the earlier one as replaced.

## [0.1.13] - 2026-10-05

Fixes from a second first-run review on 0.1.11.

### Changed

- `unknot graph cycles` lists every member of each strongly connected component, its
  elementary cycles (shortest first), the edges whose removal breaks it, and a "declared only"
  marker on an edge held only by an injected member nobody uses. `--json` returns
  `{size, members, cycles, cycles_truncated, cut}` per component instead of a list of members.
- Decomposition records carry the cycle detail of the candidate's internal component, and
  `cycle.crossing_size` names what `cycle.size` measures (cycles crossing the boundary), next
  to `boundary.internal_cycle_size`.
- Rejected treatments lead with the predicates that failed (signal, value, threshold), then
  the evidence that is missing; the same text in `--summary` and `show`.
- A driver the chosen treatment does not serve is listed under `drivers_not_served` with the
  reason, instead of being left out.
- .NET test projects (`*.Tests`, `*.UnitTests`, a `.csproj` that references a test SDK) are
  test code, so they are never candidate members; a same-folder module used only by a
  candidate is folded into it rather than counted as a reverse dependency.
- Records name the owners and their shares, de-duplicate evidence ids, say which clustering
  run broke a boundary that is not robust, and name the decompose run that wrote them.
- `init` does not propose a command that the repository's AGENTS.md, CLAUDE.md or
  CONTRIBUTING.md says not to run (it quotes the sentence, and lists test projects instead of
  `dotnet test` on the solution); nested checkouts and `.claude/` are not scanned; one note per
  proposed pipeline path.
- Until the stable `unknot` command is installed, hand-offs give the full
  `node <path>/bin/unknot ...` command first and offer the install once.

### Added

- `unknot decompose prune [--dry-run]` removes superseded records (from an older version, or
  from an older graph generation that a later run replaced) and keeps any record a campaign
  or slice refers to. `decompose list` marks them.

### Fixed

- Declared-only detection in C# handles `nameof(...)`, `?? throw` guards in constructors and
  `using` aliases.
- A handoff from an agent started outside a run may carry `run_id: null` instead of a made-up
  id.

## [0.1.12] - 2026-10-05

Repository housekeeping for open-source contributions; no runtime changes.

### Added

- A code of conduct (Contributor Covenant 2.1), issue forms for bugs and feature requests (security
  reports go to private vulnerability reporting, now enabled), a pull request template, CODEOWNERS,
  Dependabot updates for the SHA-pinned GitHub Actions, and an `.editorconfig`.

### Changed

- `main` is protected (pull requests with passing CI only, no force pushes or deletion, for
  maintainers too) and release tags are immutable; `CONTRIBUTING.md` and `docs/release.md` say so.
- Package metadata (keywords, homepage, issue tracker), README badges, and the supported-versions
  note in `SECURITY.md`.

## [0.1.11] - 2026-10-05

### Added

- Lanes: one signed plan approval for the low-risk slices of a campaign
  (`unknot lane approve <CMP-id>`, human only). Inside a lane the agent applies and verifies
  covered slices itself (`/unknot:lane`); each patch must only delete code or only change
  tests, within a size cap. A replanned slice, a config change, expiry or `unknot lane revoke`
  ends coverage. Changes are still accepted by a person: `unknot lane review`, then
  `unknot approve --lane <LN-id>`.
- One scope language for every command (`runtime/core/scope.mjs`): paths, globs,
  `ns:<namespace>` and `seed:<module or type>~N` (a module and its import neighbourhood).
- `unknot decompose list | show <DEC-id>`, `--dry-run`, `--summary`, `--driver-source` and
  `--driver-quote` (recorded as driver provenance), and a per-candidate readiness table
  (signal, value, threshold, missing evidence) for the treatments that were rejected.
- `unknot graph neighbourhood <id|path|Type>`; `graph edges --type --from --to`; hubs over
  several edge types; scoped hubs and cycles.
- `unknot cli install | status | uninstall`: a stable `unknot` command for a normal terminal
  that runs the newest installed version, so it survives upgrades. Doctor reports it.
- Runtime metrics accept the Prometheus HTTP API JSON response; `docs/runtime-evidence.md`
  explains how to export runtime evidence from hosted observability vendors.
- `unknot init` detects .NET solutions below the root, proposes protection for Azure DevOps
  pipelines anywhere and for central .NET build files, lists commands named in AGENTS.md,
  CLAUDE.md or CONTRIBUTING.md as hints (never as commands), and says why when it detects
  nothing. NuGet manifests count as dependency changes.

### Changed

- C# dependencies resolve at type level: a `using` links a file only to the files declaring
  types it mentions, and same-namespace references now link too. Before, every `using` linked
  to every file of the namespace. A dependency held only by an injected member that is never
  used is marked, and a cycle that closes only through one says so and ranks lower. Fluent
  Entity Framework mappings (`ToTable`) are recognised.
- `map` reports per-language coverage and is `partial`, with the reason under `unavailable`,
  when the dominant language is read lexically. Root CODEOWNERS files are read under any scope.
- `decompose`: the scope matches the way `map` does and warns when it matches nothing;
  record ids are stable across runs (fingerprint of target, drivers and members); candidates
  are named by namespace or directory, with the hub file when names collide, and list their
  top files; cohesion, coupling and stability are in the record; favouring signals cite the
  ids they were measured on; `selection_reason` explains non-retain treatments; the first
  slice lists every module; reverse dependencies leave out low-confidence imports and count
  test targets separately; the strangler seam check says "visible in this repository" and
  counts traced inbound calls.
- Graph tools honour their filters, return compact results by default, and cap MCP results at
  about 40 KB with a hint on how to narrow; table output never cuts ids.
- The model may run `/unknot:init` (it only writes a proposal). The README Quickstart has a
  read-only track that needs no accept, keys or approvers.
- Human-only commands refused for lack of a terminal say so (Claude Code's `!` prefix is not
  interactive) instead of blaming an agent, and hand-offs print how to reach the CLI.
- A run governs only the session that started it, and a read-only command's run left open by
  an interrupted turn ends with the next message.

### Fixed

- A slice starts only from its approved baseline: an existing `unknot/<slice>` branch at another
  commit is refused instead of reused, and the diff budget (and a lane's shape check) is
  measured on the staged patch against the baseline, which is what gets hashed and approved.
  Accepting a change re-stages the worktree and refuses if it no longer matches the approved
  diff. Found by an adversarial review of the lane design.
- During a run, commands cannot be left running in the background, and wake-ups, monitors,
  cron and remote triggers are refused: they would let work continue after the run's turn.
- A shell command that only writes text mentioning `.unknot` into another file (a heredoc
  appended to notes, a plain `cat`, `echo` or `printf` to a literal file) is no longer refused;
  any other command that mentions `.unknot`, including one split by quotes, still is.
- Hand-backs are bound to the active run: a made-up run id is replaced and kept as a warning,
  `submit_handoff` outside a run is refused, and an agent that reported through
  `submit_handoff` is not blocked for a missing block. Agent examples no longer carry a literal
  run id.

## [0.1.10] - 2026-10-05

### Fixed

- A project inside a hidden directory stays usable in the sandbox. Claude Code background
  jobs clone into scratch space inside the Claude config directory; there, the project was
  unreadable to every brokered command, so Python extraction fell back to lexical reading and
  tests could not run. The project's working set is put back after the secret rules, and
  secrets nested inside it stay hidden. A project at `$HOME` gets nothing back.
- A degraded extraction batch (one that raised a notice) is no longer cached. Before, the next
  map served the fallback facts from cache and reported `complete` with no notice.
- Tools that search upward for a manifest work in a slice worktree: the main checkout's
  tracked top-level files are readable from there (its untracked files, such as `.env`, stay
  hidden). cargo failed the baseline of every crate without `[workspace]`, because the hidden
  `Cargo.toml` above the worktree read as "not permitted" rather than "not found".
- Staging a slice no longer fails when `.gitignore` lists `node_modules` without a trailing
  slash (git refused the exclude pathspec for the linked dependency directory).
- Data-line discount: values directly inside a call's parentheses (a log message, a toast
  text) are arguments, not data. Titles mention data lines only when they are at least a
  tenth of the size.
- Apply: the slice is written only by the refactorer or the session, never handed to an
  external agent (a standing instruction to delegate to another tool sent a live session
  into a blocked call, and it stopped without patching). A hook denial means adapt, not stop.

### Changed

- A destructive migration that is the contract step of an expand/backfill/contract sequence
  (a column added and backfilled in the few preceding migrations of the same directory) is
  recognised: the finding says so, no longer advises splitting it, and ranks lower. The drop
  itself is still reported, because it is still irreversible without a backup.

### Added

- `scripts/live-suite.mjs` and the nightly `Live sessions` workflow: the plugin installed as a
  user installs it, every read-only step on pinned public repositories (Python, JavaScript,
  Rust), and the change workflow on one in rotation. Needs an `ANTHROPIC_API_KEY` secret.
- `scripts/writepath-e2e.mjs --plugin-dir`: run the sessions on a checkout before a release.

## [0.1.9] - 2026-10-05

### Fixed

- Linux sandbox, now exercised on real bubblewrap in CI: system temp paths are bound only
  where they exist (bubblewrap refused `/private/tmp`), hidden paths are mounted over only
  when they exist, a project under `/tmp` stays visible, and a child killed by a signal is
  reported as killed (bubblewrap returns 128+N).
- Editable Python installs (uv workspaces, `pip install -e`) resolve to the slice worktree's
  code during verification, through PYTHONPATH; before, tests imported the main checkout's
  unchanged code (and, in the sandbox, could not read it).

### Changed

- One finding per function: long, complex and deeply nested findings for the same function
  merge into the highest-priority one, which keeps its fingerprint and decisions.
- Size findings discount data literals (translation tables, seed data, mock scenarios), and
  say so in the title; `component_min_cyclomatic` lets a team skip long but simple UI
  components.
- Rust inline `#[cfg(test)]` modules no longer count toward module size.

### Added

- `scripts/writepath-e2e.mjs`: the change workflow end to end on a disposable clone of a real
  repository, with live sessions doing the patch and a test approver playing the human.

## [0.1.8] - 2026-10-05

### Fixed

- Inside Claude Code sessions every Python file was read lexically: the sandbox hid the
  Claude config directory, which is where an installed plugin lives, so `python3` could not
  read Unknot's own `extract.py`. The plugin directory is now readable in the sandbox (it
  holds no secrets); the rest of the config directory stays hidden. Found by running the
  installed plugin on a fresh Python repository.

### Added

- The map result lists `notices` for degraded-but-working conditions, starting with the
  Python AST extractor being unavailable, so a lexical fallback is never silent.

## [0.1.7] - 2026-10-05

From a second, unbiased audit: a fresh simple random sample of 110 findings across eleven
repositories, checked against the source. 83 true (75%), 5 factually wrong (5%), 22 true but
not worth flagging (20%). The five wrong ones are fixed here.

### Fixed

- A child process that exits before reading its input no longer crashes the CLI with EPIPE
  (live sessions on Python repositories lost their map this way); the failure is recorded
  and the Python adapter falls back to its lexical reader.
- Modules named by dotted path in strings (Django and DRF settings, Celery routes) are
  referenced, in AST and lexical extraction alike.
- Secret findings ignore optional-chain reads (`signature?.apiKey`), values that contain
  their own label (`token: 'jira-token'`) and sequential fillers; redaction is unchanged.
- Package entries declared under `dist/` map back to `src/` for implementation-leakage.
- Terraform providers are judged only by infrastructure.floating-versions (lock files,
  reusable modules), not again as unpinned build inputs.
- Re-export facades (`__init__.py`, index barrels) are not unstable dependencies.

## [0.1.6] - 2026-10-05

### Fixed

- A slice worktree's linked dependency directories (`node_modules` and similar, symlinks to
  the main checkout's) were staged into the patch when `.gitignore` names them with a
  trailing slash, which matches directories but not symlinks. Found by running the full
  write path on a real TypeScript repository.

### Added

- `unknot slice <id> diff`: the slice's patch, read-only, for agents that cannot run shell
  commands inside `.unknot/`.

## [0.1.5] - 2026-10-05

Precision release from a measured audit of five further repositories: 100 sampled findings
checked against the source (51 true before; after, 50 of them kept and 36 of 49 false ones
gone). See docs/dogfood/README.md, round 7.

### Fixed

- TypeScript generic calls (`createThunk<A, B>(...)`) no longer turn type arguments into
  exports; unreachable code ignores type-annotated nested declarations and unparseable files.
- Command execution is flagged only through `child_process` bindings (not `RegExp.exec`);
  placeholder credentials (`${VAR:-changeme}`, `ghp_secretsecret…`, `change_in_production`)
  are not findings, while redaction stays conservative; SQL f-strings that interpolate only
  module constants are not injection.
- Speculative generality judges abstract classes only (not names like *Manager, and not
  structural Protocols). Stale copies (`main_old.py` beside `main.py`) stay dead code.
- Clones ignore imports, re-exports, decorators and data-only runs (style sheets, option
  objects); similarity threshold 0.5; migrations are not compared.
- Entry points: Python scripts (shebang or `__main__`), Django convention modules, files
  started by path from code, generated component libraries (`components.json`); Meteor
  eager-loaded files only when they run something at load time.
- Oversized APIs skip barrels, type exports and component libraries; Angular/NestJS
  dependency-injection constructors are not long parameter lists; messaging calls need a
  messaging client; lazy and `TYPE_CHECKING` imports do not form cycles.
- Generated files: markers in block comments and docstrings, `.gen.` names, minified files,
  Capacitor/Cordova build output; `e2e/`, `cypress/` and `playwright/` are tests.
- Migrations that drop and re-create a function, trigger, view or index are not destructive;
  Terraform lock files and registry-prefixed sources are matched; locked root modules with
  `>=` are a low-priority finding; deploy steps ignore URLs and directory names.
- The CLI survives a reader closing stdout early (`unknot map | head` lost the map).

### Added

- `security.sandbox_loopback` (default false): lets sandboxed tests use 127.0.0.1. Baseline
  failures caused by the sandbox (blocked loopback, setuid programs such as `ps`) say so.

## [0.1.4] - 2026-10-05

### Added

- MongoDB collections in JavaScript and TypeScript: Meteor `new Mongo.Collection('x')`,
  Mongoose `mongoose.model('X')` and the driver's `db.collection('x')`, with reads and writes
  resolved through imports and re-exports to the defining module. They become `table` nodes
  with `QUERIES` and `MUTATES` edges, so data affinity and the database detectors cover
  MongoDB applications.

### Fixed

- The decompose skill reads recommendations with the `decomposition_get` tool instead of
  trying to read `.unknot/` from the shell, which policy denies.

## [0.1.3] - 2026-10-05

### Fixed

- A committed `.terraform.lock.hcl` is read: providers it pins are not reported as unpinned,
  and child modules may state minimum versions (`>=`) as Terraform recommends. On the test
  repository this removed three findings that had ranked first.
- React class `render` methods and default exports in files containing JSX (including `.js`
  files) use the component line threshold; an anonymous default export is named by its file.

## [0.1.2] - 2026-10-05

More fixes from the same repository, measured on it: open findings 878 → 554, and
"module imported by nothing" findings 246 → 15, each remaining one checked by hand.

### Fixed

- Files whose code mentions `autoGenerated` (or similar) were classified as generated and
  skipped; generated markers now count only in comments at the top of a file.
- Root-relative imports (`/imports/x`, Meteor and several bundlers) resolve against the app
  root or the repository root.
- Babel's export-default-from forms (`export X from './x'`, `export X, { a } from './x'`,
  `export default from './x'`) are re-exports.
- `Meteor.subscribe` and `Meteor.publish` are DDP data publications, not message channels, so
  they no longer produce idempotency findings.
- Whether a resource has an owner is unmeasured, not 0, when the repository records no
  ownership at all; pinning patterns no longer read as contraindicated for that reason.
- Entry points the unreferenced-module check now recognises: Meteor package manifests and
  the files they name, Meteor eager loading (no `meteor.mainModule`), Meteor `private/` and
  `public/`, Storybook config and stories, `.d.ts` files, sample configs, k6 scripts, and
  `*.tests.*` test files.

## [0.1.1] - 2026-10-05

Fixes from running the installed plugin on an unfamiliar repository (a large Meteor and React
application with GitLab CI).

### Fixed

- Default protected paths cover the CI definitions of every system the delivery adapter
  parses (GitLab, CircleCI, Azure Pipelines, Jenkins, Buildkite, Bitbucket) and git hook
  directories, not only GitHub workflows.
- `init` proposes `lint` and `typecheck` from an ESLint config or `tsconfig.json` plus the
  dependency when there is no script (linting that runs through husky or lint-staged), and
  notes missing `node_modules` and commands whose executable cannot be found.
- Deploy targets inferred from CI job names ignore emoji and punctuation, and stage words
  such as `review` and `test`; `🚀 deploy` no longer becomes a deployable named `🚀`.
- History reads at least `decomposition.history_min_commits` (default 1,000) recent commits
  when `history_days` holds fewer, so quiet repositories still yield co-change evidence; the
  map reports when the window was extended.

### Added

- `unknot graph hubs` and the `graph_hubs` MCP tool rank modules by fan-in and fan-out; the
  cartographer uses them instead of piping JSON into an interpreter, which policy denies.

## [0.1.0] - 2026-10-05

Initial release.

### Added

- Plugin runtime with the safety kernel: state machine, capability model, path and command
  broker, worktree isolation, event and evidence ledger, hook enforcement.
- Repository mapper with language, database, infrastructure, delivery and ownership adapters,
  and a generic multi-language adapter.
- Diagnosis with local and module detectors, ranked findings and pattern cards.
- Slice lifecycle: planning, approval gates, worktree-confined apply, verification engine,
  attestations, proof bundles and rollback.
- Opt-in OpenTelemetry-compatible telemetry (file or allowlisted OTLP exporter) with a content
  allowlist; off by default.
- Release pipeline: reproducible tarball, `SHA256SUMS`, CycloneDX 1.5 SBOM and Sigstore
  provenance attestations; published benchmark fixtures and harness.

### Migration notes

Initial release; there is nothing to migrate.

### Security

No advisories.
