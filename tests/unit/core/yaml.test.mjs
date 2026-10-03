import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseYAML, stringifyYAML, YAMLError } from '../../../runtime/core/yaml.mjs';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/yaml/${name}`, import.meta.url)), 'utf8');

const rejects = (text, opts, pattern) => {
  let caught;
  try {
    parseYAML(text, opts);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof YAMLError, `expected YAMLError for ${JSON.stringify(text.slice(0, 60))}`);
  assert.ok(Number.isInteger(caught.line) && caught.line >= 1);
  assert.ok(Number.isInteger(caught.column) && caught.column >= 1);
  assert.match(caught.message, /line \d+, column \d+/);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
};

test('YAMLError carries 1-based position and filename', () => {
  const e = rejects('a: 1\nb: 2\nb: 3\n', { filename: 'x.yml' }, /duplicate key "b"/);
  assert.equal(e.line, 3);
  assert.equal(e.column, 1);
  assert.equal(e.filename, 'x.yml');
  assert.match(e.message, /^x\.yml: /);
  assert.equal(e.name, 'YAMLError');
});

test('BOM and CRLF are handled', () => {
  assert.deepEqual(parseYAML('\uFEFFa: 1\r\nb:\r\n  - x\r\n  - y\r\n'), { a: 1, b: ['x', 'y'] });
  assert.deepEqual(parseYAML('a: |\r\n  l1\r\n  l2\r\n'), { a: 'l1\nl2\n' });
});

test('comments: full-line, trailing, and # inside text', () => {
  const v = parseYAML('# top\na: 1 # trailing\n  # indented comment\nb: x#y\nc: "q # not comment"\n# end');
  assert.deepEqual(v, { a: 1, b: 'x#y', c: 'q # not comment' });
});

test('empty and comment-only input', () => {
  assert.equal(parseYAML(''), null);
  assert.equal(parseYAML('# nothing\n'), null);
  assert.deepEqual(parseYAML('', { multi: true }), []);
});

test('block mappings, sequences, compact forms', () => {
  const v = parseYAML('- - a\n  - b\n- c: 1\n  d:\n  - e\n  - f\n-\n- g\n');
  assert.deepEqual(v, [['a', 'b'], { c: 1, d: ['e', 'f'] }, null, 'g']);
  assert.deepEqual(parseYAML('a:\n  b:\n    c: deep\n  d: 1\ne: 2'), { a: { b: { c: 'deep' }, d: 1 }, e: 2 });
  assert.deepEqual(parseYAML('a:\nb:\n'), { a: null, b: null });
});

test('flow collections: nested, multi-line, trailing commas', () => {
  assert.deepEqual(parseYAML('[1, [2, 3,], {a: b,},]'), [1, [2, 3], { a: 'b' }]);
  assert.deepEqual(parseYAML('a: {\n  x: 1,\n  y: [1,\n    2],\n}\nb: 3'), { a: { x: 1, y: [1, 2] }, b: 3 });
  assert.deepEqual(parseYAML('{a, b: , "c":d, e:1}'), { a: null, b: null, c: 'd', 'e:1': null });
  assert.deepEqual(parseYAML('[a: 1, "b":2]'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseYAML('[]'), []);
  assert.deepEqual(parseYAML('{}'), {});
});

test('plain scalars with multi-line folding', () => {
  assert.equal(parseYAML('a: one\n  two\n\n  three\nb: x').a, 'one two\nthree');
  assert.deepEqual(parseYAML('- one\n  two\n- three'), ['one two', 'three']);
  assert.equal(parseYAML('url: http://x.y/z?a=b:c'). url, 'http://x.y/z?a=b:c');
});

test('single-quoted scalars', () => {
  assert.equal(parseYAML("'it''s'"), "it's");
  assert.equal(parseYAML("a: 'x\n  y\n\n  z'").a, 'x y\nz');
  assert.equal(parseYAML("'\\n stays'"), '\\n stays');
});

test('double-quoted escapes', () => {
  assert.equal(parseYAML('"a\\tb\\nc\\\\d\\"e\\/f"'), 'a\tb\nc\\d"e/f');
  assert.equal(parseYAML('"\\x41\\u00e9\\U0001F600"'), 'A\u00e9\u{1F600}');
  assert.equal(parseYAML('"\\0\\a\\b\\v\\f\\r\\e\\ \\N\\_"'), '\0\x07\b\v\f\r\x1b \x85\xa0');
  assert.equal(parseYAML('"\\L\\P"'), '\u2028\u2029');
  assert.equal(parseYAML('"line one\n   line two\n\n   para"'), 'line one line two\npara');
  assert.equal(parseYAML('"join\\\n   ed"'), 'joined');
  assert.equal(parseYAML('"keep\\ \n   me"'), 'keep  me');
});

test('invalid escapes and unterminated quotes are rejected', () => {
  rejects('"\\q"', {}, /invalid escape/);
  rejects('"\\x4"', {}, /escape/);
  rejects('"\\UFFFFFFFF"', {}, /code point/);
  rejects('"abc', {}, /unterminated double/);
  rejects("a: 'abc\nb: 1", {}, /unterminated single/);
  rejects('a: "x\n---\n', {}, /unterminated/);
});

test('scalar resolution table (YAML 1.2 core schema)', () => {
  const cases = [
    ['~', null], ['null', null], ['Null', null], ['NULL', null], ['', null],
    ['true', true], ['True', true], ['TRUE', true], ['false', false], ['False', false], ['FALSE', false],
    ['on', 'on'], ['off', 'off'], ['yes', 'yes'], ['no', 'no'], ['y', 'y'], ['tRUE', 'tRUE'],
    ['0', 0], ['-12', -12], ['+7', 7], ['007', 7], ['0x1F', 31], ['0o17', 15], ['0b11', '0b11'],
    ['1.5', 1.5], ['-.5', -0.5], ['.5', 0.5], ['1.', 1], ['1e3', 1000], ['1.5E-2', 0.015], ['+1e+2', 100],
    ['.inf', Infinity], ['.Inf', Infinity], ['.INF', Infinity], ['-.inf', -Infinity], ['+.inf', Infinity],
    ['1_000', '1_000'], ['0x', '0x'], ['--1', '--1'], ['1.2.3', '1.2.3'], ['Infinity', 'Infinity'],
    ['12:30', '12:30'], ['2001-01-01', '2001-01-01'], ['.', '.'],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(parseYAML(`k: ${text}\n`).k, expected, `plain ${JSON.stringify(text)}`);
  }
  assert.ok(Number.isNaN(parseYAML('.nan')));
  assert.ok(Number.isNaN(parseYAML('.NaN')));
  assert.ok(Number.isNaN(parseYAML('.NAN')));
  assert.equal(Object.is(parseYAML('-0'), -0), true);
  // Quoting always yields strings.
  assert.deepEqual(parseYAML('["1", "true", \'null\', "~"]'), ['1', 'true', 'null', '~']);
});

test('the GitHub Actions `on` key stays a string', () => {
  const v = parseYAML('on:\n  push:\nyes: 1\nno: 2\n');
  assert.deepEqual(Object.keys(v), ['on', 'yes', 'no']);
});

test('keys: plain, quoted, numeric, boolean', () => {
  const v = parseYAML('"quoted key": 1\n\'single\': 2\n3: three\ntrue: t\n~: n\n"a:b": c\n');
  assert.deepEqual(v, { 'quoted key': 1, single: 2, 3: 'three', true: 't', '~': 'n', 'a:b': 'c' });
});

test('standard tags', () => {
  const v = parseYAML('a: !!str 123\nb: !!int "42"\nc: !!float 1\nd: !!bool true\ne: !!null ""\nf: !!map {x: 1}\ng: !!seq [1]\nh: !!str\n');
  assert.deepEqual(v, { a: '123', b: 42, c: 1, d: true, e: null, f: { x: 1 }, g: [1], h: '' });
  rejects('a: !!int abc', {}, /not valid/);
  rejects('a: !!bool maybe', {}, /not valid/);
  rejects('a: !!map [1]', {}, /does not match/);
  rejects('a: !!seq x', {}, /scalar/);
});

test('block scalar chomping matrix', () => {
  const body = '  a\n  b\n\n';
  const tail = 'next: 1\n';
  const lit = (h) => parseYAML(`k: ${h}\n${body}${tail}`).k;
  assert.equal(lit('|'), 'a\nb\n');
  assert.equal(lit('|-'), 'a\nb');
  assert.equal(lit('|+'), 'a\nb\n\n');
  assert.equal(lit('>'), 'a b\n');
  assert.equal(lit('>-'), 'a b');
  assert.equal(lit('>+'), 'a b\n\n');
  // Final line break at EOF.
  assert.equal(parseYAML('k: |\n  x').k, 'x\n');
  assert.equal(parseYAML('k: |+\n  x\n\n\n').k, 'x\n\n\n');
  assert.equal(parseYAML('k: |-\n  x\n\n\n').k, 'x');
  // Empty bodies.
  assert.equal(parseYAML('k: |\nn: 1').k, '');
  assert.equal(parseYAML('k: |+\n\nn: 1').k, '\n');
});

test('block scalars: indentation indicators, folding and nesting', () => {
  assert.equal(parseYAML('k: |2\n   lead\n  x\n').k, ' lead\nx\n');
  assert.equal(parseYAML('k: |1-\n  two\n').k, ' two');
  assert.equal(parseYAML('k: >\n  one\n  two\n\n  three\n   more\n  back\n').k, 'one two\nthree\n more\nback\n');
  assert.deepEqual(parseYAML('- |\n  a\n- >-\n  b\n  c\n- d'), ['a\n', 'b c', 'd']);
  assert.equal(parseYAML('k: | # comment\n  text\n').k, 'text\n');
  assert.equal(parseYAML('--- |\ntop\nlevel\n'), 'top\nlevel\n');
  assert.equal(parseYAML('k: |\n  # not a comment\n  tab\there\n').k, '# not a comment\ntab\there\n');
  assert.deepEqual(parseYAML('a:\n  b: |\n    x\n  c: 1'), { a: { b: 'x\n', c: 1 } });
  rejects('k: |x\n  a', {}, /block scalar header/);
});

test('documents: markers, directives, multi mode', () => {
  const stream = '%YAML 1.2\n%TAG !e! tag:example.com,2000:\n---\na: 1\n...\n---\nb: 2\n---\n- c\n';
  assert.deepEqual(parseYAML(stream, { multi: true }), [{ a: 1 }, { b: 2 }, ['c']]);
  assert.deepEqual(parseYAML('--- text\n...\n', { multi: true }), ['text']);
  assert.deepEqual(parseYAML('--- ~\n---\n', { multi: true }), [null]);
  assert.deepEqual(parseYAML('---\n---\na: 1\n', { multi: true }), [{ a: 1 }]);
  assert.deepEqual(parseYAML('---\na: 1\n'), { a: 1 });
  assert.equal(parseYAML('--- >\n folded\n text\n'), 'folded text\n');
  rejects('a: 1\n---\nb: 2\n', {}, /several/);
  rejects('%YAML 1.2\na: 1\n', {}, /---/);
});

test('Kubernetes multi-document manifest', () => {
  const docs = parseYAML(fixture('k8s-multidoc.yaml'), { multi: true });
  assert.equal(docs.length, 2);
  assert.equal(docs[0].kind, 'Deployment');
  assert.equal(docs[0].spec.replicas, 3);
  const c = docs[0].spec.template.spec.containers[0];
  assert.equal(c.image, 'nginx:1.25');
  assert.deepEqual(c.env, [{ name: 'MODE', value: 'on' }, { name: 'DEBUG', value: 'false' }]);
  assert.deepEqual(c.resources.limits, { cpu: '500m', memory: '128Mi' });
  assert.equal(docs[1].kind, 'Service');
  assert.deepEqual(docs[1].spec.ports, [{ port: 80, targetPort: 80 }]);
});

test('GitHub Actions workflow', () => {
  const wf = parseYAML(fixture('github-actions.yml'));
  assert.deepEqual(Object.keys(wf), ['name', 'on', 'env', 'jobs']);
  assert.deepEqual(wf.on.push.branches, ['main']);
  assert.deepEqual(wf.on.pull_request.branches, ['main', 'release/**']);
  const steps = wf.jobs.test.steps;
  assert.equal(steps[1].with['node-version'], '${{ matrix.node }}');
  assert.equal(steps[2].run, 'npm ci\nnpm test -- --coverage\n');
  assert.deepEqual(steps[2].env, { CI: true });
  assert.equal(steps[3].run, 'echo one two');
  assert.deepEqual(wf.jobs.test.strategy.matrix.node, [20, 22]);
});

test('docker-compose file', () => {
  const c = parseYAML(fixture('docker-compose.yml'));
  assert.equal(c.version, '3.9');
  assert.deepEqual(c.services.db.healthcheck.test, ['CMD-SHELL', 'pg_isready -U postgres']);
  assert.deepEqual(c.services.web.ports, ['8080:80']);
  assert.deepEqual(c.services.web.command, ['npm', 'start']);
  assert.deepEqual(c.volumes, { 'db-data': {} });
});

test('Helm values with anchors and merge keys', () => {
  const v = parseYAML(fixture('helm-values.yaml'));
  assert.equal(v.web.replicas, 2);
  assert.deepEqual(v.web.image, { repository: 'example/app', tag: '1.0.0' });
  // Explicit keys win over merged ones (shallow merge, like YAML says).
  assert.deepEqual(v.worker.image, { repository: 'example/worker' });
  assert.equal(v.worker.replicas, 5);
  assert.deepEqual(v.worker.resources, v.defaults.resources);
  assert.deepEqual(v.sidecar.resources, { limits: { cpu: '100m', memory: '64Mi' } });
  // Aliases are copies, not shared references.
  v.web.image.tag = 'changed';
  assert.equal(v.defaults.image.tag, '1.0.0');
});

test('merge key precedence and validation', () => {
  const v = parseYAML('a: &a {x: 1, y: 1}\nb: &b {y: 2, z: 2}\nc:\n  <<: [*a, *b]\n  w: 0\n  x: 9\n');
  assert.deepEqual(v.c, { w: 0, x: 9, y: 1, z: 2 });
  assert.deepEqual(parseYAML('a: &a {x: 1}\nb: {<<: *a, y: 2}'), { a: { x: 1 }, b: { y: 2, x: 1 } });
  assert.deepEqual(parseYAML('"<<": 1'), { '<<': 1 });
  rejects('a: &a [1]\nb:\n  <<: *a\n', {}, /merge key/);
  rejects('b:\n  <<: 5\n', {}, /merge key/);
});

test('GitLab CI with anchors', () => {
  const ci = parseYAML(fixture('gitlab-ci.yml'));
  assert.deepEqual(ci.stages, ['build', 'test']);
  assert.equal(ci.build.image, 'node:22');
  assert.deepEqual(ci.build.before_script, ['npm ci']);
  assert.deepEqual(ci.test.script, ['npm test']);
  assert.equal(ci.test.stage, 'test');
  assert.deepEqual(ci.test.only, ['main', '/^release\\/.*$/']);
  assert.deepEqual(ci.build.artifacts.paths, ['dist/']);
});

test('OpenAPI excerpt with flow maps', () => {
  const api = parseYAML(fixture('openapi.yaml'));
  assert.equal(api.openapi, '3.0.3');
  assert.deepEqual(api.info, { title: 'Pets', version: '1.0' });
  const get = api.paths['/pets/{id}'].get;
  assert.deepEqual(get.parameters[0], { name: 'id', in: 'path', required: true, schema: { type: 'string' } });
  assert.deepEqual(get.responses['200'].content['application/json'].schema, { $ref: '#/components/schemas/Pet' });
  assert.deepEqual(api.components.schemas.Pet.required, ['id', 'name']);
  assert.equal(api.components.schemas.Pet.properties.name.example, 'Rex: the dog');
});

test('CloudFormation short tags', () => {
  const t = parseYAML(fixture('cloudformation.yaml'), { tags: 'cloudformation' });
  assert.deepEqual(t.Conditions.IsProd, { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] });
  assert.deepEqual(t.Resources.Bucket.Properties.BucketName, { 'Fn::Sub': '${AWS::StackName}-${Env}' });
  assert.deepEqual(t.Resources.Topic.Properties.TopicName, {
    'Fn::Join': ['-', [{ Ref: 'Env' }, { 'Fn::Sub': '${AWS::Region}-topic' }, { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] }]],
  });
  assert.deepEqual(t.Outputs.BucketArn.Value, { 'Fn::GetAtt': ['Bucket', 'Arn'] });
  assert.deepEqual(t.Outputs.BucketDomain.Value, { 'Fn::GetAtt': ['Bucket', 'DomainName'] });
  assert.deepEqual(t.Outputs.Copy.Value, { 'Fn::If': ['IsProd', { Ref: 'Bucket' }, { Ref: 'AWS::NoValue' }] });
});

test('CloudFormation tags: every function, mappings and Condition', () => {
  const opts = { tags: 'cloudformation' };
  assert.deepEqual(parseYAML('a: !Condition IsProd', opts), { a: { Condition: 'IsProd' } });
  assert.deepEqual(parseYAML('a: !Sub\n  - "${X}"\n  - {X: !Ref Y}\n', opts), {
    a: { 'Fn::Sub': ['${X}', { X: { Ref: 'Y' } }] },
  });
  assert.deepEqual(parseYAML('a: !GetAtt A.B.C', opts), { a: { 'Fn::GetAtt': ['A', 'B.C'] } });
  const names = ['Sub', 'Join', 'Select', 'If', 'Equals', 'Not', 'And', 'Or', 'FindInMap', 'Base64',
    'Cidr', 'ImportValue', 'Split', 'GetAZs', 'Transform'];
  for (const n of names) {
    assert.deepEqual(parseYAML(`x: !${n} v`, opts), { x: { [`Fn::${n}`]: 'v' } }, n);
  }
  assert.deepEqual(parseYAML('x: !Base64 {k: v}', opts), { x: { 'Fn::Base64': { k: 'v' } } });
  assert.deepEqual(parseYAML('x: !And [!Equals [a, b], !Not [!Condition C]]', opts), {
    x: { 'Fn::And': [{ 'Fn::Equals': ['a', 'b'] }, { 'Fn::Not': [{ Condition: 'C' }] }] },
  });
  rejects('x: !Bogus 1', opts, /unknown tag/);
  rejects('x: !!set {}', opts, /unknown tag/);
});

test('tags preserve mode', () => {
  const opts = { tags: 'preserve' };
  assert.deepEqual(parseYAML('a: !vault abc', opts), { a: { __tag: '!vault', value: 'abc' } });
  assert.deepEqual(parseYAML('a: !x [1, 2]\nb: !y\n  k: v', opts), {
    a: { __tag: '!x', value: [1, 2] },
    b: { __tag: '!y', value: { k: 'v' } },
  });
  assert.deepEqual(parseYAML('a: !t 5', opts), { a: { __tag: '!t', value: 5 } });
  assert.deepEqual(parseYAML('a: !!str 5', opts), { a: '5' });
});

test('anchors and aliases', () => {
  assert.deepEqual(parseYAML('- &a [1, 2]\n- *a\n- &s str\n- *s'), [[1, 2], [1, 2], 'str', 'str']);
  assert.deepEqual(parseYAML('&m\nk: v\n'), { k: 'v' });
  assert.deepEqual(parseYAML('a: &x !!str 5\nb: *x'), { a: '5', b: '5' });
  assert.deepEqual(parseYAML('&k key: v\nother: *k'), { key: 'v', other: 'key' });
  assert.deepEqual(parseYAML('a: &e\nb: *e'), { a: null, b: null });
});

test('rejects tabs used for indentation', () => {
  const e = rejects('a:\n\tb: 1\n', {}, /tab/);
  assert.equal(e.line, 2);
  rejects('a:\n  b: 1\n \tc: 2\n', {}, /tab/);
  rejects('\ta: 1\n', {}, /tab/);
  // Tabs as separation are fine.
  assert.deepEqual(parseYAML('a:\t1\nb: [1,\t2]\n'), { a: 1, b: [1, 2] });
});

test('rejects duplicate keys, even across quoting', () => {
  rejects('a: 1\na: 2', {}, /duplicate key/);
  rejects('a: 1\n"a": 2', {}, /duplicate key/);
  rejects('{a: 1, a: 2}', {}, /duplicate key/);
  rejects('x:\n  a: 1\n  b: 2\n  a: 3', {}, /duplicate key "a"/);
  assert.deepEqual(parseYAML('x: {a: 1}\ny: {a: 2}'), { x: { a: 1 }, y: { a: 2 } });
});

test('rejects complex keys', () => {
  rejects('? a\n: b\n', {}, /complex/);
  rejects('{? a : b}', {}, /complex/);
  rejects('[a]: b', {}, /complex|key/);
  rejects('a: 1\n? b\n: 2', {}, /complex/);
});

test('rejects unknown tags by default', () => {
  rejects('a: !Ref x', {}, /unknown tag !Ref/);
  rejects('a: !custom\n  k: v', { tags: 'none' }, /unknown tag/);
  rejects('a: !!binary aGk=', {}, /unknown tag/);
});

test('rejects excessive depth', () => {
  assert.equal(parseYAML(`${'['.repeat(64)}${']'.repeat(64)}`).length, 1);
  rejects(`${'['.repeat(65)}${']'.repeat(65)}`, {}, /nesting/);
  let block = '';
  for (let i = 0; i < 70; i++) block += `${' '.repeat(i * 2)}k${i}:\n`;
  rejects(block, {}, /nesting/);
  assert.ok(parseYAML(block, { maxDepth: 100 }));
  rejects('- - - - x', { maxDepth: 3 }, /nesting/);
  rejects('['.repeat(5000), { maxDepth: 100000 });
});

test('rejects too many nodes', () => {
  const big = `[${Array.from({ length: 1000 }, (_, i) => i).join(',')}]`;
  assert.equal(parseYAML(big).length, 1000);
  rejects(big, { maxNodes: 500 }, /node limit/);
  rejects('a: 1\nb: 2\nc: 3', { maxNodes: 4 }, /node limit/);
});

test('rejects undefined aliases and forward references', () => {
  rejects('a: *missing', {}, /undefined alias/);
  rejects('a: *b\nb: &b 1', {}, /undefined alias/);
  rejects('a: &a [*a]', {}, /undefined alias/);
  rejects('a: &x 1\n---\nb: *x', { multi: true }, /undefined alias/);
});

test('alias expansion budget and billion laughs', () => {
  const levels = ['a: &a0 [x, x, x, x, x, x, x, x, x, x]'];
  for (let i = 1; i < 10; i++) levels.push(`b${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
  const bomb = `${levels.join('\n')}\n`;
  const t0 = performance.now();
  rejects(bomb, {}, /alias expansion/);
  assert.ok(performance.now() - t0 < 100, 'bomb must be rejected quickly');
  const flatBomb = `base: &b [${Array(100).fill('0').join(',')}]\n${Array.from({ length: 200 }, (_, i) => `k${i}: *b`).join('\n')}\n`;
  rejects(flatBomb, {}, /alias expansion/);
  assert.equal(Object.keys(parseYAML(flatBomb, { maxAliasExpansion: 100000 })).length, 201);
  assert.deepEqual(parseYAML('a: &a [1,2]\nb: *a', { maxAliasExpansion: 10 }), { a: [1, 2], b: [1, 2] });
  rejects('a: &a [1,2]\nb: *a\nc: *a', { maxAliasExpansion: 5 }, /alias expansion/);
});

test('rejects inconsistent indentation', () => {
  rejects('a:\n    b: 1\n  c: 2\n', {}, /indentation/);
  rejects('a: 1\n  b: 2\n', {}, /mapping key/);
  rejects('k:\n    a: 1\n   b: 2', {}, /./);
  rejects('a: 1\n- b', {}, /sequence|unexpected/);
  rejects('a: b: c', {}, /nested mapping/);
  rejects('a: - b', {}, /sequence/);
  rejects('a: 1 b: 2', {}, /./);
});

test('rejects unterminated flow collections and stray indicators', () => {
  rejects('[1, 2', {}, /unterminated flow sequence/);
  rejects('{a: 1', {}, /unterminated flow mapping/);
  rejects('a: [1,\n  2\nb: 3', {}, /./);
  rejects('[1, 2}', {}, /expected/);
  rejects('{a: 1]', {}, /expected/);
  rejects('[,]', {}, /unexpected/);
  rejects('a: [1, 2]\n]', {}, /./);
  rejects('a: @x', {}, /reserved/);
  rejects('a: `x', {}, /reserved/);
  rejects('a: "x"y', {}, /unexpected content/);
  rejects('a: *', {}, /alias name/);
  rejects('a: &', {}, /anchor name/);
  rejects('a: &x &y 1', {}, /one anchor/);
  rejects('a: !!str !!int 1', {}, /one tag/);
});

test('stringify: deterministic block style', () => {
  const out = stringifyYAML({ b: 1, a: [1, { c: [], d: {} }, [2, [3]], 'x'], e: { f: { g: null } }, h: true });
  assert.equal(out, [
    'b: 1',
    'a:',
    '  - 1',
    '  - c: []',
    '    d: {}',
    '  - - 2',
    '    - - 3',
    '  - x',
    'e:',
    '  f:',
    '    g: null',
    'h: true',
    '',
  ].join('\n'));
  assert.equal(stringifyYAML([]), '[]\n');
  assert.equal(stringifyYAML({}), '{}\n');
  assert.equal(stringifyYAML('plain'), 'plain\n');
  assert.equal(stringifyYAML(null), 'null\n');
  assert.equal(stringifyYAML([{ a: 1, b: { c: 2 } }]), '- a: 1\n  b:\n    c: 2\n');
  assert.equal(stringifyYAML({ x: undefined, z: 1 }), 'z: 1\n');
});

test('stringify: quoting rules', () => {
  const quoted = ['', 'null', 'Null', '~', 'true', 'False', '12', '1.5', '-3', '0x1F', '1e3', '.inf', '.nan', ' lead',
    'trail ', 'a: b', 'a #b', '{x}', '[x]', 'a,b', '&a', '*a', '!t', '|', '>x', "it's", 'say "hi"', '100%', '@h',
    '`c', 'line\nbreak', 'tab\there', '-dash', '?q', '---', '...', 'yes', 'on', 'No', '<<', 'nul\u0000l'];
  for (const s of quoted) {
    const out = stringifyYAML({ k: s });
    assert.ok(out.startsWith('k: "'), `expected quoting for ${JSON.stringify(s)} got ${out}`);
    assert.deepEqual(parseYAML(out), { k: s });
  }
  for (const s of ['plain', 'a b', 'path/to/file', 'snake_case', 'v1.2.3', 'x-y', 'caf\u00e9', '\u65e5\u672c']) {
    assert.equal(stringifyYAML({ k: s }), `k: ${s}\n`);
  }
  assert.equal(stringifyYAML({ 'a b': 1, 'c:d': 2, '': 3, on: 4 }), 'a b: 1\n"c:d": 2\n"": 3\n"on": 4\n');
  assert.equal(stringifyYAML(['a\nb']), '- "a\\nb"\n');
  const odd = `x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x85)}${String.fromCharCode(0xfeff)}`;
  assert.deepEqual(parseYAML(stringifyYAML({ k: odd })), { k: odd });
  assert.doesNotMatch(stringifyYAML({ k: odd }), /[\u2028\u0085\ufeff]/);
  assert.deepEqual(parseYAML(stringifyYAML({ k: '\ud800' })), { k: '\ud800' });
});

test('stringify: numbers and unsupported values', () => {
  assert.equal(stringifyYAML([1, -2.5, 1e21, 1e-7, 0]), '- 1\n- -2.5\n- 1e+21\n- 1e-7\n- 0\n');
  assert.equal(stringifyYAML([Infinity, -Infinity]), '- .inf\n- -.inf\n');
  assert.ok(Number.isNaN(parseYAML(stringifyYAML(NaN))));
  assert.deepEqual(parseYAML(stringifyYAML([1e21, 1e-7, 5e-324, Number.MAX_SAFE_INTEGER])), [1e21, 1e-7, 5e-324, 9007199254740991]);
  assert.throws(() => stringifyYAML(() => 1), TypeError);
  assert.throws(() => stringifyYAML(new Date()), TypeError);
  assert.throws(() => stringifyYAML(Symbol('s')), TypeError);
  const cyc = {};
  cyc.self = cyc;
  assert.throws(() => stringifyYAML(cyc), /circular/);
});

test('round trip handles __proto__ as an ordinary key', () => {
  const v = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
  const back = parseYAML(stringifyYAML(v));
  assert.deepEqual(Object.keys(back), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
  assert.deepEqual(back, v);
  assert.equal(parseYAML('__proto__: {polluted: true}').polluted, undefined);
  assert.equal({}.polluted, undefined);
});

// Deterministic PRNG so failures are reproducible without any dependency.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'b', 'z', 'Q', '0', '1', '9', ' ', ' ', '-', '_', '.', ':', '#', '{', '}', '[', ']', ',', '&', '*',
  '!', '|', '>', "'", '"', '%', '@', '`', '?', '\n', '\t', '\\', '/', '\u00e9', '\u65e5', '\u{1F600}', '~', '='];
const WORDS = ['', 'null', 'true', 'false', 'yes', 'no', 'on', 'off', '~', '1', '-1', '1.5', '0x1f', '1e3', '.inf',
  '.nan', 'Null', 'TRUE', '<<', '---', '...', ' ', 'a: b', '- x', '# c', 'key', 'a b'];

function genString(rng) {
  if (rng() < 0.35) return WORDS[Math.floor(rng() * WORDS.length)];
  const n = Math.floor(rng() * 9);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return s;
}

function genNumber(rng) {
  const r = rng();
  if (r < 0.4) return Math.floor((rng() - 0.5) * 2000);
  if (r < 0.5) return Number.MAX_SAFE_INTEGER - Math.floor(rng() * 10);
  const v = (rng() - 0.5) * 10 ** Math.floor(rng() * 20 - 8);
  return v === 0 ? 0 : v;
}

function genValue(rng, depth) {
  const r = rng();
  if (depth <= 0 || r < 0.45) {
    const k = rng();
    if (k < 0.1) return null;
    if (k < 0.2) return rng() < 0.5;
    if (k < 0.45) return genNumber(rng);
    return genString(rng);
  }
  const n = Math.floor(rng() * 5);
  if (r < 0.72) return Array.from({ length: n }, () => genValue(rng, depth - 1));
  const obj = {};
  for (let i = 0; i < n; i++) obj[genString(rng)] = genValue(rng, depth - 1);
  return obj;
}

test('round trip: parse(stringify(v)) deep-equals v for 300 seeded random values', () => {
  const rng = mulberry32(0xc0ffee);
  for (let i = 0; i < 300; i++) {
    const v = genValue(rng, 4);
    const text = stringifyYAML(v);
    let back;
    try {
      back = parseYAML(text);
    } catch (e) {
      assert.fail(`case ${i} failed to parse: ${e.message}\n${text}`);
    }
    assert.deepEqual(back, v, `case ${i}\n${text}`);
    assert.equal(stringifyYAML(back), text, `case ${i} is not stable`);
  }
});

test('round trip: top-level scalars and empties', () => {
  for (const v of [null, true, false, 0, -1.5, '', 'text', ' pad ', 'a\nb', [], {}, [[]], [{}], { a: [] }, { a: {} }, [[], {}, [[], {}]]]) {
    assert.deepEqual(parseYAML(stringifyYAML(v)), v, JSON.stringify(v));
  }
});
