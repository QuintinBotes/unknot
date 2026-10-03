# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[semantic versioning](https://semver.org/); see `COMPATIBILITY.md` for what counts as public API.

## [0.1.0] - Unreleased

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
