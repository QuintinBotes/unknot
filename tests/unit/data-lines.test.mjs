// Data-line counting (runtime/graph/data-lines.mjs) and its use by both language adapters
// and the size detectors.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import jsAdapter from '../../adapters/language/javascript/index.mjs';
import pyAdapter from '../../adapters/language/python/index.mjs';
import local from '../../runtime/diagnose/detectors/local.mjs';
import { dataLinePrefix, dataLinesIn } from '../../runtime/graph/data-lines.mjs';
import { Graph } from '../../runtime/graph/graph.mjs';
import { nodeFact, prov } from '../../runtime/graph/facts.mjs';
import { hasPython, realExec, unsupportedExec } from './adapters/python/helpers.mjs';

const count = (text, lang) => { const p = dataLinePrefix(text, lang); return p[p.length - 1]; };

test('data lines: literals, keys with literal values, and the brackets of such literals', () => {
  const src = [
    'const T = {', // code (const)
    "  title: 'x',", // data
    "  'en': {", // data
    "    hello: 'hi',", // data
    '  },', // data (closes a data bracket)
    '  list: [1, 2, 3],', // data
    '  rows: [', // data
    "    ['a', 'b'],", // data
    '    42,', // data
    '  ],', // data
    '};', // closes a code bracket
  ].join('\n');
  assert.equal(count(src, 'js'), 9);
});

test('data lines: calls, operators, keywords and block closers are not data', () => {
  const src = [
    'function f(a) {',
    '  if (a) {',
    '    return 1;',
    '  }',
    '  const x = a + 1;',
    '  g(1, 2);',
    '  const o = { k: compute(), z: a ? 1 : 2 };',
    '  switch (a) {',
    '    case 1:',
    '    default:',
    '  }',
    '}',
  ].join('\n');
  assert.equal(count(src, 'js'), 0);
});

test('data lines: python dict and list literals', () => {
  const src = [
    'MESSAGES = {',
    "    'en': {",
    "        'hello': 'Hello',",
    "        'bye': 'Bye',  # farewell",
    '    },',
    '    "n": [1, 2.5, None, True],',
    '}',
    'if x:',
    '    pass',
  ].join('\n');
  assert.equal(count(src, 'py'), 5);
  assert.equal(dataLinesIn(dataLinePrefix(src, 'py'), 3, 4), 2);
});

test('javascript adapter reports data_lines on functions, classes and the module', () => {
  const rows = Array.from({ length: 10 }, (_, i) => `    { id: ${i}, name: 'n${i}' },`).join('\n');
  const text = `export function seed() {\n  return buildAll([\n${rows}\n  ]);\n}\n\nexport class C {\n  m() { return 1; }\n}\n`;
  const facts = jsAdapter.extract({ path: 'a.js', kind: 'source' }, text, {});
  const attrs = (id) => facts.find((f) => f.id === id).attrs;
  assert.equal(attrs('function:a.js#seed').data_lines, 10);
  assert.equal(attrs('class:a.js#C').data_lines, 0);
  assert.equal(attrs('module:a.js').data_lines, 10);
});

for (const [name, exec, skip] of [['python3', realExec, !hasPython], ['lexical', unsupportedExec, false]]) {
  test(`[${name}] python adapter reports data_lines on functions, classes and the module`, { skip }, async () => {
    const text = [
      'def seed():',
      '    return {',
      "        'a': 1,",
      "        'b': [1, 2],",
      '    }',
      '',
      'class K:',
      '    X = {',
      "        'k': 'v',",
      '    }',
      '    def m(self):',
      '        return 1',
      '',
    ].join('\n');
    const out = await pyAdapter.extractBatch([{ file: { path: 'm.py' }, text }], { exec, options: {} });
    const facts = out.get('m.py');
    const attrs = (id) => facts.find((f) => f.id === id).attrs;
    assert.equal(attrs('module:m.py').data_lines, 3);
    assert.equal(attrs('function:m.py#seed').data_lines, 2);
    assert.equal(attrs('class:m.py#K').data_lines, 1);
  });
}

// ---- detectors ----

const P = prov({ source_type: 'ast', source_ref: 't.js:1', extractor: 'test@0.0.1', confidence: 'high' });
const run = (id, facts, options = {}) => local.find((d) => d.id === id).detect({ graph: Graph.fromFacts(facts), options });
const mod = (path, attrs = {}) => nodeFact('module', path, { name: path, path, attrs: { language: 'js', loc: 50, sloc: 40, is_test: false, parse_quality: 'ast', ...attrs } }, P);
const sym = (type, path, name, attrs) => nodeFact(type, `${path}#${name}`, { name, path, attrs: { start_line: 1, params: 1, cyclomatic: 1, cognitive: 1, max_nesting: 1, exported: true, kind: type, ...attrs } }, P);

test('long-function discounts data lines and says so', () => {
  const m = mod('a.js');
  assert.equal(run('local.long-function', [m, sym('function', 'a.js', 'seed', { lines: 120, data_lines: 60 })]).length, 0);
  const over = run('local.long-function', [m, sym('function', 'a.js', 'loadPropertyData', { lines: 392, data_lines: 180 })]);
  assert.equal(over.length, 1);
  assert.equal(over[0].title, 'loadPropertyData is 392 lines long (180 of them data; threshold 80)');
  assert.equal(over[0].measurements['function.lines'], 392);
  assert.equal(over[0].measurements['function.data_lines'], 180);
  const plain = run('local.long-function', [m, sym('function', 'a.js', 'big', { lines: 100 })]);
  assert.equal(plain[0].title, 'big is 100 lines long (threshold 80)');
});

test('long-function component_min_cyclomatic skips low-logic components only', () => {
  const m = mod('ui.tsx', { has_jsx: true });
  const facts = (cy) => [m, sym('function', 'ui.tsx', 'Form', { lines: 200, cyclomatic: cy })];
  assert.equal(run('local.long-function', facts(2)).length, 1);
  assert.equal(run('local.long-function', facts(2), { component_min_cyclomatic: 5 }).length, 0);
  assert.equal(run('local.long-function', facts(9), { component_min_cyclomatic: 5 }).length, 1);
  const plainFn = [mod('u.ts'), sym('function', 'u.ts', 'helper', { lines: 200, cyclomatic: 2 })];
  assert.equal(run('local.long-function', plainFn, { component_min_cyclomatic: 5 }).length, 1);
});

test('large-class and large-module discount data lines', () => {
  const cls = (lines, data_lines) => [mod('c.js'), sym('class', 'c.js', 'Dict', { lines, data_lines })];
  assert.equal(run('local.large-class', cls(1780, 1400)).length, 0);
  const f = run('local.large-class', cls(1780, 1000));
  assert.equal(f.length, 1);
  assert.match(f[0].title, /1780 lines, 1000 of them data/);
  assert.equal(f[0].measurements['class.data_lines'], 1000);
  assert.equal(run('local.large-module', [mod('big.js', { loc: 1500, sloc: 1400, data_lines: 900 })]).length, 0);
  const g = run('local.large-module', [mod('big.js', { loc: 2500, sloc: 2400, data_lines: 900 })]);
  assert.equal(g.length, 1);
  assert.match(g[0].title, /2400 source lines \(900 of them data; threshold 1000\)/);
});

test('arguments of a multi-line call are code, not data; literal elements and keyed lines stay data (real-repo spot check)', () => {
  const count = (text, lang) => dataLinePrefix(text, lang).at(-1);
  // A log call and a toast helper: their string arguments are not a table.
  assert.equal(count('logger.info(\n    "Incoming request",\n    extra=meta,\n)\n', 'py'), 0);
  assert.equal(count("this.presentToast(\n  'The property could not be saved.',\n  'danger',\n);\n"), 0);
  // An array literal passed to a call, and an object literal's keyed lines, are still data
  // (the closing line of a bracket opened on a code line is code).
  assert.equal(count("register([\n  'en',\n  'af',\n]);\n"), 2);
  assert.equal(count("const t = {\n  hello: 'Hallo',\n  bye: 'Totsiens',\n};\n"), 2);
  assert.equal(count('seed(\n    {\n        "name": "Ann",\n        "role": "admin",\n    },\n)\n', 'py'), 4);
});
