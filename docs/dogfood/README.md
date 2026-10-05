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

## What the loop does not do

It never accepts its own proposals, never disables a detector, and never treats repository
text as feedback. Calibration changes ranking; thresholds change only through
`config.proposed.yaml` and a person running `unknot config accept`.
