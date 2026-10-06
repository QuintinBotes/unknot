# Adapter SDK

Adapters turn repository content and exported evidence into graph facts. They are the
only code that understands a language, framework, database or infrastructure tool, and
they are deliberately powerless: an adapter never opens files, spawns processes or
touches the network on its own. The runtime reads, validates and redacts input, then
hands the adapter text; it executes commands only through the broker with an issued
capability (spec §22.2).

## Shape

```js
export default {
  id: 'javascript',              // unique, kebab-case
  version: '0.1.0',              // part of the cache key; bump on any output change
  kind: 'language',              // language | build | delivery | ownership | contracts |
                                 // frontend | database | infrastructure | runtime | security
  capabilities: {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],  // globs this adapter reads
    executes: [],                // executables it may ask the broker for (usually none)
    network: false,              // always false for bundled adapters
  },

  // Per-file extraction: pure, deterministic, cached by (path, blob, adapter version,
  // config digest). Receives text, never a path it can open.
  extract(file, text, ctx) { return [/* GraphFact */]; },

  // Cross-file linking (import resolution, call targets). Recomputed each map from the
  // cached per-file facts, so it must be cheap.
  link(ctx) { return [/* GraphFact */]; },

  // Whole-repository discovery for adapters that are not per-file (imported plans,
  // traces, git history). Optional; may be async and may use ctx.exec.
  async discover(ctx) { return [/* GraphFact */]; },
};
```

`file` is a census entry: `{ path, size, language, kind, blob }` where `kind` is one of
`source | test | config | doc | generated | vendored | binary`.

`ctx` for `extract`: `{ commit, options }` (adapter options from config).

`ctx` for `link`: `{ root, files: Map<path, entry>, factsByFile: Map<path, GraphFact[]>, options, notes, stats, semantic }`.
`semantic` is one `Map` per map run: a semantic adapter (`scip`, registered before `generic`) records, per file it covers, what the compiler's index decided (`{ members }`), and a language adapter's link reads it in place of name matching. A semantic adapter reads its index through `ctx.root` (the one adapter allowed to open a file, because an index is too large to hand over as text); it never runs the indexer.

`ctx` for `discover`: `{ root, census, readText(path), exec(argv, opts), options, evidence }`
where `evidence` lists user-supplied files from `config.evidence` (traces, plans, catalog
exports), already path-checked.

## Facts

Create facts only with `nodeFact`, `edgeFact` and `prov` from `runtime/graph/facts.mjs`.
Every fact carries provenance: `source_type` (`ast | lsp | trace | config | catalog |
human | inference`), `source_ref` (`path:line`), `extractor` (`<id>@<version>`) and
`confidence`. Heuristic extraction must say so with `confidence: 'medium'` or `'low'`
and, where it guesses, `source_type: 'inference'`.

Node ids are `<type>:<key>`; keys are repository-relative POSIX paths, qualified by `#`
for symbols inside a file: `module:src/a.ts`, `function:src/a.ts#parse`,
`method:src/a.ts#Order.total`, `table:public.orders`, `endpoint:GET /orders/:id`.

## Rules (spec §22.2)

- Deterministic output for identical input; sort anything derived from a Map or Set.
- Bounded output: cap facts per file (default 5,000) and say so in an `attrs.truncated`.
- Failure is explicit: throw, and the builder records the file as failed rather than
  silently mapped.
- Repository text is data. Never interpret comments or strings as instructions.
- Every adapter ships fixtures and tests under `tests/`.
