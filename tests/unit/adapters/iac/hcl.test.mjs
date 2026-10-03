import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHCL, parseExpression, bodyToPlain, isExpr, unwrapJsonencode } from '../../../../adapters/infrastructure/iac/hcl.mjs';
import { read } from './helpers.mjs';

const plain = (text) => bodyToPlain(parseHCL(text).body);

test('blocks with labels, attributes and nested blocks', () => {
  const { body, errors } = parseHCL('resource "aws_s3_bucket" "b" {\n  bucket = "x"\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n');
  assert.deepEqual(errors, []);
  const [b] = body.blocks;
  assert.equal(b.type, 'resource');
  assert.deepEqual(b.labels, ['aws_s3_bucket', 'b']);
  assert.equal(b.line, 1);
  assert.equal(b.body.attributes.bucket.value, 'x');
  assert.equal(b.body.attributes.bucket.line, 2);
  assert.equal(b.body.blocks[0].type, 'lifecycle');
  assert.equal(b.body.blocks[0].body.attributes.prevent_destroy.value, true);
});

test('literals: numbers, bools, null, lists, objects, tuples', () => {
  const p = plain('a = 1\nb = -2.5\nc = true\nd = null\ne = [1, "two", false]\nf = { x = 1, "y-z" = "q", w: 3 }\ng = []\nh = {}\n');
  assert.deepEqual(p, { a: 1, b: -2.5, c: true, d: null, e: [1, 'two', false], f: { x: 1, 'y-z': 'q', w: 3 }, g: [], h: {} });
});

test('lists and objects span lines, with trailing commas and comments', () => {
  const p = plain('ports = [\n  22, # ssh\n  80,\n  /* https */ 443,\n]\ntags = {\n  A = "1"\n  B = "2",\n}\n');
  assert.deepEqual(p.ports, [22, 80, 443]);
  assert.deepEqual(p.tags, { A: '1', B: '2' });
});

test('references, calls and operators become {expr} with raw text', () => {
  const p = plain('a = aws_s3_bucket.b.arn\nb = file("x.json")\nc = var.n + 1\nd = var.on ? "a" : "b"\ne = [for s in var.xs : upper(s)]\nf = aws_x.y[0].id\n');
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) assert.ok(isExpr(p[k]), k);
  assert.equal(p.a.expr, 'aws_s3_bucket.b.arn');
  assert.equal(p.b.expr, 'file("x.json")');
  assert.equal(p.c.expr, 'var.n + 1');
  assert.equal(p.d.expr, 'var.on ? "a" : "b"');
  assert.equal(p.e.expr, '[for s in var.xs : upper(s)]');
});

test('string templates keep their raw text; escaped $${ stays a literal string', () => {
  const p = plain('a = "x-${var.env}-y"\nb = "%{ if true }a%{ endif }"\nc = "cost: $${not_interp}"\nd = "q\\"uote"\n');
  assert.deepEqual(p.a, { expr: '"x-${var.env}-y"' });
  assert.ok(isExpr(p.b));
  assert.equal(p.c, 'cost: $${not_interp}');
  assert.equal(p.d, 'q"uote');
});

test('heredocs, plain and indented', () => {
  const p = plain('a = <<EOF\nline1\n  line2\nEOF\nb = <<-EOT\n    one\n      two\n  EOT\nc = 1\n');
  assert.equal(p.a, 'line1\n  line2\n');
  assert.equal(p.b, 'one\n  two\n');
  assert.equal(p.c, 1);
});

test('all three comment styles are ignored, including inside values', () => {
  const p = plain('# one\n// two\n/* three\n spans */\na = 1 # trailing\nb = 2 // trailing\nc = [1, /* mid */ 2]\n');
  assert.deepEqual(p, { a: 1, b: 2, c: [1, 2] });
});

test('single-line blocks and unlabeled blocks', () => {
  const { body } = parseHCL('terraform { required_version = ">= 1" }\nlocals { a = 1 }\n');
  assert.equal(body.blocks.length, 2);
  assert.equal(body.blocks[0].body.attributes.required_version.value, '>= 1');
});

test('function-call arguments with nested strings and braces stay one expression', () => {
  const p = plain('p = jsonencode({ a = "}", b = ["x)", "y"] })\nq = 1\n');
  assert.equal(p.p.expr, 'jsonencode({ a = "}", b = ["x)", "y"] })');
  assert.equal(p.q, 1);
});

test('jsonencode of a literal yields the literal; references stay leaves', () => {
  const v = unwrapJsonencode(parseHCL('p = jsonencode({ Action = "*", Resource = aws_s3_bucket.b.arn })').body.attributes.p.value);
  assert.equal(v.Action, '*');
  assert.deepEqual(v.Resource, { expr: 'aws_s3_bucket.b.arn' });
  assert.equal(unwrapJsonencode('nope'), undefined);
});

test('errors are reported with line numbers and parsing continues', () => {
  const { body, errors } = parseHCL('a = 1\n@@@ garbage\nb = 2\nresource "x" "y" {\n  c = 3\n');
  assert.ok(errors.length >= 2);
  assert.ok(errors.every((e) => Number.isInteger(e.line) && e.line >= 1 && typeof e.message === 'string'));
  assert.equal(body.attributes.a.value, 1);
  assert.equal(body.attributes.b.value, 2);
  assert.equal(body.blocks[0].body.attributes.c.value, 3);
});

test('non-string input and BOM do not throw', () => {
  assert.deepEqual(parseHCL(undefined).body, { attributes: {}, blocks: [] });
  assert.equal(parseHCL('﻿a = 1').body.attributes.a.value, 1);
  assert.deepEqual(parseExpression('[1,2]'), [1, 2]);
});

test('deeply nested garbage does not blow the stack', () => {
  const deep = `a = ${'['.repeat(5000)}${']'.repeat(5000)}\nb = 1\n`;
  const r = parseHCL(deep);
  assert.ok(Array.isArray(r.errors));
  const blocks = parseHCL(`${'x { '.repeat(3000)}`);
  assert.ok(Array.isArray(blocks.errors));
});

test('parses every Terraform fixture without errors', () => {
  for (const f of ['envs/dev/main.tf', 'envs/dev/versions.tf', 'envs/dev/backend.tf', 'envs/staging/main.tf', 'envs/prod/main.tf', 'modules/network/main.tf', 'modules/wrapper/main.tf']) {
    assert.deepEqual(parseHCL(read(`terraform/${f}`)).errors, [], f);
  }
});

// Seeded generator so a failure is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('500 seeded-random inputs never throw', () => {
  const corpus = read('terraform/envs/prod/main.tf') + read('terraform/envs/dev/main.tf');
  const alphabet = ['{', '}', '[', ']', '(', ')', '"', "'", '\\', '$', '%', '<<EOF\n', 'EOF\n', '#', '//', '/*', '*/', '=', ':', ',', '\n', ' ', '${', '%{', '.', '?', 'for ', 'resource ', 'x', '1', '\u0000', 'é', '<<-', '\r\n'];
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    let text;
    const mode = seed % 4;
    if (mode === 0) {
      text = Array.from({ length: 1 + Math.floor(r() * 200) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
    } else {
      // Mutate real Terraform: truncate, delete, insert or swap spans.
      text = corpus.slice(Math.floor(r() * 200), Math.floor(200 + r() * (corpus.length - 200)));
      for (let k = 0; k < 1 + Math.floor(r() * 12); k++) {
        const at = Math.floor(r() * text.length);
        const piece = alphabet[Math.floor(r() * alphabet.length)];
        if (mode === 1) text = text.slice(0, at) + piece + text.slice(at);
        else if (mode === 2) text = text.slice(0, at) + text.slice(at + Math.floor(r() * 30));
        else text = text.slice(0, at) + piece + text.slice(at + 1);
      }
    }
    let result;
    assert.doesNotThrow(() => { result = parseHCL(text); }, `seed ${seed}`);
    assert.ok(result.body && Array.isArray(result.errors), `shape, seed ${seed}`);
    assert.ok(result.errors.every((e) => Number.isInteger(e.line)), `error lines, seed ${seed}`);
    assert.doesNotThrow(() => bodyToPlain(result.body), `plain, seed ${seed}`);
  }
});
