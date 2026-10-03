import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../../../../adapters/language/generic/lexer.mjs';
import adapter from '../../../../adapters/language/generic/index.mjs';
import { rng } from './helpers.mjs';

const LANGS = ['go', 'java', 'kotlin', 'csharp', 'rust', 'ruby', 'php', 'scala', 'swift', 'c', 'cpp', 'groovy'];

const newlines = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i);
  return out;
};

test('line comments, block comments and strings are blanked, newlines preserved', () => {
  const src = 'int a = 1; // if (x) {\nchar *s = "while {"; /* for\n(;;) */ int b;\n';
  const lx = lex(src, 'c');
  assert.equal(lx.code.length, src.length);
  assert.deepEqual(newlines(lx.code), newlines(src));
  assert.ok(!lx.code.includes('if (x)'));
  assert.ok(!lx.code.includes('while'));
  assert.ok(!lx.code.includes('for'));
  assert.ok(lx.code.includes('int b;'));
  assert.ok(lx.plain.includes('"while {"'), 'plain keeps strings');
  assert.ok(!lx.plain.includes('if (x)'), 'plain drops comments');
  assert.equal(lx.literals[0].value, 'while {');
  assert.equal(lx.literals[0].line, 2);
});

test('Go raw strings span lines and contain no escapes', () => {
  const src = 'x := `a\\\n{ if }\n`\nfunc f() {}\n';
  const lx = lex(src, 'go');
  assert.ok(!lx.code.includes('if'));
  assert.ok(lx.code.includes('func f() {}'));
  assert.equal(lx.literals[0].kind, 'backtick');
});

test('Rust raw strings, lifetimes and char literals', () => {
  const src = 'fn f<\'a>(x: &\'a str) { let s = r#"fn g() { "quoted" }"#; let c = \'{\'; let d = \'\\\'\'; }\n';
  const lx = lex(src, 'rust');
  assert.ok(!lx.code.includes('fn g'));
  assert.ok(lx.code.includes("&'a str"), 'lifetime left alone');
  assert.equal([...lx.code].filter((c) => c === '{').length, 1);
  assert.equal(lx.literals.find((l) => l.kind === 'raw').value, 'fn g() { "quoted" }');
});

test('Rust nested block comments', () => {
  const lx = lex('/* a /* b */ still comment */ fn x() {}', 'rust');
  assert.ok(!lx.code.includes('still'));
  assert.ok(lx.code.includes('fn x() {}'));
});

test('C# verbatim, interpolated and raw strings', () => {
  const lx = lex('var a = @"if ""{"" x"; var b = $"{n} }"; var c = """\n  raw { "q" }\n  """; int z;', 'csharp');
  assert.ok(!lx.code.includes('if'));
  assert.equal(lx.literals[0].value, 'if ""{"" x');
  assert.ok(lx.code.includes('int z;'));
  assert.equal([...lx.code].filter((c) => c === '{' || c === '}').length, 0);
});

test('Kotlin, Swift and Scala triple-quoted strings', () => {
  for (const lang of ['kotlin', 'swift', 'scala']) {
    const lx = lex('val s = """\nclass Fake { fun x() }\n"""\nclass Real', lang);
    assert.ok(!lx.code.includes('Fake'), lang);
    assert.ok(lx.code.includes('class Real'), lang);
  }
});

test('Ruby comments, =begin/=end and heredocs', () => {
  const src = '# class Hidden\n=begin\ndef no\n=end\nx = <<~SQL\n  SELECT 1 FROM t\n  end\nSQL\ndef real\nend\n';
  const lx = lex(src, 'ruby');
  assert.ok(!lx.code.includes('Hidden'));
  assert.ok(!lx.code.includes('def no'));
  assert.ok(!lx.code.includes('SELECT'));
  assert.ok(lx.code.includes('def real'));
  assert.deepEqual(newlines(lx.code), newlines(src));
  const h = lx.literals.find((l) => l.kind === 'heredoc');
  assert.match(h.value, /SELECT 1 FROM t/);
  assert.equal(h.line, 5);
});

test('Ruby: << with a space is a shift, not a heredoc', () => {
  const lx = lex('a = 1 << FOO\nclass << self\nend\n', 'ruby');
  assert.ok(lx.code.includes('class << self'));
  assert.equal(lx.literals.length, 0);
});

test('PHP comments, heredoc and nowdoc', () => {
  const src = '<?php\n# hash { \n// slash {\n/* block { */\n$a = <<<EOT\nfunction nope() {\nEOT;\n$b = <<<\'RAW\'\n{ $x }\nRAW;\n#[Attr]\nfunction yes() {}\n';
  const lx = lex(src, 'php');
  assert.ok(!lx.code.includes('nope'));
  assert.ok(!lx.code.includes('$x'));
  assert.ok(lx.code.includes('#[Attr]'), 'PHP 8 attributes are not comments');
  assert.ok(lx.code.includes('function yes() {}'));
  assert.equal(lx.literals.filter((l) => l.kind === 'heredoc').length, 2);
});

test('C++ raw strings with delimiters', () => {
  const lx = lex('auto s = R"x(a "quoted" )" { )x"; int y;', 'cpp');
  assert.ok(lx.code.includes('int y;'));
  assert.equal(lx.literals[0].value, 'a "quoted" )" { ');
});

test('unterminated constructs end at a sane place and never throw', () => {
  for (const [lang, src] of [['java', '"abc\nint x;'], ['java', '/* open'], ['rust', 'r##"never closed'], ['ruby', 'x = <<~EOS\nbody'], ['php', '$a = <<<X\nbody'], ['csharp', '@"open']]) {
    const lx = lex(src, lang);
    assert.equal(lx.code.length, src.length);
  }
  assert.ok(lex('"abc\nint x;', 'java').code.includes('int x;'), 'a newline ends an unterminated single-line string');
});

test('lexer, analysis and extraction survive 500 random inputs per language family', () => {
  const pieces = ['"', "'", '`', '//', '/*', '*/', '#', '<<<', '<<~', '<<-', 'r#"', 'R"x(', ')x"', '@"', '"""', '=begin', '=end', '\n', '\n', '{', '}', '(', ')', '[', ']',
    '\\', 'class ', 'def ', 'end', 'func ', 'fn ', 'fun ', 'function ', 'if ', 'else', 'for ', 'package ', 'import ', 'use ', 'namespace ', 'struct ', 'impl ', '#include <', ';', ' ', 'é', '😀', '\u0000'];
  const exts = { go: 'a.go', java: 'A.java', kotlin: 'a.kt', csharp: 'A.cs', rust: 'a.rs', ruby: 'a.rb', php: 'a.php', scala: 'a.scala', swift: 'a.swift', c: 'a.c', cpp: 'a.cpp', groovy: 'a.cpp' };
  for (const lang of LANGS) {
    const next = rng(0xC0FFEE + lang.length * 7919);
    for (let k = 0; k < 500; k++) {
      let s = '';
      const len = Math.floor(next() * 120);
      for (let j = 0; j < len; j++) {
        const r = next();
        s += r < 0.6 ? pieces[Math.floor(next() * pieces.length)] : String.fromCharCode(Math.floor(next() * 256));
      }
      const lx = lex(s, lang);
      assert.equal(lx.code.length, s.length, `${lang} #${k}`);
      assert.deepEqual(newlines(lx.code), newlines(s), `${lang} #${k}`);
      assert.doesNotThrow(() => adapter.extract({ path: exts[lang], kind: 'source' }, s, {}), `${lang} #${k}: ${JSON.stringify(s)}`);
    }
  }
});

test('a 1 MB Java file extracts in under 1.5 seconds', () => {
  const unit = `
  /** doc { with brace */
  @GetMapping("/x/{id}")
  public String handle%N(int id, String name) throws Exception {
    String sql = "SELECT * FROM t WHERE id = " + id; // trailing { comment
    if (id > 0 && name != null) {
      for (int i = 0; i < id; i++) {
        while (i < 3) { i++; }
      }
    } else if (id < 0 || name == null) {
      return null;
    }
    return id > 1 ? "a" : "b";
  }
`;
  let body = '';
  for (let n = 0; body.length < 1_000_000; n++) body += unit.replace('%N', String(n));
  const src = `package big;\nimport java.util.List;\n@RequestMapping("/big")\npublic class Big {\n${body}}\n`;
  assert.ok(src.length >= 1_000_000);
  const t0 = performance.now();
  const facts = adapter.extract({ path: 'src/main/java/big/Big.java', kind: 'source' }, src, {});
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  const mod = facts.find((f) => f.id === 'module:src/main/java/big/Big.java');
  assert.ok(mod.attrs.truncated, 'huge files are capped and say so');
  assert.equal(facts.length, 5000);
});
