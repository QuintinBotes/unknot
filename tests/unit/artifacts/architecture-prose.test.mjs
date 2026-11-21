// Generated architecture notes and labels read as written by a person (issue #95).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../../../runtime/graph/graph.mjs';
import { architectureViews } from '../../../runtime/artifacts/architecture.mjs';
import { distributedMonolith, eventDriven, layeredMonolith, microservices, mod, imp } from '../../fixtures/artifacts/systems.mjs';

const systems = { layered: layeredMonolith(), distributed: distributedMonolith(), event: eventDriven(), micro: microservices(), empty: [] };
const prose = (facts) => {
  const r = architectureViews(Graph.fromFacts(facts));
  return Object.entries(r.views).flatMap(([name, v]) => [...v.notes, ...v.mermaid.split('\n').filter((l) => /"/.test(l))].map((text) => ({ name, text })));
};

test('4. no note or label has "(s)", doubled punctuation or a space before a full stop', () => {
  for (const [label, facts] of Object.entries(systems)) {
    for (const { name, text } of prose(facts)) {
      assert.doesNotMatch(text, /\(s\)/, `${label}/${name}: ${text}`);
      assert.doesNotMatch(text, /\.\.(?!\.)|,,|;;|\.,|,\.|\s\.(?!\w)|\s,/, `${label}/${name}: ${text}`);
    }
  }
});

test('1. a count of one uses the singular, of two the plural, of zero the plural', () => {
  const one = prose([mod('src/a.ts'), mod('src/b.ts'), imp('src/a.ts', 'src/b.ts')]).map((x) => x.text).join('\n');
  assert.match(one, /\b1 (container|unit|module|relationship)\b(?!s)/);
  assert.doesNotMatch(one, /\b1 (containers|units|modules|relationships|packages|entry points)\b/);
  assert.match(one, /\b2 modules\b/);
  const none = prose([]).map((x) => x.text).join('\n');
  assert.doesNotMatch(none, /\b0 (container|unit|module|relationship|entry point|package)\b(?!s)/);
});

test('verbs agree with the count', () => {
  const all = Object.values(systems).flatMap((f) => prose(f).map((x) => x.text)).join('\n');
  assert.doesNotMatch(all, /\b1 (pipeline|workload) (release|have)\b/);
  assert.doesNotMatch(all, /\b[02-9]\d* (pipelines|workloads) (releases|has)\b/);
});

test('a single aggregated container or table takes "is"', () => {
  const mods = Array.from({ length: 70 }, (_, i) => mod(`src/u${i}/x.ts`));
  const text = prose(mods).map((x) => x.text).join('\n');
  assert.doesNotMatch(text, /\b1 lower-(weight|traffic) \w+ are\b/);
});
