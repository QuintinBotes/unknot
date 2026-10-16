import assert from 'node:assert/strict';
import { test } from 'node:test';
import adapter from '../../../../adapters/contracts/index.mjs';
import literals from '../../../../adapters/literals/index.mjs';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { Graph } from '../../../../runtime/graph/graph.mjs';
import { MESSAGING_SYNTAX } from '../../../../adapters/language/messaging-ops.mjs';
import { contractEvidence } from '../../../../runtime/decompose/contracts.mjs';
import { boundaryMetrics } from '../../../../runtime/decompose/candidates.mjs';
import { buildWorkspaceGraph } from '../../../../runtime/enterprise/workspace.mjs';

function project(files, constants = true) {
  const factsByFile = new Map();
  for (const [path, text] of Object.entries(files)) {
    const file = { path, kind: 'source' };
    factsByFile.set(path, [...adapter.extract(file, text), ...(constants ? literals.extract(file, text) : [])]);
  }
  const linked = adapter.link({ factsByFile });
  const facts = [...factsByFile.values()].flat().concat(linked);
  facts.forEach(assertFact);
  return Graph.fromFacts(facts);
}

const rows = [
  ['producer', 'orders.java', 'topic', 'PUBLISHES', (c) => `kafkaTemplate.send(${c}, data)`],
  ['producer', 'orders.py', 'topic', 'PUBLISHES', (c) => `KafkaProducer().send(${c}, data)`],
  ['producer', 'orders.py', 'topic', 'PUBLISHES', (c) => `producer.send(${c}, data)`],
  ['producer', 'orders.js', 'topic', 'PUBLISHES', (c) => `producer.send({ topic: ${c}, messages: [] })`],
  ['producer', 'orders.cs', 'topic', 'PUBLISHES', (c) => `producer.Produce(${c}, data)`],
  ['producer', 'orders.cs', 'topic', 'PUBLISHES', (c) => `producer.ProduceAsync(${c}, data)`],
  ['consumer', 'orders.cs', 'topic', 'CONSUMES', (c) => `consumer.Subscribe(${c})`],
  ['consumer', 'orders.py', 'topic', 'CONSUMES', (c) => `KafkaConsumer(${c})`],
  ['consumer', 'orders.js', 'topic', 'CONSUMES', (c) => `consumer.subscribe({ topic: ${c} })`],
  ['consumer', 'orders.js', 'topic', 'CONSUMES', (c) => `consumer.subscribe({ topics: [${c}] })`],
  ['consumer', 'orders.py', 'topic', 'CONSUMES', (c) => `consumer.subscribe(${c})`],
  ['handler', 'orders.java', 'topic', 'CONSUMES', (c) => `@KafkaListener(topics = ${c})`],
  ['handler', 'orders.kt', 'topic', 'CONSUMES', (c) => `@KafkaListener(topics = [${c}])`],
  ['amqp', 'orders.py', 'exchange', 'PUBLISHES', (c) => `channel.basic_publish(exchange=${c}, routing_key="orders.created", body=data)`],
  ['amqp', 'orders.py', 'queue', 'PUBLISHES', (c) => `channel.basic_publish(exchange="", routing_key=${c}, body=data)`],
  ['amqp', 'orders.js', 'exchange', 'PUBLISHES', (c) => `channel.publish(${c}, "orders.created", data)`],
  ['amqp', 'orders.js', 'queue', 'PUBLISHES', (c) => `channel.sendToQueue(${c}, data)`],
  ['amqp', 'orders.py', 'queue', 'CONSUMES', (c) => `channel.basic_consume(queue=${c}, on_message_callback=handler)`],
  ['amqp', 'orders.js', 'queue', 'CONSUMES', (c) => `channel.consume(${c}, handler)`],
  ['handler', 'orders.java', 'queue', 'CONSUMES', (c) => `@RabbitListener(queues=${c})`],
  ['cloud', 'orders.js', 'queue', 'PUBLISHES', (c) => `queue.sendMessage({ QueueUrl: ${c}, MessageBody: data })`],
  ['cloud', 'orders.cs', 'queue', 'PUBLISHES', (c) => `queue.SendMessage(QueueUrl: ${c})`],
  ['cloud', 'orders.js', 'queue', 'CONSUMES', (c) => `queue.receiveMessage({ QueueUrl: ${c} })`],
  ['cloud', 'orders.cs', 'queue', 'CONSUMES', (c) => `queue.ReceiveMessage(QueueUrl: ${c})`],
  ['cloud', 'orders.cs', 'queue', 'PUBLISHES', (c) => `bus.CreateSender(${c})`],
  ['cloud', 'orders.cs', 'queue', 'CONSUMES', (c) => `bus.CreateReceiver(${c})`],
  ['cloud', 'orders.cs', 'queue', 'CONSUMES', (c) => `bus.CreateProcessor(${c})`],
  ['cloud', 'orders.js', 'topic', 'PUBLISHES', (c) => `bus.topic(${c}).publish(data)`],
  ['cloud', 'orders.js', 'topic', 'PUBLISHES', (c) => `bus.topic(${c}).publishMessage(data)`],
  ['nats', 'orders.js', 'subject', 'PUBLISHES', (c) => `publish(${c}, data)`],
  ['nats', 'orders.js', 'subject', 'PUBLISHES', (c) => `nc.publish(${c}, data)`],
  ['nats', 'orders.go', 'subject', 'PUBLISHES', (c) => `nc.Publish(${c}, data)`],
  ['nats', 'orders.js', 'subject', 'CONSUMES', (c) => `subscribe(${c})`],
  ['nats', 'orders.js', 'subject', 'CONSUMES', (c) => `nc.subscribe(${c})`],
  ['nats', 'orders.go', 'subject', 'CONSUMES', (c) => `nc.Subscribe(${c}, handler)`],
  ['handler', 'orders.ts', 'topic', 'CONSUMES', (c) => `@MessagePattern(${c})`],
  ['handler', 'orders.ts', 'topic', 'CONSUMES', (c) => `@EventPattern(${c})`],
  ['handler', 'orders.cs', 'queue', 'CONSUMES', (c) => `[QueueTrigger(${c})]`],
  ['handler', 'orders.cs', 'queue', 'CONSUMES', (c) => `[ServiceBusTrigger(${c})]`],
];

for (const family of [...new Set(MESSAGING_SYNTAX.map((r) => r.family))]) {
  test(`messaging ${family}: each spelling retains literal and unresolved channel evidence`, () => {
    for (const [group, path, kind, direction, code] of rows.filter((r) => r[0] === family)) {
      for (const [arg, unresolved] of [['"orders.created"', false], ['channelName', true]]) {
        const facts = adapter.extract({ path, kind: 'source' }, code(arg));
        facts.forEach(assertFact);
        const channels = facts.filter((f) => f.attrs?.kind === 'messaging_channel');
        assert.equal(channels.length, 1, `${path}: ${code(arg)}`);
        assert.equal(channels[0].attrs.channel_type, kind, code(arg));
        assert.equal(!!channels[0].attrs.channel_unresolved, unresolved, code(arg));
        if (!unresolved) assert.equal(channels[0].id, `contract:${kind} orders.created`);
        assert.ok(facts.some((f) => f.type === direction && f.from === `module:${path}` && f.to === channels[0].id), code(arg));
        assert.equal(channels[0].provenance.extractor, 'contracts@0.1.1');
      }
    }
  });
}

test('channel names use constant facts, prefer local definitions and leave ambiguity unresolved', () => {
  const files = { 'orders.js': 'const OrdersTopic = "orders.created"; producer.send({ topic: OrdersTopic });',
    'ledger.js': 'consumer.subscribe({ topic: OrdersTopic });' };
  const g = project(files);
  assert.ok(g.out('module:ledger.js', 'CONSUMES').some((e) => e.to === 'contract:topic orders.created'));
  assert.equal(g.nodes('contract').length, 1);
  assert.equal(g.node('module:orders.js').attrs.messaging_candidates, undefined);
  const ambiguous = project({ ...files, 'invoices.js': 'const OrdersTopic = "invoices.created";' });
  assert.ok(ambiguous.out('module:ledger.js', 'CONSUMES').some((e) => ambiguous.node(e.to).attrs.channel_unresolved));
  assert.ok(ambiguous.out('module:orders.js', 'PUBLISHES').some((e) => e.to === 'contract:topic orders.created'));
  const absent = project(files, false);
  assert.ok(absent.nodes('contract').every((n) => n.attrs.channel_unresolved));
});

test('arrays, comments, strings, dynamic expressions and unrelated method names', () => {
  const g = project({ 'orders.js': `
    // producer.send({ topic: 'invoices.created' });
    const example = "nc.publish('invoices.created', data)";
    consumer.subscribe({ topics: ['orders.created', 'ledger.updated'] });
    producer.send({ topic: 'orders.' + eventName });
    ledger.consume('retries'); ledger.publish('notes');
  ` });
  assert.equal(g.nodes('contract').length, 3);
  assert.equal(g.nodes('contract').filter((n) => n.attrs.channel_unresolved).length, 1);
  assert.equal(g.out('module:orders.js', 'CONSUMES').length, 2);
});

test('messaging contracts reach decompose with distinct consumers per channel', () => {
  const g = project({ 'orders.js': 'producer.send({ topic: "orders.created" })',
    'ledger.js': 'consumer.subscribe({ topic: "orders.created" }); consumer.subscribe({ topic: "orders.created" });',
    'invoices.js': 'consumer.subscribe({ topic: "orders.created" })' });
  const scope = new Set(['module:orders.js']);
  const evidence = contractEvidence(g, scope);
  assert.equal(evidence.present, true);
  assert.equal(evidence.clients, 2);
  assert.equal(evidence.routes[0].consumers, 2);
  const result = boundaryMetrics(g, scope, { tableOwners: new Map(), sccs: [], candidateOf: () => null, self: 0 });
  assert.equal(result.metrics['contracts.present'], 1);
  assert.equal(result.metrics['clients.count'], 2);
  assert.equal(result.metrics['contracts.consumers_per_channel'], 2);
});

test('two repositories link a consumer to a publisher, preserving release order and decompose evidence', () => {
  const a = project({ 'orders.js': 'producer.send({ topic: "orders.created" })' });
  const b = project({ 'ledger.js': 'consumer.subscribe({ topic: "orders.created" })' });
  const { graph, analysis } = buildWorkspaceGraph(new Map([['orders', a], ['ledger', b]]));
  const edge = graph.edges('CONSUMES').find((e) => e.attrs.cross_repo && e.attrs.via === 'messaging');
  assert.equal(edge.from, 'module:ledger:ledger.js');
  assert.equal(edge.to, 'contract:orders:topic orders.created');
  assert.equal(edge.attrs.route, 'topic orders.created');
  assert.ok(analysis.release_coupling.some((r) => r.before === 'orders' && r.after === 'ledger'));
  const workspace = { repository: 'orders', mapped_at: '2026-10-12', links: [{ kind: 'messaging', route: 'topic orders.created', from_repo: 'ledger', from: 'module:ledger.js', to_repo: 'orders', to: 'contract:topic orders.created' }] };
  const evidence = contractEvidence(a, ['module:orders.js'], workspace);
  assert.equal(evidence.present, true);
  assert.equal(evidence.routes[0].consumers, 1);
  assert.deepEqual(evidence.routes[0].client_repositories, ['ledger']);
  assert.equal(evidence.routes[0].workspace_mapped_at, workspace.mapped_at);
  const consumer = contractEvidence(b, ['module:ledger.js'], { ...workspace, repository: 'ledger' });
  assert.deepEqual(consumer.routes[0].served_by, ['orders']);
});

test('unresolved and different channel types never link between repositories', () => {
  const a = project({ 'orders.js': 'producer.send({ topic: channelName }); nc.publish("orders.created", data)' });
  const b = project({ 'ledger.js': 'consumer.subscribe({ topic: channelName }); consumer.subscribe({ topic: "orders.created" })' });
  const { graph } = buildWorkspaceGraph(new Map([['orders', a], ['ledger', b]]));
  assert.equal(graph.edges().filter((e) => e.attrs.cross_repo).length, 0);
});


test('object shorthand queue URLs resolve from constant facts; dynamic array entries remain separate', () => {
  const g = project({ 'orders.js': 'const QueueUrl = "orders.created"; queue.sendMessage({ QueueUrl }); consumer.subscribe({ topics: [firstTopic, secondTopic] });' });
  assert.ok(g.out('module:orders.js', 'PUBLISHES').some((e) => e.to === 'contract:queue orders.created'));
  assert.equal(g.nodes('contract').filter((n) => n.attrs.channel_unresolved).length, 2);
});
