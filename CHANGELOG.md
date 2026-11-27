# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[semantic versioning](https://semver.org/); see `COMPATIBILITY.md` for what counts as public API.

## [Unreleased]

### Added

- A slice can be verified in CI with no local key, and the attested result recorded (#153; docs/forge-approvals.md control 5). Pin the reusable `.github/workflows/unknot-verify.yml` by commit in `approvals.forge.ci_workflow` and call it from a push workflow on `unknot/**`; `unknot pr` then ends the pushed commit's message with an `Unknot-CI:` line, the plan CI runs. The workflow's read-only `run` job runs the slice's command obligations on that commit (`unknot verify --in-ci`, no Unknot state, no key) and uploads the evidence; its `verify` job, which runs no repository code, attests the file with `actions/attest-build-provenance`, is the `unknot / verify` check (failing when a command failed or the `run` job did not succeed) and posts a neutral `unknot / not run in CI` check for human and built-in obligations. `unknot verify --from-ci <pr>` records the evidence only when `gh attestation verify` and Unknot's own certificate checks agree that it is the pinned workflow at its pinned commit, on the bound head and slice branch, in the pinned repository, from a push on a GitHub-hosted runner, from the latest run and attempt, with the head's `.github/workflows` equal to the base branch's on GitHub; then each command obligation run with the exact command this clone would run and exited 0, in a run GitHub reports as `success`, is recorded as passed with actor `ci:<workflow>` (`--in-ci` exits 1 on a failed command, so slice code that rewrites the evidence file cannot turn a failure into a pass). Human obligations and built-in checks are never recorded from CI. `unknot doctor` fails while the base branch does not require `unknot / verify`. The config schema gains one optional key; no store migration.
- Slices can be approved through GitHub pull request reviews bound to the head (#152; docs/forge-approvals.md controls 2 to 4 and 6). Opt in with `approvals.via: forge` (only reviews count) or `both` (reviews or local signatures); the default stays `local` and nothing reaches GitHub. Roles map from `approvals.forge.roles.<role>` (`users` as numeric user ids, `teams` as `org/team`, or `codeowners: true` for a code owner of every changed path under the CODEOWNERS GitHub has at the pull request's base), and a reviewer also needs write access. `approvals.forge.repository` pins the repository (and `approvals.forge.base` the base branch, default its default branch) and `approvals.forge.agent_accounts` lists the user ids agents act as; both must be set before any review counts, and a pull request outside the repository or targeting another base counts nothing; `approvers.<name>.github_id` links a local approver to one. `approvals.forge.gh` names the `gh` binary; `PATH` is never searched. `unknot pr` then posts the change binding and the head commit it pushed, signed with the project audit key, as a comment and records `forge.binding_posted`. The new `unknot approvals <slice>` (human only, like `approve`) shows where approvals stand and, for the change stage, each reviewer's latest review and why it does or does not count: a review counts only when it is `APPROVED` on the current head, that head is the one `unknot pr` pushed (a force-push needs `unknot pr` again), the head did not move while reviews were read, the head's diff against the baseline hashes to the bound diff, the posted binding still matches (a new push, a changed plan or policy, or expiry makes it stale), and the reviewer is not the author and holds the role; a review by a listed agent account also needs the linked approver's local signature and counts only for the roles signed. Only a review's id, state, author and commit are read, never review or comment text; a malformed review is ignored and any API error counts nothing. A `REVIEW_READY` slice whose reviews complete the change stage is accepted after the person types the slice id, and only then are the counted reviews recorded as `approval.recorded` with `via: forge`. Unknot's git now ignores replace refs (`GIT_NO_REPLACE_OBJECTS=1` on every git call), so a local `refs/replace/*` cannot change what a commit id means. Every call is `gh api --hostname github.com`; Unknot never approves, dismisses or edits reviews. `unknot doctor` fails when the default branch does not require reviews and code-owner review, when `agent_accounts` is unset, or when an agent account can push to it without review. The config schema gains optional keys only; no store migration.
- Every slice records a convention report, and an approval goes stale when the guidance it came from changes (#155): a newly planned slice stores `conventions`, each rule with `rule`, `scope`, `source` (file and line), `status` and `verification`, nearest scope first. `enforced` rules are the ones Unknot checks (guidance-protected paths, forbidden commands, required commands an obligation runs, repository hook checks) and `verification` names the obligation or check; prose is `documented`, Unknot's own rules where the repository is silent are `default`, a command both required and forbidden is `conflict`, and text that tries to grant something is `flagged` with no effect. Approvals bind the content digest of each applicable guidance file (`guidance_digests`), so editing one after approval makes the approval stale with `conventions changed (<file>)`, `unknot apply` refuses with `UK_APPROVAL_REQUIRED`, and `status` (`stale_evidence.reapproval`), `next` (`needs_reapproval`) and `slice` list the slice as needing re-approval; guidance in a directory the slice does not reach changes nothing. `unknot slice show <id>` is accepted as `unknot slice <id>`, and its output groups the report by status. The slice and approval schemas gain optional fields only; a slice planned before the upgrade shows `not recorded` and keeps its approvals. No store migration.
- A release publishes only when its gates pass on the tagged commit (#154): `release.yml` runs four read-only gate jobs (tests and the restore drill; the upgrade test from the last five releases; the cross-command consistency check on the quick corpus; the 10k benchmark) and the publishing job needs all of them. Dispatching `release.yml` on a branch runs the gates alone, as a dry run. The upgrade test now carries working state across: each earlier release plans a campaign, approves its slice with a test key and applies it, and this release must then migrate the store and keep `status`, `slice`, `audit verify` and the signed approval working (an approval goes stale only because a release changed the effective config, as it does when defaults change). `scripts/bench.mjs --release-gate` gates on the bounds `main` meets (no-change re-map at most 0.1 of the cold map, a 10-file re-map at most 0.5 of it); the two #88 bounds still missed (#145) are reported, not gated. `COMPATIBILITY.md` has a Tested profile table that a test checks against `ci.yml`, `release.yml`, the benchmark shape and the config schema, and the Claude Code pin bump updates it too; `docs/release.md` makes the live session a release step whose run link goes in the release notes.
- `unknot pr <slice>` opens a draft pull request for a verified slice (#151), so a team reviews an Unknot change in its normal review flow. Human only, like `approve`: it needs a terminal, and the shell rule refuses it from an agent session. It pushes the slice's staged change as a commit on the approved baseline to `<remote>/unknot/<slice>` (the `origin` remote, or the only one), without force and with the repository's hooks off, then runs `gh pr create --draft`. The body is rendered only from the proof bundle: the objective and the finding with its evidence, the slice's convention report (#155), what ran and passed, what failed, what was not run and why, the evidence gaps and uncertainties, the security delta and how to revert; bundle text is quoted as data, long sections are collapsed and secrets redacted. Run again after a re-patch, it pushes a new commit on top, updates the body with `gh pr edit` and says the verification is stale until `unknot verify` runs again. Without `gh` or a remote it writes the body to `.unknot/runs/<id>/pr.md` and prints the commands to open the pull request by hand. `gh` is only ever called with `pr create --draft` or `pr edit`; Unknot never merges, marks ready, approves or force-pushes. The ledger records `pr.opened` and `pr.updated` events.
- A repository can limit which kinds of change it receives (#149): `apply.allowed_kinds` lists the kinds `unknot apply` accepts (`tests`, `deletion`, `documentation`, `refactor`, `extraction`, `migration`, `infrastructure`, `public-interface`); without it nothing changes. A slice's kinds are judged from the paths it reaches, its declared surfaces and, at `apply finish`, the staged diff and the API check, never only its label, so a "refactor" that removes an export is a public-interface change. `documentation` is judged from the files (Markdown, MDX, reStructuredText, AsciiDoc), never the slice's `kind`, and a slice labelled documentation whose scope reaches code now gets the code proof obligations. The change approval checks the list again, so a slice patched before the list was narrowed is not accepted. A slice the list does not accept is plan-only in `unknot plan` and in no lane, and `unknot apply` refuses it with the new code `UK_KIND_NOT_ALLOWED` (exit 3, HTTP 403) naming the setting. The key is tighten-only: organization policy intersects it and an unaccepted edit can only narrow it. `apply finish` is now asynchronous in the runtime API. Container and deployment files (`Dockerfile`, `*.dockerfile`, compose files, Helm charts) now raise a slice to at least medium risk and are in the default `protected_paths`, so a slice touching one is high risk and needs a platform owner; a slice planned before the upgrade is reclassified when it is next applied. Because the default policy changed, approvals and lanes signed before the upgrade are stale and are signed again.
- The ledger and restores can be checked against an independent anchor, and every release runs a restore drill (#150): `unknot audit checkpoint --out <file>` writes the verified head hash, event count, audit public key and time as JSON. `unknot audit verify --anchor <file>` takes only that checkpoint as the trust root and exits 4 naming `key` (signed under a different key), `truncated` (fewer events than the checkpoint) or `rewritten` (a broken chain, or a different event at the checkpoint's position), so an attacker who controls the store, even holding the audit key, cannot pass it. `unknot backup verify|restore --anchor <file>` refuses a backup whose ledger does not extend the checkpoint, and a restore or verify without `--anchor` now says the ledger was checked only against the backup's own manifest (`ledger.checked_against` in `--json`). `scripts/restore-drill.mjs` maps and plans a fixture, approves it with a test key, checkpoints, backs up, wipes, restores with the anchor and verifies through the CLI; `release.yml` runs it before publishing and CI runs it on every pull request. SECURITY.md, docs/operations.md, README and the spec now say plainly that keys, trusted policy and checkpoints are out of the agent's reach only under a separate OS user or machine, and that the worktree isolates changes, not trust. No store migration.
- A display-only campaign panel, `/unknot-panel` (#165): on Claude Code 2.1.287 and later the plugin loads a mod (`hooks/register.jsx`, under `modules` in `hooks/hooks.json`; the settings hooks there are unchanged and older versions ignore the entry). The command runs mid-turn and opens a pane with the mode, each campaign's slices by state, blockers, stale evidence and the steps waiting for a person, with the exact commands to type in their own terminal. It reads only `unknot status --read-only --json`, when opened, after each Unknot MCP tool call or `unknot` command, and every 30 seconds while open; a failed read shows the error beside the last good state, marked stale, and a repository without `.unknot` is told to run `/unknot:init`. It never approves, attests, accepts configuration or signs a lane. `npm run test:mod` runs its tests with `claude plugin test`.
- Out-of-scope edits during a slice are held at the call (#166): the mod asks the new read-only `unknot slice patching --session <id> -- <path>` before every `Edit`, `Write` and `NotebookEdit`, and while a slice is `PATCHING` refuses one its scope holds back, naming the slice, its scope, the path and the change budget left. The query judges paths with the PDP's own rule, now shared as `sliceScopeDenial`, so the two cannot disagree. It only denies, and does nothing with no slice in `PATCHING` or when another session owns the run; a slice left `PATCHING` with no active run holds out-of-scope edits in every session. It fails closed only while a slice is `PATCHING`: the query reads the slices before the configuration and names them in its error when it cannot judge the path, and a query that gives no answer refuses the edit when the last answer had a slice in `PATCHING`. `unknot status --read-only` (what the panel runs) and `slice patching` open the store read-only and write nothing to the project. The `PreToolUse` hook stays and still judges every call the mod lets through.
- Weak evidence yields a plan, not an edit (#146): every slice records `gaps` (its source findings' uncertainties and non-observed evidence, the lexical reads and analysis-coverage holes in its scope) and `evidence_strength`; a source finding with low confidence, or with more than half its evidence inferred, raises the slice's risk one level, with the reason. `unknot apply` refuses, with the new code `UK_INSUFFICIENT_EVIDENCE` (exit 3), a slice whose scope was mostly read lexically, naming the gap and the two ways forward: add semantic evidence (a SCIP index) and map again, or a person sets `evidence.allow_weak: [<campaign>]` and accepts the config in a terminal. Test-only slices are not stopped. An organization policy can forbid `allow_weak` with `false`, and its `evidence` lists now replace the repository's list by list instead of as one block.
- A rejection says why (#147): `unknot reject <F-id> --reason wrong|not-worth|other --rationale "..."` (and `reason` on `POST /v1/decisions`) stores the reason with the decision, mirroring the accuracy corpus labels; without it, and for every rejection recorded before, the reason is `other`. Only `wrong` is a false positive: `learn report` shows per detector the precision (accepted against wrong) and the actionability (accepted against not-worth) separately, `false_positive_rate` counts only wrong rejections and `not_worth_rate` is new, and threshold proposals and the ranking multiplier use wrong rejections only. A rejection without a reason no longer lowers a detector's rank or feeds a threshold proposal. The MCP `finding_get` and `findings_list` tools return `reason` for a rejected finding. The store gains a `decisions.reason` column through an additive migration (`decision-reason`); older releases still open the store.
- A repository's git-hook checks run as proof obligations, and the documentation says slice commits skip hooks (#98): commits run with `core.hooksPath=/dev/null`, so when the repository configures pre-commit (`.pre-commit-config.yaml`), husky (`.husky/pre-commit`) or lefthook, planning adds one `lint` obligation per system that runs its checks through the command broker (OS sandbox, no network), and a failing check leaves the slice unproven. If the tool (`pre-commit` or `lefthook`) is not installed, the obligation is left for a person to confirm instead of blocking every slice. Slices planned before the upgrade have no such obligation.

- COMPATIBILITY says which commands and skills are public API (#97): every command in `unknot --help` and every skill is public under semver except `exec`, `run` and `daemon`, which are internal plumbing. A test fails when a command or skill is added, removed or left unclassified.
- `diagnose --baseline <ref> [--fail-on new:<severity>]` judges a change only on what it adds (#101): it maps the tree, maps the base commit in a detached worktree into its own store, and lists the open findings whose fingerprint the base does not have, each with `severity` (`diagnose.severity` by kind, then category; cycles, hubs and security findings are `high` by default) and `location`. `--fail-on` exits 1 when a new finding reaches that severity; a base that cannot be mapped exits 5. `--json` output now carries `schema_version` `1.0`, and every listed finding its `severity` and `location`. No model and no network.
- `map` and `decompose` report progress on stderr (#89): one plain line per update with the phase, done of total and elapsed seconds, after 5 s and at most every 5 s, on a terminal or with `--progress`; stdout, including `--json`, is unchanged. `scripts/bench-map.mjs` maps a pinned public C# repository (nopCommerce) cold and warm and records wall time, peak RSS and file counts as JSON (docs/benchmarks.md).
- `decompose` is about 2.5 times faster on large graphs (#89): the graph keeps a per-type edge index instead of scanning every edge for each lookup. On Roslyn (35,502 files) a decompose dry run went from 20.1 s to 8.0 s on the same store; `scripts/corpus.json` pins Roslyn and `scripts/bench-map.mjs` times decompose (docs/benchmarks.md).
- Layer membership is a derived fact every command reads (#245): `layers` joins the derived kinds, one row per non-test module in a layer with `layer`, `index` (its place in the order, top first) and `source`: `configured` when `detectors['module.layer-bypass'].layers` lists two or more layers, else `directory` (the presentation, business and data directory names the layered style knows). `module.layer-bypass` and the layered style of `architecture` read the rows instead of matching globs or directory names themselves, so they cannot place a module in different layers; with configured layers the layered style now uses them (its evidence says `configured layers`). The rows are updated incrementally, a change to the configured layers recomputes them on the next map, and the consistency suite checks them against the graph and config, the MCP `graph_query` (`derived: layers`), the layer-bypass findings and the layered style. `DERIVED_VERSION` is 4: a store mapped before recomputes its derived facts once. A layer glob that is not a non-empty string now matches nothing instead of failing the detector.

### Changed

- Write modes fail closed without an OS sandbox (#148): `security.require_os_sandbox` is now unset by default, which means required in `assist`, `governed` and `campaign` and not in `observe` or `plan`. In a write mode with no usable sandbox every brokered command (tests, builds, hook checks, internal tools) is refused before it starts with the new code `UK_SANDBOX_REQUIRED` (exit 3), naming the platform's sandbox and how to install it, and `unknot doctor` fails (`os sandbox required`) instead of warning. bubblewrap that is installed but cannot start (no unprivileged user namespaces) now counts as no sandbox, as an unusable `sandbox-exec` already did, and the wrapper runs bubblewrap from its fixed location instead of the first `bwrap` on `PATH`. A person can opt out with `security.require_os_sandbox: false` in an accepted config (an unaccepted edit cannot, and org policy `true` forbids it); every evidence record then says `sandbox: none (explicitly allowed)`, a new value of the evidence schema's `sandbox`. Any command that runs without a sandbox, in any mode, gets an empty private `HOME` instead of the user's.
- Hook checks run on the slice's changed files, not the whole tree (#137): a pre-existing violation in a file the slice does not touch no longer blocks every slice. `verify` builds the argv from the slice's changes against its baseline commit (`pre-commit run --files <paths>`, `lefthook run pre-commit --file=<path>…`), leaves out deleted paths and passes renamed files under their new name, each path one argument and never through a shell; a slice with no remaining paths passes without running the tool. Husky has no file-list mode and still checks the whole tree, which its obligation's description now says. A missing tool is still left for a person to confirm. Obligations carry an optional `hook` field (the schema allows it); slices planned before the upgrade keep the whole-tree command.
- A re-map costs in proportion to the change, and the store does not grow with each one (#88): a map whose inputs are all unchanged (same commit, same bytes in every file, same adapters, options, evidence and imports) returns the last complete result after the census, with `unchanged: true` in its summary; the constant-use scan of `literals` reads only files whose content changed (`discover_files` in the summary says how many it scanned and how many it reused); a replaced discovery or history cache blob is deleted instead of kept, and the write-ahead log is folded into the database after each map. A map in which an enabled SCIP indexer was blocked (missing, timed out, failed) is not reused, so installing the tool takes effect on the next map; a blob shared by two caches is kept while either still references it. On nopCommerce a re-map after a one-file edit no longer grows the store by about 1.8 MB.
- A re-map after a commit reads only the new commits from git (#88): each commit's parsed changes are kept by sha (commits never change), so the history step lists the window's commits and reads the changes of those it has not seen; the summary's `history.commits_read` says how many. The result equals a history read in full. The graph no longer stores the clone fingerprints of the `quality` adapter: they serve its link, which keeps the clones they find (`attrs.clones`), and stay in the per-file cache, so module nodes are smaller and a re-map hashes and reloads less. The first map after the upgrade rewrites those module facts once. `scripts/bench.mjs --gate` and `scripts/bench-map.mjs --gate` fail when a ratio of #88 is over its bound (no-change re-map at most 10% of the cold map, a re-map after a small change at most twice the no-change one, the store at most three times the source tree); `bench-map.mjs` now also times a re-map after one file is edited and committed.
- A re-map links again only what a change reaches, the census stops opening unchanged files, and edges are stored compactly (#88, FR-001 and FR-003): each linker is told which files changed since the state it saved. The `generic` linker keeps each file's link result with the keys it looked up (module paths, type names, packages, directories, C# names and namespaces, member reach) and links a file again only when it changed or a changed file's answer to one of those keys differs; the `quality` clone linker re-pairs only modules that share a fingerprint hash with a changed file; CODEOWNERS rules are compiled once and their answer per path is kept. A change to a manifest, to the set of types or bases a file declares, to friend assemblies, or a repository with a SCIP index still links everything. The map summary's `link` says how many modules each linker linked again, and `census.cached` how many files were neither stat'ed nor opened. The result equals a cold map (compared row by row in `tests/unit/graph/incremental-link.test.mjs`). The edges table is keyed by (source, type, target) without a stored text id or a source index; `id` is a computed column, so queries are unchanged. On a 30.8k-file C# monolith a one-file re-map went from 147 s to 25 to 31 s, a no-change re-map from 4.7 s to 0.6 s and the store from 3.5 to 3.1 GiB (docs/benchmarks.md). The synthetic 50k tier still misses two of the three bounds (`bench.mjs --gate`: no change / cold 0.014, changed / no change 11.6, store / tree 50).
- A re-map after a change brings derived facts forward instead of recomputing them (#145): projection reports the node and edge rows it wrote or deleted, and when none of them is an import edge, a package, package containment or a package reference, only the node-level rows of changed modules, and the components and declared-only edges holding a module whose type, path, test flag or language changed, are worked out again from the store. Otherwise everything is recomputed, reading only the edge types derived facts use. The map summary's `derived` says `updated`, `recomputed` or `kept`. Derived rows keep the generation they were written at (the `_done` row names it), so they are recomputed once after the upgrade. Hashing fact ids no longer copies attributes already in canonical form (about half the CPU), empty cache rows are not parsed, and only linkers that keep state read it. The result equals a cold map (`tests/unit/graph/incremental-link.test.mjs`, `tests/unit/graph/incremental-derived.test.mjs`). On the 50k tier a 10-file re-map went from 12.0 s to 8.8 s (derived facts from about 2.9 s to under 0.1 s), and on a 30.8k-file C# monolith a one-file edit from 30 to 44 s to 23 to 27 s (derived facts from 5 to 9 s to milliseconds); the bound of twice the no-change re-map is still not met, because reading every file's cached facts, linking and hashing every fact still run over the whole repository (docs/benchmarks.md says why).
- Three indexes of the facts table that no query reads are dropped (#145, migration 4): about a tenth of a large store and work on every fact written. The migration does not raise `schema_version`; an existing store reuses the freed pages, a new one is smaller.
- CI scans the code and its tool pins are settled (#84): a CodeQL workflow analyses JavaScript on pull requests, on `main` and weekly; the blocking plugin validation runs a pinned Claude Code (2.1.289, the version `live.yml` installs) while a non-blocking job validates against the latest; a release takes its notes from the CHANGELOG section of the tag through `scripts/release-notes.mjs` and fails when the section is missing; versions 0.1.0 to 0.1.7 and 0.1.9 are marked as never tagged. A weekly workflow opens one PR that bumps both pins together (`scripts/bump-claude-pin.mjs`).
- Test temporary directories are removed when the test process ends, pass or fail (#85): every test creates them through `mkTmp` in `tests/helpers/tmp.mjs`, a test fails on a direct `mkdtemp` call, and `UNKNOT_KEEP_TMP=1` keeps them and prints their paths.
- The tests run git without the developer's global or system configuration (#86): `tests/helpers/git-env.mjs` sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, and every test file that runs git imports it, so a global hook, commit signing or template cannot slow or fail a test, in the full suite or in a single file.
- CI tests every Node.js line the support policy promises, and the engines floor (#87): the test job adds Node 26 and a Node 22.13.0 job on Ubuntu, COMPATIBILITY lists each line with the date its window ends, and a workflow test ties the matrix to `engines.node` and to that list, and names a line for removal once its window has ended. The new floor job found a real defect, fixed here: on Node 22.13 a statement streamed with `iterate()` was finalized mid-loop ("statement has been finalized", or a crash on Linux), so the store now streams through `Store.iterate`, which keeps the statement alive.

### Fixed

- Unknot's git reads only the repository's own objects (#221, hardening #152): it now ignores a `.git/info/grafts` file (`GIT_GRAFT_FILE=/dev/null` on every call; git has no config key for it), so a graft cannot change a commit's parents, and it refuses a repository whose object store borrows from another through `.git/objects/info/alternates` with `UK_INTEGRITY`, naming the file and the way out (`git repack -a -d`, then remove the file). Git cannot be told to ignore alternates, and an object only the other store holds would otherwise read as this repository's. Guidance discovery, `init`'s tracked-source and `.unknot/` ignore checks, and the run's recorded head now run git through the same hardened helper instead of directly. `unknot pr`'s own `git push` is unchanged.
- Config acceptance is signed, so writing the store unlocks nothing (#215, found by the review of #209): a config used to count as accepted when the store held its text and digest, so any process that could write `.unknot/state/unknot.db` could accept `mode: assist` with `security.require_os_sandbox: false`, or `evidence.allow_weak`, wider `apply.allowed_kinds` or `approvals.forge`. `unknot config accept` now signs the acceptance with the project's audit key from `UNKNOT_HOME`, over the digest, the project id, the checkout's path and the time, and records the acceptance in force for the checkout in `UNKNOT_HOME/roots/<sha256 of the checkout path>/acceptance.json`, whatever the store's project id, and for the project in `UNKNOT_HOME/projects/<id>/acceptance.json`, whatever the path (#222). Only the latest acceptance verifies: the one `config accept` wrote last for this checkout path and also the one it wrote last for this project id, so after a checkout moves and is accepted at its new path, a copy of its older store at the old path (or a bind mount of it) is superseded too. `config accept` also removes the `roots/` records of checkout paths that no longer exist (an unreadable path is kept). An acceptance that is unsigned, does not verify, is not the one in force for the checkout or the project (a replay, an older store or backup put back, a store recreated under another project id, the pre-move store of a moved checkout), was signed for another project or path, or whose key was removed is `invalid`: nothing it accepts is honoured, the file applies as unaccepted (plan mode, no approvers), the sandbox stays required where a write mode left traces, and `doctor`, `status` and `config show` say why and ask for one `unknot config accept`.
- The OS sandbox requirement holds against unaccepted mode changes and fake sandbox binaries (#170, follow-up to #148). An edit to `.unknot/config.yaml` nobody accepted, or removing the file, can still lower the mode, but no longer drops the sandbox requirement of the accepted configuration: after an agent sets `mode: plan` over an accepted `assist`, `verify` and `exec` still refuse with `UK_SANDBOX_REQUIRED` where no sandbox is available, and `doctor` still fails. A person who accepts the lower mode (`unknot config accept`) lifts it, as before. A sandbox binary (`/usr/bin/sandbox-exec`, `bwrap` at its fixed paths) now counts only when root owns it and every directory above its real path, and none of them is group- or world-writable: on Debian the `staff` group can write `/usr/local`, so `/usr/local/bin/bwrap` there is no longer trusted. The adversarial test of a fake `bwrap` on `PATH` now runs detection as Linux; it used to run as FreeBSD, where detection never looks for a binary. `PYTHONUSERBASE` and `PIP_CONFIG_FILE`, when they are absolute paths, now reach brokered commands, beside `RUSTUP_HOME` and `CARGO_HOME`, so toolchains can be found under a private `HOME`. A symbolic link at a fixed sandbox path is judged where it sits as well as where it points, so a link to `/usr/bin/true` in a group-writable `/usr/local/bin` is no sandbox, and the wrapper runs the checked real path. With no accepted configuration (`.unknot/state` removed, or `git clean -xfd`) but slice worktrees, applied slices, approvals or lanes left behind, brokered commands need an OS sandbox until a person accepts a configuration.
- `next` and `status` offer only slices `apply` can take (#178): a slice whose planned kinds `apply.allowed_kinds` refuses, or whose scope was mostly read lexically without `evidence.allow_weak` for its campaign, is never picked or listed as "Also ready" by `next` and gets no approve command in the "For you" block. Both use the checks `apply start` runs. `next` lists them as `Plan-only` or `Waits on evidence` with the reason (`plan_only` and `waits_on_evidence`, with `ways_forward`, in `--json` and the MCP `next_slice` tool); `status` lists them under "Not offered for approval", leaves them out of `awaiting_approval`, and `for_you.held` carries them for the panel and the MCP `status` tool.
- A test slice no longer waits forever on a plan-only refactor slice in the same campaign (#217): when a proposal leaves the order implicit, each slice depends on the one before it, and under `apply.allowed_kinds` a slice that can be applied now skips the plan-only slices before it and depends on the last applicable one instead. A dependency the proposal states is kept, and `next` names it in `blocked[].held_by` (in `--json` and the MCP `next_slice` tool) with the dependency's plan-only or weak-evidence reason. Without `allowed_kinds`, dependencies are planned as before.
- Plain `unknot next` says which dependency holds a blocked slice (#220): for each `blocked[].held_by` entry it prints `<slice> waits on <dependency> (<reason>)`, also when another slice is ready. The `--json` output is unchanged.
- No guidance change that applies to a slice's scope leaves its approval or lane valid (#189): approvals bind every guidance file that applies to the scope now, not only those recorded at planning, so a new `AGENTS.md` or `CONTRIBUTING.md` inside the scope, or one renamed into it, reads `conventions changed (<file>)`, and `status`, `next` and `apply` say the slice needs re-approval. A lane binds the same guidance digests for each slice it covers (`guidance` in the signed lane body), so a changed or added applicable guidance file ends its coverage of that slice until it is signed again; a lane signed before the upgrade stops covering slices that have applicable guidance, once. MCP `slice_get` and the daemon's `GET /v1/slices/<id>` return `conventions` grouped by status, as `unknot slice show` does.

- Lane eligibility agrees with apply (#171): `plan`, `plan show`, `slice show` and the MCP `slice_get` tool now list a slice that apply would refuse on weak evidence as `lane: not eligible (weak evidence: ...)`, judged per campaign with `evidence.allow_weak`, and `approve --lane` no longer covers it. What a scope reaches is no longer judged from its glob text with `*` read as one segment, which brace globs and globs ending in `.md*` slipped past: protected paths (lanes, risk, apply), guidance-protected paths, test-only and documentation-only plans now judge each brace alternative and the module paths a glob matches, so `{src/a/**,.github/**}` reaches `.github/**` (high risk, not lane-eligible) and `src/**/*.md*` is not documentation-only. A slice whose eligibility or risk changes this way is listed differently from now on; signed lanes keep their signature and apply still refuses on evidence.
- `approve --lane` reports what it accepted when a slice is refused (#173): the allowed kinds are checked before a slice's change approval is recorded, so a refused slice carries none, and the error lists every slice accepted earlier in the run (which stay ACCEPTED, and committed in governed mode), says which slice was refused and why, and carries `accepted` and `refused` in its details. MDX files no longer count as `documentation` for `apply.allowed_kinds`, because MDX can import and run code at build time; a slice that changes one is a `refactor`.
- A typo can no longer empty the graph (#186): `map --adapter` refuses an id no adapter has with `UK_CONFIG_INVALID`, naming it and the valid ids, before anything is written; it used to map with no adapter and replace the graph with an empty one. A flag that takes a value (`--adapter`, `--findings`, `--proposal`, `--scope`, `--from`, `--rationale`, `--reason`, `--days`, `--session` and the others listed in `runtime/cli/util.mjs`) given without one is a usage error naming the flag and what it expects, instead of the value `true` (which gave `no finding true` or a Node.js type error). Such errors now print as `unknot <command>: UK_CONFIG_INVALID: ...`, or as JSON with `--json`.
- A no-change re-map says it reused the last result (#182): the text output starts with `Unchanged since the last map: reused generation N from <time>` instead of `Mapped ...`, and the `--json` summary's counts describe this run: every adapter's `extracted` is 0 and `cached` equals `files`, every linker's `relinked` is 0, and `discover_files` is absent, where before they were copied from the earlier map. `generated_at` says when the reused generation was mapped (absent for a result saved before the upgrade).
- `decompose` no longer offers CI helper scripts as a backend candidate (#161): on MewsSystems/mews the first recommendation was `.github/scripts/*.py` (3 modules, confidence `medium`, above every real candidate). Modules under `.github/`, `.gitlab/`, `.circleci/`, `.buildkite/`, `.azure-pipelines/`, `.azuredevops/` and `.teamcity/` are members of no candidate; they stay in the affinity graph so the grouping of everything else is unchanged. A candidate nothing crosses (`module.consumers` 0 and `boundary.coupling` 0) is now `low`, with `confidence_lowered` saying why: its robustness was earned only by having no edges for the perturbation to move.
- Every finding records a confidence, so a low-confidence finding raises slice risk (#179): only the dead-code detectors set `confidence`, so a slice planned from, say, a lexically read C# finding stayed `low` risk with "no risk factor found", and `plan` and `status` said "none recorded (diagnose again to record it)" although diagnosing again recorded nothing. Diagnose now sets it on every finding with one rule over the evidence the finding rests on: `low` when every module it rests on was read lexically, none of its evidence is observed, its evidence factor is below 0.5, or its detector states low confidence; `medium` when a module was read only partly (lexically, a syntax error, a degraded parse), some evidence is inferred, or the evidence factor is below 0.8; `high` otherwise. A detector that judges its own confidence keeps it (the dead-code and unused-member detectors, which already weigh lexical reads, so an unused injected member in C# can still be a proven deletion as #46 intends). On a C# repository read lexically, a slice planned from, say, a long parameter list is now `medium` risk with the reason "source finding confidence is low". Findings stored before the upgrade gain a confidence the next time `diagnose` runs. Fingerprints do not read confidence, so recorded decisions still match.
- A proof bundle still matches its manifest after `unknot verify` ends (#183): verify wrote its run summary over the bundle's `verification.json`, so that file listed only the run's results and its digest no longer matched `manifest.json`. The summary is now written to `.unknot/runs/<run-id>/verify-summary.json` on every run, and the bundle's `verification.json` keeps every obligation and its status. `unknot verify --json` and the daemon are unchanged. Bundles written before the fix still fail their manifest check, and `unknot pr` refuses one with `UK_STATE_CONFLICT` asking for `unknot verify <slice>` again instead of rendering the run's results as the obligation list.
- `doctor` no longer calls a project with no accepted configuration "accepted (none)" (#180): it says built-in defaults apply and, when `unknot init` left a proposal, warns that it waits with the `config diff` and `config accept` commands, as `status` does. The warning does not change the exit code.
- `status --read-only` and `slice patching` write nothing and work on a read-only state directory (#176): a read-only open of the store left `unknot.db-wal` and `unknot.db-shm` behind, and failed with `attempt to write a readonly database` when `.unknot/state` was not writable. With no `-wal` file (no writer is live) the store is now opened as immutable; beside a live writer it still shares the WAL. Node before 22.15 cannot pass the flag and opens as before.
- Verification sees the same SCIP links as mapping (#184): the before/after graphs of `unknot verify` called each adapter's `link` without the project root, so the SCIP adapter failed on every verification, its links were missing from both graphs, and every proof bundle's `uncertainties.md` carried `scip link failed during verification` twice. `link` now gets the root, as in `unknot map`, and a supplied or cached SCIP index is imported. Verification still never starts an indexer.
- `verify` and the hooks name `apply` commands the CLI accepts (#177): they suggested `unknot apply finish <slice>` and `unknot apply replan <slice>`, which fail with `unknown apply step`; they now say `unknot apply <slice> finish` and `unknot apply <slice> replan --reason "..."`. `verify` on a slice still `AWAITING_APPROVAL` says it needs approval and `unknot apply <slice>`, not `finish`.
- An agent's refused `accept` or `reject` suggests a command that keeps its signal (#181): the suggestion carries the `--reason` (one of `wrong`, `not-worth`, `other`) and `--days` the agent gave, offers `[--reason wrong|not-worth|other]` when it gave none, and names both `/unknot:reject ...` and the same `unknot reject ...` for the person's own terminal. Before, it dropped the reason, so a person who copied it recorded `other`.
- `unknot search` no longer lists doc comments as constant definitions (#160): on MewsSystems/mews, `search TransactionContext` listed four `/// <see cref="TransactionContext"/>` lines under "Defined" as `constant cref`. A comment line (`//`, `///`, `/*`, `*`, `#`, `--`, `<!--`, `;`) now defines nothing, so a `cref`, `paramref` or `typeparamref` is a use. A scanned line that declares a type of the searched name (`class`, `struct`, `interface`, `record`, `enum`, `trait`, `type`) is listed under "Defined" as `type <Name>` (`definition.kind: 'type'` in `--json` and the MCP `search_text` tool). Constants and config keys are found as before; the literals adapter already skipped comment lines, so its output and version are unchanged.
- A C# set verb called through a receiver resolves through the receiver's type (#191): `db.Messages.Add(m)` is a table write when `db` is declared in the file (field, property, parameter or local) with a type that declares `DbSet<Message> Messages`, or inherits from one; when the receiver's type is declared in the repository and does not (`BizContext context` whose `Messages` is a `MessageComponent`), it is not; when the receiver has no type in the file (a lambda parameter, a longer chain), the write is kept as inferred with `low` confidence. A set verb called with more arguments than the set's own takes (`context.Messages.Add(client, thread, text)`; `Add`, `Remove`, `Update` and `Attach` take one entity) is another type's method and no write. The `generic` adapter is bumped to 0.1.22, so C# files are read again once at the next map.
- C# set-verb arguments are counted past commas inside generic arguments, brackets, object initializers and string or char literals, verbatim, interpolated and raw ones included (#212), so `db.Orders.Add(Make<A, B>())` is one argument and a write again. Adding to or removing from a collection navigation of an entity a `DbContext` maps with `DbSet<T>` (`reservation.Companionships.AddRange(xs)`, with `reservation` typed in the file and `Reservation` declaring `ICollection<Companionship> Companionships`) is an inferred, `low`-confidence write to the element's table. The `generic` adapter is bumped to 0.1.23, so C# files are read again once at the next map.
- Table writers are real data access (#158): a C# `Messages.Add(x)` with no receiver is a table write only when the file declares `Messages` as a `DbSet`; declared as anything else (`List<string> Messages`, `MessageComponent Messages`) it is not, and with no declaration in the file (an inherited member) the write is kept as inferred with `low` confidence. Test files that write a table are left out of `unknot database`'s writer groups and shared-writer tables and of the `database.multiple-writers` owners, and counted on their own line (`test_writers` in `--json`). A T-SQL `UPDATE t SET ... FROM orders t` (or `DELETE t FROM orders t`) writes `orders`, and an alias of an interpolated table writes nothing, instead of inventing a table named `t`.
- A GitHub Action input named `*-token`, `*-secret` or `*-password` is no longer reported as a secret (#159): a `key: value` credential assignment now needs its value on the key's own line, so a YAML key that opens a nested mapping (`launchdarkly-token:` followed by `description: ...`) is not taken for one. Literal values (`api_token: <value>`, `password: <value>`) are still reported, and `${{ secrets.X }}` is still a reference. The `security` adapter is bumped to 0.1.4, so files are scanned again once at the next map.
- A credential whose value starts on the next line is detected and redacted again (#201, a regression from #159): after a YAML block-scalar indicator (`password: |`, `>`, `|-`, `>-`), or as an indented scalar under the key (`password =` then an indented value, as in INI continuations). A next line that is itself a `key:` still opens a nested mapping, so #159's action inputs stay clean. The `security` adapter is bumped to 0.1.5, so files are scanned again once at the next map.
- `architecture` no longer takes half an hour on a large repository (#157): finding a node's parent scanned every incoming edge of that node, so each edge into a hub (a test package such as NUnit, imported by 29,000 modules) rescanned the hub's 29,000 in-edges, and the container model did that for every edge in five views. The graph now keeps each node's first `CONTAINS` parent in an index. On MewsSystems/mews (30.8k files, 1.08M edges) `architecture` went from 1,428 s wall / 481 s CPU to 47 s wall / 12 s CPU on a loaded machine, with byte-identical output; the views themselves take about 2.6 s and the rest is reading the store. The summary now prints the time per view, and `--json` carries it as `timings` (milliseconds). `diagnose` and `decompose` call the same parent lookup and get the same saving.
- The release job no longer fails the `stable` advance with a bare 403 when the release changes workflow files: it checks `.github/workflows` against `stable` first, and on that case or any 403 it fails with an `::error::` that prints the owner's command to move `stable` by hand.
- The container view shows what runs, not CI jobs (#79, from a large C# monolith where 13 CI tasks with 0 modules appeared as containers and the real web host was missing): a .NET project with a `Microsoft.NET.Sdk.Web` or `.Worker` SDK, or `OutputType` Exe or WinExe (not a test project), is a container; a Dockerfile whose `dotnet publish` or `dotnet build` names a project (relative to its `WORKDIR`) is linked to that container (`dockerfile` in the view), and a Compose service that builds that Dockerfile is the same container; a Compose service that only runs an `image:` with no build stays listed as `external: true` and is not a gap; an Aspire app host contributes the projects it references, except its `IsAspireSharedProject` library; a deployable inferred from a CI job joins a container only when one of that name already exists, so CI jobs are never containers. `architecture --json` lists each container's `modules`, and a container with 0 modules is named as a gap in the notes. `architecture <scope>` keeps the containers whose project lies under the scope. A class library is never a container, and a repository with no recognisable deployable says so and falls back to packages or directories. The `generic` adapter is bumped to 0.1.20; The container-config adapter is bumped to 0.1.2, so Dockerfiles are read again once and link to their project at the next map.
- MCP tools and the bundled agents work on a project below the session root (#90): every tool takes an optional `project` path (relative to the session root, or absolute inside it) that must resolve, links followed, inside the root or is refused (`UK_SCOPE_VIOLATION`), the handoff tool follows the same rule, and a "not initialised" answer lists the initialised projects found below the root (bounded in depth and time). The agents are told to pass `project` for a nested project. Without `project` the server behaves as before.
- The coverage report lists every language present, and says what was not read (#92): F#, Razor (`.cshtml`, `.razor`), PowerShell and shell appear with their file counts, a language no adapter reads has `quality` `not analysed` instead of `none`, files of an unknown extension are counted under `other` (last, and only when there are any), and `diagnose` names the unread languages in its analysis gaps. Generated and vendored files stay excluded. F# files are now source files, so they count in `by_kind.source`; Razor files stay `other` and are listed through a new `template` flag on the language row.
- The database adapter reads changelog migrations and T-SQL correctly, and never takes a SQL keyword for a table (#80): a file whose content is a `databaseChangeLog` is read whatever its name (`capabilities.sniff`, a content match the builder applies beside the globs); `include`, `includeAll` and `sqlFile` are resolved as Liquibase resolves them (relative to the including file, or as a classpath path), recorded on the migration (`includes`, `resolved`) with a `DEPENDS_ON` edge to included changelogs, and a missing target is a notice naming the path; SQL Server is its own engine (`sqlserver`, `mssql`, or inferred from `GO`, `[dbo]`, `NVARCHAR`): T-SQL is lexed with `GO` and bracket identifiers and an unqualified table is in `dbo`, not `public`; an unquoted reserved word (`from`, `where`, `select`, `join`) is not accepted as an object name while a quoted one is; `unknot database` reports table ownership as `unmeasured` when no ownership edge, ORM mapping or statistics import measures it; and the migration-risk forecast has no SQL Server model, so it says so (rule `mssql.unmodelled.*`, low confidence) instead of applying the PostgreSQL one; T-SQL names compare case-insensitively with `dbo` applied to bare and bracketed names alike, and a Prisma `sqlserver` provider now maps to the SQL Server engine (schema `dbo`) instead of PostgreSQL.
- The first run on a compiled-language repository starts from a correct configuration and a complete list of steps (#91): init proposes the ecosystem's build outputs as scope excludes (`bin/` and `obj/` for .NET, `target/` for Maven, Gradle and Cargo) and no longer excludes `build/` when git tracks source files under it, each proposed protected path appears once, doctor warns when the executable behind a configured command is not on PATH, and status lists the CLI install step whenever `unknot` is not on the login PATH, even when nothing else is pending. Guidance that forbids a command was already honoured and is now covered by a test.
- A lexical reference follows the declared build graph (#71, the top fix from a large-monolith run, where 0.33% of cross-project edges were impossible and created a 1,753-file cycle across 39 projects): a file of a .NET project links only to declarations in its project or in projects it reaches through `ProjectReference`s, never to a C# or Kotlin type another project keeps `internal` unless it names the project in `InternalsVisibleTo`, and never to a Java package-private type from another package. A name after a member access (`order. Status`) is no type reference, a linked source file belongs to every project that compiles it, and a file in no project or in a project whose file cannot be read keeps name matching. `map` reports how many candidate edges were refused (`build_graph.rejected`). Maven and Gradle module dependencies do not cut edges yet. The `generic` adapter is bumped to 0.1.15, so the files it reads are extracted again once.
- A decomposition candidate's cycle signal is its own part in a cycle (#73, the second of the top fixes from a large-monolith run, where contact with one 1,753-file component decided half the treatments and every record cited the same files): `cycle.boundary_edges` counts the candidate's boundary import edges that lie on a cycle once the candidate is collapsed to one node, and its evidence lists exactly those edges. The modularize-in-place, extract-module and frontend modular monolith cards read it instead of `cycle.size`, which stays in the record as context (the size of the largest component crossing the boundary). Decomposition records get the new metric and may change treatment once after the upgrade.
- A file cycle across build units the build cannot have in a cycle is flagged, not trusted (#72): when a component spans .NET projects, Maven or Gradle modules, crates or Go packages (`acyclicUnits` in the language table), `map` and `graph cycles` warn on stderr with the units and the edges that go against the declared references, `graph cycles --json` marks it `impossible_by_build` with `closing_edges`, and a dependency-cycle finding on it says so in its uncertainty. Derived facts are recomputed once after the upgrade.
- A qualified Go name resolves only in the package its qualifier names (#99): `var _ io.Reader = (*Buf)(nil)` no longer implements a repository `Reader` of another imported package, an embedded `io.Reader` promotes no repository methods, and an alias (`st.Reader`) or a package clause that differs from the directory name is followed. Go imports record their alias. The `generic` adapter is bumped to 0.1.16.
- A C# partial type declared across several files is one logical type (#75): the generic adapter adds one node listing the declaration files and the members of every part, and the hub detector reports such a type once, with the fan-in of distinct files outside its parts, instead of one hub per file. The `generic` adapter is bumped to 0.1.17.
- Five false-positive classes from a large C# monolith are gone (#81): a misplaced-module finding skips a package whose role is to be consumed, by name (`Contracts`, `Shared`, `Common`, `Models`, `Entities` and the like, extended by `detectors.decomposition.misplaced-module.consumed_names`) or because the production code of several packages imports it (`min_consumers`, 3); a one-implementation interface that a test doubles with a mocking library (Moq, NSubstitute, FakeItEasy, Mockito, testify's `mock` and others) is not reported; a long-parameter-list finding skips the constructor of a record, a struct or a DTO-named class; the style classifier no longer reads C#, Kotlin or Swift extension-method files in an `Extensions` folder as plugins or CI workflow jobs as a batch pipeline. Configuration, data and view-template files were already never dead code, and a test now holds that.
- Missing git history is reported as unmeasured, not read as no coupling (#78, from a shallow clone of a large C# monolith that read 1 commit and fed "no coupling" into every record): `map` detects a shallow clone (`git rev-parse --is-shallow-repository`), a history with fewer commits than `decomposition.min_shared_commits` and a directory that is not a git repository, and says so on stderr, for a shallow clone with `git fetch --shallow-since=<date>` and `git fetch --unshallow`. Such a history adds no co-change edges; decompose reports `components.evolutionary` as `unmeasured` and each record lists `unmeasured: ["evolutionary"]` with the reason among its evidence gaps. A shallow clone counts as cut only when its boundary lies inside the window, so a fetch with the suggested `--shallow-since` date clears the notice, and a clone deepened since the last map is read again; only commits that touch mapped source files count toward the minimum; a boundary commit, which lists every file as added, adds no churn.
- After a map on shallow or too-short history, `diagnose` leaves open co-change findings open and says `history unmeasured` instead of resolving them, and `workspace map` and the `import` re-maps print the shallow-history notice like `map` (#124): a co-change detector that cannot measure cannot say a coupling is gone.
- A test double counts per interface, and a `global using` in another file counts (#125): the one-implementation-interface check no longer lets a mocking test excuse every interface of the file it imports, and a C# file that relies on `global using Moq;` declared elsewhere has the `Moq` dependency edge. The C# adapter is 0.1.20 (test files list the type names they use from a module).
- Edges found only by matching names are labelled `inferred`, not `observed` (#77, from a large C# map where over a million facts were `observed` though 99.6% of files were read lexically): in the `generic` adapter, C# type references, member calls, types named without an import, siblings guessed from a bare name, and a Ruby `require` or C `#include` found only by the tail of its path. A dependency-cycle finding labels a cut edge the way the graph labels it. With a SCIP index, an edge between two files the index links is `observed`; a resolved import path stays `observed`. A decomposition boundary resting mostly on inferred module-to-module edges (`boundary.inferred_share` at 0.5 or more) is one step less sure, with `confidence_lowered` saying why; an architecture style resting mostly on inferred imports gets a label one step lower; each architecture view states the share of inferred edges it rests on. Finding fingerprints do not change. The `generic` adapter is bumped to 0.1.19.
- Two build units with the same name stay two modules (#109): the `package` node of a .NET project, Maven or Gradle module or crate is keyed by its manifest's repository-relative path (`package:src/Shop.Orders/Shop.Orders.csproj` instead of `package:Shop.Orders`), so two `Api.csproj` files in different folders, or Gradle subprojects `:a:core` and `:b:core`, no longer merge into one node. Names stay short and add the fewest distinguishing folders only when two units share one (`billing/Api`, `shipping/Api`), in decomposition candidates and in the architecture views; each build unit in a record names its `manifest`. A record written with name-keyed units is listed as replaced after the next decompose run. Graph node ids of build units change, so `unknot graph node package:<name>` becomes `package:<manifest path>`. Findings about build-unit packages (package cycles, package-level stable dependencies, low-cohesion packages, co-change leaks, entity services) get new fingerprints once after this upgrade, so decisions recorded on them must be made again. Findings name such units by name, never by manifest path, and a dependency name two crates share resolves to the crate the manifest names by path. The `generic` adapter is bumped to 0.1.18.

### Changed

- Findings are ranked by impact (#76, from a large-monolith run where the most important coupling point ranked 2,366th): each kind has a documented impact measure (cycles by their files and cut edges, hubs by fan-in times size, any other kind by the files in its scope), the rank is the priority times the square root of 1 + impact, ties go to impact then id, one subject reported by two detectors (a file cycle and a package cycle over the same files) is one finding that names the other in `related_kinds`, and the default listing puts at most `diagnose.max_per_kind` (10) findings of one kind first. On the first run after the upgrade, an open package-cycle finding over exactly the files of a file cycle is resolved with `replaced_by` naming the file-cycle finding it folds into.
- The build unit is the default module for compiled languages (#74, from a large-monolith run where 29,086 file modules gave candidates of 2 to 2,477 files with uninformative names): for C#, Java, Kotlin and Rust (`buildUnit` in the language table) a .NET project, Maven or Gradle module or crate is one module of the decomposition, candidates are named after the units they contain and list each unit's files, and other languages keep one module per file. The default `decomposition.size_band` now scales with the number of modules (5 to 20 at 100) and a configured band wins. Decomposition records of compiled-language repositories change once after the upgrade.
- Graph selectors and CLI errors are consistent (#93): `graph edges --from` and `--to` take a glob, a path, a namespace or a declared type, as the other commands do, and say so when nothing matches or when the row cap cut the list; `decompose --json` names each recommendation (`name`, beside `candidate`); in a terminal an error names `unknot init` rather than the skill `/unknot:init` (an agent session still sees the skill); an unknown command suggests the nearest one.
- Decompose says up front what it can recommend without a driver (#94): the first lines of the output, `notices` in `--json` and stderr for `--summary --json` name the treatments that need no driver, say that T3 and T7 need one, and show `--driver <id>`; the decompose skill relays the notice before the results.
- Architecture notes and diagram labels use correct singular and plural forms and agreement (#95): "1 container", "2 containers", "1 pipeline releases", with no "(s)".
- The README explains how to upgrade and uninstall Unknot (#96): the plugin update command, what happens to `.unknot/` and `~/.config/unknot` on upgrade, restarting the session, and every directory and key to remove, with `unknot backup create` first for anyone keeping the ledger.

### Migration notes

- Config acceptances recorded by earlier releases carry no signature (#215), so after the upgrade they are `invalid` and unlock nothing: a project in `assist`, `governed` or `campaign` runs in `plan` with no approvers, and existing approvals are stale, until a person runs `unknot config accept` once in a terminal (`doctor` and `status` say so). Moving a checkout to another path, restoring a backup (to any path), or replacing the project's audit key in `UNKNOT_HOME` needs the same one accept. Copies of one checkout that share a store (and so a project id) at different paths supersede each other: accepting in one makes the others `invalid` until they are accepted again (#222). No store migration.
- A repository in `assist`, `governed` or `campaign` on a machine without a usable OS sandbox (Linux without bubblewrap or user namespaces, a Mac that forbids `sandbox-exec`, other platforms) stops running brokered commands after the upgrade: `verify`, `apply` baselines and `exec` fail with `UK_SANDBOX_REQUIRED`. Install the sandbox (`unknot doctor` says how), or, accepting that your test suite then runs unconfined, set `security.require_os_sandbox: false` and run `unknot config accept` in a terminal. A config that sets `require_os_sandbox: false` explicitly keeps the old behaviour, now with a private `HOME`. `observe` and `plan` are unchanged apart from that `HOME`. A toolchain found through `HOME` is then missing (a default rustup install, `pip --user` packages, `~/.m2/settings.xml`): set `RUSTUP_HOME` and `CARGO_HOME` (usually `~/.rustup` and `~/.cargo`), and `PYTHONUSERBASE` (for `pip --user`, usually `~/.local`) and `PIP_CONFIG_FILE` as absolute paths, in the environment Unknot runs in; brokered commands keep these variables. Maven's `~/.m2` is never readable to a brokered command, with or without a sandbox, because it holds credentials: keep a `settings.xml` and a local repository without credentials outside `~/.m2`, and name them in the configured command (`mvn -s <path>/settings.xml -Dmaven.repo.local=<path>`). On Linux, a `bwrap` that root does not own, or that sits in a group-writable directory such as a Debian `/usr/local/bin`, is no longer used (#170): install bubblewrap from the distribution package (`/usr/bin/bwrap`).
- A lane signed before #189 binds no guidance, so it stops covering a slice that has applicable guidance files; sign it again (`unknot lane approve <CMP-id>`). Per-slice approvals keep holding unless a guidance file was added inside the slice's scope since they were given.
- A repository in `assist`, `governed` or `campaign` on a machine without a usable OS sandbox (Linux without bubblewrap or user namespaces, a Mac that forbids `sandbox-exec`, other platforms) stops running brokered commands after the upgrade: `verify`, `apply` baselines and `exec` fail with `UK_SANDBOX_REQUIRED`. Install the sandbox (`unknot doctor` says how), or, accepting that your test suite then runs unconfined, set `security.require_os_sandbox: false` and run `unknot config accept` in a terminal. A config that sets `require_os_sandbox: false` explicitly keeps the old behaviour, now with a private `HOME`. `observe` and `plan` are unchanged apart from that `HOME`.
- The store moves to schema 3 (`compact-edges`) the first time this release opens it: the edges table is rebuilt with its rows copied, so no re-map is needed; on a large store the first open takes a few seconds longer. Releases before this one cannot write a schema-3 store and say so (`store schema 3 is newer than this runtime supports`); their hooks in a running session still allow read-only commands. While a session that ran an older release's hooks in the last 15 minutes is open, the migration waits and names the fix (reload plugins or start a new session). Each linker links in full once after the upgrade, then incrementally.
- Migration 4 (`drop-unused-fact-indexes`, #145) drops three facts indexes on first open and keeps schema 3. Releases before schema 3 already refuse the store (see above); a build of main between `compact-edges` and this one creates the indexes again over the whole facts table, which can take a while on a large store, and the next open here drops them. Derived facts are recomputed once by the first map after the upgrade.

## [0.4.0] - 2026-11-20

### Added

- Go types implement interfaces by having their methods (roadmap #16, the tier gap the equivalence test named): a language that implements interfaces implicitly says so in its table row (`structuralInterfaces`), and a type whose methods, including those promoted from the repository's types it embeds, match an interface's method names and parameter counts `IMPLEMENTS` it (`by: structural`, low-confidence inference). Unresolved embeds, type-set constraints and empty interfaces imply nothing, an unexported method matches only one declared in the interface's package, and an interface more than 25 types satisfy gets edges from the first 25, each with the full count (`satisfied_by`) (`generic` 0.1.14). A compile-time assertion (`var _ I = (*T)(nil)`, `implementsAssertion` in the table) states an implementation the methods cannot show, such as one through an embedded type from a dependency; a qualified name in it resolves only through the file's imports, and the implementer must be a concrete type, which also applies to Rust `impl` blocks. `one-implementation-interface` no longer reports an interface whose only implementer is test code, in any language, and for Go it names that types outside the repository can implement the interface unseen.
- One architecture written in C#, Java, Python, TypeScript and Go maps to equivalent graphs, checked in CI (`tests/golden/equivalent-architecture.test.mjs`, roadmap #16, item 1): the same unit dependencies, file dependencies, route, table and container binding in every language, no cycle, and the same findings apart from gaps a tier cannot see, which the test names (Go's implicit interfaces). It found the three fixes below.
- Dependency-injection container registrations are graph facts (roadmap #16): a new `di` framework adapter (0.1.0) reads every covered container spelling through one table-driven rule (`adapters/language/di-ops.mjs`, `DI_SYNTAX` — one row per spelling, separate from the language adapters). A registration that resolves by simple name states that the service type `RESOLVES_TO` its implementation type and that the registering module `DEPENDS_ON` the implementation's module (`via: container`, with the lifetime normalised to singleton, scoped, transient or unknown; medium-confidence inference, low for component scanning), so an implementation module that only a registration references is no longer dead code. Names that match nothing, or several types, stay unresolved with no edge for that side and are counted in the map notices.
- Agents may not approve a pull or merge request on the forge (roadmap #16, item 4, phase 1 of `docs/forge-approvals.md`): `gh pr review --approve`/`-a` (also among other short flags), `gh api` calls that post an approving review (REST or GraphQL, or an unreadable body), defining or importing `gh` aliases, and MCP tools that create or submit an approving review or approve (including one tool that does either by a method argument, such as `pull_request_review_write`, or with the event deeper in its arguments) are refused under `approval.human_only`. Every command is parsed, so quoting changes nothing, and a computed word counts as an approval where it could be one. Reading reviews, commenting and requesting changes still work, and text that only mentions an approval is data.
- Messaging contract evidence is one table-driven rule for publisher calls and consumer calls/handlers across source languages. Channel contracts retain literal names, resolved string constants and unresolved names, supply `contracts.present` and consuming-module counts, and link consumers to publishers across repositories. A callback, lambda, object literal or typed parameter names no channel, a function or method declaration is no call, a bare `publish(x)` or `subscribe(x)` names a channel only through a string or a constant, and a file that calls none of the table's names is not lexed again.
- Generated RPC clients and named GraphQL operations now match protobuf services/methods and schema root operations, including provider declarations found through workspace mapping. The contracts adapter is bumped to 0.1.1; its version-pinning test and adapter documentation cover the new output.
- Delivery history is imported evidence (roadmap #16): `unknot import deliveries <file> [--source label] [--environment name]` reads one documented format of deployment rows per deployable unit (JSON array, JSON Lines or CSV; unit, deployed time and status, with optional environment, commit and committed time, release id and code root). Each unit becomes a `deployable` node carrying its deployments, deploys per week, change failure rate and lead-time median and p90 with their window and expiry, and units sharing a release id get a `RELEASED_WITH` edge with their shared share. `decompose` reports a candidate's units as observed `delivery_evidence`, sets `service.deploy_coupling` from the releases shared with units outside the candidate, and names expired, unplaced or missing delivery evidence in its gaps. It is idempotent per source and refuses `.unknot/` and credential paths. The delivery adapter is bumped to 0.1.3. See `docs/runtime-evidence.md`.
- ORM mapping recognition is one table-driven rule (`adapters/language/orm-maps.mjs`, `ORM_SYNTAX`): a type mapped to a table, named by the code or by that ORM's convention (`table_name_basis: 'convention'`), plus reads and writes through the mapped type, which now count as writers for `multiple-writers`. JPA, EF Core, SQLAlchemy, Django and Prisma moved onto it; TypeORM, Sequelize, ActiveRecord, GORM, Doctrine and Eloquent are new rows, each a row of the table rather than code. The `generic`, `python`, `javascript` and `database` adapters are bumped to 0.1.11, 0.1.12, 0.1.15 and 0.1.1.
- A scheduled quality run (`.github/workflows/quality.yml`, roadmap #16): weekly and on demand it measures precision, factual accuracy and seeded recall on the quick corpus, runs the cross-command consistency check on every mapped repository (`scripts/consistency.mjs --work`), compares with the previous run (`scripts/accuracy-compare.mjs`), writes a step summary and uploads the reports. It gates nothing on the numbers yet; `scripts/accuracy.mjs` now exits 1 when a repository fails. A release reviews the latest result (`docs/release.md`).
- Database query statistics are now one documented evidence format for any database (#16). `unknot import database-stats <file> [--format pg|sqlserver|mysql|normalised] [--source label] [--window w]` reads normalised rows (statement, calls, times, tables read and written, window, optional transaction grouping) or the PostgreSQL `pg_stat_statements`, SQL Server Query Store and MySQL `events_statements_summary_by_digest` exports through small readers and one conservative SQL table extractor. It attaches query facts to existing table nodes, lists unmatched tables and statements it could not read, is idempotent per source, and refuses `.unknot/` and credential paths. Tables written in one transaction become `SHARES_TRANSACTION_WITH` facts with a window and expiry; `decompose` reports cross-boundary transactions from them as observed evidence and names expired facts in its gaps. The PostgreSQL catalog adapter now reads through the same format with unchanged facts. See `docs/runtime-evidence.md`.
- SCIP indexers can now run only with the explicit `adapters.scip.run: true` opt-in (#54). The table-driven, brokered runner writes a private per-language cache, keeps network disabled, applies per-run time and memory caps, refuses tracked cache paths and repository-supplied executables, and reports semantic or lexical fallback reasons per language. A supplied SCIP index still wins for its language. A document whose indexer leaves its language empty, as scip-typescript does, takes the language from its extension in the same table. `adapters.scip.run` is ignored in a configuration nobody accepted, so a repository cannot enable it for its own first map, and an indexer that runs the repository's build is refused when no OS sandbox is available.

### Fixed

- More false findings from the labelled corpus, each fixed generally:
  - a Go field read through a type that embeds its owner is a use (embedded types count as bases for member reach; on gitea, `objectFormatCache` read through `Repository`);
  - an extensionless JavaScript import resolves to a single-file component (`./components/AkauntingDate` to `AkauntingDate.vue`) when no script matches;
  - a method called only from a module's top-level code (`server.listen()` in an entry file) is not dead;
  - a file named as a dummy, fake or placeholder (`..._dummy_gpg_key.txt`) yields no secret findings; example and sample files keep their token-shaped ones.
  - a Vue single-file component's template counts as uses of the names it mentions, so a method bound only by `@click="changeTab(...)"` is not dead;
  - a cycle finding shows a cycle between files, not a component that imports itself (a recursive Vue component), when other files take part.
- Semantic tier (SCIP), checked on nopCommerce with a scip-dotnet index: unused injected members went from 81 findings, most of them wrong, to 91; the 20 checked against the source are all true, 9 of them event payloads published for plugins (the lexical tier finds 2). A document language the indexer names in its own way (`"C#"`) now falls back to the file extension, so C# rules apply to scip-dotnet indexes. An index that records no read or write roles (scip-dotnet) is read from the source: an occurrence followed by a lone `=` is a write, so a field only assigned in the constructor is unused. A member is read through an interface or base type of its own that declares a member of the same name and is read; a member with a serializer or binding attribute is read by reflection (`annotation` in the indexer table), but not one with an injection attribute (`injection`); and a member a Razor view names (`templates`: `.cshtml`, `.razor`) may be read (`scip` 0.3.1).
- Unused injected members in Java, Kotlin, Go and the other generically read languages: a file linked before the first file that needed the member index lost its member reads, so a member read only there could be reported unused, depending on file order. The index is now built before linking.
- In Go, a read of an unexported member inside its package counts as a use whatever the receiver (a call result, a closure parameter), since only the package can name it (`scopePrivate` in the member syntax). On gitea this removes a false finding that `requestrecord.go` held `funcinfo.go` only through the unread member `funcInfo`.
- A module that defines nothing another module could import (no exports, or in Python no function or class) but runs code at top level is a script, so "imported by nothing" no longer reports it; a module that only declares things is still reported, and so is one in a Meteor app with a main module or a Vue or Svelte component. On microservices-demo this removes two false dead-code findings (a manual gRPC client and a SQL generation script), and on excalidraw seven build scripts and a service worker (`python` 0.1.15 records `top_level_calls`).
- A CI job is a deploy by its commands, not by prose: comments and quoted text in a `run` script (`echo "not a semver release"`) no longer make a job deploy something, and a job that creates the cluster it deploys to (kind, minikube, k3d) tests the deployment rather than being one. On saleor and spring-petclinic this removes two false `missing-rollback-path` findings (`delivery` 0.1.4).
- A TypeScript named import of interfaces and type aliases only is erased like `import type` (`type_only`), even without the keyword, so it closes no runtime cycle; an enum, a value, or a name that is both stays a runtime import. On prestashop this removes a false `Dropzone.vue` ↔ `DropzoneWindow.vue` cycle.
- Secret findings: a credential word followed by `==`, `=>` or `::` (`$response == Password::RESET_LINK_SENT`) is no assignment, and in translation files (`locale/`, `i18n/`, `lang/`, `translations/`, `messages_xx.properties`, `.po`, `.xliff`) a `password` key holds the word for one, so only token-shaped secrets count there. On akaunting, openmrs-core and gitea these made three false findings (`security` 0.1.3).
- Dead code no longer lists methods that run without a call: constructors (run by `new`), getters and setters (run by property access), and the lifecycle callbacks of React class components (`componentDidCatch`, `componentWillUnmount`, `getDerivedStateFromError` and the like) and custom elements (`connectedCallback`, `attributeChangedCallback` and the like). On excalidraw, prestashop, mastodon and gitea these made three false findings.
- A Python import of a standard-library name (`from collections import defaultdict`) is never resolved to a same-named sibling file (`collections.py`) by the flat-sibling rule. On saleor that edge closed a false seven-module import cycle (`python` 0.1.14).
- `DELETE FROM` followed by a table the code fills in (`{schema}.{table}`, `${table}`, `?`) no longer records a table named `from`; the T-SQL form without `FROM` (`DELETE orders WHERE ...`) still names its table. On nopCommerce this removes a `multiple-writers` finding about a table `from` (`database` 0.1.4).
- JavaScript and TypeScript imports through a bundler alias (`resolve.alias` in a Vite, Vitest or webpack configuration, object or `find`/`replacement` form) resolve to the aliased directory, nearest configuration first; before, `import x from "@/logs/page"` stayed unresolved and the module it named looked dead. On pocketbase this removes 18 false dead-code findings, every page its router imports through `@/`.
- An `innerHTML` or `outerHTML` assignment of a literal with nothing joined to it (`el.innerHTML = ""`, a template without `${}`) is no longer an injection signal; one with interpolation, concatenation or a variable still is (`javascript` 0.1.16).
- Go files of one package that use each other's types no longer form import cycles or count as hub fan-in and fan-out. Since the language makes the package the unit (`packageUnit` in the table), those references are marked `intra_package`, and the cycle view every command reads (`graph cycles`, diagnose, decompose) leaves them out; dead code and decompose affinity still count them. On pocketbase this removes two in-package cycle findings and five hub findings that the same-package edges had added.
- Go parameters of channel type (`in <-chan T`, `out chan<- T`) are counted: the channel arrow was read as an opening `<`, so the parameters after it were missed in parameter counts and `long-parameter-list`.
- A table has one node whichever adapter names it. Language adapters name ORM tables by their bare name and the database adapter, which knows the engine, gives every table id its canonical form after linking and discovery (`canonicalId`, a new optional adapter hook, see `docs/adapters.md`). Before, Python and JavaScript ORM tables existed twice (`table:orders` beside `table:public.orders`), so ORM reads and writes landed on a different node than the DDL; under MySQL, MariaDB or SQLite, C#, Java, Go, Ruby and PHP ORM tables and traced tables were `public.`-qualified while the DDL's were not. Table ids from those adapters change once, and so do the fingerprints of findings about them (`generic` 0.1.13, `database` 0.1.3, `runtime` 0.1.1).
- A Java, Kotlin or Go file that uses a type of its own package (or directory) without importing it now depends on that type's file (`IMPORTS`, `via: type`), as C# files already did through their namespace. Before, only a type held by an unused member made that edge, so cycles, fan-in and decomposition affinity inside a package were missing.
- Clone detection treats package and namespace headers and C# `using` directives as plumbing, like imports, so two small classes that share only their header, imports and injected-constructor shape are no longer reported as duplicated code (`quality` 0.1.3). `using (...)` and `using var` statements are still code.
- Index and constraint ids in DDL files under a dialect-named path (for example `db/mysql/`, `docker/postgres/`) now carry the dialect, so findings about them get new fingerprints once after this upgrade.
- Foreign keys declared in migration DSLs are recorded as the same facts DDL `REFERENCES` produces, so `missing-constraint-candidates` no longer reports columns that are constrained: Rails `t.references ... foreign_key:`, `add_reference` and `add_foreign_key`, Laravel `foreignId()->constrained()` and `foreign()->references()->on()`, Django `ForeignKey`, Alembic `sa.ForeignKey`, `ForeignKeyConstraint` and `op.create_foreign_key`, EF Core `table.ForeignKey` and `AddForeignKey`, Knex `.references().inTable()`, TypeORM `TableForeignKey` and Sequelize `references`. Laravel and EF Core migrations are now read at all (database adapter 0.1.2).
- Destructive-migration findings no longer count drops in a migration's rollback section (Rails `down`, Laravel `down()`, Alembic `downgrade()`, Django reverse code and `reverse_sql`, Flyway `U__` undo files, Liquibase `<rollback>`, EF Core `Down()`); only forward sections count.
- Migration DSL options are no longer read as columns: `t.timestamps null: false` adds `created_at` and `updated_at` instead of a column named `null`, as Laravel `$table->timestamps()` and Knex `timestamps()` do.
- Schema files for different database dialects (`db/h2/schema.sql`, `db/mysql/schema.sql`, `db/postgres/schema.sql`) are alternative variants of one table: indexes and constraints are kept per variant, the table records its `variants`, and `duplicate-index` never compares across variants.
- ORM entities that inherit from an abstract base are mapped (Django `abstract = True`, SQLAlchemy `__abstract__ = True`, ActiveRecord `self.abstract_class = true`, JPA and Doctrine `MappedSuperclass`): a concrete class whose inheritance chain, resolved by name across the repository, reaches an entity or a mapped superclass of an ORM is an entity of it, with the table its own name or that ORM's convention gives; the abstract bases are no longer mapped as tables, and their tables are schema-qualified like those of directly mapped entities. The rule is the `abstract` and `inherits` fields of the `ORM_SYNTAX` rows. `generic` 0.1.12, `python` 0.1.13.
- A Django migration field that points at `settings.AUTH_USER_MODEL` records no foreign key instead of one to a guessed `auth_user` table, since projects often swap in their own user model.
- An entity name in an ORM query string (JPQL, HQL, DQL) resolves to the entity's mapped table instead of becoming an inferred table, and a name in a string written that way (`SELECT ptype FROM PetType ptype`, `JOIN FETCH o.items`) that matches no mapped entity creates no table. `database` 0.1.2.
- The dead-code detector judges only modules of programming languages by the language registry: configuration, resource, locale, template and data files are never reported as modules nothing imports.
- Telemetry reports the running release as the OTLP `service.version` and instrumentation scope version; both were a constant `0.1.0` (#70).
- Per-language ids, extensions, globs, lexical rules and analysis coverage now derive from one registry; language adapters and SCIP use it too. Python stubs (`.pyi`), C++ `.hxx` files and batch files are now classified wherever their language is supported, and the registry guard rejects ids in comparisons, switch cases and collection checks (#64).
- `map` and `config show` now name `adapters.scip.run` when an unaccepted configuration forced it off, and say that a person enables it with `unknot config accept` in a terminal (#58).
- `doctor` now gives every detected language with a SCIP indexer-table row an indexer line, including the required project marker when it is absent (#59).
- `explain` now renders its ten answers, evidence locations and alternatives as readable terminal text by default; `--json` retains the existing record (#60).
- The hostile repository hook test now controls its own `PATH`, so an ambient `unknot` executable cannot change what it proves about a repository-provided look-alike (#61).
- Lexically read source files now carry generic size, complexity, nesting and member-count metrics, including Dart, and `diagnose` names every per-language analysis that did not run instead of treating silence as a clean result (#56).
- A unique flat sibling Python import such as `from proc import process` now resolves through the shared table-driven import rule with inferred provenance; conflicting sibling module layouts remain unresolved rather than becoming an arbitrary dependency (#57).
- During an open run, subagents can deliver a final report through `SubagentHandback` and can read an existing regular background-task `.output` file from their session's harness task directory (#52). The exception is limited to that direct file path: other temporary files, traversal outside the directory and symlink targets remain denied.

### Changed

- The `Live sessions` workflow (`.github/workflows/live.yml`) no longer runs every night. Run it by hand before a release (about $3 a run); a failure there still blocks the release (#82).

## [0.3.3] - 2026-10-06

### Fixed

- Findings keep the detector's `confidence` (it was dropped when a finding was stored), so a proven deletion can qualify on a real unused-member finding (#46). Each proven-deletion problem names the measured value against what is needed (`confidence: low; needs medium or high`, `confidence: none recorded`, `evidence: 1 of 3 entries inferred`). Findings stored by earlier releases have no confidence until `diagnose` runs again. A test now runs the real map, diagnose and proven-deletion check in two languages.
- `decompose` carries a driver's source and quote along the whole `supersedes` chain, to the nearest record that has them (`carried_from` names it), instead of only from the record directly replaced; `driver_provenance_missing` lists every driver whose saved provenance has neither a source nor a quote, in text and JSON, and is empty only when every driver has some (#47).
- `contracts.present` and `clients.count` reach `candidate.metrics` (the metric-name filter dropped the `contracts` and `clients` prefixes; unmeasured stays absent) and the readiness rows; text `decompose show` has a Contracts section listing each route with its client interfaces and, from a workspace map, the repository that serves it; a candidate's client routes add an evidence gap naming them as a seam served elsewhere until a workspace map confirms it. The other prefixes selection cards read that no candidate measures (`backup`, `data`, `migration`, `clients.response_shape_variance`) stay unmeasured in readiness; `metrics`, `service` and `team` are global signals no decomposition card uses (#48).
- A strongly connected component of the runtime import view always yields one `module.dependency-cycle` finding, whatever its size (#49): the finding names every member in its scope (it was cut at 50), lists the edges that break it (declared-only ones named, `cycle.cut_heuristic` when the ordering cut was used), and a scoped `diagnose` holding any member shows it and names the members outside the scope that close it. `--objective decompose` ranks cycle findings ahead of every other kind, and `graph cycles` prints why a component has no finding.
- Endpoints registered on a route group keep the group's prefix (#45): C# `MapGroup` (held in a variable, chained, or handed to an extension method), Express `Router` mounted with `app.use('/v1', r)`, Go chi `Route` and gin `Group`, FastAPI `APIRouter(prefix=...)` with `include_router(..., prefix=...)` and Flask `Blueprint(url_prefix=...)` all join every prefix up the chain, across files when a group is handed to a registration function or mounted from another file; a prefix that cannot be resolved keeps the endpoint with `prefix_unresolved: true`. `generic` 0.1.8, `javascript` 0.1.14, `python` 0.1.11.

### Added

- `unknot workspace add <name> <path>` and `workspace remove <name>` (#50) write the workspace repositories into the configuration proposal (never the accepted config), validating a git root, a unique name and path, and a path outside `.unknot/`, and record `workspace add` as the source for `config diff`. `workspace list` and `map` in a root whose repositories are only in an unaccepted proposal fail with the new error code `UK_WORKSPACE_UNACCEPTED`, and `status` says why the accept step is listed.

## [0.3.2] - 2026-10-06

### Added

- Cross-repository clients and endpoints in a single-repository `decompose` (#30): `unknot workspace map` records the workspace, the repository's name in it and the time of the map in each member project's store, and `decompose` inside a member reads the workspace's client-to-endpoint links for the candidate's modules. Endpoints the candidate serves that clients in other repositories call (`clients.count` per route, `client_repositories`) and routes the candidate calls that another repository serves (`served_by`) count as `contracts.present`; the record's `candidate.contracts` lists the routes, each labelled with `workspace_mapped_at`, and `candidate.workspace` names the map. When the repository was mapped after the workspace map, the evidence is still used but the record's gaps say the cross-repository evidence is stale. A project outside any workspace is unchanged.

## [0.3.1] - 2026-10-06

### Changed

- HTTP clients and endpoints are detected by one language-generic rule instead of per library: a method that declares an HTTP method and a route through an attribute, annotation or decorator is an operation, a client operation (a `contract:` route node its module consumes) on an interface, abstract type or bodiless method and an endpoint on a concrete handler, with the type's base path joined, for C#, Java, Kotlin, TypeScript, JavaScript and Python (and Go router registrations, taking the method from the handler when the call has none); `generic` 0.1.7, `javascript` 0.1.13 and `python` 0.1.10, an interface or abstract type that a concrete type in the repository implements or extends is a server-side API declaration whose routes are endpoints of the implementer (its own markers win), not a client; and the `framework` of such a client or endpoint is now `attribute`, `annotation` or `decorator`.
- The unused-member analysis (a module held only through a member nothing reads: `declared_only` edges, `code.unused-injected-member`, cycle cutting, proven deletions) is language-generic. One engine (`generic/members.mjs`) reads a per-language syntax table (`generic/member-syntax.mjs`) for C#, Java, Kotlin, TypeScript (constructor parameter properties too), Python (`self.x = x` from an annotated `__init__` parameter, or a class-level annotation) and Go (struct fields read through the receiver), and a SCIP index decides it directly for every indexed language (`adapters/semantic/scip`, adapters generic 0.1.7, javascript 0.1.13, python 0.1.10, scip 0.2.0).

## [0.3.0] - 2026-10-06

### Added

- Semantic facts from a SCIP index (#29, first part). Unknot imports an `index.scip` that a person produced with an indexer (scip-dotnet for C#, scip-typescript, scip-java, scip-python); it never runs the indexer or a build. The new `scip` adapter (`adapters.scip.index`, default `index.scip` at the repository root) streams the index one document at a time through a zero-dependency protobuf reader for the SCIP subset, and emits observed facts (source type `lsp`): `REFERENCES` and `CALLS` between modules, `EXTENDS` and `IMPLEMENTS` from relationships, and per module the definitions and the members nothing references outside their own definition. Files the index covers are `parse_quality: semantic` in `coverage` (`qualities` gives the files per quality; `map` prints them and notes a mixed language). For C# the unused-injected-member decision then comes from the index (a write-only occurrence is not a read), replacing name matching for those files; lexical stays for the rest. `unknot doctor` reports whether an index is configured or found, its age against the last commit touching covered files, and the indexers' own commands to produce one. A direct Roslyn adapter stays open in #29. An index is used only when the person produced it for this code: one committed to the repository, or older than a commit or a working-tree change to a file it covers, is set aside with a notice and every file keeps its lexical result.
- A proven-deletion path (#35): a slice that removes code in one literal file, from findings that are open, observed (not inferred), medium or high confidence, of kind `code.unused-injected-member`, `code.dead-code` or `code.unreachable-code`, not about a public member or a file in the derived public surface unless the accepted config says `repository.publishes_api: false` (this repository publishes no library API; default true), is low risk and needs one approval from the new `approvals.proven_deletion` (default `[any-approver]`: any registered approver; a repository can tighten it). The decision is `provenDeletion` in `runtime/policy/proven.mjs`, from stored data only; it skips just the planner's `medium`, module-boundary and internal-contract factors and never lowers anything high or critical. The approval is still a signed one by a person at a terminal, and `unknot approve` needs no `--role` for it. When the patch is staged, a diff that adds a line or touches another file ends the status (recorded in the ledger), the slice is reclassified and the normal approvals are needed again. `unknot status`, `unknot slice show`, `unknot plan` and the MCP `slice_get` list proven-deletion slices with their reasons, and the others with what stands in the way.
- Typed HTTP clients are contracts (#30). The `generic` adapter (0.1.6) reads Refit interfaces (`[Get("/v1/orders/{id}")]` and the other verbs), Feign (`@FeignClient`, mapping annotations, `@RequestLine`) and Retrofit (`@GET("x")`) as `contract` nodes: one per interface with its operations, one per route (`contract:GET /v1/orders/:id`), consumed by the declaring module. `decompose` reports `contracts.present` for a candidate whose modules declare, consume or import such a client, or that serves a route one declares, or one an OpenAPI or Pact file describes, lists the routes and counts `clients.count` per route, so extraction treatments are no longer rejected for missing contracts when it holds. TypeScript and JavaScript have no common declarative client form and are not covered.
- `unknot workspace map` links a client route in one repository to the endpoint that serves it in another (#30), by method plus path template (`{id}` and `{orderId}` match; slashes, query strings and the method's case do not matter; an endpoint for any method answers every client method), with a `CONSUMES` edge from the client `contract` node to the `endpoint` node. Client routes nothing serves are listed as unmatched in `workspace map` and `workspace graph`, and `unknot graph edges <node> --workspace` shows the links of a node in the combined graph.

- A documented runtime import for decompose evidence (#36): `unknot import runtime <file> [--source <label>]` reads CSV or JSON rows (`caller, callee, operation, count, p95_ms, error_rate, window`), matches each caller and callee onto a module, symbol, route or service node, stores the rows with their window, source and import time, and reports the matched rows and the first 20 unmatched with why. Importing the same file again changes nothing; a newer import with the same source replaces the older. `decompose` measures `runtime.cross_boundary_calls`, `runtime.cross_boundary_p95_ms` and `runtime.cross_boundary_error_rate` for each candidate, labelled observed with their window (`runtime_evidence` in the record), and static evidence alone now caps an extraction (T3, T6, T7) at `medium` until `runtime.boundary_coverage` (the share of the candidate's boundary edges that runtime rows connect) reaches 0.5. The format, matching rules and an export recipe for an OpenTelemetry-compatible trace backend are in `docs/runtime-evidence.md`.

### Removed

- The deprecated 0.1.x names `boundary.reverse_deps`, `boundary.reverse_deps_test`, `boundary.reverse_deps_low_confidence` and the record field `reverse_dependency_targets`, as announced in 0.2.0: use `boundary.outbound_dependencies*` and `outbound_dependency_targets`. Pattern cards that still use the old names no longer match. Records written by earlier releases still display.

## [0.2.3] - 2026-10-06

### Fixed

- A run started by the CLI inside an agent session (`unknot map` through the Bash tool) governs that session and its subagents only (#32): it records the session (`CLAUDE_CODE_SESSION_ID`), so other sessions in the same repository keep only the always-on protections and are no longer refused `git push`, `gh` or `cd` while it runs. A refusal caused by a run names the run, where it was started and how a person ends it. A run started in a person's own terminal still applies to every session.
- The human-only rule judges the commands that would run, not the words in the command text (#40): a heredoc body, a quoted argument or a commit message that mentions `unknot approve` is data. `bash -c`, `eval`, `env` and similar wrappers are unwrapped and still refused, and when the text mentions a human-only command and the command cannot be read that precisely (a shell or interpreter reading text as code, a package runner, a git or gh alias, a computed command word, an unparseable line), it is refused as before.
- Rerunning `decompose` with the same drivers keeps their recorded source and quote (#37). A record that replaces an earlier one, or rewrites itself, carries each driver's source and quote forward when it has none of its own, and says so (`carried_from: DEC-xxxx`, shown as "carried from DEC-xxxx"); words given now win. `--driver-source <id>=<url>` and `--driver-quote <id>=<text>` are repeatable per driver (a bare value still applies to every `--driver`), and `--drivers-file <json>` reads drivers with their provenance. When a driver has no source or quote and none can be carried, the output starts with a notice that says so (`driver_provenance_missing` in `--json`).
- A decomposition record names each metric once (#38). Selection and the boundary summary were already fed by one set of signals, so the record is checked rather than changed in that respect, but two measures read as one: `boundary.outbound_dependencies` counts import edges (25) while the targets list names the few modules they reach. The distinct-module count is now its own metric, `boundary.outbound_dependency_modules`, shown beside the edge count with both definitions in `decompose show`, and the metrics a rejection or readiness row quotes from the graph-wide signals (`traces.available`, `ci.per_unit_pipeline`, `driver.*`) are in the boundary metrics too, so every metric a treatment evaluation names equals its value in the record's boundary summary. A consistency test asserts it.
- A decomposition candidate is named after the namespace or folder that a strict majority of its members share, with outliers noted (`Shop.Orders.Checkout (+1 from Shop.Notifications)`), instead of the members' common prefix, which could name a much larger parent namespace. The common prefix is used only when nothing holds a majority (#39).

### Added

- `unknot diagnose --objective <decompose|simplify|security>` (and `objective`/`all` on the MCP `findings_list`) ranks findings by relevance to the objective from one table in `runtime/diagnose/objectives.mjs`. For `decompose`, cycles, the unused dependencies that close them, co-change leaks, shared table writers, hubs and misplaced modules come first and generic code-style findings fold into one "N code-style findings hidden (--all to show)" line; `--all` lists them last. JSON carries `objective`, `hidden` and `hidden_kinds`. Output without `--objective` is unchanged, and `/unknot:decompose` uses the decompose objective (#31).
- `unknot status` (text and `--json`) and the MCP `status` tool print one block headed "For you, in your own terminal:" with every pending human step as a ready-to-paste command, in order: install the CLI (only when `unknot` does not resolve on a login shell's PATH; a failed or timed-out check counts as unknown, not missing), review and accept a waiting configuration, register an approver key, approve each slice awaiting approval with its role and name, end the active run by id. The human-only refusal and the skills point to this block (#33).
- `unknot config diff` labels every changed line with its source: `detected: <file>:<line>` for commands found in build files, `guidance: <file>:<line> "<sentence>"` for rules inferred from repository guidance, `default` for template values. Guidance-derived lines (including a command guidance kept out of the proposal) are grouped and marked as needing a person's judgement. `unknot config accept --detected-only` accepts the proposal without them; it stays human-only and uses the same accept path. `init` records the sources in `.unknot/state/config.proposed.sources.json`; the proposal and the accepted config format are unchanged (#34).

## [0.2.2] - 2026-10-06

### Fixed

- Node arguments with an unknown prefix (`file:<path>`) resolve to the matching node with a note; a node that is not found lists the accepted forms and suggests the nearest paths (#27).
- The MCP `search_text` no longer spends its 20 s budget before scanning any file (#26). It scans concurrently like the CLI, the budget starts at entry and covers listing the files (one `git ls-files`, classified by path; files are statted and read only during the scan), and it stops starting reads when the budget is spent. A result that scanned no file says `searched: false` with a notice suggesting a scope or the CLI, instead of an empty hit list, and results report `files_scanned`.
- Guidance no longer turns an exception into a repository-wide ban (#25). A sentence is a forbidden command or path only when phrased as a prohibition aimed at the reader ("do not run X", "don't use X", "never X", "X is forbidden / not allowed", "avoid X"); "X will only fail there" and "the sandbox cannot build" are descriptions and are not. Rules under a heading or in a sentence that scopes them to a named actor or environment ("Exception: ci-bot sandbox", "if you are the release bot", "in CI") are recorded with `scope` and `enforced: false`, shown in `guidance_get`, and not applied repository-wide. A command the guidance both requires and forbids repository-wide is reported in `flagged` with both sources and is not enforced; `init`, `apply` and the policy checks skip unenforced rules, and `init` says so. Cursor `.mdc` rules (`globs:`) and Copilot `.github/instructions/*.instructions.md` (`applyTo:`) apply only to paths their globs match.
- `guidance_get` no longer walks the repository (#26). Guidance files are found by their known names and locations along the requested path's ancestor directories, and parsed files are cached by mtime. The full listing uses `git ls-files` in a git work tree.

## [0.2.1] - 2026-10-06

### Changed

- Scopes accumulate across maps (#22). `unknot map B` after `unknot map A` maps both, so edges between them no longer vanish silently; the recorded scopes live in store meta and unchanged files come from the per-file cache. `unknot map` with no scope maps and records the whole repository, `--replace` maps exactly the given scopes, and a recorded scope deleted from disk is dropped with a notice. `map` (text and `--json`) and `status` name the covered scopes and what was kept or dropped.

### Fixed

- A member access whose receiver has a declared type outside the mapped files (`ctx.X` where `ctx` is a `ShopContext` declared elsewhere) no longer counts as a possible use of a same-named injected member on a mapped type, unless that type is the declaring type or related to it by name or inheritance; the member is reported as unused (#19). Only receivers with no declared type at all (call results, `var x = Make()`, lambda parameters) keep the name-only, lowered-confidence path, and the edge now names the files holding them (`possible_receivers`). Generic adapter 0.1.5.
- An injected public member that other files may read only through receivers of unknown type (lambda parameters, call results, fields declared outside the mapped files) is reported as possibly unused at low confidence, naming those files, instead of not at all (#19).
- A slice planned from a finding that a re-map no longer reports is shown as stale in `unknot status`, `unknot slice` and the MCP `slice_get` and `status` tools, naming the finding; its state and approvals are untouched (#19).
- `--help` on any command or subcommand prints its usage without running it (#23).
- `unknot search --scan` no longer takes minutes on a large repository and prints nothing (#21). It stats and reads files concurrently (it used to read each file twice, one after the other, so a slow file system's latency was paid per file), never opens files the census excludes, stops after a time budget (default 60 s, `--budget-seconds N`) with a partial result that says how many files were not scanned, and writes progress to stderr (not in `--json` mode) once it runs longer than about 3 seconds. `search_text` scans serially with a 20 s budget and reports the same notice.
- `unknot search` and `search_text` no longer let an exact constant match hide the constants that start with the same text (#20): the exact match comes first, then the constants that extend it with their sites, within the limits, and `constants_left_out` (and a line in the text output) says how many were cut.
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

_Never tagged: no git tag or GitHub release exists for this version._

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

_Never tagged: no git tag or GitHub release exists for this version._

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

_Never tagged: no git tag or GitHub release exists for this version._

### Fixed

- A slice worktree's linked dependency directories (`node_modules` and similar, symlinks to
  the main checkout's) were staged into the patch when `.gitignore` names them with a
  trailing slash, which matches directories but not symlinks. Found by running the full
  write path on a real TypeScript repository.

### Added

- `unknot slice <id> diff`: the slice's patch, read-only, for agents that cannot run shell
  commands inside `.unknot/`.

## [0.1.5] - 2026-10-05

_Never tagged: no git tag or GitHub release exists for this version._

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

_Never tagged: no git tag or GitHub release exists for this version._

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

_Never tagged: no git tag or GitHub release exists for this version._

### Fixed

- A committed `.terraform.lock.hcl` is read: providers it pins are not reported as unpinned,
  and child modules may state minimum versions (`>=`) as Terraform recommends. On the test
  repository this removed three findings that had ranked first.
- React class `render` methods and default exports in files containing JSX (including `.js`
  files) use the component line threshold; an anonymous default export is named by its file.

## [0.1.2] - 2026-10-05

_Never tagged: no git tag or GitHub release exists for this version._

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

_Never tagged: no git tag or GitHub release exists for this version._

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

_Never tagged: no git tag or GitHub release exists for this version._

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
