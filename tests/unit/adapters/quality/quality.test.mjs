// Clone-detection adapter: tokenisation, fingerprints, and cross-file linking over real
// fixture files with a planted renamed duplicate and an unrelated file.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import adapter, { fingerprint, tokenize } from '../../../../adapters/quality/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';

const DIR = new URL('../../../fixtures/detectors/clones/', import.meta.url);
const read = (name) => readFileSync(new URL(name, DIR), 'utf8');
const FILES = ['orders.js', 'invoices.js', 'unrelated.js'];

function run(kinds = {}) {
  const factsByFile = new Map();
  const files = new Map();
  for (const name of FILES) {
    const entry = { path: name, kind: kinds[name] ?? 'source' };
    files.set(name, entry);
    factsByFile.set(name, adapter.extract(entry, read(name), {}));
  }
  return { factsByFile, linked: adapter.link({ files, factsByFile, options: {} }) };
}

test('descriptor', () => {
  assert.equal(adapter.id, 'quality');
  assert.equal(adapter.version, '0.1.1');
  assert.equal(adapter.kind, 'language');
  assert.deepEqual(adapter.capabilities.executes, []);
  assert.equal(adapter.capabilities.network, false);
  assert.ok(adapter.capabilities.files[0].includes('py') && adapter.capabilities.files[0].includes('rs'));
});

test('tokenizer strips comments and strings and collapses identifiers and literals', () => {
  const js = tokenize('// note\nconst a = "x" + 1; /* c\n c */ if (a) return foo(a);', 'c').map((t) => t.t).join(' ');
  assert.equal(js, 'const I = L + L ; if ( I ) return I ( I ) ;');
  assert.equal(tokenize('a\n/* x\ny */\nb', 'c').map((t) => t.line).join(','), '1,4');
  const py = tokenize('# c\nx = """doc\nstring"""\ndef f(): pass', 'python').map((t) => t.t).join(' ');
  assert.equal(py, 'I = L def I ( ) : pass');
  const rb = tokenize('=begin\nx\n=end\nputs "hi" # tail', 'ruby').map((t) => t.t).join(' ');
  assert.equal(rb, 'I L');
  const rs = tokenize("fn f<'a>(x: &'a str) -> char { 'z' }", 'rust').map((t) => t.t);
  assert.ok(rs.includes("'") && rs[rs.length - 2] === 'L');
});

test('renaming identifiers does not change fingerprints', () => {
  const a = fingerprint(tokenize(read('orders.js'), 'c')).fingerprints.map((f) => f[0]);
  const b = fingerprint(tokenize(read('invoices.js'), 'c')).fingerprints.map((f) => f[0]);
  const shared = a.filter((h) => b.includes(h));
  assert.ok(shared.length >= 8, `shared ${shared.length}`);
});

test('extract emits one module fact with capped fingerprints and medium confidence', () => {
  const [f] = adapter.extract({ path: 'orders.js', kind: 'source' }, read('orders.js'), {});
  assertFact(f);
  assert.equal(f.id, 'module:orders.js');
  assert.equal(f.provenance.source_type, 'ast');
  assert.equal(f.provenance.extractor, 'quality@0.1.0');
  assert.equal(f.provenance.confidence, 'medium');
  assert.ok(f.attrs.fingerprints.length > 0 && f.attrs.fingerprints.length <= 2000);
  const [hash, s, e] = f.attrs.fingerprints[0];
  assert.ok(Number.isInteger(hash) && s >= 1 && e >= s);
  assert.deepEqual(adapter.extract({ path: 'x.js', kind: 'generated' }, read('orders.js'), {}), []);
  assert.deepEqual(adapter.extract({ path: 'notes.txt', kind: 'source' }, 'hello', {}), []);
  const big = Array.from({ length: 6000 }, (_, i) => `v${i} = f(${i}) + g(h[${i % 7}]) * k${i};`).join('\n');
  const [bf] = adapter.extract({ path: 'big.js', kind: 'source' }, big, {});
  assert.ok(bf.attrs.fingerprints.length <= 2000);
  assert.ok(bf.attrs.fp_truncated.dropped > 0);
});

test('link finds the planted near-duplicate and ignores the unrelated file', () => {
  const { linked } = run();
  linked.forEach(assertFact);
  const by = new Map(linked.map((f) => [f.id, f]));
  assert.deepEqual([...by.keys()].sort(), ['module:invoices.js', 'module:orders.js']);
  const [clone] = by.get('module:orders.js').attrs.clones;
  assert.equal(clone.other, 'invoices.js');
  assert.ok(clone.similarity > 0.4 && clone.similarity <= 1, `similarity ${clone.similarity}`);
  assert.ok(clone.lines >= 15, `lines ${clone.lines}`);
  const [sa, ea, sb, eb] = clone.ranges[0];
  assert.ok(sa <= 8 && ea >= 25 && sb <= 8 && eb >= 25, JSON.stringify(clone.ranges));
  const back = by.get('module:invoices.js').attrs.clones[0];
  assert.equal(back.other, 'orders.js');
  assert.equal(back.similarity, clone.similarity);
  assert.deepEqual(back.ranges[0], [sb, eb, sa, ea]);
  assert.equal(by.get('module:orders.js').provenance.confidence, 'medium');
});

test('link output merges into a Graph and is deterministic', () => {
  const a = run();
  const b = run();
  assert.deepEqual(a.linked, b.linked);
  const g = Graph.fromFacts([...[...a.factsByFile.values()].flat(), ...a.linked]);
  assert.equal(g.node('module:orders.js').attrs.clones.length, 1);
  assert.equal(g.node('module:unrelated.js').attrs.clones, undefined);
});

test('test-to-test and generated pairs are skipped', () => {
  assert.deepEqual(run({ 'orders.js': 'test', 'invoices.js': 'test' }).linked, []);
  assert.equal(run({ 'orders.js': 'test' }).linked.length, 2); // a test copying source is still a clone
  assert.deepEqual(run({ 'invoices.js': 'generated' }).linked, []);
});

test('boilerplate shared by many files is ignored; clones per module are capped', () => {
  const body = read('orders.js');
  const make = (n) => {
    const factsByFile = new Map();
    const files = new Map();
    for (let i = 0; i < n; i++) {
      const entry = { path: `copy${String(i).padStart(2, '0')}.js`, kind: 'source' };
      files.set(entry.path, entry);
      factsByFile.set(entry.path, adapter.extract(entry, body, {}));
    }
    return adapter.link({ files, factsByFile, options: {} });
  };
  assert.deepEqual(make(40), []); // every hash is in 40 files: above the posting limit
  const linked = make(15);
  assert.equal(linked.length, 15);
  assert.ok(linked.every((f) => f.attrs.clones.length === 14));
});
