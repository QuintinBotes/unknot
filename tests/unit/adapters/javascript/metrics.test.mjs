import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractOne, fnAttrs, moduleAttrs } from './helpers.mjs';

const metrics = (src, id, path = 'm.js') => {
  const a = fnAttrs(extractOne(path, src), `function:${path}#${id}`);
  return [a.cyclomatic, a.cognitive, a.max_nesting];
};

test('if / else if / else / for-of / && / ternary (hand computed)', () => {
  const src = [
    'function f(a, b) {',
    '  if (a) {', //                  cog +1
    '    for (const x of b) {', //   cog +2 (nest 1)
    '      if (x && a) {', //        cog +3 (nest 2), +1 for &&
    '      }',
    '    }',
    '  } else if (b) {', //          cog +1 (flat)
    '  } else {', //                 cog +1
    '  }',
    '  return a ? 1 : 2;', //        cog +1
    '}',
  ].join('\n');
  // cyclomatic: 1 + if + for + if + && + else-if + ternary
  assert.deepEqual(metrics(src, 'f'), [7, 10, 3]);
});

test('switch counts once for cognitive and once per non-default case for cyclomatic', () => {
  const src = 'function g(x) {\n  switch (x) {\n    case 1:\n      break;\n    case 2:\n      return 2;\n    default:\n      return 0;\n  }\n}';
  assert.deepEqual(metrics(src, 'g'), [3, 1, 1]);
});

test('try / catch / while / do-while, with nesting increments', () => {
  const src = [
    'function h(list) {',
    '  try {',
    '    while (list.length) {', //     cog +1
    '      list.pop();',
    '    }',
    '  } catch (e) {', //               cog +1
    '    do {', //                       cog +1 +1 nest
    '      list.push(e);',
    '    } while (list.length < 3);', // the trailer is not a second loop
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(metrics(src, 'h'), [4, 4, 2]);
});

test('runs of the same boolean operator are one cognitive step; assignment forms count', () => {
  const src = 'function k(a, b, c, d) {\n  a ||= b;\n  return (a && b && c) || d;\n}';
  // cyclomatic: 1 + ||= + && + && + ||; cognitive: ||= + (&& run) + ||
  assert.deepEqual(metrics(src, 'k'), [5, 3, 0]);
});

test('optional chaining is not a branch; nullish coalescing is', () => {
  assert.deepEqual(metrics('function n(a) { return a?.b?.c ?? 0; }', 'n'), [2, 1, 0]);
});

test('nested named functions have their own metrics; callbacks charge the enclosing function', () => {
  const src = [
    'function outer(items) {',
    '  function inner(v) {',
    '    if (v) { return v; }',
    '    return 0;',
    '  }',
    '  outer: for (const a of items) {', //                          cog +1
    '    for (const b of a) {', //                                   cog +2
    '      if (b === inner(b)) continue outer;', //                  cog +3, labelled jump +1
    '    }',
    '  }',
    '  items.forEach((x) => { if (x) { x++; } });', //               cog +2 (callback nests one level)
    '}',
  ].join('\n');
  assert.deepEqual(metrics(src, 'outer'), [5, 9, 3]);
  assert.deepEqual(metrics(src, 'outer.inner'), [2, 1, 1]);
});

test('arrow functions bound to const, object members and class properties get names', () => {
  const src = [
    'export const a = (x) => x || 1;',
    'const b = async function (y) { return y; };',
    'const api = { list: () => 1, get(id) { return id ? 1 : 2; }, nested: { deep() {} } };',
    'class K { handler = (e) => { if (e) { return 1; } }; static make() { return new K(); } }',
  ].join('\n');
  const facts = extractOne('n.js', src);
  const ids = facts.filter((f) => f.kind === 'node' && /^(function|method):/.test(f.id)).map((f) => f.id).sort();
  assert.deepEqual(ids, [
    'function:n.js#a', 'function:n.js#api.get', 'function:n.js#api.list', 'function:n.js#api.nested.deep', 'function:n.js#b',
    'method:n.js#K.handler', 'method:n.js#K.make',
  ]);
  assert.equal(fnAttrs(facts, 'function:n.js#a').kind, 'arrow');
  assert.equal(fnAttrs(facts, 'function:n.js#a').exported, true);
  assert.equal(fnAttrs(facts, 'function:n.js#b').async, true);
  assert.equal(fnAttrs(facts, 'function:n.js#api.get').cyclomatic, 2);
  assert.equal(fnAttrs(facts, 'method:n.js#K.handler').kind, 'arrow');
  assert.equal(fnAttrs(facts, 'method:n.js#K.handler').cyclomatic, 2);
});

test('anonymous callbacks are not nodes', () => {
  const facts = extractOne('c.js', 'function run(xs) { return xs.map((x) => x * 2).filter(function (y) { return y > 1; }); }');
  assert.deepEqual(facts.filter((f) => f.kind === 'node' && f.type === 'function').map((f) => f.id), ['function:c.js#run']);
});

test('export default function is named default; kinds, params and lines are recorded', () => {
  const src = 'export default async function (a, { b }, ...rest) {\n  return a;\n}\nclass Q { get v() { return 1; } set v(x) {} constructor(a) {} *gen() {} }';
  const facts = extractOne('d.js', src);
  const d = fnAttrs(facts, 'function:d.js#default');
  assert.deepEqual([d.params, d.async, d.exported, d.start_line, d.end_line, d.lines], [3, true, true, 1, 3, 3]);
  assert.deepEqual(d.param_names, ['a', '{}', 'rest']);
  const kinds = facts.filter((f) => f.kind === 'node' && f.id.startsWith('method:d.js#Q.')).map((f) => `${f.name}:${f.attrs.kind}`).sort();
  assert.deepEqual(kinds, ['Q.constructor:constructor', 'Q.gen:method', 'Q.v:getter', `Q.v~${4}:setter`].sort());
});

test('TypeScript annotations do not leak into metrics', () => {
  const src = [
    'type Cond<T> = T extends string ? "s" : "n";',
    'interface I { a?: number; b: () => void }',
    'function t(a?: number, cb: (x: number) => void = () => {}): Cond<string> {',
    '  const f: (n: number) => string = (n) => String(n);',
    '  return a ? "s" : "n";',
    '}',
  ].join('\n');
  const facts = extractOne('t.ts', src);
  const t = fnAttrs(facts, 'function:t.ts#t');
  assert.deepEqual([t.cyclomatic, t.cognitive, t.params], [2, 1, 2]);
  assert.equal(t.return_type, 'Cond<string>');
  assert.ok(facts.some((f) => f.id === 'interface:t.ts#I'));
  assert.ok(facts.some((f) => f.id === 'type:t.ts#Cond'));
});

test('the module counts loc and sloc and flags tests', () => {
  const src = '// header\n\nconst a = 1;\n/* c */\nfunction f() {\n  return a;\n}\n';
  const mod = extractOne('x/__tests__/f.js', src).find((f) => f.id === 'module:x/__tests__/f.js').attrs;
  assert.equal(mod.loc, 8);
  assert.equal(mod.sloc, 4);
  assert.equal(mod.is_test, true);
  assert.equal(mod.language, 'javascript');
  assert.equal(mod.parse_quality, 'ok');
  for (const p of ['a.test.ts', 'a.spec.jsx', 'test/a.js', 'src/tests/a.js']) {
    assert.equal(extractOne(p, 'x').find((f) => f.type === 'module').attrs.is_test, true, p);
  }
  assert.equal(extractOne('src/latest.js', 'x').find((f) => f.type === 'module').attrs.is_test, false);
});

test('real-world shapes: prototype assignment, computed keys, namespaces, abstract members, Vue-style default objects', () => {
  const src = [
    'function Legacy(opts) { this.opts = opts; }',
    'Legacy.prototype.run = function () { if (this.opts) { return 1; } };',
    'class A { [Symbol.iterator]() { return this; } abstract area(): number; }',
    'namespace NS { export function inNs() { return 1; } }',
    'export default { methods: { go() { return this.a ? 1 : 2; } } };',
    'const Memo = memo(({ x }) => x);',
  ].join('\n');
  const facts = extractOne('rw.ts', src);
  const ids = facts.filter((f) => f.kind === 'node' && /^(function|method):/.test(f.id)).map((f) => f.id).sort();
  assert.deepEqual(ids, [
    'function:rw.ts#Legacy', 'function:rw.ts#Legacy.run', 'function:rw.ts#Memo', 'function:rw.ts#NS.inNs', 'function:rw.ts#default.methods.go',
    'method:rw.ts#A.[Symbol_iterator]',
  ]);
  assert.equal(fnAttrs(facts, 'function:rw.ts#Legacy.run').cyclomatic, 2);
  assert.deepEqual(moduleAttrs(facts, 'rw.ts').exports.map((e) => e.name), ['default']);
  assert.deepEqual(moduleAttrs(facts, 'rw.ts').calls.map((c) => c.name), ['memo']);
});
