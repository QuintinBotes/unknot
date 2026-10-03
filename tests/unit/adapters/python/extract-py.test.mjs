// extract.py is run directly (no shell) the same way the runtime's broker would run it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EXTRACT_PY, hasPython, loadFixture } from './helpers.mjs';

function run(items, input) {
  const r = spawnSync('python3', ['-I', '-S', EXTRACT_PY], {
    input: input ?? JSON.stringify(items), encoding: 'utf8', shell: false,
  });
  const records = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, records, stderr: r.stderr };
}

const one = (path, text) => run([{ path, text }]).records[0];

function fixtureRecord(name, path) {
  const item = loadFixture(name).find((i) => i.file.path === path);
  return one(path, item.text);
}

test('extract.py computes hand-checked metrics', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const rec = fixtureRecord('misc', 'metrics.py');
  const fn = Object.fromEntries(rec.functions.map((f) => [f.name, f]));
  // simple: no branches at all
  assert.equal(fn.simple.cyclomatic, 1);
  assert.equal(fn.simple.cognitive, 0);
  assert.equal(fn.simple.max_nesting, 0);
  // branchy: cyclomatic 1 + if + `and` + for + inner if + elif = 6
  // cognitive: if 1, `and` 1, for 1+1, inner if 1+2, elif 1, else 1 = 9; deepest chain if>for>if = 3
  assert.equal(fn.branchy.cyclomatic, 6);
  assert.equal(fn.branchy.cognitive, 9);
  assert.equal(fn.branchy.max_nesting, 3);
  assert.deepEqual(fn.branchy.params, ['a', 'b']);
  // fetch: one except handler = cyclomatic 2, cognitive 1, try+handler nest once
  assert.equal(fn.fetch.cyclomatic, 2);
  assert.equal(fn.fetch.cognitive, 1);
  assert.equal(fn.fetch.max_nesting, 1);
  assert.equal(fn.fetch.async, true);
  assert.equal(fn.fetch.returns, 'bytes');
  assert.deepEqual(fn.fetch.params, ['url', 'timeout', '*rest', '**opts']);
  assert.equal(fn.simple.start_line, 1);
  assert.equal(fn.simple.end_line, 2);
});

test('extract.py reports qualified names, kinds, decorators and bases', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const rec = one('m.py', [
    'import functools',
    'class Outer(Base, metaclass=Meta):',
    '    class Inner:',
    '        def deep(self): pass',
    '    @staticmethod',
    '    def s(x): return x',
    '    @functools.lru_cache(maxsize=8)',
    '    def m(self, a, *, b=1): return a',
    '    def _private(self): pass',
    'def top():',
    '    def nested(): pass',
    '',
  ].join('\n'));
  const quals = rec.functions.map((f) => f.qual);
  assert.deepEqual(quals, ['Outer.Inner.deep', 'Outer.s', 'Outer.m', 'Outer._private', 'top', 'top.nested']);
  const by = Object.fromEntries(rec.functions.map((f) => [f.qual, f]));
  assert.equal(by['Outer.s'].kind, 'staticmethod');
  assert.deepEqual(by['Outer.s'].params, ['x']);
  assert.equal(by['Outer.m'].decorators[0].name, 'functools.lru_cache');
  assert.equal(by['Outer.m'].decorators[0].kwargs.maxsize, 8);
  assert.deepEqual(by['Outer.m'].params, ['a', 'b']);
  assert.equal(by['top.nested'].parent, 'top');
  const outer = rec.classes.find((c) => c.qual === 'Outer');
  assert.deepEqual(outer.bases, ['Base']);
  assert.deepEqual(outer.keywords, { metaclass: { ref: 'Meta' } });
  assert.ok(rec.classes.some((c) => c.qual === 'Outer.Inner'));
});

test('extract.py records imports with level, module and names', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const rec = one('pkg/m.py', 'import os.path as p\nfrom .. import x\nfrom .a.b import c as d, e\nimport json\n');
  assert.deepEqual(rec.imports, [
    { kind: 'import', level: 0, module: 'os.path', as: 'p', names: [], line: 1 },
    { kind: 'from', level: 2, module: '', names: [{ name: 'x', as: null }], line: 2 },
    { kind: 'from', level: 1, module: 'a.b', names: [{ name: 'c', as: 'd' }, { name: 'e', as: null }], line: 3 },
    { kind: 'import', level: 0, module: 'json', as: null, names: [], line: 4 },
  ]);
});

test('extract.py flags security signals and SQL, and skips safe variants', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const rec = fixtureRecord('flask_app', 'queries.py');
  const kinds = rec.security.map((s) => `${s.kind}@${s.line}`);
  assert.deepEqual(kinds, ['sql_injection@11', 'yaml_unsafe_load@20']); // SafeLoader call on line 24 is clean
  assert.equal(rec.security[0].how, 'fstring');
  assert.equal(rec.security[0].scope, 'find_user');
  assert.deepEqual(rec.sql.map((s) => s.line), [5, 6, 11]);
  assert.equal(rec.sql[2].text, "SELECT * FROM users WHERE name = '{}'");

  const sec = one('s.py', [
    'import os, subprocess, pickle, marshal, yaml',
    'subprocess.run("ls", shell=True)',
    'subprocess.run(["ls"])',
    'subprocess.Popen("x", shell=False)',
    'os.system("a"); os.popen("b")',
    'eval("1"); exec("2")',
    'pickle.loads(b""); pickle.load(f); marshal.loads(b"")',
    'yaml.load(s, Loader=yaml.SafeLoader); yaml.load(s, yaml.CLoader)',
    'c.execute("select 1 from t where a = %s" % a)',
    'c.execute("select 1 from t where a = " + a)',
    'c.execute("select 1 from t where a = {}".format(a))',
    'c.execute("select 1 from t where a = %s", (a,))',
    '',
  ].join('\n'));
  assert.deepEqual(sec.security.map((s) => `${s.kind}@${s.line}`), [
    'shell_true@2', 'os_system@5', 'os_popen@5', 'eval@6', 'exec@6', 'pickle_load@7', 'pickle_load@7',
    'marshal_load@7', 'yaml_unsafe_load@8', 'sql_injection@9', 'sql_injection@10', 'sql_injection@11',
  ]);
});

test('extract.py collects environment reads, calls and call details', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const rec = fixtureRecord('flask_app', 'app.py');
  assert.deepEqual(rec.env.map((e) => [e.name, e.required]), [['SECRET_KEY', true], ['DATABASE_URL', false]]);
  const reg = rec.calls_detail.find((c) => c.name === 'app.register_blueprint');
  assert.deepEqual(reg.args, [{ ref: 'auth_bp' }]);
  assert.deepEqual(reg.kwargs, { url_prefix: '/api/v1' });
  const deploy = rec.functions.find((f) => f.name === 'deploy');
  assert.deepEqual(deploy.calls, ['subprocess.run']);
});

test('extract.py bounds distinct calls per function at 500', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const body = Array.from({ length: 700 }, (_, i) => `    f${i}()`).join('\n');
  const rec = one('big.py', `def many():\n${body}\n`);
  assert.equal(rec.functions[0].calls.length, 500);
});

test('extract.py reports a SyntaxError per file and keeps going', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const { records, status } = run([
    { path: 'misc/broken.py', text: loadFixture('misc').find((i) => i.file.path === 'broken.py').text },
    { path: 'ok.py', text: 'x = 1\n' },
  ]);
  assert.equal(status, 0);
  assert.equal(records[0].path, 'misc/broken.py');
  assert.equal(records[0].error.line, 1);
  assert.match(records[0].error.msg, /syntax/i);
  assert.equal(records[1].error, undefined);
  assert.equal(records[1].loc, 1);
});

test('extract.py survives hostile input without crashing', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const deep = `${'('.repeat(5000)}1${')'.repeat(5000)}`;
  const nested = `${'if x:\n'.repeat(1)}${Array.from({ length: 120 }, (_, i) => `${' '.repeat(i + 1)}if x:`).join('\n')}\n${' '.repeat(121)}pass\n`;
  const { status, records } = run([
    { path: 'nul.py', text: 'x = 1\0\n' },
    { path: 'deep.py', text: deep },
    { path: 'nest.py', text: nested },
    { path: 'num.py', text: 123 },
    { path: 'bom.py', text: '\ufeffx = "é"\n' },
    { path: 'empty.py', text: '' },
    { path: 'tabs.py', text: 'if 1:\n\tx = 1\n        y = 2\n' },
    { text: 'no path' },
    'not an object',
  ]);
  assert.equal(status, 0);
  assert.deepEqual(records.map((r) => r.path), ['nul.py', 'deep.py', 'nest.py', 'num.py', 'bom.py', 'empty.py', 'tabs.py']);
  for (const r of records) assert.ok(r.error || typeof r.loc === 'number', r.path);
  assert.equal(records.find((r) => r.path === 'empty.py').loc, 0);
});

test('extract.py exits non-zero on malformed stdin', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  assert.equal(run(null, 'not json').status, 2);
  assert.equal(run(null, '{"a":1}').status, 2);
});

test('extract.py treats prompt-injection text as inert data', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const rec = fixtureRecord('misc', 'injection.py');
  assert.equal(rec.error, undefined);
  assert.deepEqual(rec.functions.map((f) => f.name), ['helper']);
  assert.deepEqual(rec.security, []);
  assert.deepEqual(rec.sql, []);
});

test('extract.py source never reads files or executes code', () => {
  const src = readFileSync(EXTRACT_PY, 'utf8');
  assert.doesNotMatch(src, /(?<![\w.])(open|eval|exec|compile|__import__)\s*\(/);
  assert.doesNotMatch(src, /^\s*(?:import|from)\s+(?:importlib|subprocess|pathlib|os|runpy|builtins)\b/m);
  const imports = [...src.matchAll(/^import (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['ast', 'json', 're', 'sys', 'warnings']);
});
