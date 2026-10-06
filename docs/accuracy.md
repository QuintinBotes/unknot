# Published accuracy

How often Unknot's findings are right, and how many planted defects it finds, measured on a
pinned corpus of public repositories. This is the accuracy part of roadmap item 7. Earlier
audits ([dogfood rounds 7 and 8](dogfood/README.md)) were done by hand on ad hoc repositories;
this page is the repeatable version.

## Method

`scripts/accuracy.mjs` fetches each repository in `scripts/corpus.json` at its pinned commit
(shallow, into `--work`, never into this checkout), then runs `init`, `map` and `diagnose` with
the current checkout of Unknot.

**Precision.** Findings are grouped into strata of (finding kind, language of the first file in
scope). Strata and the members of each stratum are ordered by a hash seeded with `--seed`, and
the sample takes them round-robin until it has `--sample N` findings (default 20 per
repository). The same seed gives the same sample, and any prefix of a sample is itself
stratified. Each sampled finding is compared with the label stored in
`corpus/labels/<name>@<sha>.json`, keyed by the finding's fingerprint:

| Label | Meaning |
|---|---|
| `true` | The claim is correct and a maintainer would want to know |
| `false` | The claim is factually wrong |
| `not-worth` | The claim is correct but not worth acting on |

The report gives, per detector (finding kind), per language and overall: the number labelled,
the count of each label, the unlabelled findings in the sample (so labelling can continue),
**precision** (`true` over labelled) and **factual** accuracy (`true` plus `not-worth` over
labelled).

Because strata are equal-sized rather than proportional, the overall figure over-represents
rare finding kinds. It is not comparable with the simple random sample of round 8 (75% true),
where common kinds dominated. Read the per-detector rows for what a detector does.

**Recall.** A copy of each repository gets known defects in new files under `unknot_seed/`
(`scripts/lib/accuracy-seeds.mjs`), in the repository's dominant language: an import cycle
between two files, a private function nobody calls, a function of 110 lines, and, for C# and
Java, a constructor-injected member that is never used. The copy is re-mapped and diagnosed;
a seed counts as found when a finding of the expected kind has a seeded file in its scope.
Recall is measured only on these planted defects. It says nothing about defects Unknot does
not know how to describe.

## Corpus

Pinned in `scripts/corpus.json`; sizes are files mapped by the 0.1.15 run below.

| Repository | Language | Style | Files |
|---|---|---|---:|
| nopCommerce | C# | layered monolith (ASP.NET Core MVC) | 6,741 |
| OpenMRS core | Java | layered monolith (Spring, Hibernate) | 1,929 |
| Spring PetClinic | Java | small reference application (quick) | 132 |
| Saleor | Python | monolith (Django, GraphQL) | 4,690 |
| Mastodon | Ruby | monolith (Rails) with a React frontend | 10,070 |
| Akaunting | PHP | modular monolith (Laravel) | 4,310 |
| PrestaShop | PHP | layered monolith (Symfony) | 15,860 |
| Gitea | Go | monolith (Go server, web frontend) | 6,331 |
| PocketBase | Go | small server framework (quick) | 923 |
| Twenty | TypeScript | monorepo (NestJS, React), `large: true` | 35,763 |
| Online Boutique microservices demo | Go (five languages) | eleven-service microservice set | 364 |
| Excalidraw | TypeScript | React single-page app | 1,308 |

Shallow checkouts of all twelve total about 4.9 GB with the map state. Twenty is marked
`large` because it has 35,763 files and needs `limits.max_files_read` above its default of
50,000 (the harness raises it); it runs only with `--include-large` or `--only twenty`.

## Running it

```sh
# Everything not marked large (about 5 minutes of mapping on an idle 10-core laptop, plus the clones)
node scripts/accuracy.mjs --work ~/uk-corpus --out ~/uk-accuracy
# Add the large repositories, or pick some
node scripts/accuracy.mjs --work ~/uk-corpus --out ~/uk-accuracy --include-large
node scripts/accuracy.mjs --work ~/uk-corpus --out ~/uk-accuracy --only gitea,saleor
# Weekly CI: the two small repositories, about 15 seconds after a cached fetch
node scripts/accuracy.mjs --quick --work "$RUNNER_TEMP/uk-corpus" --out accuracy-report
```

`--out` receives `accuracy.md`, `accuracy.json` and `samples/<name>@<sha>.json`, which lists the
sampled findings with titles, scope, evidence and fingerprints for labelling. Other flags:
`--sample N`, `--seed S`, `--no-recall`, `--labels DIR`, `--corpus FILE`. `--work` and `--out`
must be outside this repository. A scheduled CI job runs the `--quick` line and uploads
`accuracy-report`; none is configured yet.

## Adding a repository

1. Pick a public repository. Resolve the commit: `git ls-remote <url> HEAD`.
2. Add an entry to `scripts/corpus.json`: `name`, `url`, `sha` (full 40 characters),
   `language` (one of csharp, java, python, ruby, php, go, typescript; it is also the language
   seeded), `style`, `size`, `large`, `quick`. Set `seed_languages` to seed several languages.
3. Run `node scripts/accuracy.mjs --only <name> --out DIR`, read `DIR/samples/<name>@<sha>.json`.

## Adding labels

For each sampled finding open the cited source and decide `true`, `false` or `not-worth`; be
strict, and check a claim (a caller, an import, a use) by searching the source rather than by
the title. Write `corpus/labels/<name>@<sha>.json`:

```json
{ "<fingerprint>": { "label": "false", "note": "the member is used in Foo.cs" } }
```

A bare string value (`"false"`) is accepted too. Labels are keyed by fingerprint, so they
carry over while a finding keeps its kind and scope; labels for findings that no longer exist
are ignored. Raise `--sample` to bring more of the stratified order into the labelled set.

## First results (Unknot 0.1.15)

Ten sampled findings per repository, all labelled by reading the source, except that three of
Saleor's sample were not in the labelled set because its findings differ slightly between runs
(see below). Seed `unknot-1`. 117 labelled findings: 21 true, 27 false, 69 true but not worth
acting on. **That is 18% precision and 77% factual accuracy** on a sample that deliberately
over-weights rare finding kinds. With samples this small, a rate can move by 20 points or more
with one more label, and one reviewer (a model working under written strict rules, not a team
of maintainers) did the labelling; treat the numbers as a first baseline, not a verdict.

By language (small samples, language is that of the first file in scope):

| Language | Labelled | True | False | Not worth | Precision | Factual |
|---|---:|---:|---:|---:|---:|---:|
| C# | 7 | 1 | 2 | 4 | 14% | 71% |
| Go | 10 | 0 | 3 | 7 | 0% | 70% |
| Java | 6 | 1 | 1 | 4 | 17% | 83% |
| JavaScript | 7 | 1 | 5 | 1 | 14% | 29% |
| PHP | 10 | 3 | 0 | 7 | 30% | 100% |
| Python | 6 | 0 | 3 | 3 | 0% | 50% |
| Ruby | 5 | 1 | 3 | 1 | 20% | 40% |
| TypeScript | 31 | 4 | 8 | 19 | 13% | 74% |
| YAML | 25 | 9 | 1 | 15 | 36% | 96% |
| SQL, Terraform, other | 10 | 1 | 1 | 8 | | |

By detector, where at least five findings were labelled:

| Detector | Labelled | True | False | Not worth |
|---|---:|---:|---:|---:|
| `delivery.broad-ci-permissions` | 6 | 6 | 0 | 0 |
| `module.dependency-cycle` | 8 | 3 | 4 | 1 |
| `code.large-class` | 8 | 2 | 0 | 6 |
| `code.long-parameter-list` | 6 | 1 | 1 | 4 |
| `delivery.missing-health-checks` | 9 | 2 | 0 | 7 |
| `code.complex-function` | 5 | 2 | 0 | 3 |
| `security.duplicated-authorization` | 5 | 0 | 3 | 2 |
| `security.secret-exposure` | 5 | 0 | 2 | 3 |
| `security.injection-risk` | 5 | 0 | 1 | 4 |
| `security.unpinned-build-inputs` | 5 | 1 | 0 | 4 |
| `module.unstable-dependency` | 5 | 0 | 0 | 5 |
| `code.duplicated-code` | 5 | 0 | 0 | 5 |

The rest of the 38 kinds have under five labels each; the full table is in the report the
script writes. What the false findings had in common:

- Type-only imports (`import type`, `TYPE_CHECKING`) counted as import-cycle edges (4 cycle
  findings, TypeScript and Python).
- Vendored or generated code analysed as the project's own (a bundled library flagged as a large
  module, vendored emscripten output, a minified bundle).
- Dead code: callers missed, including `.vue` importers and an instance call to a same-named
  static method (4 of 4 labelled dead-code findings were false).
- `security.duplicated-authorization` matches methods of the same name that are unrelated
  (3 of 5 false), and `security.secret-exposure` flags placeholder strings and input fields
  named `api_key`.
- Hub metrics that count fan-in and fan-out of the package, not of the file.

Most "not worth" findings are demo or development infrastructure (compose files, sample
Kubernetes manifests), declarative data and test code.

### Recall on seeded defects

| Detector | Found | Seeded | Recall |
|---|---:|---:|---:|
| `module.dependency-cycle` | 12 | 12 | 100% |
| `code.long-function` | 12 | 12 | 100% |
| `code.dead-code` | 2 | 12 | 17% |
| `code.unused-injected-member` | 1 | 3 | 33% |

By language: TypeScript 6 of 6, C# 3 of 4, Go 6 of 9, PHP 4 of 6, Python 2 of 3, Ruby 2 of 3,
Java 4 of 8. The misses are explained:

- **Dead code** is not reported for languages read lexically (C#, Java, Go, Ruby, PHP) because
  an absent caller is not evidence there. This is deliberate; it appears here as low recall and
  will rise with the semantic tier of roadmap item 1. It was also missed for the Python seed
  (a private function in a new module of Saleor), which is worth investigating; only TypeScript
  found it.
- **Unused injected member** is implemented for C# only. It was found in nopCommerce and not in
  the two Java repositories.

### Cost and caveats

Per repository, map plus diagnose took 1 second (PetClinic) to 4.4 minutes (Twenty, 35,763
files) in the final run, which shared a heavily loaded machine; the same repositories mapped
about three times faster in an earlier run on a quieter machine (for example 22 seconds for
Gitea). The `--quick` pair takes about 15 seconds when its checkouts are already fetched.

Findings are not fully reproducible between runs: Saleor produced 557 findings in one run and
575 in another, and Mastodon 510 or 512, on the same commit. Fingerprints of unchanged
findings are stable, so labels persist, but a few sampled findings move in or out. The cause is
not yet understood and should be fixed before accuracy is used to block a release.
