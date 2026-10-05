# Benchmarks

Spec §28 requires performance targets to be validated with published benchmark fixtures. This
document describes the fixtures and the method, and records one measured run. The numbers below are
what one machine produced; they are not a guarantee, and your repository's shape (languages,
adapters, history length) will move them.

## Method

`node scripts/bench.mjs [--quick] [--large] [--sizes 1k,10k] [--out <dir>]`

- **Fixtures** are generated deterministically from a seed (`tests/fixtures/bench/shape.json`,
  PRNG mulberry32), so every machine builds the same repository. Files are grouped into modules of
  50, each module a single language chosen by the seed (about 45% TypeScript, 30% Python, 25% Go).
  Each file has 2 to 4 imports (about 15% cross-module, same language), a few branches and three
  functions. A `go.mod` and `package.json` sit at the root. The generated tree is committed to a
  throwaway git repository.
- **Cold map**: `mapRepository` is called in-process with a temporary `UNKNOT_HOME` and an empty
  index, including census, extraction, linking, discovery, git history and projection.
- **Incremental map**: 5 files spread across the repository get an appended function, the change is
  committed, and `mapRepository` runs again against the warm index. Unchanged files are served from
  the file-level cache.
- **Peak RSS** is `process.resourceUsage().maxRSS`, a process-lifetime high-water mark. Each size
  runs in its own child process so sizes do not contaminate each other. The incremental column is
  the high-water mark after both runs.
- Wall time excludes fixture generation and `git` setup. `--large` adds the 100,000-file fixture
  (slow, and not run in CI); `--quick` is a 300-file smoke used by CI.
- The cache counts in `results.json` are per adapter-file pair (more than one adapter
  reads each file), so they exceed the file count.

Results are written as `results.json` and `results.md` in the output directory (default: the system
temp directory).

## Measured run

Machine: Apple M1 Max, 10 cores, 32 GB RAM, darwin arm64, Node v22.18.0.

| Fixture | Files | Cold map | Peak RSS (cold) | Incremental map (5 files changed) | Peak RSS (after incremental) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1k | 1,000 | 1.8 s | 228 MB | 0.9 s | 228 MB |
| 10k | 10,000 | 12.8 s | 566 MB | 6.0 s | 569 MB |
| 100k | 100,000 | 329 s | 3,259 MB | 79 s | 3,808 MB |

Graph sizes: 1k 3,753 nodes and 13,253 edges; 10k 37,903 and 126,671; 100k 375,103 and
1,309,413. The incremental runs re-extracted 15 adapter-file pairs (5 files) and reused the rest.

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
