# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[semantic versioning](https://semver.org/); see `COMPATIBILITY.md` for what counts as public API.

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
