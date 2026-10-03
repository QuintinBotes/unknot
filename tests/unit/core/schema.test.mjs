import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSchemas, validateArtifact, assertArtifact, schemaId } from '../../../runtime/core/schema.mjs';
import { UnknotError } from '../../../runtime/core/errors.mjs';

const ok = (schema, value, opts) => {
  const r = compile(schema, opts)(value);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
};
const no = (schema, value, keyword, opts) => {
  const r = compile(schema, opts)(value);
  assert.equal(r.valid, false, `expected ${JSON.stringify(value)} to be invalid`);
  if (keyword) assert.ok(r.errors.some((e) => e.keyword === keyword), `no ${keyword} error in ${JSON.stringify(r.errors)}`);
  return r.errors;
};

test('type: single, array form, and integer distinct from number', () => {
  ok({ type: 'string' }, 'x');
  no({ type: 'string' }, 1, 'type');
  ok({ type: ['string', 'null'] }, null);
  no({ type: ['string', 'null'] }, 1, 'type');
  ok({ type: 'integer' }, 3);
  ok({ type: 'integer' }, 3.0);
  no({ type: 'integer' }, 3.5, 'type');
  ok({ type: 'number' }, 3);
  ok({ type: 'number' }, 3.5);
  no({ type: 'number' }, '3', 'type');
  no({ type: 'object' }, [], 'type');
  no({ type: 'array' }, {}, 'type');
  ok({ type: 'boolean' }, false);
  no({ type: 'null' }, 0, 'type');
});

test('enum and const use deep equality', () => {
  ok({ enum: ['a', 1, { x: [1, 2] }, null] }, { x: [1, 2] });
  no({ enum: ['a', 'b'] }, 'c', 'enum');
  no({ enum: [1] }, '1', 'enum');
  ok({ const: { a: 1, b: 2 } }, { b: 2, a: 1 });
  no({ const: { a: 1 } }, { a: 2 }, 'const');
  ok({ const: null }, null);
  no({ const: 0 }, false, 'const');
});

test('properties, required, additionalProperties', () => {
  const s = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false };
  ok(s, { a: 1 });
  assert.deepEqual(no(s, {}, 'required').map((e) => e.path), ['']);
  const errs = no(s, { a: 'x', b: 1 });
  assert.deepEqual(errs.map((e) => [e.path, e.keyword]).sort(), [['', 'additionalProperties'], ['/a', 'type']]);
  ok({ additionalProperties: { type: 'string' } }, { x: 'y' });
  no({ additionalProperties: { type: 'string' } }, { x: 1 }, 'type');
  ok({ properties: { a: {} } }, { a: 1, zzz: 2 }); // open by default
  ok({ required: ['a'] }, 'not an object'); // object keywords ignore other types
});

test('patternProperties and propertyNames', () => {
  const s = { patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false };
  ok(s, { 'x-a': 'v' });
  no(s, { 'x-a': 1 }, 'type');
  no(s, { other: 'v' }, 'additionalProperties');
  const p = { propertyNames: { pattern: '^[a-z]+$' } };
  ok(p, { abc: 1 });
  no(p, { 'ABC': 1 }, 'propertyNames');
});

test('minProperties / maxProperties', () => {
  ok({ minProperties: 1 }, { a: 1 });
  no({ minProperties: 1 }, {}, 'minProperties');
  ok({ maxProperties: 1 }, { a: 1 });
  no({ maxProperties: 1 }, { a: 1, b: 2 }, 'maxProperties');
});

test('items, prefixItems, minItems, maxItems', () => {
  ok({ items: { type: 'integer' } }, [1, 2]);
  const e = no({ items: { type: 'integer' } }, [1, 'x', 3], 'type');
  assert.equal(e[0].path, '/1');
  ok({ prefixItems: [{ type: 'string' }, { type: 'integer' }] }, ['a', 1, 'extra']);
  no({ prefixItems: [{ type: 'string' }, { type: 'integer' }] }, ['a', 'b'], 'type');
  ok({ prefixItems: [{ type: 'string' }], items: false }, ['a']);
  no({ prefixItems: [{ type: 'string' }], items: false }, ['a', 'b'], 'false');
  ok({ minItems: 2 }, [1, 2]);
  no({ minItems: 2 }, [1], 'minItems');
  ok({ maxItems: 1 }, [1]);
  no({ maxItems: 1 }, [1, 2], 'maxItems');
});

test('uniqueItems uses deep equality', () => {
  ok({ uniqueItems: true }, [1, '1', { a: 1 }, { a: 2 }]);
  no({ uniqueItems: true }, [{ a: 1, b: [1] }, { b: [1], a: 1 }], 'uniqueItems');
  ok({ uniqueItems: false }, [1, 1]);
});

test('contains, minContains, maxContains', () => {
  const c = { contains: { const: 'retain' } };
  ok(c, ['a', 'retain']);
  no(c, ['a'], 'contains');
  no(c, [], 'contains');
  ok({ ...c, minContains: 2 }, ['retain', 'retain']);
  no({ ...c, minContains: 2 }, ['retain'], 'minContains');
  ok({ ...c, minContains: 0 }, []);
  ok({ ...c, maxContains: 1 }, ['retain', 'x']);
  no({ ...c, maxContains: 1 }, ['retain', 'retain'], 'maxContains');
  ok(c, 'not an array');
});

test('minLength / maxLength count code points, not UTF-16 units', () => {
  ok({ maxLength: 1 }, '😀');
  no({ maxLength: 1 }, 'ab', 'maxLength');
  ok({ minLength: 2 }, '😀😀');
  no({ minLength: 2 }, '😀', 'minLength');
  ok({ minLength: 1 }, 5); // string keywords ignore non-strings
});

test('pattern is unanchored and unicode-aware', () => {
  ok({ pattern: 'b' }, 'abc');
  no({ pattern: '^b' }, 'abc', 'pattern');
  ok({ pattern: '^\\p{L}+$' }, 'héllo');
  ok({ pattern: '^.$' }, '😀');
  assert.throws(() => compile({ pattern: '(' }), /regex/);
});

test('numeric bounds', () => {
  ok({ minimum: 1 }, 1);
  no({ minimum: 1 }, 0.5, 'minimum');
  ok({ maximum: 1 }, 1);
  no({ maximum: 1 }, 2, 'maximum');
  ok({ exclusiveMinimum: 1 }, 1.1);
  no({ exclusiveMinimum: 1 }, 1, 'exclusiveMinimum');
  ok({ exclusiveMaximum: 1 }, 0.9);
  no({ exclusiveMaximum: 1 }, 1, 'exclusiveMaximum');
  ok({ minimum: 5 }, 'x');
});

test('format: date-time is strict RFC 3339', () => {
  const f = { format: 'date-time' };
  for (const v of ['2026-10-03T12:00:00Z', '2026-10-03T12:00:00.123+02:00', '2024-02-29T23:59:60Z']) ok(f, v);
  for (const v of ['2026-10-03', '2026-10-03 12:00:00Z', '2026-13-01T00:00:00Z', '2025-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z', '2026-10-03T24:00:00Z', '2026-10-03T12:60:00Z', '2026-10-03T12:00:00', '2026-10-03t12:00:00z',
    '2026-10-03T12:00:00+25:00']) {
    no(f, v, 'format');
  }
  ok(f, 12); // formats only constrain strings
});

test('format: uri and uuid', () => {
  ok({ format: 'uri' }, 'https://unknot.dev/schemas/x.json');
  ok({ format: 'uri' }, 'urn:uuid:123');
  no({ format: 'uri' }, 'not a uri', 'format');
  no({ format: 'uri' }, '/relative/path', 'format');
  ok({ format: 'uuid' }, '123e4567-e89b-12d3-a456-426614174000');
  no({ format: 'uuid' }, '123e4567e89b12d3a456426614174000', 'format');
});

test('unknown format is a compile error', () => {
  assert.throws(() => compile({ format: 'email' }), /unknown format/);
});

test('allOf / anyOf / oneOf / not', () => {
  ok({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 3);
  no({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 1, 'minimum');
  ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 1);
  no({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, null, 'anyOf');
  ok({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 'a');
  no({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1, 'oneOf');
  no({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, null, 'oneOf');
  ok({ not: { type: 'string' } }, 1);
  no({ not: { type: 'string' } }, 'x', 'not');
});

test('oneOf failure surfaces the closest alternative errors', () => {
  const s = { oneOf: [
    { properties: { kind: { const: 'a' }, x: { type: 'integer' } }, required: ['kind'] },
    { properties: { kind: { const: 'b' } }, required: ['kind'] },
  ] };
  const errs = no(s, { kind: 'a', x: 'bad' }, 'oneOf');
  assert.ok(errs.some((e) => e.path === '/x' && e.keyword === 'type'));
});

test('if / then / else', () => {
  const s = { if: { properties: { k: { const: 1 } }, required: ['k'] }, then: { required: ['a'] }, else: { required: ['b'] } };
  ok(s, { k: 1, a: 1 });
  no(s, { k: 1 }, 'required');
  ok(s, { k: 2, b: 1 });
  no(s, { k: 2 }, 'required');
  ok({ if: { type: 'string' }, then: { minLength: 2 } }, 5); // no else: passes
  assert.throws(() => compile({ then: {} }), /require "if"/);
});

test('boolean schemas', () => {
  ok(true, 1);
  no(false, 1, 'false');
  ok({ properties: { a: true } }, { a: 1 });
  no({ properties: { a: false } }, { a: 1 });
});

test('$ref: local $defs, root, and JSON pointers', () => {
  const s = {
    $defs: { n: { type: 'integer', minimum: 0 }, 'a/b': { type: 'string' } },
    properties: { x: { $ref: '#/$defs/n' }, y: { $ref: '#/$defs/a~1b' }, z: { $ref: '#/properties/x' } },
  };
  ok(s, { x: 1, y: 's', z: 2 });
  no(s, { x: -1 }, 'minimum');
  no(s, { y: 1 }, 'type');
  no(s, { z: -1 }, 'minimum');
  assert.throws(() => compile({ $ref: '#/$defs/missing' }), /does not resolve/);
  assert.throws(() => compile({ $ref: 'nowhere.json#/x' }), /not in the registry/);
});

test('$ref: recursive schemas validate trees', () => {
  const tree = { $id: 'https://t/tree.json', type: 'object', properties: { kids: { type: 'array', items: { $ref: '#' } }, n: { type: 'integer' } }, additionalProperties: false };
  ok(tree, { n: 1, kids: [{ n: 2, kids: [{ n: 3 }] }] });
  const errs = no(tree, { kids: [{ kids: [{ n: 'x' }] }] }, 'type');
  assert.equal(errs[0].path, '/kids/0/kids/0/n');
});

test('$ref cycles are cut off by a depth limit', () => {
  const v = compile({ $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' });
  const r = v(1);
  assert.equal(r.valid, false);
  assert.equal(r.errors[0].keyword, '$ref');
});

test('$ref across schemas resolves by $id against the registry', () => {
  const a = { $id: 'https://u/a.schema.json', $defs: { id: { type: 'string', pattern: '^A-' } } };
  const b = {
    $id: 'https://u/b.schema.json',
    type: 'object',
    properties: { id: { $ref: 'a.schema.json#/$defs/id' }, abs: { $ref: 'https://u/a.schema.json#/$defs/id' } },
  };
  const registry = new Map([[a.$id, a], [b.$id, b]]);
  const v = compile(b, { registry });
  assert.equal(v({ id: 'A-1', abs: 'A-2' }).valid, true);
  const r = v({ id: 'B-1' });
  assert.equal(r.valid, false);
  assert.equal(r.errors[0].path, '/id');
  assert.throws(() => compile({ $id: 'https://u/c.json', $ref: 'zzz.json' }, { registry }), /not in the registry/);
});

test('cross-schema refs keep resolving relative to the target schema base', () => {
  const a = { $id: 'https://u/a.json', $defs: { x: { $ref: 'c.json' } } };
  const c = { $id: 'https://u/c.json', type: 'integer' };
  const b = { $id: 'https://u/b.json', $ref: 'a.json#/$defs/x' };
  const registry = new Map([[a.$id, a], [b.$id, b], [c.$id, c]]);
  assert.equal(compile(b, { registry })(1).valid, true);
  assert.equal(compile(b, { registry })('s').valid, false);
});

test('unknown keywords throw at compile time, including nested ones', () => {
  assert.throws(() => compile({ additionalProperites: false }), /unknown keyword "additionalProperites"/);
  assert.throws(() => compile({ properties: { a: { typ: 'string' } } }), /unknown keyword "typ"/);
  assert.throws(() => compile({ $defs: { a: { requird: [] } } }), /unknown keyword/);
  assert.throws(() => compile({ items: { dependentRequired: {} } }), /unknown keyword/);
  assert.throws(() => compile({ $schema: 'http://json-schema.org/draft-07/schema#' }), /\$schema/);
  assert.throws(() => compile({ type: 'strng' }), /type/);
  assert.throws(() => compile({ minLength: -1 }), /minLength/);
  assert.throws(() => compile({ required: 'a' }), /required/);
  try {
    compile({ bogus: 1 });
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof UnknotError);
    assert.equal(err.code, 'UK_SCHEMA_INVALID');
  }
});

test('annotation keywords are accepted and ignored', () => {
  ok({ title: 't', description: 'd', default: 1, examples: [1], $comment: 'c', deprecated: true, readOnly: true, type: 'integer' }, 1);
});

test('values must be JSON-like', () => {
  const v = compile(true);
  for (const bad of [undefined, () => 1, NaN, Infinity, -Infinity, 1n, Symbol('s'), new Date(), new Map(), { a: undefined }, [1, undefined], { a: { b: NaN } }]) {
    assert.equal(v(bad).valid, false, String(bad));
  }
  const cyc = {};
  cyc.self = cyc;
  assert.equal(v(cyc).valid, false);
  const r = v({ a: [0, NaN] });
  assert.equal(r.errors[0].path, '/a/1');
  assert.equal(v(Object.create(null)).valid, true);
  assert.equal(v({ a: [1, 'b', null, true, { c: 1.5 }] }).valid, true);
});

test('error paths are JSON pointers with escaping', () => {
  const e = no({ properties: { 'a/b': { properties: { 'c~d': { type: 'string' } } } } }, { 'a/b': { 'c~d': 1 } }, 'type');
  assert.equal(e[0].path, '/a~1b/c~0d');
  const e2 = no({ items: { properties: { b: { type: 'string' } } } }, [{ b: 'x' }, { b: 2 }]);
  assert.equal(e2[0].path, '/1/b');
  assert.deepEqual(Object.keys(e2[0]).sort(), ['keyword', 'message', 'path']);
});

test('errors are collected (not first-fail) and capped at 100', () => {
  const s = { type: 'object', required: ['a', 'b', 'c'] };
  assert.equal(no(s, {}).length, 3);
  const many = compile({ items: { type: 'string' } })(Array.from({ length: 500 }, (_, i) => i));
  assert.equal(many.errors.length, 100);
});

test('loadSchemas / validateArtifact / assertArtifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-schema-'));
  try {
    writeFileSync(join(dir, 'a.schema.json'), JSON.stringify({ $id: schemaId('a'), type: 'object', required: ['n'], properties: { n: { $ref: 'b.schema.json#/$defs/n' } } }));
    writeFileSync(join(dir, 'b.schema.json'), JSON.stringify({ $id: schemaId('b'), $defs: { n: { type: 'integer' } } }));
    writeFileSync(join(dir, 'ignored.json'), '{}');
    const reg = loadSchemas(dir);
    assert.deepEqual([...reg.keys()], [schemaId('a'), schemaId('b')]);
    assert.equal(validateArtifact('a', { n: 1 }, { registry: reg }).valid, true);
    assert.equal(validateArtifact('a', { n: 's' }, { registry: reg }).valid, false);
    assert.deepEqual(assertArtifact('a', { n: 1 }, { registry: reg }), { n: 1 });
    try {
      assertArtifact('a', { n: 's' }, { registry: reg });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof UnknotError);
      assert.equal(err.code, 'UK_SCHEMA_INVALID');
      assert.equal(err.details.schema, 'a');
      assert.equal(err.details.errors[0].path, '/n');
    }
    assert.throws(() => validateArtifact('zzz', {}, { registry: reg }), (e) => e.code === 'UK_NOT_FOUND');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSchemas rejects a schema without $id and duplicates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-schema-'));
  try {
    writeFileSync(join(dir, 'a.schema.json'), '{"type":"object"}');
    assert.throws(() => loadSchemas(dir), /no \$id/);
    writeFileSync(join(dir, 'a.schema.json'), '{"$id":"https://x/y"}');
    writeFileSync(join(dir, 'b.schema.json'), '{"$id":"https://x/y"}');
    assert.throws(() => loadSchemas(dir), /duplicate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every shipped schema loads and compiles, with only known keywords', () => {
  const reg = loadSchemas();
  assert.ok(reg.size >= 15);
  for (const id of reg.keys()) {
    const name = id.split('/').pop().replace('.schema.json', '');
    assert.doesNotThrow(() => validateArtifact(name, {}), name);
  }
});
