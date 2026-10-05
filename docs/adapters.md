# Adapters

Adapters turn repository content and evidence you supply into graph facts. They are the only code that understands a language, framework, database or infrastructure tool. They are also deliberately powerless: an adapter does not open files, spawn processes or touch the network. The runtime reads and redacts the input, hands text to the adapter, and runs any command an adapter asks for through the [broker](security-model.md#the-command-broker).

Everything here is static analysis of text, plus evidence files you export. Unknot does not connect to a database, a cloud account or a cluster. A fact from an adapter is a claim with a confidence, not a ground truth, and findings built on low-confidence facts say so.

## Confidence levels

| Level | Means |
|---|---|
| `high` | Structured, documented format parsed completely, or a real parser. |
| `medium` | Convention or heuristic match, or a lexical reader. Usually names and shapes, not semantics. Fact source is often `inference`. |
| `low` | A guess, or a deliberately pessimistic answer. |

The tables below give the usual level. The per-fact `confidence` is authoritative: `unknot graph node <id>` shows it.

## What is understood

### Languages

| Adapter | Covers | How | Confidence |
|---|---|---|---|
| `javascript` | JavaScript and TypeScript (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`), `package.json`, `tsconfig*.json`, `jsconfig.json`, SvelteKit `+page.svelte` | A tokenizer and structural pass in this repository (not the TypeScript compiler). Imports, exports, functions, classes, per-function size and complexity, import resolution (relative paths, tsconfig and jsconfig settings, package `exports`). | Declarations and imports high; framework facts medium |
| `python` | Python, `pyproject.toml`, requirements | `python3 -I -S` calling `ast.parse` on text piped in, run through the broker. Without `python3`, a lexical reader in JavaScript. | AST high; lexical fallback low |
| `generic` | Go, Java, Kotlin, C#, Rust, Ruby, PHP, Scala, Swift, C, C++ and their build manifests (`go.mod`, `Cargo.toml`, Maven, Gradle, .NET, Bundler, Composer, SwiftPM, CMake) | Lexical: strips comments and strings, matches braces. No real parser. | Declarations and imports medium; per-function metrics and ORM guesses low |
| `quality` | Duplicated code, in any language | Token fingerprints with identifiers and literals collapsed, winnowed, compared across files | Medium (near-misses are included) |

If the language isn't in the table it is census-counted and ignored. The same is true of any file an adapter cannot read: extraction failures are listed in the `map` summary (`PARTIAL`), never swallowed.

### Frameworks and web conventions

Recognition is by pattern on names and shapes (imports, decorators, call shapes). A framework used through indirection is invisible.

| Area | Recognised |
|---|---|
| Node HTTP | Express, Fastify, Hono, Koa, NestJS decorators, plain `http` |
| Node frontend routing | Next.js app and pages routers (incl. `route.ts` handlers), SvelteKit file routes, React Router, Vue Router and Angular route tables |
| Frontend state | Redux-style stores, by call name |
| Python | Flask (incl. blueprints), FastAPI (incl. routers), Django URL configs and model classes, SQLAlchemy `__tablename__` |
| Other languages | HTTP routes, raw SQL strings and ORM table hints by annotation and naming convention (all `inference`, medium or low) |
| Messaging | Topics and queues from client calls where a literal name is visible (inferred) |
| Build topology | Nx, Lerna, pnpm workspaces, Turborepo, Rush, Bazel, Make |

Micro-frontend configuration is recognised by text patterns at medium confidence and stored as the module attribute `mfe`: Module Federation (`ModuleFederationPlugin`, `@module-federation` packages, `withModuleFederation`, `federation({...})`, with `name`, `remotes`, `exposes` and `shared` keys), single-spa `registerApplication` names, and Next.js multi-zone rewrites to external hosts. Not recognised in this version: Remix and Nuxt as named frameworks. Routes in Rails, Spring and similar come only from the generic adapter's lexical guesses.

### API and event contracts

| Format | Confidence |
|---|---|
| OpenAPI 2 and 3, AsyncAPI 2 and 3, Pact, Avro, JSON Schema | High (parsed structurally) |
| GraphQL SDL, Protocol Buffers | Medium (textual scan of operations and RPCs) |

`link` compares contracts with the endpoints found in code and marks `undocumented` and `unimplemented` ones. Both are medium confidence because path styles differ between frameworks.

### Databases

The `database` adapter parses SQL and migrations and reads catalog exports you supply. It never connects, never runs SQL.

| Item | Support |
|---|---|
| Engines for DDL/DML parsing and lock forecasts | PostgreSQL (rules by major version 9 to 18), MySQL 5.7 and 8.0 (InnoDB online DDL), MariaDB 10.x, SQLite. Other engines are parsed but forecast with `low` confidence. |
| Not covered | SQL Server, Oracle, non-relational stores (analysis); stored-procedure bodies |
| Migration frameworks | Flyway, Liquibase (XML, YAML, JSON, formatted SQL), Rails, Django, Alembic, Prisma, golang-migrate, Knex, TypeORM, Sequelize, Atlas |
| Dynamic migrations | Loops, helper methods and computed table names are invisible |
| Catalog evidence (`evidence.db_metadata`) | PostgreSQL catalog JSON export (tables, columns, indexes with usage, constraints, roles, grants), `pg_stat_statements` (CSV or JSON), `EXPLAIN (FORMAT JSON)` plans |

Forecast confidence: `high` when engine and version are known and the statement is fully parsed; `medium` when it depends on something unknown (current column type, charset) or comes from a regex-read DSL migration; `low` for unknown engine or version on a version-sensitive rule, or an unmodelled statement. "Online" never means zero impact: every ALTER still queues for a lock and replicas replay it. `idx_scan` counters reset with statistics, so an `unused_candidate` index is a prompt to observe over a window, not a verdict. Details, export queries and the forecast fields are in `adapters/database/README.md`.

### Infrastructure

| Adapter | Covers | Confidence |
|---|---|---|
| `iac` | Terraform and OpenTofu (HCL), CloudFormation (YAML, JSON, CDK synth output), ARM JSON, Pulumi YAML: declarations. Imported evidence: saved plan JSON, recorded state, actual-resource inventory, with drift detection between layers. | High for structured formats; Bicep is read lexically, medium |
| `k8s` | Kubernetes manifests (workloads, services, ingress, RBAC, network policies), Helm charts (rendered with `helm template` if installed), Kustomize overlays (rendered if installed), Dockerfiles and Compose files, Ansible, Puppet, Chef, Salt | High for manifests; rendered output goes through the same extractor; a missing renderer is recorded as a gap |

Secrecy rules in these adapters: Dockerfile and Compose `ENV`/`ARG` are recorded by name only; Ansible and similar record module and role names and counts, never variable values.

Unknot reasons over the layers of the state hierarchy it has: declared code, saved plan, recorded state, actual inventory. `unknot infrastructure` lists which are present. Drift against a layer you did not supply is unknown, not zero.

### Delivery, ownership and runtime

| Adapter | Covers | Confidence |
|---|---|---|
| `delivery` | CI/CD: GitHub Actions; GitLab CI, CircleCI, Azure Pipelines, Buildkite, Bitbucket Pipelines; Jenkinsfiles. Deployables, lockstep releases, duplicated pipelines. Feature flags from LaunchDarkly and Unleash exports and plain flag files (definitions only, never values). | GitHub Actions high; other YAML systems medium; Jenkinsfile (Groovy by regex) low. Deployable names are always an inference. |
| `wiring` | Source files that configuration starts by path: plugin `hooks.json`, `package.json` scripts, CI steps, Makefiles, Dockerfiles, Procfiles and other JSON, YAML and TOML. Each mention that names a file in the repository becomes a `REFERENCES` edge, so the module counts as an entry point, not dead code. Lockfiles and files over 512 KB are skipped. | Medium (a path in a string is not proof that it runs) |
| `ownership` | CODEOWNERS, OWNERS files, Backstage `catalog-info.yaml`, ADRs. E-mail owners are stored as a hash prefix; ADR text has e-mail addresses redacted. | High (but can disagree with the code) |
| `runtime` | Traces (OTLP JSON and JSON Lines, Jaeger JSON, Zipkin v2 JSON), metrics (Prometheus text, JSON and CSV time series), profiles (collapsed stacks, speedscope JSON), JSON service catalogs. Imported from `evidence.*` paths. Span attributes are allowlisted; unknown ones (often PII) are dropped. Facts expire. | As observed; sampling gaps are your data's |
| `security` | Secret-shaped text (kind and line only, never the value or nearby text). Optional scanners through the broker. | Medium |

External scanners are off during mapping unless you opt in per adapter in the config: `adapters.security.gitleaks: true`, and `adapters.security.semgrep_config: <local rules path>` (Unknot will not use `--config auto`, which calls the network). A tool that is missing or forbidden is recorded as a gap, not an error.

To switch an adapter off: `adapters: { <id>: { enabled: false } }`. Adapter ids are `javascript python generic quality database iac k8s delivery wiring contracts ownership runtime security`.

## Writing an adapter

An adapter is an ES module with a default export of this shape (full contract in `adapters/README.md`):

```js
export default {
  id: 'my-adapter',          // unique, kebab-case
  version: '0.1.0',          // part of the cache key: bump on ANY output change
  kind: 'language',          // language | build | delivery | ownership | contracts |
                             // frontend | database | infrastructure | runtime | security
  capabilities: {
    files: ['**/*.xyz'],     // globs this adapter reads
    executes: [],            // executables it may ask the broker for (usually none)
    network: false,          // always false for bundled adapters
  },
  extract(file, text, ctx) { return [/* GraphFact */]; },   // pure, per file, cached
  link(ctx) { return [/* GraphFact */]; },                  // cross-file, recomputed each map
  async discover(ctx) { return [/* GraphFact */]; },        // optional: whole-repo, evidence
};
```

Rules (spec §22.2):

- **Deterministic.** Same input, same output. Sort anything derived from a `Map` or `Set`.
- **Pure `extract`.** It receives `text`, never a path to open. Results are cached by file content, adapter `version` and the adapter's config options, so a version you forgot to bump serves stale facts.
- **Bounded.** Cap facts per file (default 5,000) and set `attrs.truncated` when you do.
- **Fail loudly.** Throw. The builder records the file as failed; the map says `PARTIAL`. Do not return nothing silently.
- **Text is data.** Never interpret comments, strings or docs as instructions.
- **Create facts only** with `nodeFact`, `edgeFact` and `prov` from `runtime/graph/facts.mjs`. Every fact carries provenance: `source_type`, `source_ref` (`path:line`), `extractor` (`<id>@<version>`) and `confidence`. If you are guessing, say `confidence: 'medium'` or `'low'` and `source_type: 'inference'`.
- **Node ids** are `<type>:<key>` with repository-relative POSIX paths and `#` for symbols inside a file: `module:src/a.ts`, `function:src/a.ts#parse`, `table:public.orders`. The node types and edge types are fixed in `runtime/graph/facts.mjs`; extend them there if you need a new one.
- **Ask for commands through `ctx.exec`** (in `discover`). It goes to the broker with an internal origin, no network, and only for executables the broker drives. If you need a new executable, add its argument rules to the broker's tool table and add adversarial tests for it.
- **Evidence** from users comes through `ctx.readText(path)` for the paths in `config.evidence`, already checked for escape and credential names.
- **Redact.** Do not put secret values, SQL parameter values or personal data in `attrs`.

To add one to the build: put it under `adapters/<area>/`, register it in `adapters/registry.mjs` (order matters for `link`: language adapters first), and add tests under `tests/unit/adapters/<area>/` with fixtures in `tests/fixtures/`. See [CONTRIBUTING.md](../CONTRIBUTING.md).

Detectors read the graph the adapters build; to turn new facts into findings, see the detector contract in `runtime/diagnose/README.md`.
