# Benchmarks

Spec §28 requires performance targets to be validated with published benchmark fixtures. This
document describes the fixtures and the method, and records one measured run. The numbers below are
what one machine produced; they are not a guarantee, and your repository's shape (languages,
adapters, history length) will move them.

## Method

`node scripts/bench.mjs [--quick] [--large] [--sizes 1k,50k,250k,1m] [--out <dir>] [--work <dir>] [--keep]`

- **Fixtures** are generated deterministically from a seed (`tests/fixtures/bench/shape.json`,
  PRNG mulberry32), so every machine builds the same repository. Files are grouped into modules of
  50, each module a single language chosen by the seed (30% TypeScript, 20% Python, 20% C#, 15%
  Java, 15% Go). Each file has 2 to 4 imports (about 15% cross-module, same language) with the
  language's own namespaces or packages, a few branches and functions; every tenth file is a test
  importing code under test; three files per module import each other in a cycle (not Go). A
  `go.mod` and `package.json` sit at the root. The tree is written under `--work` (default: the
  system temp directory, never this repository), committed to a throwaway git repository, and
  removed afterwards unless `--keep` is given.
- **Cold map**: `mapRepository` is called in-process with a temporary `UNKNOT_HOME` and an empty
  index, including census, extraction, linking, discovery, git history and projection.
- **Re-map, no change**: the same call again on the unchanged commit.
- **Re-map, 10 files changed**: 10 files spread across the repository get an appended function,
  the change is committed, and `mapRepository` runs against the warm index. Unchanged files are
  served from the file-level cache.
- **Phases** are wall time inside one map (`phases` in the builder's summary): census, extraction
  (cache lookup, extraction, and the per-file cache commits), link (cross-file linking), discovery,
  history, coverage, projection (writing the graph to the store). There is no separate
  derived-facts phase; derived facts are produced by linking and projection.
- **Store size** is the size of the project's `.unknot` directory after the last map.
- **Peak RSS** is `process.resourceUsage().maxRSS`, a process-lifetime high-water mark. Each size
  runs in its own child process (with a 16 GB heap limit, `--heap-mb`) so sizes do not contaminate
  each other. The column is the high-water mark after all three maps.
- Wall time excludes fixture generation and `git` setup. `--large` adds the 100,000-file fixture
  (slow, and not run in CI); `--quick` is a 300-file smoke used by CI. The 1,000,000-file tier
  (`--sizes 1m`) runs only when named.
- The cache counts in `results.json` are per adapter-file pair (more than one adapter
  reads each file), so they exceed the file count.

Results are written as `results.json` and `results.md` in the output directory (default: the system
temp directory).

## Measured run

The first table is the earlier, three-language fixture (45% TypeScript, 30% Python, 25% Go,
5 files changed); it is kept for history and is not reproducible with the current generator.

Machine: Apple M1 Max, 10 cores, 32 GB RAM, darwin arm64, Node v22.18.0.

| Fixture | Files | Cold map | Peak RSS (cold) | Incremental map (5 files changed) | Peak RSS (after incremental) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1k | 1,000 | 1.8 s | 228 MB | 0.9 s | 228 MB |
| 10k | 10,000 | 12.8 s | 566 MB | 6.0 s | 569 MB |
| 100k | 100,000 | 329 s | 3,259 MB | 79 s | 3,808 MB |

Graph sizes: 1k 3,753 nodes and 13,253 edges; 10k 37,903 and 126,671; 100k 375,103 and
1,309,413. The incremental runs re-extracted 15 adapter-file pairs (5 files) and reused the rest.

### Scale tiers (five languages)

`node scripts/bench.mjs --sizes 50k,250k`, same machine. Other work was running on the machine
during the 250k run (it was swapping, 2.8 GB of swap in use afterwards), so the 250k re-map
times are an upper bound and noisier than the cold time.

| Fixture | Files | Cold map | Re-map, no change | Re-map, 10 files changed | Peak RSS | Store size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50k | 50,000 | 77.1 s | 43.5 s | 39.8 s | 3,829 MB | 2,044 MB |
| 250k | 250,000 | 654.2 s | 842.2 s | 1,347.5 s | 6,705 MB | 10,401 MB |

Graph sizes: 50k 194,793 nodes and 556,383 edges; 250k 971,318 and 2,820,082. Status was
`complete` with no failures in every run. The changed-file runs re-extracted 30 adapter-file
pairs (10 files).

Time per phase:

| Run | Census | Extraction | Link | Discovery | History | Coverage | Projection |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50k cold | 3.9 s | 37.5 s | 2.5 s | 0.4 s | 0.8 s | 0.1 s | 31.9 s |
| 50k no change | 7.2 s | 3.5 s | 2.5 s | 0.4 s | 0.1 s | 0.0 s | 29.7 s |
| 50k 10 changed | 5.9 s | 4.5 s | 2.2 s | 0.4 s | 0.8 s | 0.2 s | 25.9 s |
| 250k cold | 49.4 s | 219.0 s | 16.1 s | 2.4 s | 6.3 s | 1.0 s | 360.1 s |
| 250k no change | 80.8 s | 41.1 s | 24.7 s | 6.0 s | 5.7 s | 2.0 s | 681.8 s |
| 250k 10 changed | 108.5 s | 133.3 s | 118.8 s | 20.9 s | 31.0 s | 9.1 s | 925.8 s |

Reading the phases: projection (rewriting the whole graph to the store) is the largest cost of
every map, cold or not, and at 250k it is 70 to 80% of a re-map that changed nothing. Cold
extraction is the second largest (219 s at 250k, in parallel workers). Link is small (16 to 25 s
unchanged). The 1,000,000-file tier was not attempted: the 250k run took about 54 minutes in
total, well over the 20 minute limit set for this package, and projection at that size would
also need a much larger store and heap.

### Delta projection

A map now writes only the facts, nodes and edges that changed (facts matched by id and a content
signature; nodes and edges recomputed only where a changed fact touches them), and an unchanged
graph is not rewritten, keeps its generation and its derived facts. Cached per-file facts are
still read back on every map: linking, discovery and coverage all read every file's facts, so
that cost (the `extraction` phase, 3.5 s at 50k) remains.

Same machine, 50k fixture, derived facts switched off for the measurement (see below), load
average 38 at the start (not idle, so treat times as upper bounds):

| Run | Projection before | Projection after | Whole map before | Whole map after |
| --- | ---: | ---: | ---: | ---: |
| 50k cold | 31.9 s | 45.9 s | 77.1 s | 98.2 s |
| 50k no change | 29.7 s | 5.6 s | 43.5 s | 18.0 s |
| 50k 10 changed | 25.9 s | 4.9 s | 39.8 s | 18.1 s |

At 10k: projection 5.4 s cold, 1.0 s unchanged and 10 changed. Cold projection is no faster
(it writes everything, plus signatures); the 250k tier was not re-run. The remaining
unchanged-map cost is hashing every fact (about 5 s at 50k), census and the cached-facts read.

**Derived facts now dominate larger fixtures.** The `derived` step (cycle breakdown of each
strongly connected component, `cycleBreakdown` in `runtime/graph/algorithms.mjs`) is not in the
phase table above and is superlinear in component size: about 6 s at 1,000 files, and the
10,000 and 50,000-file fixtures did not finish within 10 and 30 minutes when it ran. It is
skipped when the graph is unchanged, but any change recomputes it in full. Its greedy cut loop
needs a bound or an incremental form before the 50k and 250k tiers can be published with it on.

## Reading the results against the targets

- **Cold map of 100,000 files, resumable and bounded by configured workers:** 5.5 minutes and
  3.3 GB peak on this machine. Extraction runs in at most `limits.workers` threads (default: cores
  minus one, at most 8) and commits to the per-file cache every 5,000 files, so an interrupted map
  continues from the last committed chunk (`tests/unit/graph/resume.test.mjs`). Chunked commits
  cost about 15% of cold-map time at 100k files (287 s without them).
- **Incremental map after a small commit, under two minutes:** 6.0 s at 10,000 files and 79 s at
  100,000. Most of that is fixed per-map work (census, linking, projection), not extraction, so
  it grows with repository size even when little changed; at 100k files it is inside the target
  but not by a wide margin.
- **Interactive finding explanation, under five seconds with cached evidence:** not part of this
  synthetic benchmark. On a real 1,987-file repository (17,065 nodes) `unknot explain` took
  1.8–2.1 s over three runs.
- **Scaling:** cold map is close to linear from 1k to 10k (7x for 10x the files) and grows
  faster from 10k to 100k (26x), where SQLite writes and memory pressure dominate.
- **A defect this benchmark found:** before the 100k run, cross-file linking passed its results
  through `Array.prototype.push(...facts)`, which throws past roughly 100k arguments. The builder
  recorded it as a link failure and continued, so the first 100k run reported exactly 300,000
  edges (containment only). Spreads that grow with the repository now go through
  `runtime/core/arrays.mjs`.
