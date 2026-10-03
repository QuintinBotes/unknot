# Release and observability

This document covers how an Unknot release is built, signed and verified (spec §29), and how
telemetry is emitted (spec §27, §16.5).

## Release process

1. Update `CHANGELOG.md` (migration notes included) and `COMPATIBILITY.md` if the matrix changed.
2. Bump `version` in `package.json` and `.claude-plugin/plugin.json`; they must agree.
3. Merge to `main` with CI green (`npm test`, benchmark smoke, `plugin validate --strict`).
4. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
5. `.github/workflows/release.yml` then, in a single job:
   - checks the tag equals `v<package.json version>`;
   - runs `npm test`;
   - runs `node scripts/build-release.mjs --out dist`;
   - runs `node scripts/verify-release.mjs dist`;
   - attests the tarball and the SBOM with `actions/attest-build-provenance` (Sigstore);
   - creates the GitHub release with `gh release create` using `GITHUB_TOKEN`, uploading the tarball,
     `SHA256SUMS` and `sbom.cdx.json`.

Only that job holds `contents: write`, `id-token: write` and `attestations: write`; every other
workflow runs with `permissions: {}` or read-only scope, and every action is pinned to a full
commit SHA.

### Artifacts

| File | Contents |
| --- | --- |
| `unknot-<version>.tar.gz` | `git archive` of the tagged commit, prefix `unknot-<version>/`. Tests and fixtures are included: they are part of the reproducible source. |
| `SHA256SUMS` | SHA-256 of the tarball and of the SBOM, in `sha256sum` format. |
| `sbom.cdx.json` | CycloneDX 1.5 SBOM: the package, its zero npm dependencies, the Node.js requirement, the optional external tools (python3, git, helm, kustomize, terraform, gitleaks, semgrep) and the SHA-256 of every shipped file. |
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
