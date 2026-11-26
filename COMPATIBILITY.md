# Compatibility

Unknot follows [semantic versioning](https://semver.org/) for its public API (spec §29).

## Public API

A change to any of these is governed by the semver policy below.

| Surface | Where it is defined |
| --- | --- |
| The public commands and skills listed below, their arguments, flags and exit codes; the `bin/unknot` executable | spec §4.1, `runtime/cli/` |
| Configuration schema (`.unknot/config.yaml`, `version: 1`) | `schemas/config.schema.json` |
| Pattern-card schema | `schemas/pattern-card.schema.json` |
| Adapter interfaces (`id`, `version`, `kind`, `capabilities`, `extract`, `link`, ...) | `adapters/README.md` |
| Artifact schemas: finding, graph fact, provenance, campaign, slice, approval, decision, evidence record, proof obligation, proof-bundle manifest, handoff, event, error, migration, decomposition recommendation | `schemas/*.schema.json` |
| Policy input/output (operation in, `allow | ask | deny` decision with reasons out) and the organisation policy bundle format | `runtime/policy/`, spec §14 |

### Commands and skills

Every command in `unknot --help` and every skill is public API, except `exec`, `run` and `daemon`,
which skills and agents call as plumbing: they may change in any minor release. The human-only
commands (`approve`, `attest`, `keys`) are public. A test keeps these lists in step with `COMMANDS`
and `skills/`, so a new command or skill must be classified here.

**Public commands**: `init`, `map`, `import`, `diagnose`, `explain`, `decompose`, `plan`, `next`, `apply`, `verify`, `architecture`, `database`, `infrastructure`, `security`, `status`, `rollback`, `accept`, `reject`, `cli`, `lane`, `search`, `doctor`, `pattern`, `graph`, `slice`, `approve`, `attest`, `keys`, `config`, `audit`, `policy`, `backup`, `workspace`, `gc`, `learn`

**Internal commands**: `exec`, `run`, `daemon`

**Public skills**: `accept`, `apply`, `architecture`, `database`, `decompose`, `diagnose`, `doctor`, `explain`, `infrastructure`, `init`, `lane`, `learn`, `map`, `next`, `plan`, `reject`, `rollback`, `security`, `status`, `verify`

Not public: anything under `runtime/` imported directly, the SQLite state layout (migrated
automatically, see `schemas/migration.schema.json`), the `.unknot/telemetry/` file contents beyond
OTLP/JSON, and the benchmark harness.

A store is migrated forward when a newer release opens it, never back. A migration older releases
cannot live with raises the store's `schema_version`, after which those releases refuse to write it
(their hooks still allow read-only commands); the release that ships one says so in the CHANGELOG
migration notes. The compact edge table after 0.4.0 (schema 3, #88) is such a migration.

## Compatibility matrix

| Component | Supported | Notes |
| --- | --- | --- |
| Node.js | 22.13 and later; CI runs 22, 24 and 26, and the exact floor 22.13.0 | `engines.node` is `>=22.13`. No npm dependencies. |
| Operating systems | Linux and macOS (CI: ubuntu-latest, macos-latest) | Windows is not tested; use WSL2. |
| Claude Code | A version supporting plugins with hooks and `claude plugin validate --strict` | Validated in CI against the current release. |
| git | Required | Worktree isolation and census depend on it. |
| python3 | Optional | Python adapter helpers, when present. |
| helm, kustomize, terraform | Optional | Infrastructure adapters render or plan only when installed. |
| gitleaks, semgrep | Optional | Used as extra evidence when installed; built-in secret redaction does not depend on them. |

Optional tools are detected at run time (`/unknot:doctor` reports them) and are never bundled; a
missing tool reduces evidence and is reported, never silently ignored.

## Semver policy

- **Major**: removing or renaming a command, flag, schema field or adapter interface member;
  tightening a schema so previously valid files are rejected; changing a policy decision's meaning;
  raising the minimum Node.js version.
- **Minor**: new commands, flags, optional schema fields, detectors, adapters and metrics.
- **Patch**: fixes, including fixes that make a previously permissive security behaviour stricter.
- Schemas carry their own `version`/`schema_version`. A schema revision that is not backward
  compatible ships with a migration (see `CHANGELOG.md` migration notes) and an upgrade path
  through `unknot doctor`.
- Pre-1.0 (`0.x`): minor releases may include breaking changes; they are always listed in the
  changelog.

## Support policy

- The latest minor release receives fixes. Security fixes are also backported to the previous
  minor release for 90 days after the newer minor is published.
- Each Node.js version is supported while it is in Active or Maintenance LTS, and for at least one
  minor release after it reaches end of life.
  The lines, and the date each window ends (end of Maintenance LTS), which a test checks against the CI matrix:

  | Node.js line | Window ends |
  |---|---|
  | 22 | 2027-04-30 |
  | 24 | 2028-04-30 |
  | 26 | 2029-04-30 |
- Security advisories are published as GitHub Security Advisories and listed in `CHANGELOG.md`.
- Each release ships a signed provenance attestation, checksums and an SBOM; see `docs/release.md`.
