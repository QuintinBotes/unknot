# Contributing

Thank you for helping. Unknot is a safety tool, so the bar for changes that touch policy, the broker, hooks, approvals or the ledger is high: a change there needs a test that fails without it, and an adversarial test if it closes or could open a bypass.

For vulnerabilities, do not open a public issue; see [SECURITY.md](SECURITY.md).

## Setup

Requirements: Node.js 22.13 or later and git. Python 3, Helm, Kustomize, Terraform, gitleaks and semgrep are optional; tests that need them skip or opt in explicitly.

```sh
git clone https://github.com/QuintinBotes/unknot.git
cd unknot
node bin/unknot --version
node bin/unknot doctor
```

There is nothing to install: the runtime has zero npm dependencies and uses only Node's standard library (`node:sqlite`, `node:crypto`, `node:http`, and so on). Please keep it that way. A change that adds a dependency needs a very good reason and will be discussed first.

To use your checkout as a plugin while developing, point Claude Code at it (`claude --plugin-dir <path>`), or run the CLI directly with `node bin/unknot`. Use a scratch repository and set `UNKNOT_HOME` to a temporary directory so you do not touch your real keys:

```sh
export UNKNOT_HOME=$(mktemp -d)
cd /path/to/scratch-repo
node /path/to/unknot/bin/unknot init
```

## Tests

```sh
npm test                 # everything: node --test --test-concurrency=4 "tests/**/*.test.mjs"
npm run test:unit        # tests/unit
npm run test:adversarial # tests/adversarial: shell, PDP and hook bypass attempts
node --test tests/unit/broker/broker.test.mjs   # one file
npm run bench            # scripts/bench.mjs; add --quick for the CI smoke size
npm run validate         # claude plugin validate --strict .   (needs the claude CLI)
```

CI runs `npm test` and the benchmark smoke on Ubuntu and macOS with Node 22 and 24, and validates the plugin manifest. Tests create their own temporary repositories and `UNKNOT_HOME`; see `tests/helpers/kernel.mjs` for the kernel fixtures. Use fixtures under `tests/fixtures/` for adapter and detector tests, and keep them small.

Conventions:

- ES modules, `.mjs`, Node built-ins only, two-space indent, single quotes, semicolons. Follow the style of the file you are in. There is no formatter or linter configured, so keep diffs focused.
- Deterministic output: sort anything derived from a `Map` or `Set`; seed any randomness.
- Errors use `UnknotError` with a code from `runtime/core/errors.mjs`.
- Anything user-visible that comes from the repository under analysis is data. It must never reach a place where it could be interpreted as an instruction, a path outside the project, or a shell command.
- Document what exists. If you change behaviour, update the relevant file in `docs/`. The documentation states what the code does, including limits, and should keep doing so.

## Adding a detector

A detector reads the graph and returns finding drafts. It never writes, never runs commands, and never decides priority, approvals or status. The contract is in `runtime/diagnose/README.md`.

1. Add the detector to the module for its category in `runtime/diagnose/detectors/` (`local`, `module`, `service`, `delivery`, `security`, `database`, `infrastructure`, `decomposition`, `frontend`), or add a new module and register it in `runtime/diagnose/detectors/index.mjs`. The id is `<category>.<name>`.
2. Fill in every field of the draft. They answer the ten questions: what, evidence with `source_ref`, why it is accidental and what might make it essential, the smallest simplification, invariants, what could fail, verification, recovery, uncertainty. A draft that leaves one blank is not finished. Always include `retain` among the alternatives.
3. Say which thresholds are heuristics, in `thresholds`. Take them from `ctx.options` with a default, so a user can tune them under `detectors.<id>` in the config.
4. Name pattern cards in `patterns` that should be evaluated for fit.
5. Add tests under `tests/unit/detectors/` with a fixture graph or repository that triggers it, and one that must not. Prefer false negatives to false positives: a finding that is usually wrong teaches users to ignore all of them.
6. If the detector has a numeric option that the learning loop should be able to tune, add it to `THRESHOLD_FOR` in `runtime/learn/calibration.mjs`.

## Adding a pattern card

Cards live in `patterns/<category>/<name>.yaml` and are validated by `schemas/pattern-card.schema.json`. The id is `<category>.<kebab-name>`.

1. Copy a neighbouring card. Fill in the problem, forces, applicability signals, preconditions, contraindications, benefits, liabilities, introduced complexity, invariants, transformations, proof obligations, rollback strategies, composes/conflicts, and a removal recipe. A pattern with no honest liabilities has not been thought through.
2. Machine-evaluable conditions use `predicate: { metric, op, value }`, and `metric` must be in the vocabulary table in `patterns/README.md`. Add a new metric there only if something actually measures it, and say what measures it. A metric nothing produces makes the card return `insufficient_evidence` forever.
3. Mark `hard: true` on contraindications that must rule the pattern out.
4. Card counts are asserted per category in `tests/unit/patterns/*.test.mjs`; update the count when you add a card.
5. For decomposition treatments (T0 to T9), `treatment` links the card to the selection algorithm in `runtime/decompose/select.mjs`. Changing the invasiveness order or driver mapping is a design change; raise it first.

## Adding an adapter

See [docs/adapters.md](docs/adapters.md#writing-an-adapter) and `adapters/README.md`. In short: default export with `id`, `version`, `kind`, `capabilities`, and `extract`/`link`/`discover`; powerless (no fs, process or network access of its own); deterministic; bounded; facts only through `nodeFact`/`edgeFact`/`prov` with honest confidence. Register it in `adapters/registry.mjs`, bump `version` on any output change, and add tests under `tests/unit/adapters/<area>/` with fixtures. Adapters that need an executable go through the broker, which means a rule in `TOOL_RULES` in `runtime/broker/broker.mjs`, with adversarial tests for the argument rules.

## Changing policy, hooks or the broker

- Make the behaviour fail closed. If you cannot decide, deny.
- Add tests to `tests/adversarial/` that try to get around your change. Look at `kernel-pdp.test.mjs` and `shell-corpus.test.mjs` for the form.
- The human-only command list lives in `runtime/policy/commands.mjs` (`HUMAN_ONLY_SUBCOMMANDS`) and in `alwaysOn` in `runtime/policy/pdp.mjs`. A new command that records a decision, changes authority, or ends enforcement must be added to both and must call `requireHumanTTY`.
- A new CLI command needs an entry in `COMMANDS` in `runtime/cli/main.mjs`, a module in `runtime/cli/commands/`, and, if it is a run command, an entry in `COMMANDS` in `runtime/state/runs.mjs`. If it has a `/unknot:` form, add `skills/<name>/SKILL.md`.
- Config keys: change `schemas/config.schema.json`, `runtime/policy/defaults.mjs`, and, if org policy should be able to tighten it, `runtime/policy/merge.mjs`. Update `docs/configuration.md`.
- Anything in the public surface listed in [COMPATIBILITY.md](COMPATIBILITY.md) follows semver. Say so in the changelog.

## The dogfood harness

`scripts/dogfood.mjs` runs Unknot's read-only pipeline over real repositories and records what happened, so the feedback loop has data. It clones each repository into a temporary directory first (your checkout is never opened for writing), uses a throwaway `UNKNOT_HOME`, writes and accepts a plan-mode config with detected commands, then runs `map`, a second `map` (to measure the cache), `diagnose`, `decompose` and `architecture`, timing each.

```sh
node scripts/dogfood.mjs [--out DIR] [--top N] <repo-path>...
```

It prints one summary line per repository and writes `<repo>.json` and `summary.json` to `--out` (default: a timestamped directory under the system temp). The per-repository report has timings and memory, file kinds, node and edge counts, extraction failures, adapters that were unavailable, the top `--top` findings (default 25) with their evidence and uncertainty, decomposition recommendations with sample rejected treatments and gaps, and recognised architectural styles.

What to do with it: look at the top findings of a repository you know and ask whether each is right. A finding you would reject is a bug report against a detector (or a threshold); a real problem it missed is a bug report against an adapter or a detector. Fixes that came out of earlier rounds are in the git history (messages beginning "Dogfood round"). Do not commit output from private repositories.

## Live sessions

Unit tests cannot show what happens when a model drives the plugin: a skill that steers it wrong, a hook that denies a legitimate step, a sandbox rule that breaks the installed layout, a silent fallback. Two scripts run real headless Claude Code sessions (they cost API usage).

`scripts/writepath-e2e.mjs` runs the change workflow end to end on a disposable clone of one repository: map, diagnose, a slice planned from a real long or complex function, the plan approved with a throwaway test approver key, a live `/unknot:apply` session, a live `/unknot:verify` session, then the change approved and accepted. It passes when the slice is ACCEPTED, only the planned file is staged, the main checkout is untouched and the ledger verifies.

```sh
node scripts/writepath-e2e.mjs --repo <path> --test '<json argv>' [--setup '<shell>'] \
  [--lang py|js|ts|rs|go] [--within <dir>] [--plugin-dir .] [--out report.json]
```

`--setup` runs outside Unknot, with network (install dependencies there; the sandbox has none). `--plugin-dir .` runs the sessions on your checkout instead of the installed plugin, which is how you test a skill or hook change before a release.

`scripts/live-suite.mjs` installs the plugin as a user would and runs every read-only step (`init`, `map`, `diagnose`, `explain`, `decompose`) on the public repositories pinned in `scripts/live-suite.json`, plus the change workflow on one of them in rotation (`--change all` for every one). A session fails on a non-zero exit, a crash in a tool result or a degraded map (a notice); hook denials and Unknot errors are listed as warnings to read.

```sh
node scripts/live-suite.mjs --install local [--repos click] [--change all|none|<name>]
```

The `Live sessions` workflow runs it nightly with `--install fresh` (a new Claude config, the plugin added from this checkout as a marketplace) when the repository has an `ANTHROPIC_API_KEY` secret, and uploads the transcripts. Run it before a release; a failure there is a release blocker.

## Commits and pull requests

- One logical change per commit. Commit subjects are short, sentence-case, imperative or descriptive, with no type prefix: `Brokered commands get a private TMPDIR outside the project`. Put the reason in the body when it is not obvious, and name the dogfood finding if one drove the change.
- Run `npm test` before you push. If you changed anything under `runtime/policy`, `runtime/broker`, `runtime/hooks` or `runtime/core/shell.mjs`, say in the pull request what you tried to bypass.
- Update `CHANGELOG.md` under the unreleased version for anything a user would notice, and `COMPATIBILITY.md` if the matrix changed.
- Do not weaken a safety property to make a test pass. If a test is wrong, say why.

## Releasing

Releases are built and attested by the workflow in `.github/workflows/release.yml`; the process is in [docs/release.md](docs/release.md).
