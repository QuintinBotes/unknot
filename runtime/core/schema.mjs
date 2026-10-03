// A strict JSON Schema validator (draft 2020-12 subset) and the artifact schema registry.
//
// Why our own: Unknot ships with zero dependencies, and artifacts that cross a model
// boundary (handoffs, findings, approvals) must be rejected loudly when malformed. The
// subset is deliberately small, and any keyword outside it throws at compile time, so a
// typo like `additionalProperites` in a schema can never silently weaken validation.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnknotError } from './errors.mjs';

export const SCHEMA_BASE = 'https://unknot.dev/schemas/';
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const MAX_ERRORS = 100;
const MAX_REF_DEPTH = 64;
const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');

/** Keywords that carry no validation semantics; allowed and ignored. */
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$comment', 'deprecated', 'readOnly']);
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  '$schema', '$id', '$defs', '$ref',
  'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'string', 'number', 'integer']);

// ---- formats -------------------------------------------------------------------------

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** RFC 3339 date-time with real calendar ranges. Uppercase T and Z only (strict). */
function isDateTime(s) {
  const m = DATE_TIME.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > dim || h > 23 || mi > 59 || se > 60) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  return true;
}

function isUri(s) {
  if (!URI.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

const FORMATS = Object.freeze({
  'date-time': isDateTime,
  uri: isUri,
  uuid: (s) => UUID.test(s),
});

// ---- value helpers -------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v, t) {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return isObject(v);
    default: return false;
  }
}

/** Structural equality for JSON values (key order is irrelevant). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const codePoints = (s) => { let n = 0; for (const _ of s) n++; return n; }; // eslint-disable-line no-unused-vars

const escapePtr = (seg) => String(seg).replaceAll('~', '~0').replaceAll('/', '~1');

/** Why a value is not JSON-like, or null. Catches what JSON.stringify would silently drop. */
function nonJSON(value, path = '', seen = new Set()) {
  const t = typeof value;
  if (value === null || t === 'string' || t === 'boolean') return null;
  if (t === 'number') return Number.isFinite(value) ? null : { path, message: `non-finite number ${value} is not JSON` };
  if (t !== 'object') return { path, message: `${t} is not a JSON value` };
  if (seen.has(value)) return { path, message: 'circular reference is not JSON' };
  if (Array.isArray(value)) {
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      // sparse holes read as undefined
      const r = nonJSON(value[i], `${path}/${i}`, seen);
      if (r) return r;
    }
    seen.delete(value);
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return { path, message: 'only plain objects are JSON values' };
  seen.add(value);
  for (const k of Object.keys(value)) {
    const r = nonJSON(value[k], `${path}/${escapePtr(k)}`, seen);
    if (r) return r;
  }
  seen.delete(value);
  return null;
}

// ---- compiler ------------------------------------------------------------------------

const bad = (where, msg) => new UnknotError('UK_SCHEMA_INVALID', `schema ${where}: ${msg}`, { details: { where } });

function decodePointer(frag) {
  let s;
  try {
    s = decodeURIComponent(frag);
  } catch {
    throw bad(frag, 'malformed percent-encoding in $ref');
  }
  if (s === '') return [];
  if (!s.startsWith('/')) throw bad(frag, `unsupported $ref fragment "#${frag}" (only JSON pointers)`);
  return s.slice(1).split('/').map((x) => x.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function pointerGet(root, tokens, where) {
  let cur = root;
  for (const t of tokens) {
    if (Array.isArray(cur) && /^(0|[1-9]\d*)$/.test(t) && Number(t) < cur.length) cur = cur[Number(t)];
    else if (isObject(cur) && Object.hasOwn(cur, t)) cur = cur[t];
    else throw bad(where, `$ref pointer /${tokens.map(escapePtr).join('/')} does not resolve`);
  }
  return cur;
}

// One cache of compiled nodes per registry, so recursive and shared subschemas compile once.
const caches = new WeakMap();
const NO_REGISTRY = {};

function cacheFor(registry) {
  const key = registry ?? NO_REGISTRY;
  let c = caches.get(key);
  if (!c) caches.set(key, (c = new WeakMap()));
  return c;
}

/**
 * Compile a schema into a validator.
 * @param {object|boolean} schema
 * @param {{registry?: Map<string, object>}} [opts] registry of raw schemas keyed by `$id`,
 *   used to resolve cross-schema `$ref`s.
 * @returns {(value: unknown) => {valid: boolean, errors: {path: string, keyword: string, message: string}[]}}
 */
export function compile(schema, { registry } = {}) {
  if (typeof schema !== 'boolean' && !isObject(schema)) throw bad('<root>', 'a schema must be an object or boolean');
  const base = typeof schema === 'object' && typeof schema.$id === 'string' ? schema.$id : null;
  const ctx = { root: schema, base, registry: registry ?? new Map(), cache: cacheFor(registry) };
  const node = compileNode(schema, ctx, '#');
  return (value) => {
    const errors = [];
    const badJSON = nonJSON(value);
    if (badJSON) {
      errors.push({ path: badJSON.path, keyword: 'type', message: badJSON.message });
    } else {
      node(value, '', errors, 0);
    }
    return { valid: errors.length === 0, errors };
  };
}

/** Resolve a `$ref` string to {node, ctx} for the target schema. */
function resolveRef(ref, ctx, where) {
  const hash = ref.indexOf('#');
  const basePart = hash === -1 ? ref : ref.slice(0, hash);
  const frag = hash === -1 ? '' : ref.slice(hash + 1);
  let root = ctx.root;
  let base = ctx.base;
  if (basePart !== '') {
    let id;
    try {
      id = ctx.base ? new URL(basePart, ctx.base).href : basePart;
    } catch {
      throw bad(where, `bad $ref "${ref}"`);
    }
    const found = ctx.registry.get(id) ?? ctx.registry.get(basePart);
    if (found === undefined) throw bad(where, `$ref "${ref}" names a schema not in the registry (${id})`);
    root = found;
    base = isObject(found) && typeof found.$id === 'string' ? found.$id : id;
  }
  const target = pointerGet(root, decodePointer(frag), where);
  return { node: target, ctx: root === ctx.root ? ctx : { ...ctx, root, base } };
}

function compileNode(schema, ctx, where) {
  if (schema === true) return () => {};
  if (schema === false) {
    return (v, path, errors) => addError(errors, path, 'false', 'no value is allowed here');
  }
  if (!isObject(schema)) throw bad(where, 'a schema must be an object or boolean');
  const hit = ctx.cache.get(schema);
  if (hit) return hit;
  // Install a forwarding stub first: a schema that reaches itself through $ref compiles once.
  let impl;
  const fn = (v, p, e, d) => impl(v, p, e, d);
  ctx.cache.set(schema, fn);
  try {
    impl = build(schema, ctx, where);
  } catch (err) {
    ctx.cache.delete(schema);
    throw err;
  }
  return fn;
}

function addError(errors, path, keyword, message) {
  if (errors.length < MAX_ERRORS) errors.push({ path, keyword, message });
}

const expect = (cond, where, kw, what) => {
  if (!cond) throw bad(where, `"${kw}" must be ${what}`);
};
const isCount = (n) => Number.isInteger(n) && n >= 0;
const isStrings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

function compileRegex(src, where, kw) {
  try {
    return new RegExp(src, 'u');
  } catch (err) {
    throw bad(where, `"${kw}" is not a valid unicode regex: ${err.message}`);
  }
}

/** Compile each keyword of one schema object into a check, in a stable order. */
function build(s, ctx, where) {
  for (const k of Object.keys(s)) {
    if (!KEYWORDS.has(k)) throw bad(where, `unknown keyword "${k}"`);
  }
  if (s.$schema !== undefined) expect(s.$schema === DIALECT, where, '$schema', `"${DIALECT}"`);
  if (s.$id !== undefined) expect(typeof s.$id === 'string' && s.$id !== '', where, '$id', 'a non-empty string');

  const checks = [];
  const sub = (child, w) => compileNode(child, ctx, `${where}/${w}`);

  // $defs are compiled eagerly even when unreferenced, so typos in them still fail.
  if (s.$defs !== undefined) {
    expect(isObject(s.$defs), where, '$defs', 'an object');
    for (const [name, def] of Object.entries(s.$defs)) sub(def, `$defs/${escapePtr(name)}`);
  }

  if (s.$ref !== undefined) {
    expect(typeof s.$ref === 'string', where, '$ref', 'a string');
    const target = resolveRef(s.$ref, ctx, where);
    const run = compileNode(target.node, target.ctx, `${where}/$ref(${s.$ref})`);
    checks.push((v, p, e, d) => {
      if (d >= MAX_REF_DEPTH) return addError(e, p, '$ref', `$ref depth limit ${MAX_REF_DEPTH} exceeded (cycle?)`);
      run(v, p, e, d + 1);
    });
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    expect(types.length > 0 && types.every((t) => TYPES.has(t)), where, 'type', 'a JSON type name or array of them');
    checks.push((v, p, e) => {
      if (!types.some((t) => matchesType(v, t))) {
        addError(e, p, 'type', `expected ${types.join(' or ')}, got ${typeOf(v)}`);
      }
    });
  }

  if (s.enum !== undefined) {
    expect(Array.isArray(s.enum) && s.enum.length > 0, where, 'enum', 'a non-empty array');
    checks.push((v, p, e) => {
      if (!s.enum.some((x) => deepEqual(x, v))) {
        addError(e, p, 'enum', `must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`);
      }
    });
  }

  if (s.const !== undefined) {
    checks.push((v, p, e) => {
      if (!deepEqual(s.const, v)) addError(e, p, 'const', `must equal ${JSON.stringify(s.const)}`);
    });
  }

  // ---- numbers
  for (const [kw, test, word] of [
    ['minimum', (v, n) => v >= n, '>='],
    ['maximum', (v, n) => v <= n, '<='],
    ['exclusiveMinimum', (v, n) => v > n, '>'],
    ['exclusiveMaximum', (v, n) => v < n, '<'],
  ]) {
    if (s[kw] === undefined) continue;
    expect(typeof s[kw] === 'number' && Number.isFinite(s[kw]), where, kw, 'a finite number');
    checks.push((v, p, e) => {
      if (typeof v === 'number' && !test(v, s[kw])) addError(e, p, kw, `must be ${word} ${s[kw]}`);
    });
  }

  // ---- strings
  if (s.minLength !== undefined) {
    expect(isCount(s.minLength), where, 'minLength', 'a non-negative integer');
    checks.push((v, p, e) => {
      if (typeof v === 'string' && codePoints(v) < s.minLength) addError(e, p, 'minLength', `must have at least ${s.minLength} characters`);
    });
  }
  if (s.maxLength !== undefined) {
    expect(isCount(s.maxLength), where, 'maxLength', 'a non-negative integer');
    checks.push((v, p, e) => {
      if (typeof v === 'string' && codePoints(v) > s.maxLength) addError(e, p, 'maxLength', `must have at most ${s.maxLength} characters`);
    });
  }
  if (s.pattern !== undefined) {
    expect(typeof s.pattern === 'string', where, 'pattern', 'a string');
    const re = compileRegex(s.pattern, where, 'pattern');
    checks.push((v, p, e) => {
      if (typeof v === 'string' && !re.test(v)) addError(e, p, 'pattern', `must match ${s.pattern}`);
    });
  }
  if (s.format !== undefined) {
    const f = typeof s.format === 'string' ? FORMATS[s.format] : undefined;
    if (!f) throw bad(where, `unknown format "${s.format}" (supported: ${Object.keys(FORMATS).join(', ')})`);
    checks.push((v, p, e) => {
      if (typeof v === 'string' && !f(v)) addError(e, p, 'format', `must be a valid ${s.format}`);
    });
  }

  // ---- objects
  if (s.required !== undefined) {
    expect(isStrings(s.required), where, 'required', 'an array of strings');
    checks.push((v, p, e) => {
      if (!isObject(v)) return;
      for (const k of s.required) {
        if (!Object.hasOwn(v, k)) addError(e, p, 'required', `missing required property "${k}"`);
      }
    });
  }
  if (s.minProperties !== undefined) {
    expect(isCount(s.minProperties), where, 'minProperties', 'a non-negative integer');
    checks.push((v, p, e) => {
      if (isObject(v) && Object.keys(v).length < s.minProperties) addError(e, p, 'minProperties', `must have at least ${s.minProperties} properties`);
    });
  }
  if (s.maxProperties !== undefined) {
    expect(isCount(s.maxProperties), where, 'maxProperties', 'a non-negative integer');
    checks.push((v, p, e) => {
      if (isObject(v) && Object.keys(v).length > s.maxProperties) addError(e, p, 'maxProperties', `must have at most ${s.maxProperties} properties`);
    });
  }

  const props = {};
  if (s.properties !== undefined) {
    expect(isObject(s.properties), where, 'properties', 'an object');
    for (const [k, def] of Object.entries(s.properties)) props[k] = sub(def, `properties/${escapePtr(k)}`);
  }
  const patterns = [];
  if (s.patternProperties !== undefined) {
    expect(isObject(s.patternProperties), where, 'patternProperties', 'an object');
    for (const [src, def] of Object.entries(s.patternProperties)) {
      patterns.push([compileRegex(src, where, 'patternProperties'), sub(def, `patternProperties/${escapePtr(src)}`)]);
    }
  }
  let additional;
  if (s.additionalProperties !== undefined) {
    expect(typeof s.additionalProperties === 'boolean' || isObject(s.additionalProperties), where, 'additionalProperties', 'a boolean or schema');
    additional = sub(s.additionalProperties, 'additionalProperties');
  }
  if (s.properties !== undefined || s.patternProperties !== undefined || additional) {
    checks.push((v, p, e, d) => {
      if (!isObject(v)) return;
      for (const k of Object.keys(v)) {
        const kp = `${p}/${escapePtr(k)}`;
        let matched = false;
        if (Object.hasOwn(props, k)) {
          matched = true;
          props[k](v[k], kp, e, d);
        }
        for (const [re, run] of patterns) {
          if (re.test(k)) {
            matched = true;
            run(v[k], kp, e, d);
          }
        }
        if (!matched && additional) {
          if (s.additionalProperties === false) addError(e, p, 'additionalProperties', `unknown property "${k}"`);
          else additional(v[k], kp, e, d);
        }
      }
    });
  }
  if (s.propertyNames !== undefined) {
    const run = sub(s.propertyNames, 'propertyNames');
    checks.push((v, p, e, d) => {
      if (!isObject(v)) return;
      for (const k of Object.keys(v)) {
        const local = [];
        run(k, p, local, d);
        for (const err of local) addError(e, p, 'propertyNames', `property name "${k}": ${err.message}`);
      }
    });
  }

  // ---- arrays
  let prefix = [];
  if (s.prefixItems !== undefined) {
    expect(Array.isArray(s.prefixItems), where, 'prefixItems', 'an array of schemas');
    prefix = s.prefixItems.map((c, i) => sub(c, `prefixItems/${i}`));
  }
  const itemsRun = s.items === undefined ? null : sub(s.items, 'items');
  if (s.items !== undefined) expect(typeof s.items === 'boolean' || isObject(s.items), where, 'items', 'a schema');
  if (prefix.length || itemsRun) {
    checks.push((v, p, e, d) => {
      if (!Array.isArray(v)) return;
      for (let i = 0; i < v.length; i++) {
        if (i < prefix.length) prefix[i](v[i], `${p}/${i}`, e, d);
        else if (itemsRun) itemsRun(v[i], `${p}/${i}`, e, d);
      }
    });
  }
  if (s.minItems !== undefined) {
    expect(isCount(s.minItems), where, 'minItems', 'a non-negative integer');
    checks.push((v, p, e) => {
      if (Array.isArray(v) && v.length < s.minItems) addError(e, p, 'minItems', `must have at least ${s.minItems} items`);
    });
  }
  if (s.maxItems !== undefined) {
    expect(isCount(s.maxItems), where, 'maxItems', 'a non-negative integer');
    checks.push((v, p, e) => {
      if (Array.isArray(v) && v.length > s.maxItems) addError(e, p, 'maxItems', `must have at most ${s.maxItems} items`);
    });
  }
  if (s.uniqueItems !== undefined) {
    expect(typeof s.uniqueItems === 'boolean', where, 'uniqueItems', 'a boolean');
    if (s.uniqueItems) {
      checks.push((v, p, e) => {
        if (!Array.isArray(v)) return;
        for (let i = 1; i < v.length; i++) {
          const j = v.slice(0, i).findIndex((x) => deepEqual(x, v[i]));
          if (j !== -1) addError(e, `${p}/${i}`, 'uniqueItems', `duplicates item ${j}`);
        }
      });
    }
  }
  if (s.minContains !== undefined) expect(isCount(s.minContains), where, 'minContains', 'a non-negative integer');
  if (s.maxContains !== undefined) expect(isCount(s.maxContains), where, 'maxContains', 'a non-negative integer');
  if (s.contains !== undefined) {
    const run = sub(s.contains, 'contains');
    const min = s.minContains ?? 1;
    checks.push((v, p, e, d) => {
      if (!Array.isArray(v)) return;
      let n = 0;
      for (const item of v) {
        const local = [];
        run(item, p, local, d);
        if (local.length === 0) n++;
      }
      if (n < min) addError(e, p, n === 0 && s.minContains === undefined ? 'contains' : 'minContains', `must contain at least ${min} matching item(s), found ${n}`);
      else if (s.maxContains !== undefined && n > s.maxContains) addError(e, p, 'maxContains', `must contain at most ${s.maxContains} matching item(s), found ${n}`);
    });
  }

  // ---- composition
  if (s.allOf !== undefined) {
    expect(Array.isArray(s.allOf) && s.allOf.length > 0, where, 'allOf', 'a non-empty array of schemas');
    const runs = s.allOf.map((c, i) => sub(c, `allOf/${i}`));
    checks.push((v, p, e, d) => runs.forEach((r) => r(v, p, e, d)));
  }
  if (s.anyOf !== undefined) {
    expect(Array.isArray(s.anyOf) && s.anyOf.length > 0, where, 'anyOf', 'a non-empty array of schemas');
    const runs = s.anyOf.map((c, i) => sub(c, `anyOf/${i}`));
    checks.push((v, p, e, d) => {
      const tried = runs.map((r) => { const l = []; r(v, p, l, d); return l; });
      if (tried.some((l) => l.length === 0)) return;
      addError(e, p, 'anyOf', 'must match at least one alternative');
      closest(tried).forEach((x) => addError(e, x.path, x.keyword, x.message));
    });
  }
  if (s.oneOf !== undefined) {
    expect(Array.isArray(s.oneOf) && s.oneOf.length > 0, where, 'oneOf', 'a non-empty array of schemas');
    const runs = s.oneOf.map((c, i) => sub(c, `oneOf/${i}`));
    checks.push((v, p, e, d) => {
      const tried = runs.map((r) => { const l = []; r(v, p, l, d); return l; });
      const ok = tried.filter((l) => l.length === 0).length;
      if (ok === 1) return;
      if (ok > 1) return addError(e, p, 'oneOf', `must match exactly one alternative, matched ${ok}`);
      addError(e, p, 'oneOf', 'must match exactly one alternative, matched none');
      closest(tried).forEach((x) => addError(e, x.path, x.keyword, x.message));
    });
  }
  if (s.not !== undefined) {
    const run = sub(s.not, 'not');
    checks.push((v, p, e, d) => {
      const l = [];
      run(v, p, l, d);
      if (l.length === 0) addError(e, p, 'not', 'must not match the forbidden schema');
    });
  }
  if (s.if !== undefined) {
    const cond = sub(s.if, 'if');
    const then = s.then === undefined ? null : sub(s.then, 'then');
    const els = s.else === undefined ? null : sub(s.else, 'else');
    checks.push((v, p, e, d) => {
      const l = [];
      cond(v, p, l, d);
      const branch = l.length === 0 ? then : els;
      if (branch) branch(v, p, e, d);
    });
  } else if (s.then !== undefined || s.else !== undefined) {
    // then/else without if are inert in 2020-12, which is almost always a mistake here.
    throw bad(where, '"then"/"else" require "if"');
  }

  return (v, p, e, d) => {
    for (const c of checks) c(v, p, e, d);
  };
}

/** The alternative that failed with the fewest errors: the most useful one to show. */
function closest(tried) {
  return tried.reduce((best, l) => (l.length < best.length ? l : best)).slice(0, 5);
}

// ---- artifact registry ---------------------------------------------------------------

const registries = new WeakMap(); // registry -> Map(name -> validator)
let defaultRegistry = null;

/**
 * Load every `*.schema.json` in a directory into a registry keyed by `$id`. Schemas are
 * compiled lazily (on first validation), so loading is cheap and a broken schema surfaces
 * only where it is used.
 * @param {string} [dir]
 * @returns {Map<string, object>}
 */
export function loadSchemas(dir = DEFAULT_DIR) {
  const registry = new Map();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.schema.json')).sort()) {
    let schema;
    try {
      schema = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      throw new UnknotError('UK_SCHEMA_INVALID', `cannot read schema ${f}: ${err.message}`, { details: { file: f } });
    }
    if (!isObject(schema) || typeof schema.$id !== 'string') {
      throw new UnknotError('UK_SCHEMA_INVALID', `schema ${f} has no $id`, { details: { file: f } });
    }
    if (registry.has(schema.$id)) {
      throw new UnknotError('UK_SCHEMA_INVALID', `duplicate $id ${schema.$id} in ${f}`, { details: { file: f } });
    }
    registry.set(schema.$id, schema);
  }
  return registry;
}

/** `finding` -> `https://unknot.dev/schemas/finding.schema.json`. */
export const schemaId = (name) => `${SCHEMA_BASE}${name}.schema.json`;

function validatorFor(name, registry) {
  const reg = registry ?? (defaultRegistry ??= loadSchemas());
  let byName = registries.get(reg);
  if (!byName) registries.set(reg, (byName = new Map()));
  let v = byName.get(name);
  if (!v) {
    const schema = reg.get(schemaId(name));
    if (!schema) throw new UnknotError('UK_NOT_FOUND', `no schema named "${name}"`, { details: { schema: name } });
    v = compile(schema, { registry: reg });
    byName.set(name, v);
  }
  return v;
}

/** Validate against a named artifact schema. Returns `{valid, errors}`. */
export function validateArtifact(name, value, { registry } = {}) {
  return validatorFor(name, registry)(value);
}

/** Like {@link validateArtifact} but throws UK_SCHEMA_INVALID with the errors in `details`. */
export function assertArtifact(name, value, { registry } = {}) {
  const r = validateArtifact(name, value, { registry });
  if (!r.valid) {
    const head = r.errors.slice(0, 3).map((x) => `${x.path || '/'}: ${x.message}`).join('; ');
    const more = r.errors.length > 3 ? ` (+${r.errors.length - 3} more)` : '';
    throw new UnknotError('UK_SCHEMA_INVALID', `${name} is invalid: ${head}${more}`, {
      details: { schema: name, errors: r.errors },
    });
  }
  return value;
}
