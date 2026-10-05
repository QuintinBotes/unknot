// Fact production through the adapter surface, run once per parser: extract.py (python3)
// and the lexical fallback. The fact shape must be identical; only provenance differs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import adapter from '../../../../adapters/language/python/index.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import {
  all, edges, extractFixture, find, hasPython, loadFixture, nodes, realExec, unsupportedExec,
} from './helpers.mjs';

const MODES = [
  { name: 'python3', exec: realExec, quality: 'ast', source: 'ast', confidence: 'high' },
  { name: 'lexical', exec: unsupportedExec, quality: 'lexical', source: 'inference', confidence: 'low' },
];

for (const mode of MODES) {
  const skip = mode.name === 'python3' && !hasPython ? 'python3 not available' : false;

  test(`[${mode.name}] adapter descriptor and fact validity`, { skip }, async () => {
    assert.equal(adapter.id, 'python');
    assert.equal(adapter.version, '0.1.2');
    assert.equal(adapter.kind, 'language');
    assert.deepEqual(adapter.capabilities.executes, ['python3']);
    assert.equal(adapter.capabilities.network, false);
    assert.ok(adapter.capabilities.files.includes('**/requirements*.txt'));
    for (const fixture of ['flask_app', 'fastapi_service', 'django_project', 'pkg_src', 'misc']) {
      const facts = all(await extractFixture(fixture, mode.exec));
      assert.ok(facts.length > 0);
      for (const f of facts) {
        assertFact(f);
        assert.equal(f.provenance.extractor, 'python@0.1.0');
      }
      Graph.fromFacts(facts); // must merge cleanly
    }
  });

  test(`[${mode.name}] module and symbol facts carry metrics and provenance`, { skip }, async () => {
    const facts = all(await extractFixture('misc', mode.exec));
    const mod = find(facts, 'module:metrics.py');
    assert.equal(mod.attrs.language, 'python');
    assert.equal(mod.attrs.parse_quality, mode.quality);
    assert.equal(mod.attrs.is_test, false);
    assert.equal(mod.attrs.loc, 20);
    assert.equal(mod.attrs.sloc, 16);
    assert.equal(mod.provenance.source_type, mode.source);
    assert.equal(mod.provenance.confidence, mode.confidence);

    const branchy = find(facts, 'function:metrics.py#branchy');
    assert.equal(branchy.provenance.source_ref, 'metrics.py:5');
    assert.deepEqual(
      { s: branchy.attrs.start_line, e: branchy.attrs.end_line, l: branchy.attrs.lines, p: branchy.attrs.params },
      { s: 5, e: 13, l: 9, p: 2 },
    );
    assert.deepEqual(
      [branchy.attrs.cyclomatic, branchy.attrs.cognitive, branchy.attrs.max_nesting],
      [6, 9, 3],
    );
    assert.equal(branchy.attrs.exported, true);
    assert.equal(branchy.attrs.async, false);
    assert.equal(branchy.attrs.kind, 'function');
    assert.equal(branchy.attrs.parse_quality, mode.quality);
    const fetch = find(facts, 'function:metrics.py#fetch');
    assert.equal(fetch.attrs.async, true);
    assert.equal(fetch.attrs.returns, 'bytes');
    assert.ok(edges(facts, 'CONTAINS').some((e) => e.from === 'module:metrics.py' && e.to === branchy.id));
  });

  test(`[${mode.name}] methods, classes and exported flag`, { skip }, async () => {
    const facts = all(await extractFixture('flask_app', mode.exec));
    const cls = find(facts, 'class:models.py#User');
    assert.deepEqual(cls.attrs.bases, ['Base']);
    assert.equal(cls.attrs.methods, 1);
    const m = find(facts, 'method:models.py#User.find');
    assert.equal(m.attrs.kind, 'classmethod');
    assert.equal(m.attrs.class, 'User');
    assert.equal(m.attrs.params, 1); // cls is not counted
    assert.ok(edges(facts, 'CONTAINS').some((e) => e.from === cls.id && e.to === m.id));
    assert.equal(find(facts, 'class:models.py#_Registry').attrs.exported, false);
  });

  test(`[${mode.name}] module attrs: imports, env, sql, security`, { skip }, async () => {
    const facts = all(await extractFixture('flask_app', mode.exec));
    const app = find(facts, 'module:app.py');
    assert.deepEqual(app.attrs.env_reads, ['DATABASE_URL', 'SECRET_KEY']);
    assert.deepEqual(app.attrs.imports.map((i) => i.module), ['os', 'subprocess', 'flask', 'auth.routes', 'models']);
    assert.deepEqual(app.attrs.security_signals.map((s) => s.kind), ['shell_true']);
    assert.equal(app.attrs.security_signals[0].scope, 'deploy');
    const q = find(facts, 'module:queries.py');
    assert.deepEqual(q.attrs.sql.map((s) => s.line), [5, 6, 11]);
    assert.deepEqual(q.attrs.security_signals.map((s) => s.kind), ['sql_injection', 'yaml_unsafe_load']);
  });

  test(`[${mode.name}] Flask routes with blueprint prefixes`, { skip }, async () => {
    const facts = all(await extractFixture('flask_app', mode.exec));
    const ids = nodes(facts, 'endpoint').map((n) => n.id).sort();
    assert.deepEqual(ids, [
      'endpoint:DELETE /orders/:order_id', 'endpoint:GET /auth/me', 'endpoint:GET /health',
      'endpoint:GET /orders/:order_id', 'endpoint:POST /auth/login', 'endpoint:POST /deploy',
    ]);
    const ep = find(facts, 'endpoint:GET /auth/me');
    assert.equal(ep.attrs.framework, 'flask');
    assert.equal(ep.provenance.source_type, 'inference');
    assert.equal(ep.provenance.confidence, mode.quality === 'ast' ? 'medium' : 'low');
    assert.ok(edges(facts, 'EXPOSES').some((e) => e.from === 'function:auth/routes.py#me' && e.to === ep.id));
  });

  test(`[${mode.name}] SQLAlchemy models become tables owned by their module`, { skip }, async () => {
    const facts = all(await extractFixture('flask_app', mode.exec));
    const users = find(facts, 'table:users');
    assert.equal(users.attrs.orm, 'sqlalchemy');
    assert.deepEqual(users.attrs.columns, [
      { name: 'id', type: 'Integer', nullable: false, primary_key: true, foreign_key: null },
      { name: 'email', type: 'String(120)', nullable: false, primary_key: false, foreign_key: null },
      { name: 'nickname', type: 'String(40)', nullable: true, primary_key: false, foreign_key: null },
    ]);
    const orders = find(facts, 'table:orders');
    assert.deepEqual(orders.attrs.columns, [
      { name: 'id', type: 'int', nullable: false, primary_key: true, foreign_key: null },
      { name: 'user_id', type: 'int', nullable: false, primary_key: false, foreign_key: 'users.id' },
      { name: 'note', type: 'String(200)', nullable: true, primary_key: false, foreign_key: null },
    ]);
    assert.equal(users.provenance.source_type === 'ast' || mode.quality === 'lexical', true);
    assert.equal(users.provenance.confidence, mode.quality === 'ast' ? 'medium' : 'low');
    assert.ok(edges(facts, 'OWNS_DATA').some((e) => e.from === 'module:models.py' && e.to === 'table:users'));
  });

  test(`[${mode.name}] FastAPI routers, Celery tasks and Kafka producers`, { skip }, async () => {
    const facts = all(await extractFixture('fastapi_service', mode.exec));
    const ids = nodes(facts, 'endpoint').map((n) => n.id).sort();
    assert.deepEqual(ids, ['endpoint:DELETE /:user_id', 'endpoint:GET /', 'endpoint:GET /items/:item_id', 'endpoint:GET /ping', 'endpoint:POST /items']);
    assert.equal(find(facts, 'endpoint:GET /items/:item_id').attrs.framework, 'fastapi');
    const job = find(facts, 'job:routers.users.send_welcome');
    assert.equal(job.attrs.framework, 'celery');
    assert.equal(job.attrs.function, 'function:routers/users.py#send_welcome');
    assert.ok(find(facts, 'topic:item-events'));
    const pub = edges(facts, 'PUBLISHES')[0];
    assert.equal(pub.from, 'function:routers/items.py#create_item');
    assert.equal(pub.provenance.source_type, 'inference');
  });

  test(`[${mode.name}] Django urls and models`, { skip }, async () => {
    const facts = all(await extractFixture('django_project', mode.exec));
    assert.deepEqual(nodes(facts, 'endpoint').map((n) => n.id).sort(), [
      'endpoint:ANY /customers/:cid/', 'endpoint:ANY /products/', 'endpoint:ANY /products/:pk/',
    ]);
    assert.equal(find(facts, 'endpoint:ANY /products/').attrs.view, 'views.product_list');
    assert.equal(find(facts, 'endpoint:ANY /products/:pk/').attrs.view, 'views.ProductDetail');
    const customers = find(facts, 'table:shop_customers'); // Meta.db_table wins
    assert.equal(customers.attrs.orm, 'django');
    assert.deepEqual(customers.attrs.columns.map((c) => [c.name, c.type, c.nullable, c.primary_key]), [
      ['id', 'AutoField', false, true], ['name', 'CharField', false, false], ['email', 'EmailField', true, false],
    ]);
    const product = find(facts, 'table:shop_product'); // default <app>_<model>
    assert.deepEqual(product.attrs.columns.find((c) => c.name === 'owner_id').foreign_key, 'Customer');
    assert.equal(nodes(facts, 'table').length, 2);
  });

  test(`[${mode.name}] messaging: pika publish/consume and kafka consumers`, { skip }, async () => {
    const text = [
      'import pika',
      'from kafka import KafkaConsumer',
      'def handle(ch, method, props, body): pass',
      'def send(ch):',
      "    ch.basic_publish(exchange='', routing_key='jobs', body=b'x')",
      "    ch.basic_publish(exchange='events', routing_key='order.created', body=b'x')",
      'def listen(ch):',
      "    ch.basic_consume(queue='jobs', on_message_callback=handle)",
      "consumer = KafkaConsumer('audit', group_id='g')",
      "consumer.subscribe(['billing'])",
      '',
    ].join('\n');
    const m = await adapter.extractBatch([{ file: { path: 'mq.py' }, text }], { exec: mode.exec });
    const facts = m.get('mq.py');
    const pairs = edges(facts).filter((e) => ['PUBLISHES', 'SUBSCRIBES'].includes(e.type)).map((e) => `${e.type} ${e.from} ${e.to}`).sort();
    assert.deepEqual(pairs, [
      'PUBLISHES function:mq.py#send queue:jobs',
      'PUBLISHES function:mq.py#send topic:events',
      'SUBSCRIBES function:mq.py#handle queue:jobs',
      'SUBSCRIBES module:mq.py topic:audit',
      'SUBSCRIBES module:mq.py topic:billing',
    ]);
    assert.equal(edges(facts, 'PUBLISHES').find((e) => e.to === 'topic:events').attrs.routing_key, 'order.created');
  });

  test(`[${mode.name}] syntax errors yield a module fact and no guesses`, { skip }, async () => {
    const facts = all(await extractFixture('misc', mode.exec)).filter((f) => f.path === 'broken.py');
    const mod = find(facts, 'module:broken.py');
    assert.ok(mod);
    if (mode.quality === 'ast') {
      // python3 refused to parse it: one module fact recording why, nothing invented.
      assert.equal(facts.length, 1);
      assert.equal(mod.attrs.parse_quality, 'syntax_error');
      assert.equal(mod.attrs.syntax_error.line, 1);
      assert.match(mod.attrs.syntax_error.msg, /syntax/i);
    } else {
      // The lexical reader has no grammar, so it cannot know; its facts are low confidence.
      assert.equal(mod.attrs.parse_quality, 'lexical');
      assert.equal(mod.provenance.confidence, 'low');
    }
  });

  test(`[${mode.name}] prompt-injection comments are inert data`, { skip }, async () => {
    const facts = all(await extractFixture('misc', mode.exec)).filter((f) => f.path === 'injection.py');
    assert.deepEqual(facts.map((f) => f.id).sort(), ['function:injection.py#helper', 'module:injection.py']);
    assert.deepEqual(find(facts, 'module:injection.py').attrs.security_signals, []);
    assert.doesNotMatch(JSON.stringify(facts), /IGNORE ALL PREVIOUS|admin mode|id_rsa/);
  });

  test(`[${mode.name}] output is deterministic`, { skip }, async () => {
    const a = JSON.stringify(all(await extractFixture('flask_app', mode.exec)));
    const b = JSON.stringify(all(await extractFixture('flask_app', mode.exec)));
    assert.equal(a, b);
  });
}

test('python3 and lexical parsers agree on every fixture fact id and metric', { skip: !hasPython && 'python3 not available' }, async () => {
  for (const fixture of ['flask_app', 'fastapi_service', 'django_project', 'pkg_src', 'misc']) {
    const ast = all(await extractFixture(fixture, realExec)).filter((f) => ![f.id, f.from, f.to].some((x) => x?.includes('broken.py')));
    const lex = all(await extractFixture(fixture, unsupportedExec)).filter((f) => ![f.id, f.from, f.to].some((x) => x?.includes('broken.py')));
    const key = (f) => (f.kind === 'node' ? f.id : `${f.type}|${f.from}|${f.to}`);
    assert.deepEqual(ast.map(key).sort(), lex.map(key).sort(), fixture);
    const metrics = (facts) => facts.filter((f) => f.kind === 'node' && /^(function|method)$/.test(f.type))
      .map((f) => [f.id, f.attrs.cyclomatic, f.attrs.cognitive, f.attrs.max_nesting, f.attrs.params].join(':')).sort();
    assert.deepEqual(metrics(ast), metrics(lex), fixture);
  }
});

test('extractBatch falls back to lexical when exec is unsupported, fails, or returns junk', async () => {
  const items = [{ file: { path: 'a.py' }, text: 'def f():\n    return 1\n' }];
  const failing = [
    unsupportedExec,
    () => Promise.resolve({ exitCode: 3, stdout: '', stderr: 'boom' }),
    () => Promise.resolve({ exitCode: 0, stdout: 'not json\n', stderr: '' }),
    () => Promise.reject(new Error('timeout')),
    undefined,
  ];
  for (const exec of failing) {
    const facts = (await adapter.extractBatch(items, exec ? { exec } : {})).get('a.py');
    const f = find(facts, 'function:a.py#f');
    assert.equal(f.attrs.parse_quality, 'lexical');
    assert.equal(f.provenance.confidence, 'low');
  }
});

test('extractBatch invokes python3 without a shell and pipes a path/text array', async () => {
  let seen;
  const exec = (argv, opts) => {
    seen = { argv, opts };
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
  await adapter.extractBatch([{ file: { path: 'a.py' }, text: 'x = 1\n' }, { file: { path: 'requirements.txt' }, text: 'six\n' }], { exec });
  assert.deepEqual(seen.argv.slice(0, 3), ['python3', '-I', '-S']);
  assert.match(seen.argv[3], /adapters\/language\/python\/extract\.py$/);
  assert.ok(seen.argv[3].startsWith('/'));
  assert.deepEqual(JSON.parse(seen.opts.input), [{ path: 'a.py', text: 'x = 1\n' }]);
  assert.ok(seen.opts.timeoutMs > 0);
});

test('a file python3 omits from its output is recovered lexically, others stay ast', async () => {
  const exec = () => Promise.resolve({
    exitCode: 0,
    stdout: `${JSON.stringify({ path: 'a.py', loc: 1, sloc: 1, functions: [], classes: [], imports: [], calls: [], calls_detail: [], sql: [], env: [], security: [] })}\n`,
    stderr: '',
  });
  const items = [{ file: { path: 'a.py' }, text: 'x = 1\n' }, { file: { path: 'b.py' }, text: 'def g(): pass\n' }];
  const m = await adapter.extractBatch(items, { exec });
  assert.equal(find(m.get('a.py'), 'module:a.py').attrs.parse_quality, 'ast');
  assert.equal(find(m.get('b.py'), 'module:b.py').attrs.parse_quality, 'lexical');
});

test('sync extract is the lexical path and ignores non-python files', () => {
  const facts = adapter.extract({ path: 'x.py' }, 'def f(a):\n    if a:\n        return 1\n', {});
  assert.equal(find(facts, 'function:x.py#f').attrs.cyclomatic, 2);
  assert.equal(find(facts, 'module:x.py').attrs.parse_quality, 'lexical');
  assert.deepEqual(adapter.extract({ path: 'notes.md' }, '# hi', {}), []);
});

test('facts per file are capped and say so', async () => {
  const text = Array.from({ length: 2600 }, (_, i) => `def f${i}(): pass`).join('\n');
  const facts = adapter.extract({ path: 'huge.py' }, text, {});
  assert.equal(facts.length, 5000);
  assert.deepEqual(find(facts, 'module:huge.py').attrs.truncated, { dropped: 201, cap: 5000 });
});

test('test-file detection', async () => {
  const names = ['test_a.py', 'a_test.py', 'conftest.py', 'tests/helper.py', 'pkg/tests/x.py', 'src/attest.py', 'contest.py'];
  const m = await adapter.extractBatch(names.map((path) => ({ file: { path }, text: 'x = 1\n' })), { exec: unsupportedExec });
  const flags = Object.fromEntries(names.map((n) => [n, find(m.get(n), `module:${n}`).attrs.is_test]));
  assert.deepEqual(flags, {
    'test_a.py': true, 'a_test.py': true, 'conftest.py': true, 'tests/helper.py': true, 'pkg/tests/x.py': true,
    'src/attest.py': false, 'contest.py': false,
  });
  assert.ok(loadFixture('pkg_src').length > 0);
});

test('required parameters exclude optional keyword-only ones and self (dogfood FB14)', { skip: !process.env.PATH }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../../../../adapters/language/python/extract.py', import.meta.url));
  const src = [
    'class S:',
    '    def __init__(self, *, session, audit=None, clock=None, reader=None):',
    '        pass',
    'def h(a, b, c=1, *, d, e=None):',
    '    pass',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-S', script], { input: JSON.stringify([{ path: 'm.py', text: src }]), encoding: 'utf8' });
  if (r.error) return; // python3 missing: covered by the lexical path elsewhere
  const out = JSON.parse(r.stdout.trim().split('\n')[0]);
  const fns = Object.fromEntries(out.functions.map((f) => [f.name, f]));
  assert.equal(fns.__init__.params_required, 1, 'only `session` is required');
  assert.equal(fns.h.params_required, 3, 'a, b and keyword-only d');
});
