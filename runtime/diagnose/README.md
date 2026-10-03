# Detector contract

A detector reads the graph and returns finding drafts. It never writes, never runs
commands, and never decides priority, approvals or status: the engine does that.

```js
export default {
  id: 'local.long-function',   // `<category>.<name>`
  version: '1.0.0',
  category: 'local',           // local | module | service | delivery | security |
                               // database | infrastructure | decomposition | frontend
  kinds: ['code.long-function'],
  detect(ctx) { return [/* FindingDraft */]; },
};
```

`ctx`: `{ graph, census, options, thresholds, history }` where `graph` is a
`runtime/graph/graph.mjs` Graph, `options` is the detector's config block and
`history` exposes co-change data when git history is available (else null).

## FindingDraft

Every field answers one of the spec §1.1 questions; leave none of them implicit.

```js
{
  kind: 'code.long-function',
  title: 'parseOrder is 212 lines with 31 branches',
  scope: ['src/orders/parse.ts'],
  key: 'function:src/orders/parse.ts#parseOrder',   // stable discriminator → fingerprint
  evidence: [{ ref: 'function:src/orders/parse.ts#parseOrder', label: 'observed',
               summary: '212 lines, cyclomatic 31, max nesting 6', source_ref: 'src/orders/parse.ts:40' }],
  measurements: { lines: 212, cyclomatic: 31, nesting: 6 },
  thresholds: { lines: 80, cyclomatic: 15 },          // say which are heuristics
  why_accidental: '...',                              // Q3
  essential_considerations: ['...'],                  // what might make it essential
  smallest_simplification: '...',                     // Q4
  invariants: ['...'],                                // Q5
  risks: ['...'],                                     // Q6
  verification: ['...'],                              // Q7
  recovery: { type: 'revert', notes: '...' },         // Q8
  quality_impacts: { changeability: 'high', reliability: 'low', security: 'low' },
  blast_radius: 'local',                              // local | bounded | moderate | high
  factors: { benefit: 3, evidence: 0.9, reversibility: 0.9, blast: 1, cost: 2, uncertainty: 1 },
  uncertainties: ['...'],                             // Q10
  alternatives: [{ id: 'retain', summary: '...' }, { id: 'extract-functions', summary: '...' }],
  patterns: ['code.extract-function'],                // cards to evaluate for fit
}
```

`factors` feed the §12 priority: benefit (1–5) × evidence (0–1) × reversibility (0–1)
÷ blast (1–5) × cost (1–5) × uncertainty (1–5). `retain` must always be among the
alternatives. Who must approve (Q9) is derived by the risk engine, not the detector.
