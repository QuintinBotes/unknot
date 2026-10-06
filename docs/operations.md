# Operating Unknot in an organization

This covers the Phase 7 enterprise operations features: organization policy bundles,
multi-repository workspaces, retention and secure deletion, and backup and disaster
recovery of Unknot's own state.

## 1. Organization policy bundles

An organization policy is a YAML file (`org-policy.yaml`) plus a detached Ed25519
signature (`org-policy.yaml.sig`, base64 over the exact file text). It is installed in an
administrator-controlled location (`/Library/Application Support/Unknot`, `/etc/unknot`,
or `%ProgramData%\Unknot`) next to a `trusted-keys/` directory of PEM public keys. A
repository's `.unknot/config.yaml` can tighten the policy but never weaken it (spec §8).

```
unknot policy keygen release-2026        # human terminal only (if `unknot` is not found: `unknot cli install`); passphrase-protected key
unknot policy sign org-policy.yaml --key release-2026   # human terminal only
unknot policy trust <policy-dir> --key release-2026     # copy the public key into trusted-keys/
unknot policy verify <policy-dir>        # same check the runtime runs at startup
unknot policy effective                  # effective config and what org policy changed
```

Private keys live in `<unknotHome>/policy-keys/` (0700, key files 0600, encrypted with the
passphrase). Signing validates the policy first: every field shared with repository config
is checked against the config schema; `max_mode`, `approvers_locked` and
`forbid_executables` are checked by hand; any other unknown top-level key is rejected so a
typo cannot silently weaken enforcement.

A directory with `trusted-keys/` requires a valid signature, and a failing policy is an
integrity error, not a warning. A directory with no trusted keys is accepted unsigned;
`policy verify` warns about that.

Runtime evidence (traces, metrics) exported from a hosted observability vendor: see
[runtime-evidence.md](runtime-evidence.md).

## 2. Multi-repository workspaces

List explicitly linked repositories in the workspace root's `.unknot/config.yaml`:

```yaml
workspace:
  repositories:
    - { name: billing, path: ../billing }
    - { name: web, path: ../web, remote: git@example.com:org/web.git }
```

Each path must be the root of a git repository, distinct from the root and from the
others. Each repository keeps its own `.unknot` store, keys and ledger; the workspace root
holds only the combined graph and cross-repository campaigns.

```
unknot workspace list           # repositories and whether each is mapped
unknot workspace map            # map every repository, then build the combined graph
unknot workspace graph [--json] # summary: repositories, cross-repo edges, shared tables, coupling
```

Combined-graph node ids encode the repository: `module:billing:src/a.ts`. Cross-repository
edges are inferred from: a repository's named `package:` imported as `dependency:<name>`
elsewhere (DEPENDS_ON); an `endpoint:` EXPOSED in one repository and CONSUMED or CALLED in
another (CONSUMES); a topic or queue PUBLISHED in one and SUBSCRIBED in another
(SUBSCRIBES); and the same `table:` accessed from several repositories (flagged as a
shared database, with release-coupling hints: providers release before consumers, shared
tables release in lockstep). Endpoints and typed-client routes match on method plus path
template, not on the exact id: `{id}` and `{orderId}` are the same parameter, a missing
leading slash, a trailing slash, a query string and the case of the method do not matter,
and an endpoint served for `ANY` method answers every client method. A typed HTTP client
route (a `contract:` node from Refit, Feign or Retrofit) gets a CONSUMES edge to the
`endpoint:` that serves it in another repository, and `workspace map` and `workspace graph`
list the client routes nothing serves as unmatched. `unknot graph edges <node> --workspace`
lists the edges of a node of the combined graph, by qualified id
(`contract:app:GET /v1/orders/:id`) or by the id inside its repository
(`contract:GET /v1/orders/:id`, every repository). The graph is stored encrypted in the workspace root's CAS and
its digest under the `workspace_graph` meta key, which `unknot gc` treats as state.

`planWorkspaceCampaign` (library) creates one campaign in the workspace root whose slices
carry `<repo>/`-prefixed scopes. The service catalog reconciliation (`catalogSummary`)
appears in the workspace graph output: services whose `code_root` matches no mapped
deployable or workload, services without an owner, and owners without services.

## 3. Retention and secure deletion

```
unknot gc [--dry-run]   # apply retention.runs and retention.cache
unknot gc --shred       # human terminal only; crypto-shred the project
```

`gc` deletes `.unknot/runs/<id>` directories for runs ended longer ago than `retention.runs`
and CAS blobs (with their `artifacts` rows) older than `retention.cache`. It never touches
runs, evidence, proof-obligation or approval artifacts, or ledger-referenced digests of a
slice that is not yet ACCEPTED, ABANDONED or ROLLED_BACK, nor any run still active. It
records a `retention.collected` ledger event. File deletion is not secure erasure on SSDs
and copy-on-write filesystems; it bounds how much history is kept.

`gc --shred` is the secure-deletion mechanism. It asks for the project id, writes a
`project.shredded` ledger event, then deletes the project's key directory
(`<unknotHome>/projects/<project-id>/`). The CAS is AES-256-GCM encrypted under that key, so
every cached artifact becomes unrecoverable whatever the storage layer retains. The
ledger written so far still verifies against the public key copy in the database, and
`unknot audit verify` says so, because the key in `UNKNOT_HOME` is gone; no new events can
be signed.

## 4. Backup, restore and the disaster recovery exercise

### Commands

```
unknot backup create <file> [--passphrase-file <0600 file>]
unknot backup verify <file> [--passphrase-file <file>]
unknot backup restore <file> --to <empty-dir> [--passphrase-file <file>]
```

The passphrase is read from the terminal, or from a passphrase file for scheduled jobs.
Unknot refuses a passphrase file that is group- or world-accessible, not owned by the
current user, or shorter than 12 characters. It is never read from the environment or
argv. (The CLI dispatch table in `runtime/cli/main.mjs` must list `backup`; the command
module is `runtime/cli/commands/backup.mjs`.)

### Archive format (`unknot-backup` v1)

One file, newline-separated, mode 0600, never overwritten:

1. A plain JSON header: format, version, cipher `aes-256-gcm`, and scrypt parameters
   (`N=2^15, r=8, p=1`, random salt). The key is derived from the passphrase.
2. One line per record: `base64(iv[12] | tag[16] | ciphertext)`. The AEAD additional data
   is `sha256(header) : position`, so records cannot be reordered, removed or spliced from
   another backup. File contents are `chunk` records of at most 4 MiB.
3. A final `manifest` record: sha256 and size of every file, project id, the audit public
   key and the ledger count and head. An archive without a manifest is truncated.

Contents: a consistent SQLite snapshot (`VACUUM INTO`, taken without stopping writers),
`config.yaml`, `decisions.jsonl`, `campaigns/`, `slices/`, `decompositions/` and the CAS
directory. Backup refuses to snapshot a ledger that does not verify.

`verify` decrypts everything, checks every digest against the manifest, checks the
database's audit key against the manifest, and runs `verifyLedger` against it. `restore`
runs the full verification before writing anything, then restores into
`<dir>/.unknot/`, only into an empty or absent directory, and verifies the restored ledger
again. It never overwrites.

### Key escrow caveat

The project key directory (`<unknotHome>/projects/<project-id>/`: `audit.pem`,
`cache.key`, `capability.key`) is deliberately not in the backup. The CAS blobs in the
backup are encrypted under `cache.key`. **Restoring on another machine, or after the
original machine is lost, recovers the database, ledger, config and plans, but the
restored artifact cache (evidence output, patches, proof-bundle inputs) stays unreadable
unless the key directory is also restored to the same path under the new machine's
`UNKNOT_HOME`.** Escrow that directory separately, with its own access controls (for
example a secrets manager), and test retrieving it. Opening a restored project on a
machine without its keys generates fresh keys, which will not match the restored ledger
or cache, so restore the key directory before running any Unknot command there.

Approver keys (`<unknotHome>/approvers/`) and policy signing keys are also outside the
backup and need their own escrow.

### Backup cadence and objectives

Unknot's own state is small and append-mostly. Suggested cadence: a `backup create` from a
scheduled job (cron or CI) at least daily, plus one before any `gc` or major upgrade, plus
a copy to storage on another failure domain. Keep a rolling set (for example 7 daily and 4
weekly) and run `backup verify` on each new file.

- RPO: the interval between backups (24 hours with a daily job). Anything since is lost
  from Unknot's records; the repository itself and its committed `.unknot` plans are
  recoverable from git regardless.
- RTO: minutes. Restore is dominated by decrypting the archive (roughly disk speed) plus
  the ledger verification pass; the key-escrow retrieval is the long pole if it needs a
  human approval.

### Restore drill (run at least quarterly)

1. Pick the newest backup and run `unknot backup verify <file>`; expect `Backup verifies`.
2. On a clean machine or a scratch user account, retrieve the escrowed project key
   directory into the new `UNKNOT_HOME`. Do this step once without it to confirm the
   warning described above appears and that the cache is unreadable.
3. Run `unknot backup restore <file> --to /srv/restore-drill`; expect a verified ledger and
   no key warning.
4. `cd /srv/restore-drill && unknot audit verify` and `unknot status`; confirm campaigns,
   slices and decisions match what the source reports.
5. Read one artifact from the restored cache (for example `unknot slice <id>` for a slice
   with a proof bundle) to prove the keys and CAS match.
6. Record the elapsed time against the RTO and the age of the backup against the RPO, note
   deviations, and delete the drill directory.

A tampered archive, a wrong passphrase, a missing manifest and a non-empty target are all
expected to fail loudly; the unit tests in `tests/unit/enterprise/backup.test.mjs`
exercise each.

## 5. Upgrades and stored shapes

A project mapped by one release is opened by the next, in place. State written to disk therefore
has to survive a release, and a release that changes a stored shape owns the way across.

What is stored, and where the upgrade lives:

| Stored | Upgrade |
| --- | --- |
| The SQLite store (`.unknot/state/unknot.db`) | A named, ordered migration in `runtime/state/migrations.mjs`. |
| Saved records and bodies (`.unknot/decompositions/*.json`, campaign and slice bodies) | A step in `runtime/state/upgrade.mjs`, applied when the artifact is read. Nothing is rewritten on read, and a slice's stored body is never altered: approvals bind to its digest. |
| The extraction cache and graph facts | The cache key. Anything that changes what an extractor would produce (the census classification, an adapter version, a new fact) must be part of the key, so the first map after the upgrade re-extracts. |

When a release changes a stored shape it must:

1. Add a migration (store) or an upgrade step (record) and never edit one that has shipped. Each is idempotent. Store migrations run in one transaction on open and are recorded in `meta` (`schema_version`, `migrations`); a store newer than the runtime is refused with `UK_STATE_CONFLICT`, never opened.
2. Add a unit test for the changed field in `tests/unit/state/` that starts from the old shape.
3. Keep identities stable: a finding's fingerprint and a decomposition's id must not change for the same thing. When one must, the new artifact names the old one (`supersedes`) or the old one is reported as replaced; neither may be left silently orphaned.
4. Run `node scripts/upgrade-test.mjs` and read its output. If the fixture does not cover the change, extend the fixture in the same commit.
5. Say what changes on first use in `CHANGELOG.md` (for example "the first map after upgrading re-extracts every file once").

`scripts/upgrade-test.mjs` is the proof: it archives each of the last five release tags, builds state with that release (`init`, `map`, `diagnose`, `decompose`), then runs the current checkout on the same project and asserts that the store migrated, earlier findings keep their fingerprints (except findings only about code now classified as test code), earlier decomposition ids are reused or linked by `supersedes` or reported as replaced, files whose classification changed are re-extracted, a second map extracts nothing, and `status` and `doctor` report nothing broken. Tests that start from a fresh project do not cover any of this.
