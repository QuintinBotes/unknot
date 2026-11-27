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
- **Gate** (`--gate`, #88): every result carries the three ratios of #88 with their bounds
  (`GATES` in `scripts/bench.mjs`): a no-change re-map at most 0.1 of the cold map, a re-map
  after the small change at most 2 times the no-change one, and the store at most 3 times the
  source tree (`tree_bytes`, the fixture without `.git` and `.unknot`). With `--gate` the script
  exits 1 and names each ratio over its bound. `scripts/bench-map.mjs --gate` checks the same
  ratios on a pinned public repository, with one edited file as the change. Ratios rather than
  times keep the bounds the same on every machine, but a machine whose file opens are slow
  (an endpoint scanner, a cold disk) inflates the census, which every map pays, and so moves them.
- **Release gate** (`--release-gate`, #154): `release.yml` runs `--sizes 10k --release-gate` and
  publishes only when the ratios of `RELEASE_GATES` hold: a no-change re-map at most 0.1 of the
  cold map and a re-map after the small change at most 0.5 of it. Those are the bounds `main`
  meets; the other two #88 ratios are printed but not gated until it meets them (#145). On an
  Apple M5 Max the 10k tier gave 0.017 and 0.159 (cold 15.5 s, no change 0.3 s, 10 changed 2.5 s).

Results are written as `results.json` and `results.md` in the output directory (default: the system
temp directory).

### Opt-in SCIP indexer benchmark

`npm run bench:scip` creates a temporary TypeScript repository with 3,000 files and maps it twice, once with `adapters.scip.run` off and once on. Each map is in its own child process, so the JSON report gives wall time and peak RSS for each. It never installs an indexer or enables network. When `scip-typescript` is unavailable on `PATH`, it returns a JSON skip with that exact reason instead of inventing a measurement.

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

**Derived facts, bounded.** The `derived` step (cycle breakdown of each strongly connected
component) used a greedy cut search that re-checked the whole component after every edge it
cut; at 10,000 and 50,000 files it did not finish within 10 and 30 minutes. Components above 50
modules or 400 edges now get their cut from an ordering in linear time (see `cycleBreakdown` in
`runtime/graph/algorithms.mjs`). Whole maps with derived facts on, same machine, load average 6
at the start:

| Tier | Cold | No change | 10 changed | Peak RSS | Store |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k | 16.0 s | 2.8 s | 4.1 s | 1014 MB | 438 MB |
| 50k | 81.4 s | 19.6 s | 23.3 s | 5964 MB | 2189 MB |

| Run | Census | Extraction | Link | Discovery | History | Coverage | Projection |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10k cold | 0.8 s | 8.7 s | 0.4 s | 0.1 s | 0.2 s | 0.0 s | 4.7 s |
| 10k no change | 0.7 s | 0.6 s | 0.4 s | 0.1 s | 0.0 s | 0.0 s | 0.9 s |
| 10k 10 changed | 0.7 s | 0.8 s | 0.3 s | 0.1 s | 0.2 s | 0.0 s | 1.0 s |
| 50k cold | 3.8 s | 40.6 s | 2.3 s | 0.4 s | 0.7 s | 0.1 s | 27.5 s |
| 50k no change | 5.8 s | 3.2 s | 2.1 s | 0.4 s | 0.1 s | 0.0 s | 8.1 s |
| 50k 10 changed | 5.5 s | 3.9 s | 2.2 s | 0.4 s | 1.1 s | 0.1 s | 5.0 s |

The rest of each total is the derived step and opening the store. The 250k tier has not been
re-run with these changes.

### 250k after delta projection, and a same-day comparison (2026-10-18)

`node scripts/bench.mjs --sizes 50k,250k` on the development branch after 0.4.0, same machine.
It was not idle: other work kept the load average between 9 and 24 (on 10 cores) during the
run, so read the cold times as upper bounds.

| Tier | Cold | No change | 10 changed | Peak RSS | Store |
| --- | ---: | ---: | ---: | ---: | ---: |
| 250k | 1,222.5 s | 365.2 s | 379.4 s | 5,199 MB | 11,255 MB |

| Run | Census | Extraction | Link | Discovery | History | Coverage | Projection |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250k cold | 51.6 s | 432.2 s | 84.9 s | 4.7 s | 6.2 s | 6.3 s | 556.8 s |
| 250k no change | 54.9 s | 135.3 s | 73.3 s | 8.7 s | 9.1 s | 4.2 s | 79.8 s |
| 250k 10 changed | 46.6 s | 63.5 s | 90.4 s | 8.7 s | 10.5 s | 8.7 s | 78.6 s |

Against the earlier 250k run, which preceded delta projection: re-maps are 2.3 times
(no change) and 3.6 times (10 changed) faster, projection on a re-map fell from 682 to 80 s,
and peak memory from 6,705 to 5,199 MB (the store grew from 10,401 to 11,255 MB). The cold map took 1,222 s against 654 s then.

To tell load from code, the 50k tier was run four times, alternating v0.3.3 and the branch:

| Run | Cold | No change | 10 changed | Load average at the end |
| --- | ---: | ---: | ---: | ---: |
| v0.3.3, round 1 | 108.1 s | 24.4 s | 28.9 s | 10.5 |
| branch, round 1 | 110.4 s | 29.7 s | 36.7 s | 10.2 |
| v0.3.3, round 2 | 108.1 s | 27.3 s | 33.6 s | 14.3 |
| branch, round 2 | 121.8 s | 33.2 s | 40.9 s | 33.9 |

Cold maps are the same within the noise of the load. Re-maps are about 20% slower. The graph is
identical (195,493 nodes, 597,813 edges), but the branch extracts 300,006 adapter-file pairs
against 200,006: the `contracts` adapter (messaging channels) and the `di` adapter read every
source file. Each pair is a cache lookup on every re-map even when it holds no facts, and the
extra time is spread over census, extraction, link and projection rather than one phase. The
cold 250k time therefore says more about the load during that run than about the code; a
v0.3.3 run at 250k on an idle machine would settle it.

### Re-map cost and store size on nopCommerce (#88)

Pinned public repository (`scripts/corpus.json`, 24,609 adapter-file pairs, 96 MB of source), cold
map, a re-map with no change, then three one-file edits, each committed. Same machine, not idle
(load average 19), so times are upper bounds; the work counts and sizes are exact. Before is `main`
at the time, after is this change. The facts and edges after the edits equal those of a cold map
of the final tree in both.

| Run | Before | After | Files re-extracted |
| --- | ---: | ---: | ---: |
| Cold map | 66.8 s | 16.5 s (load differed) | 24,609 |
| Re-map, no change | 9.0 s | 1.9 s (census only) | 0 |
| Re-map, one file edited | 10.4 to 21.9 s | 4.3 to 4.8 s | 6 adapter-file pairs (one file) |

| Store | Before | After |
| --- | ---: | ---: |
| After the cold map (database, write-ahead log and blobs) | 446 MB | 255 MB |
| Growth per one-file re-map | 1.75 MB | 0.01 to 0.02 MB |

Where a one-file re-map spent its time: the constant-use scan of the `literals` adapter read every
source file again (0.6 to 3.4 s here) because its cache key holds the blob of every file it reads,
and wrote its 1.8 MB result as a new blob each time without removing the old one. The write-ahead
log (about 180 MB after a cold map) counted toward the store until the database closed. What is
left in a one-file re-map is the census (about 1.4 s), reading every file's cached facts (0.6 s),
linking (0.6 s), hashing every fact in projection (0.6 s) and the derived facts (0.4 s): all
proportional to the repository, not to the change.

**Second part.** A profile of a one-file re-map on `main` after the first part (4.2 s, no-change
1.7 s) put the time in census 1.2 s, extraction 0.66 s, link 0.79 s, history 0.41 s (the whole
`git log --numstat` window again for one new commit), projection 0.56 s and derived facts 0.39 s.
History now reads only commits it has not seen, and the graph no longer stores clone
fingerprints. Measured with `main` and this change side by side on two clones, four committed
one-file edits each, alternating; the first round ran while another benchmark saturated the disk
and is left out (load average 9 to 17):

| Run | `main` | This change |
| --- | ---: | ---: |
| Re-map, one file edited (three rounds) | 3.4 to 3.9 s | 3.0 s |
| of which after the census | 2.4 to 2.8 s | 2.0 s |
| of which history | 0.37 to 0.39 s | 0.07 s |
| Re-map, no change | 1.1 to 1.4 s | 1.1 to 1.3 s |
| Edited / no change, per round | 2.4 to 3.3 | 2.4 to 2.6 |
| Store after a cold map | 250 MB | 233 MB (2.4 times the 96 MB tree) |

`node scripts/bench.mjs --sizes 10k,50k --gate`, same machine and load, before (`main`) and after:

| Tier | Cold | No change | 10 changed | Store | No change / cold | Changed / no change | Store / tree |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10k before | 26.0 s | 1.6 s | 4.2 s | 259 MB | 0.06 | 2.6 | 55 |
| 10k after | 14.9 s | 1.5 s | 3.8 s | 245 MB | 0.101 | 2.50 | 52.1 |
| 50k before | 725 s | 180 s | 355 s | 1,235 MB | 0.25 | 1.97 | n/a |
| 50k after | 147 s | 14.9 s | 19.4 s | 1,238 MB | 0.101 | 1.30 | 53.0 |

The 50k times are the census's: opening 50,000 files took 180 s in the `main` no-change re-map
(a disk saturated by other work) and 14.7 s against 7.5 s in the two re-maps after, so the 50k
ratios say more about the load than the code. The synthetic store is 50 times its tree because
the fixture files are a few hundred bytes each.

Scenario 2 (at most twice the no-change re-map) is still not met: what is left after the census is
extraction (0.5 s, reading every file's cached facts), link (0.55 s), projection (0.43 s) and
derived facts (0.29 s), each over the whole repository.

### Incremental linking, census cache and compact edges (#88, third part)

What a re-map still did over the whole repository after the second part, and what changed:

- **Census.** Every map stat'ed every file and read the first 4 KB of most. Entries of tracked files
  git sees unchanged are now kept in the store (`census:entry`) for the rules they were worked out
  under; a file with the same blob is neither stat'ed nor opened (`census.cached` in the summary).
- **Linking.** Each linker is told which files changed since the state it saved. `generic` keeps each
  file's link result with the keys it looked up and links again only the files that changed or read
  a key whose answer a changed file changed; `quality` re-pairs only modules sharing a fingerprint
  hash with a changed file (the postings are the reverse index); CODEOWNERS answers are kept per path.
  The summary's `link` says how many modules each linker linked again. Manifest changes, type-set or
  base changes, friend assemblies and a SCIP index still link everything.
- **Edges** are keyed by (source, type, target) in a `WITHOUT ROWID` table; the text id is computed,
  and the separate source index is gone (migration 3, `compact-edges`).

A one-file re-map of a 30.8k-file C# monolith (MewsSystems/mews, lexical C#, 210,713 nodes,
1,085,342 edges), `unknot map` from the CLI, the edit a comment appended and committed. `main` is
the run reported on #88; this change ran on the same machine (Apple M5 Max, Node 26.13, load 2 to
16):

| Run | `main` | This change |
| --- | ---: | ---: |
| Cold map | 163 s | 128 s |
| Re-map, no change | 4.7 s | 0.6 s (2.4 s the first time after the cold map) |
| Re-map, one file edited (a hub, `Enterprise.cs`) | 147 s | 25 to 31 s (1 file linked again by `generic`) |
| Re-map, one file edited (a leaf) | n/a | 25 s |
| Store (`du` of `.unknot`) | 3.5 GiB | 3.1 GiB (the tree is about 0.37 GiB) |

Most of the 147 s was linking that did not depend on the change: the ownership linker compiled
every CODEOWNERS rule again for every node (about 4 minutes of CPU under a profiler), the clone
linker re-paired every module, and the generic linker re-resolved every C# file. What is left of a
one-file re-map there is reading every file's cached facts (3.2 s), linking (9.6 s, mostly loading
the kept per-file results and the global analyses: member reach, inheritance, partial types),
discovery (1.7 s), projection (4.8 s) and derived facts (4.5 s).

`node scripts/bench.mjs --sizes 50k --gate`, same machine, `main` and this change back to back (load
average 3 to 16, so times are upper bounds):

| Run | Cold | No change | 10 changed | Store | No change / cold | Changed / no change | Store / tree |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `main` | 49.8 s | 2.7 s | 12.0 s | 1,238 MB | 0.054 | 4.46 | 53.0 |
| this change (first run) | 47.1 s | 0.65 s | 10.7 s | 1,225 MB | 0.014 | 16.5 | 52.5 |
| this change (final, busier machine) | 78.0 s | 1.1 s | 12.2 s | 1,168 MB | 0.014 | 11.6 | 50.0 |

The first ratio is met with room. The second is not, and the census cache makes it look worse: the
no-change re-map fell from 2.7 s to under a second while the 10-file re-map still pays, over the
whole repository, for reading every file's cached facts (2.1 s), projection (2.9 s) and derived facts
(2.9 s), which this change does not touch, and for linking (3.3 s), where on these fixtures the
generic linker relinks 10 of 4,400 files at 10k but the JavaScript and Python linkers, which are not
incremental, and loading the kept results take the time. The third is about file size: the fixture
files are a few hundred bytes each, so the store is 50 times the tree whatever the edge encoding.

### Derived facts brought forward, cheaper hashing, fewer indexes (#145)

What a changed re-map still did over the whole repository after the third part, and what changed:

- **Derived facts** were recomputed from the whole graph: every node and edge read back from the
  store, then every component. Projection now reports the node and edge rows it wrote or deleted.
  Components depend only on IMPORTS edges, and the build check on packages, package containment and
  DEPENDS_ON, so when none of those changed the components stand, and only the node-level rows of
  changed modules, and the components and declared-only edges holding a module whose type, path, test
  flag or language changed, are worked out again from the store. Otherwise everything is recomputed,
  reading only the four edge types derived facts use. The summary's `derived` says which
  (`updated`, `recomputed` or `kept`).
- **Projection** still hashes every fact and reads every stored fact key, but a fact id no longer
  copies attributes that are already in canonical form (cached facts are): about half the CPU of
  hashing fact ids (1.5 to 1.9 s against 3.5 to 3.7 s for 376,000 facts, measured alternately in one
  process).
- **Reading cached facts**: an empty row (most rows of `contracts`, `di` and `security`) is not
  parsed, and a linker's saved state is read only by a linker that keeps one.
- **Store**: three indexes of the facts table that no query reads are dropped (migration 4, which
  does not raise `schema_version`). They were 75 MB of the 50k store and 353 MB of the 3.1 GB
  monolith store below; an existing store keeps the freed pages for later writes, a new one is smaller.

`node scripts/bench.mjs --sizes 50k --gate`, `main` and this change back to back on the same machine,
twice (Apple M5 Max, Node 26.13; other work kept the load average between 8 and 60, the second pair
ran at 8 to 10):

| Run | Cold | No change | 10 changed | Store | No change / cold | Changed / no change | Store / tree |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `main`, first pair | 51.7 s | 0.5 s | 12.5 s | 1,168 MB | 0.01 | 24.2 | 50.0 |
| this change, first pair | 122.4 s | 1.0 s | 10.2 s | 1,092 MB | 0.008 | 10.5 | 46.8 |
| `main`, second pair | 48.8 s | 0.5 s | 12.0 s | 1,168 MB | 0.011 | 23.3 | 50.0 |
| this change, second pair | 49.3 s | 0.5 s | 8.8 s | 1,092 MB | 0.01 | 17.6 | 46.8 |

The first pair's branch run met a load spike (its cold map took 122 s), so only the second pair
compares. On a copy of the 50k fixture re-mapped five times after 10-file commits, a cold map of
the same tree and history stores the same facts, nodes, edges and derived facts (hashed row by row). Where the second pair's 10-file re-maps spent their time:

| Run | Census | Extraction | Link | Discovery | History | Coverage | Projection | Derived |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `main` | 0.3 s | 2.0 s | 3.3 s | 0.3 s | 0.1 s | 0.2 s | 2.9 s | about 2.9 s |
| this change | 0.4 s | 2.0 s | 3.2 s | 0.3 s | 0.1 s | 0.2 s | 2.7 s | under 0.1 s |

The bound of at most twice the no-change re-map is still far off. The no-change re-map is the census
alone (0.4 to 0.5 s); a re-map after any change still reads every file's cached facts (2.0 s), links
(3.2 s) and hashes every fact (2.7 s). These are not made proportional here, for these reasons:

- Not reading every file's facts needs every consumer of them to work from a delta: the linkers
  build their indexes (types, modules, exports, member reach) from every file's facts, and discovery
  and coverage read them too.
- Projecting only the facts of changed files is not sound with the linkers as they are: several of
  them change other files' facts after loading them (the route-group and server-interface steps of
  the JavaScript, Python and generic linkers rewrite or drop facts of any file that holds an affected
  route or client, `contracts` replaces lists, and member attributes are dropped in place), so what a
  file contributes to the graph is not a function of its own cache row. Skipping its hash would need
  each of those steps to record what it changed per file.
- Incremental JavaScript and Python linking in the `generic` pattern (each file's result kept with
  the keys it read) would save at most their whole cost, about 0.5 s and 0.35 s of CPU in a 10-file
  re-map at 50k, less the cost of reading the kept results back (the `generic` linker spends about
  0.5 s of its 1.1 s doing that for 24,900 files). It would not change the ratio much, so it is not
  done here.

MewsSystems/mews (30.8k files, lexical C#, 210,713 nodes, 1,085,342 edges), `unknot map` from the
CLI, a comment appended to `Enterprise.cs` and committed, `main` and this change alternating on two
copies of the same store (load average 12 to 23):

| Run | `main` | This change |
| --- | ---: | ---: |
| Re-map, no change | 0.7 s | 0.7 s |
| Re-map, one file edited (three rounds) | 44 s, 30 s, 30 s | 27 s, 25 s, 23 s |
| of which derived facts | 9.3 s, 5.6 s, 5.4 s | 4 ms, 2 ms, 16 ms |
| of which link, projection, extraction, discovery | 11.8 to 12.4 s, 5.4 to 13.3 s, 3.6 to 5.5 s, 2.0 to 2.1 s | 11.0 to 12.1 s, 5.1 to 5.7 s, 3.5 to 3.9 s, 1.9 to 2.3 s |
| Store after a cold map (`du` of `.unknot`) | 3.1 GiB (#88) | 2.75 GiB (the tree is about 0.37 GiB) |

A cold map of the same tree has the same rows as the store after the four incremental maps: facts
(1,374,200), nodes, edges and derived facts hash the same. What is left of a one-file edit there is
mostly the `generic` linker (loading the kept per-file results and the global analyses: member reach,
inheritance, partial types), hashing every fact, and reading every file's cached facts.

The store stays about 47 times the tree on this fixture because each file is a few hundred bytes and
yields about 18 facts, each kept in the per-file cache, the facts table and the merged nodes and
edges. On the 50k store: per-file cache 347 MB, facts 323 MB plus its key and `object` index (63 MB),
edges 150 MB with their index, nodes 116 MB with theirs, derived facts 22 MB.

## Real C# monolith: map, cold and warm

`scripts/bench-map.mjs` fetches a repository from `scripts/corpus.json` at its pinned commit
(default `nopcommerce`, a public ASP.NET Core monolith) into a directory outside this checkout,
then maps it twice in separate processes: cold (no store) and warm (unchanged tree, store kept).
It writes wall time, peak RSS (MB), files, nodes, edges and the store size to a JSON file.

```
node scripts/bench-map.mjs [--repo nopcommerce] [--work DIR] [--out FILE.json]
```

After the two maps it times one `decompose` dry run on the stored graph. The pinned `roslyn`
repository (large: pass `--repo roslyn`) has 35,502 mapped files:

| Roslyn 20b549ba, Node 22.23.5, darwin arm64 | Wall | Peak RSS |
|---|---|---|
| cold map | 201 s | 3,782 MB |
| warm map (no change) | 108 s | 2,809 MB |
| decompose before (origin/main, same store) | 20.1 s | 1,690 MB |
| decompose after (per-type edge index) | 8.0 s | 1,696 MB |

Store 4,371 MB, 203,474 nodes, 683,871 edges. Single runs on a machine shared with other agents,
so each is an upper bound; the decompose before and after ran back to back on the same store.
The saving is the per-type edge scan that `decompose` repeated for every node (a CPU profile of
the old code puts about 3.5 s of self time in `graph.edges`); the rest is store reads.

It needs `git` and network access for the first fetch, and spends nothing else. Run it on an idle
machine: numbers from a shared one are an upper bound.

### `architecture` on MewsSystems/mews (#157)

`unknot architecture` on a mapped store of MewsSystems/mews at 30b35157 (30.8k files, C# read
lexically; 210,715 nodes, 1,085,344 edges), `/usr/bin/time -l`, back to back on the same store:

| Node 22, darwin arm64, load average about 40-50 | Wall | CPU (user + sys) | Peak RSS |
|---|---|---|---|
| before (origin/main e0e4d2b) | 1,428 s | 481 s | 1,355 MB |
| after (parent index) | 47 s | 12 s | 1,583 MB |

The output (12 files) is byte-identical (`diff -r`). A CPU profile of the old container model
(`unitEdges` over every edge, 329 s on its own) put 324 of 370 s in the `CONTAINS` filter inside
`Graph.parent`: each edge into a hub such as `dependency:NUnit` (29,088 in-edges) rescanned all of
them. After the fix the views take 2.6 s together (the summary prints each one) and most of the
rest is reading the store into memory. The machine was shared and heavily loaded, so compare the
CPU column; peak RSS is a single sample and moves with garbage collection timing.
`tests/unit/artifacts/architecture.test.mjs` counts the in-edges the views scan on a 3,000-module
graph with one hub (108 million before, under ten times the edge count now).

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

Measured on 2026-10-11 on an Apple-silicon Mac, Node 22.23, scip-typescript 0.4.0, single run:

| Mode | Wall time | Peak RSS | Coverage |
|---|---|---|---|
| `run` off | 5.9 s | 256 MB | lexical |
| `run` on | 4.7 s | 258 MB | semantic, 3,000 of 3,000 files |

On this repository, the indexer's cost is within the noise of one run. A build-based indexer (scip-dotnet, scip-java) runs the project's build and costs much more; measure it on your own repository.
