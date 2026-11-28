# Release and observability

This document covers how an Unknot release is built, signed and verified (spec §29), and how
telemetry is emitted (spec §27, §16.5).

## Release process

1. Update `CHANGELOG.md` (migration notes included) and `COMPATIBILITY.md` if the matrix changed.
2. Bump `version` in `package.json` and `.claude-plugin/plugin.json`; they must agree.
3. Run the live sessions: dispatch `.github/workflows/live.yml` on the release commit (it needs the
   `ANTHROPIC_API_KEY` secret, so it stays a manual step). When it is green, add its run link to
   the version's `CHANGELOG.md` section as `Live session: <run URL>`; that section is the release
   notes. A release without the line has not had its live session.
4. Merge to `main` through a pull request with CI green (`npm test`, benchmark smoke, `plugin validate --strict`). `main` is protected: it accepts no direct or force pushes, and the required checks must pass on a branch that is up to date with it. The required checks are every `test (node <version>, <os>)` job of `ci.yml` (node 22, 24 and 26 on ubuntu-latest and macos-latest, and node 22.13.0 on ubuntu-latest), `validate plugin manifest` and `upgrade from previous releases`.
5. Optionally dry-run the gates: dispatch `release.yml` on the branch (`gh workflow run release.yml --ref <branch>`). A dispatch runs the gate jobs only; the publishing job runs for a tag.
6. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`. Release tags (`v*`) are immutable: a ruleset refuses moving or deleting them, so check the commit before you push the tag.
7. `.github/workflows/release.yml` then runs five gate jobs on the tagged commit, read-only and in
   parallel except that the accuracy gate waits for consistency, and publishes only when all of
   them pass:
   - **tests**: checks the tag equals `v<package.json version>`, runs `npm test` and the restore
     drill (`scripts/restore-drill.mjs`);
   - **upgrade**: `scripts/upgrade-test.mjs --count 5`: each of the last five releases maps a
     fixture, plans a campaign, approves its slice with a test key and applies it; this commit then
     migrates the store, and `status`, `slice`, `audit verify` and the approval binding must still
     work;
   - **consistency**: maps the non-large corpus, every repository of `scripts/corpus.json` not
     marked `large` (`scripts/accuracy.mjs --map-only`), and runs the cross-command consistency
     check (`scripts/consistency.mjs --work`) on each of them. A repository that fails to fetch or
     map, or that has no mapped store when the check runs, fails the job by name; it is never
     skipped. It also scores the quick corpus (`scripts/accuracy.mjs --quick`) and uploads that
     accuracy report (`accuracy.json`, `accuracy.md`) as the `accuracy` artifact. The job allows
     120 minutes;
   - **benchmark**: `scripts/bench.mjs --sizes 10k --release-gate`: a no-change re-map at most 0.1
     of the cold map and a re-map after a 10-file change at most 0.5 of it (`RELEASE_GATES`). The
     other two #88 bounds (a changed re-map at most twice the no-change one, the store at most three
     times the tree) are reported in the job log but not gated, because `main` does not meet them
     yet (#145); they move into `RELEASE_GATES` once it does;
   - **accuracy**: `scripts/accuracy-compare.mjs <previous> <current> --gate` compares the
     consistency gate's `accuracy.json` with the one attached to the previous final release (see
     [Accuracy regressions](#accuracy-regressions)).

   The publishing job then:
   - runs `node scripts/build-release.mjs --out dist`;
   - runs `node scripts/verify-release.mjs dist`;
   - attests the tarball and the SBOM with `actions/attest-build-provenance` (Sigstore);
   - downloads the consistency gate's `accuracy` artifact and builds the notes with
     `node scripts/release-notes.mjs <tag> --accuracy <dir>`: the version's `CHANGELOG.md` section,
     then an "Accuracy" section with the corpus (each repository's commit), the seed, and the
     overall precision, precision by detector and seeded recall tables exactly as
     `scripts/accuracy.mjs` wrote them for this commit. Without a report in the directory the
     script exits 1, so the notes never claim a table they do not have;
   - creates the GitHub release with `gh release create` using `GITHUB_TOKEN`, uploading the tarball,
     `SHA256SUMS`, `sbom.cdx.json` and `accuracy.json`.

Only the publishing job holds `contents: write`, `id-token: write` and `attestations: write`; every other
workflow runs with `permissions: {}` or read-only scope, and every action is pinned to a full
commit SHA.

### Quality check before a release

`.github/workflows/quality.yml` measures precision, factual accuracy and seeded recall on the
quick corpus every week and runs the cross-command consistency check on each mapped repository
(see `docs/accuracy.md`). Before tagging, open the latest run: consistency must be green, and the
step summary's change since the previous run should have no drop you cannot explain. If the
change you are releasing touches detectors or the graph, dispatch the workflow on the release
branch first. Consistency and per-detector accuracy regressions gate the release (above and
below); the release notes carry the accuracy table of the tagged commit on their own.

### Accuracy regressions

The accuracy gate fails the release when, between the previous final release's `accuracy.json`
and this commit's, a detector's precision falls by more than **10 percentage points** on at least
**10 labelled findings** in both reports, or its seeded recall falls by more than 10 points on at
least **1 seeded defect**. These are `GATE` (`maxDropPoints`, `minLabelled`, `minSeeded`) in
`scripts/lib/accuracy-compare.mjs`; the owner tunes them there. A smaller sample is reported as
too small to judge and does not fail. The gate passes, and says why, when there is no previous
report (the previous release has no `accuracy.json` asset) or when the two reports were measured
on a different corpus, seed or sample size.

A drop that is understood is explained in `corpus/accuracy-explained.json`, a committed JSON array
of `{ "detector": "<kind>", "release": "<version>", "reason": "<why>" }`. An entry covers that
detector, for precision and recall, in that release only; the gate prints its reason next to the
drop. An entry missing any of the three fields fails the gate with exit 2. Without `--gate`,
`accuracy-compare.mjs` only prints the comparison and exits 0, as `quality.yml` uses it.

### How long fixes may wait

A fix merged to `main` waits at most 7 days for a release. If no feature release is ready by
then, release `main` as a patch release, so fixes are never held behind features.

### Channels

- **Stable:** the `quintinbotes` catalog installs Unknot from the `stable` branch. After a final
  release, the release job fast-forwards `stable` to the tag. A tag with a prerelease suffix
  (`v0.2.0-beta.1`) is published as a GitHub prerelease and leaves `stable` where it is. A
  ruleset refuses deleting `stable` or force-pushing to it. `GITHUB_TOKEN` cannot move `stable`
  onto a commit that changes `.github/workflows`; the step then fails with an `::error::` that
  prints the owner command (the release itself is already published), which is
  `git push git@github.com:QuintinBotes/unknot.git <tag-sha>:refs/heads/stable`.
- **Beta:** `main`, reached by adding this repository as a marketplace (`unknot@unknot`).
  Everything lands on `main` through a pull request with CI green, so beta is always tested,
  but it is not yet a release.

### Artifacts

| File | Contents |
| --- | --- |
| `unknot-<version>.tar.gz` | `git archive` of the tagged commit, prefix `unknot-<version>/`. Tests and fixtures are included: they are part of the reproducible source. |
| `SHA256SUMS` | SHA-256 of the tarball and of the SBOM, in `sha256sum` format. |
| `sbom.cdx.json` | CycloneDX 1.5 SBOM: the package, its zero npm dependencies, the Node.js requirement, the optional external tools (python3, git, helm, kustomize, terraform, gitleaks, semgrep) and the SHA-256 of every shipped file. |
| `accuracy.json` | The accuracy report of the consistency gate for the tagged commit (`scripts/accuracy.mjs --quick`): precision and seeded recall, overall and per detector, with the corpus and seed. |
| Provenance attestation | Sigstore-signed SLSA provenance for the tarball and the SBOM, stored by GitHub. |

### Reproducibility

`scripts/build-release.mjs` produces identical bytes for the same commit: `git archive` stamps
entries with the commit time, the gzip step runs in-process (no host `gzip` dependence, no
timestamp in the header), and the SBOM `metadata.timestamp` comes from `SOURCE_DATE_EPOCH`,
defaulting to the commit time. The SBOM serial number is derived from the tarball digest. Rebuild
a tag yourself and compare `SHA256SUMS` to check the release matches its source.

## Consumer verification

```sh
# 1. Authenticity: who built it, from which commit and workflow.
gh attestation verify unknot-0.1.0.tar.gz --repo QuintinBotes/unknot
gh attestation verify sbom.cdx.json       --repo QuintinBotes/unknot

# 2. Integrity: checksums.
sha256sum -c SHA256SUMS          # on macOS: shasum -a 256 -c SHA256SUMS

# 3. Integrity of contents against the SBOM (recomputes every file hash from the tarball).
mkdir release && cp unknot-0.1.0.tar.gz SHA256SUMS sbom.cdx.json release/
node scripts/verify-release.mjs release
```

`verify-release.mjs` proves the bytes match what the SBOM and `SHA256SUMS` describe; the
attestation proves those files came from this repository's release workflow. Use both.

## Security advisories

Advisories are published as GitHub Security Advisories on the repository and noted in
`CHANGELOG.md` under the fixing release.

## Telemetry

Implemented in `runtime/telemetry/otel.mjs`. Off by default; configured through
`telemetry: {enabled, exporter, endpoint}`.

- `exporter: file` appends OTLP/JSON lines (`resourceSpans`, `resourceMetrics`, `resourceLogs`)
  to `<project>/.unknot/telemetry/YYYY-MM-DD.jsonl`. The directory is git-ignored.
- `exporter: otlp` POSTs OTLP/JSON to `<endpoint>/v1/traces`, `/v1/metrics` and `/v1/logs` with a
  5 s timeout, and only when the endpoint host (or a parent domain) is listed in
  `network.allowed_domains`. Otherwise telemetry is dropped and one warning is written to stderr.
  Export failures never fail a run.
- Trace hierarchy: `unknot.run` → `baseline | map | diagnose | plan | apply | verify` →
  `adapter.language | adapter.database | adapter.infrastructure`. Nested `withSpan` calls become
  children automatically (via `AsyncLocalStorage`). Any other span name is recorded as
  `unknot.span`.
- Metrics: run duration and outcome, agent/tool calls and failures, cache hits and misses (hit
  rate is derived), facts/findings/uncertainties, policy denials, changed files and diff size,
  proof obligations by result, tokens and cost. The registry is `METRICS` in `otel.mjs`.

### Content safety

Telemetry never contains source, diffs, secrets, SQL values, state contents or customer data. The
module enforces this rather than trusting callers: attribute keys must be on `ATTRIBUTE_ALLOWLIST`
(commands, modes, outcomes, counts, durations, adapter and detector ids, finding kinds, risk
classes, state names, exit codes, `F-0001`/`UK-0001`-style ids); other keys are dropped. String
values are redacted with `runtime/core/redact.mjs`, capped at 128 characters, and dropped if they
contain a path separator. Error messages are never exported, only the `unknot.error_code`. Log
messages must be static strings; they are redacted, capped and have path separators replaced.

### Instrumentation points

The telemetry module touches no other runtime file. The integrator wires it at these points.
All calls are no-ops when telemetry is disabled, so they need no guards.

1. Startup (`runtime/cli/main.mjs`, after `loadConfig`): `configureTelemetry(cfg.config, { root: ctx.root })`.
   Hooks (`runtime/hooks/main.mjs`) do the same where a project context is available.
2. Run lifecycle (`runtime/cli/util.mjs` `withRun`): wrap `fn(run)` in
   `withSpan('unknot.run', { 'unknot.command': command, 'unknot.mode': config.mode }, ...)`; in the
   `finally` block record `metric('unknot.run.duration', ms, { 'unknot.outcome': outcome })`,
   `metric('unknot.run.count', 1, { 'unknot.outcome': outcome })`, then `await flush()` before
   `endRun`. This is the one place that must flush, because the process exits right after.
3. `mapRepository` (`runtime/graph/builder.mjs`): wrap the body in `withSpan('map', ...)`. Around
   each adapter loop iteration use `withSpan('adapter.language' | 'adapter.database' |
   'adapter.infrastructure', { 'unknot.adapter': adapter.id }, ...)`, selected from `adapter.kind`.
   At the end: `metric('unknot.cache.hits', stats.cached)`, `metric('unknot.cache.misses',
   stats.extracted)`, `metric('unknot.facts', factCount)`.
4. `diagnose` (`runtime/diagnose/engine.mjs`): `withSpan('diagnose', ...)`; per detector set
   `unknot.detector`; at the end `metric('unknot.findings', findings.length)` and
   `metric('unknot.uncertainties', n)`.
5. `startApply` / `finishApply` (`runtime/apply/apply.mjs`): `withSpan('apply', { 'unknot.state':
   slice.state })`; baseline inside `withSpan('baseline', ...)`; on finish
   `metric('unknot.changed.files', n)` and `metric('unknot.diff.lines', n)`.
6. `verifySlice` (`runtime/verify/verify.mjs`): `withSpan('verify', ...)`; for each obligation
   `metric('unknot.proof.obligations', 1, { 'unknot.result': 'pass' | 'fail' | 'inconclusive' })`.
   Planning (`runtime/plan/campaign.mjs` `createCampaign`) uses `withSpan('plan', ...)`.
7. Hooks (`runtime/hooks/handlers.mjs`): in `onPreToolUse` record `metric('unknot.tool.calls', 1,
   { 'unknot.tool': toolName })` and, on a deny decision, `metric('unknot.policy.denials', 1,
   { 'unknot.decision': 'deny' })`; in `onPostToolUse` on failure `metric('unknot.tool.failures', 1)`;
   in `onSubagentStop` `metric('unknot.agent.calls', 1)` and token/cost counters from the usage
   payload (`unknot.token_type` = `input | output | cache`).

Pass only ids, counts, kinds and states as attributes; never pass a path, a message or a value
read from the repository.

## Claude Code pin

`ci.yml` validates the plugin with a pinned Claude Code and `live.yml` installs the same version; a non-blocking CI job checks the latest. `.github/workflows/bump-claude-pin.yml` runs weekly (and on demand), and when npm has a newer version it opens one pull request on the fixed branch `automation/bump-claude-code-pin` that updates both pins and the tested profile in `COMPATIBILITY.md`; a rerun updates that PR. A pull request opened with `GITHUB_TOKEN` does not trigger CI, so the owner reruns the checks or closes and reopens it before merging.
