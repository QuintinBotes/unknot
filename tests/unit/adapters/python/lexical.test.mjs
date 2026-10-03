// The pure-JS fallback must agree with extract.py on the simple cases and degrade
// gracefully (never throw) on everything else.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lexicalAnalyze, parseArgs, scan } from '../../../../adapters/language/python/lexical.mjs';
import { loadFixture } from './helpers.mjs';

const fixture = (name, path) => loadFixture(name).find((i) => i.file.path === path).text;

test('lexical metrics match the hand-computed values', () => {
  const rec = lexicalAnalyze('metrics.py', fixture('misc', 'metrics.py'));
  const fn = Object.fromEntries(rec.functions.map((f) => [f.name, f]));
  assert.deepEqual([fn.simple.cyclomatic, fn.simple.cognitive, fn.simple.max_nesting], [1, 0, 0]);
  assert.deepEqual([fn.branchy.cyclomatic, fn.branchy.cognitive, fn.branchy.max_nesting], [6, 9, 3]);
  assert.deepEqual([fn.fetch.cyclomatic, fn.fetch.cognitive, fn.fetch.max_nesting], [2, 1, 1]);
  assert.equal(fn.fetch.async, true);
  assert.equal(fn.fetch.returns, 'bytes');
  assert.deepEqual(fn.fetch.params, ['url', 'timeout', '*rest', '**opts']);
  assert.deepEqual([fn.branchy.start_line, fn.branchy.end_line], [5, 13]);
});

test('lexical scan joins bracket continuations and blanks string contents', () => {
  const { lines } = scan('x = foo(1,\n        "if a and b",  # c\n        [2])\ny = """def z():\n  pass"""\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].line, 1);
  assert.equal(lines[0].endLine, 3);
  assert.doesNotMatch(lines[0].code, /if a and b/);
  assert.match(lines[0].raw, /if a and b/);
  assert.doesNotMatch(lines[1].code, /def z/);
  assert.equal(lines[1].strings[0].value, 'def z():\n  pass');
});

test('lexical reader does not mistake strings or comments for code', () => {
  const rec = lexicalAnalyze('t.py', [
    'def f(a):',
    '    s = "if x and y or z: while True:"',
    '    # if commented and out',
    '    return a',
    '',
  ].join('\n'));
  assert.equal(rec.functions[0].cyclomatic, 1);
  assert.equal(rec.functions[0].cognitive, 0);
});

test('lexical reader handles multi-line signatures, decorators, nesting and one-liners', () => {
  const rec = lexicalAnalyze('t.py', [
    'class A(B, metaclass=M):',
    '    @staticmethod',
    '    def s(x): return x',
    '    @property',
    '    def p(',
    '        self,',
    '    ) -> int:',
    '        return 1',
    'def outer(a, b=(1, 2)):',
    '    def inner(c):',
    '        if c: return 1',
    '    return inner',
    '',
  ].join('\n'));
  assert.deepEqual(rec.classes[0].bases, ['B']);
  assert.deepEqual(rec.classes[0].keywords, { metaclass: { ref: 'M' } });
  const by = Object.fromEntries(rec.functions.map((f) => [f.qual, f]));
  assert.deepEqual(Object.keys(by), ['A.s', 'A.p', 'outer', 'outer.inner']);
  assert.equal(by['A.s'].kind, 'staticmethod');
  assert.equal(by['A.p'].kind, 'property');
  assert.equal(by['A.p'].returns, 'int');
  assert.deepEqual(by['A.p'].params, []);
  assert.deepEqual(by.outer.params, ['a', 'b']);
  assert.equal(by['outer.inner'].parent, 'outer');
  assert.equal(by['outer.inner'].cyclomatic, 1 + 1);
  assert.equal(by.outer.cyclomatic, 1); // the nested function's branch is not the parent's
  assert.equal(by['A.p'].end_line, 8);
});

test('lexical argument parser mirrors extract.py encoding', () => {
  const s = "'/x', methods=['GET', 'POST'], n=-3, flag=True, t=Column(Integer, ForeignKey('u.id')), f=f'a{b}c', d=a.b, e=x+1)";
  const { args, kwargs } = parseArgs(s, 0);
  assert.deepEqual(args, ['/x']);
  assert.deepEqual(kwargs.methods, ['GET', 'POST']);
  assert.equal(kwargs.n, -3);
  assert.equal(kwargs.flag, true);
  assert.deepEqual(kwargs.t, { call: 'Column', args: [{ ref: 'Integer' }, { call: 'ForeignKey', args: ['u.id'], kwargs: {} }], kwargs: {} });
  assert.deepEqual(kwargs.f, { fstring: 'a{}c' });
  assert.deepEqual(kwargs.d, { ref: 'a.b' });
  assert.deepEqual(kwargs.e, { expr: 'x+1' });
});

test('lexical security, SQL and environment signals', () => {
  const rec = lexicalAnalyze('q.py', fixture('flask_app', 'queries.py'));
  assert.deepEqual(rec.security.map((s) => `${s.kind}@${s.line}`), ['sql_injection@11', 'yaml_unsafe_load@20']);
  assert.deepEqual(rec.sql.map((s) => s.line), [5, 6, 11]);
  const app = lexicalAnalyze('app.py', fixture('flask_app', 'app.py'));
  assert.deepEqual(app.env.map((e) => e.name), ['SECRET_KEY', 'DATABASE_URL']);
  assert.deepEqual(app.security.map((s) => s.kind), ['shell_true']);
});

test('lexical reader is total: garbage in, a record out', () => {
  for (const text of ['', '\0\0', 'def (:\n  )))', '"""unterminated', "x = 'a\ny = (", 'class\n@\ndef', '\t\tif x:\n\t  y', 'a' + '('.repeat(5000)]) {
    const rec = lexicalAnalyze('g.py', text);
    assert.ok(Array.isArray(rec.functions), JSON.stringify(text.slice(0, 20)));
  }
});

test('lexical reader leaves injected instructions as data', () => {
  const rec = lexicalAnalyze('injection.py', fixture('misc', 'injection.py'));
  assert.deepEqual(rec.functions.map((f) => f.name), ['helper']);
  assert.deepEqual(rec.security, []);
  assert.deepEqual(rec.sql, []);
});
