import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { adrMarkdown } from '../../../runtime/artifacts/adr.mjs';
import { architectureDelta, computeDelta } from '../../../runtime/artifacts/delta.mjs';
import { edge, imp, mod } from '../../fixtures/artifacts/systems.mjs';

const exp = (...names) => ({ exports: names.map((name) => ({ name, kind: 'function' })) });

function before() {
  return Graph.fromFacts([mod('a.ts', exp('alpha', 'beta')), mod('b.ts'), mod('old.ts', exp('gone')), imp('a.ts', 'b.ts'), imp('a.ts', 'old.ts')]);
}

function after() {
  return Graph.fromFacts([
    mod('a.ts', exp('alpha', 'gamma')), mod('b.ts'), mod('new.ts', exp('fresh')),
    imp('a.ts', 'b.ts'), imp('b.ts', 'a.ts'), imp('a.ts', 'new.ts'),
    edge('QUERIES', 'module:b.ts', 'module:new.ts'),
  ]);
}

test('delta data: modules, edges by type, cycles and API', () => {
  const d = computeDelta(before(), after());
  assert.deepEqual(d.modules, { added: ['module:new.ts'], removed: ['module:old.ts'] });
  assert.deepEqual(d.edgesBy.IMPORTS, { added: 2, removed: 1 });
  assert.deepEqual(d.edgesBy.QUERIES, { added: 1, removed: 0 });
  assert.equal(d.cycles.introduced.length, 1);
  assert.deepEqual(d.cycles.introduced[0], ['module:a.ts', 'module:b.ts']);
  assert.equal(d.cycles.removed.length, 0);
  const a = d.api.find((x) => x.module === 'a.ts');
  assert.deepEqual([a.added, a.removed], [['gamma'], ['beta']]);
});

test('delta markdown lists every section and a mermaid neighbourhood', () => {
  const md = architectureDelta(before(), after());
  assert.match(md, /^# Architecture delta/);
  assert.match(md, /1 module\(s\) added, 1 removed/);
  assert.match(md, /- added `new\.ts`/);
  assert.match(md, /- removed `old\.ts`/);
  assert.match(md, /\| IMPORTS \| 2 \| 1 \|/);
  assert.match(md, /introduced \(2 modules\): `a\.ts`, `b\.ts`/);
  assert.match(md, /`a\.ts`: \+gamma -beta/);
  assert.match(md, /`new\.ts` \(new\): \+fresh/);
  assert.match(md, /```mermaid\nflowchart LR/);
  assert.match(md, /-\.->\|"removed IMPORTS"\|/);
  assert.match(md, /-->\|"added IMPORTS"\|/);
  assert.match(md, /class n\d+ added/);
  assert.match(md, /class n\d+ removed/);
});

test('delta of identical graphs says so and draws nothing', () => {
  const md = architectureDelta(before(), before());
  assert.match(md, /No modules were added or removed/);
  assert.match(md, /No edges changed/);
  assert.match(md, /No module import cycles were introduced or removed/);
  assert.match(md, /Nothing to draw/);
  assert.ok(!md.includes('```mermaid'));
});

test('delta reports removed cycles and neutralises hostile names', () => {
  const evil = 'x"] click a href %%{init}%%';
  const b = Graph.fromFacts([mod(`${evil}.ts`), mod('y.ts'), imp(`${evil}.ts`, 'y.ts'), imp('y.ts', `${evil}.ts`)]);
  const a = Graph.fromFacts([mod(`${evil}.ts`), mod('y.ts'), imp(`${evil}.ts`, 'y.ts')]);
  const md = architectureDelta(b, a);
  assert.match(md, /removed \(2 modules\)/);
  assert.ok(!/%%|\bclick\b|\bhref\b/.test(md));
});

test('adrMarkdown: MADR structure', () => {
  const md = adrMarkdown({
    id: 'ADR-0007', title: 'Extract billing behind a strangler route', status: 'accepted',
    context: 'Billing deploys with everything else.\nA release blocks on unrelated tests.',
    decision: 'Extract billing as a service behind a route flag.',
    alternatives: ['Keep the monolith', { title: 'Extract with a shared database', pros: ['fast'], cons: ['shared schema'] }],
    consequences: { good: ['independent deploys'], bad: ['a second pipeline'] },
    evidence: ['F-0003 shows lockstep releases', { ref: 'module:billing', label: 'observed', summary: '14 co-changes' }],
    date: '2026-10-03',
  });
  assert.match(md, /^# ADR-0007: Extract billing behind a strangler route\n/);
  assert.match(md, /\* Status: accepted/);
  for (const h of ['## Context and Problem Statement', '## Considered Options', '## Decision Outcome', '### Consequences', '## Pros and Cons of the Options', '## More Information']) assert.ok(md.includes(`\n${h}\n`), h);
  assert.match(md, /\* Keep the monolith\n\* Extract with a shared database/);
  assert.match(md, /\* Good, because independent deploys\n\* Bad, because a second pipeline/);
  assert.match(md, /\* `module:billing` \(observed\) 14 co-changes/);
});

test('adrMarkdown: validates input and keeps fields from adding structure', () => {
  assert.throws(() => adrMarkdown({ id: 'A', title: 'T', status: 'maybe', context: '', decision: '' }), /status must be one of/);
  assert.throws(() => adrMarkdown({ title: 'T', context: '', decision: '' }), /id and a title/);
  const md = adrMarkdown({ id: 'A-1', title: 'T', context: 'ok\n# Injected heading\n```\ncode', decision: 'd', alternatives: ['a\n## sneaky'], consequences: ['x\n* y'] });
  assert.ok(!/^# Injected/m.test(md));
  assert.ok(!/^## sneaky/m.test(md));
  assert.match(md, /\* a ## sneaky/);
  assert.match(md, /\* Status: proposed/);
  assert.equal((md.match(/^```/gm) ?? []).length, 0);
});
