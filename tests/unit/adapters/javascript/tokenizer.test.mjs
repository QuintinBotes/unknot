import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tokenize } from '../../../../adapters/language/javascript/tokenizer.mjs';

function toks(src, opts = {}) {
  const r = tokenize(src, opts);
  return { list: r.tokens.slice(0, r.n), r };
}

const kinds = (src, opts) => toks(src, opts).list.map((t) => t.t);
const values = (src, opts) => toks(src, opts).list.map((t) => `${t.t}:${t.v}`);

test('division is not a regex after a value, a regex is after an operator or keyword', () => {
  assert.deepEqual(kinds('a / b / c'), ['id', 'p', 'id', 'p', 'id']);
  assert.deepEqual(kinds('(a) / 2'), ['p', 'id', 'p', 'p', 'num']);
  assert.deepEqual(kinds('x = /a\\/b[/]/gi'), ['id', 'p', 're']);
  assert.deepEqual(values('return /x/.test(y)').slice(0, 2), ['id:return', 're:/x/']);
  assert.deepEqual(kinds('a[0] / 2'), ['id', 'p', 'num', 'p', 'p', 'num']);
  assert.deepEqual(values('a /= 2'), ['id:a', 'p:/=', 'num:2']);
});

test('comments never produce tokens and keep line numbers right', () => {
  const { list } = toks('// c1\n/* a\n b */ x /* ok */ = 1; // tail\n"//no"; y');
  assert.deepEqual(list.map((t) => `${t.t}:${t.v}@${t.l}`), ['id:x@3', 'p:=@3', 'num:1@3', 'p:;@3', 'str://no@4', 'p:;@4', 'id:y@4']);
});

test('template literals nest to arbitrary depth without recursion', () => {
  assert.deepEqual(kinds('`a ${`b ${`c ${x}`}`} d`'), ['tplh', 'tplh', 'tplh', 'id', 'tplt', 'tplt', 'tplt']);
  const depth = 400;
  const src = `${'`${'.repeat(depth)}x${'}`'.repeat(depth)}`;
  const r = tokenize(src);
  assert.equal(r.issues.length, 0);
  assert.equal(r.tokens.slice(0, r.n).filter((t) => t.t === 'tplh').length, depth);
});

test('braces and strings inside a template expression do not end it early', () => {
  const { list, r } = toks("`obj ${JSON.stringify({ k: `v${x}`, brace: '}' })} done` + y");
  assert.equal(r.issues.length, 0);
  assert.equal(list[list.length - 1].v, 'y');
  assert.equal(list[list.length - 2].v, '+');
  assert.ok(list.some((t) => t.t === 'str' && t.v === '}'));
});

test('a multi-line template keeps following line numbers', () => {
  const { list } = toks('const t = `a\nb ${x}\nc`;\nlet z');
  const z = list.find((t) => t.v === 'z');
  assert.equal(z.l, 4);
});

test('numeric separators, bigint, hex and exponent literals are single tokens', () => {
  assert.deepEqual(values('1_000_000 10n 0xFF_FF .5e-3 1e3 0b1_0'), [
    'num:1_000_000', 'num:10n', 'num:0xFF_FF', 'num:.5e-3', 'num:1e3', 'num:0b1_0',
  ]);
});

test('private names and decorators', () => {
  assert.deepEqual(values('@Dec() class A { #x = 1; m() { return this.#x; } }').filter((v) => v.startsWith('id:#')), ['id:#x', 'id:#x']);
  assert.deepEqual(values('@Dec()').slice(0, 2), ['p:@', 'id:Dec']);
});

test('JSX text may contain quotes and apostrophes', () => {
  const { list, r } = toks('const a = <p>Don\'t "stop" me</p>; const b = 2;');
  assert.equal(r.issues.length, 0);
  assert.deepEqual(list.map((t) => t.t), ['id', 'id', 'p', 'jo', 'jc', 'jx', 'p', 'id', 'id', 'p', 'num', 'p']);
});

test('JSX attributes: strings, expressions, spread, fragments and nested elements', () => {
  const src = 'x = <><A b="1" c={\'>\'} {...rest} d>{items.map((i) => <li key={i}>{i}</li>)}</A></>;';
  const { list, r } = toks(src);
  assert.equal(r.issues.length, 0);
  assert.deepEqual(list.filter((t) => t.t === 'jo').map((t) => t.v), ['', 'A', 'li']);
  assert.deepEqual(list.filter((t) => t.t === 'ja').map((t) => t.v), ['b', 'c', 'd', 'key']);
  assert.equal(list.filter((t) => t.t === 'jx').length, 3);
  assert.equal(list[list.length - 1].v, ';');
});

test('element versus comparison is decided by the previous token', () => {
  assert.deepEqual(kinds('a < b && c > d'), ['id', 'p', 'id', 'p', 'id', 'p', 'id']);
  assert.ok(kinds('if (a < b) {}').every((k) => k !== 'jo'));
  assert.ok(kinds('return <div/>;').includes('jo'));
  assert.ok(kinds('x ? <a/> : <b/>').filter((k) => k === 'jo').length === 2);
  assert.ok(kinds('f(1 < 2, <i/>)').filter((k) => k === 'jo').length === 1);
});

test('generics: TSX arrow <T,> is not an element; .ts never has JSX', () => {
  assert.ok(!kinds('const f = <T,>(x: T) => x;', { ts: true }).includes('jo'));
  assert.ok(!kinds('const f = <T extends object>(x: T) => x;', { ts: true }).includes('jo'));
  assert.ok(!kinds('const y = <any>z;', { jsx: false, ts: true }).includes('jo'));
  assert.ok(!kinds('useState<string>("a")', { ts: true }).includes('jo'));
});

test('JSX inside an attribute expression nests correctly', () => {
  const { list, r } = toks('<A render={() => <B x="1">t</B>}>text</A>; done');
  assert.equal(r.issues.length, 0);
  assert.equal(list[list.length - 1].v, 'done');
});

test('code lines (sloc) ignore comments and blanks but count JSX text and templates', () => {
  const r = tokenize('// c\n\nconst a = 1;\n/* x\ny */\nconst b = `\nq\n`;\n<p>\n text\n</p>');
  assert.equal(r.loc, 11);
  assert.equal(r.sloc, 7);
});

test('weird input never throws; unrecoverable cases are flagged', () => {
  const weird = [
    '', '`', '`${', '`${`${', '"abc', "'abc\n", '/* never ends', '/', '/[', '<', '<div', '<div a="', '<div>', '</div>',
    '{', '}', '}}}', '{{{', '${', '#', '#!/usr/bin/env node', '\u0000\u0001', 'a ? : ;', '<>', '<></', '<a b={', '@', '\\',
    'x = <a>{</a>', '`\\', "'\\", '1e', '0x', '..5', 'a?.5:1',
  ];
  for (const w of weird) {
    for (const opts of [{}, { ts: true }, { jsx: false }]) {
      assert.doesNotThrow(() => tokenize(w, opts), JSON.stringify(w));
    }
  }
  for (const w of ['`${', '"abc', '/* never ends', '{', '<div>', '`']) assert.ok(tokenize(w).issues.length > 0, JSON.stringify(w));
  assert.equal(tokenize('const a = 1;').issues.length, 0);
});

test('optional chaining versus a conditional with a number', () => {
  assert.deepEqual(values('a?.b'), ['id:a', 'p:?.', 'id:b']);
  assert.deepEqual(values('a?.5:1'), ['id:a', 'p:?', 'num:.5', 'p::', 'num:1']);
});
