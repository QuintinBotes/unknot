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
| 1k | 1,000 | 1.6 s | 225 MB | 0.9 s | 225 MB |
| 10k | 10,000 | 29.1 s | 569 MB | 7.1 s | 726 MB |

The 1k run produced 3,752 nodes and 13,253 edges; the 10k run 37,902 nodes and 126,671 edges. The
incremental runs re-extracted 10 adapter-file pairs (5 files) and reused the rest.

## Reading the results against the targets

- Incremental map after a small commit: 7.1 s at 10,000 files, well under the two-minute target.
  Most of that time is fixed per-map work (census, linking, projection), not extraction, so it grows
  with repository size even when little changed.
- Cold map at 100,000 files and its memory bound have **not** been measured here. Run with
  `--large` on the machine you care about before relying on the target; this document will be
  updated when that run is recorded.
- Interactive finding explanation (target under five seconds when evidence is cached) is not
  covered by this benchmark.
- Cold-map time scales roughly 18x from 1k to 10k files in this run, which is worse than linear;
  that is worth profiling before the 100k run.
