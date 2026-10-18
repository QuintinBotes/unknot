// One messaging rule: a call/marker names a channel and a direction. Library spellings
// are data; there is no per-library extractor. Unknown names remain local evidence.
import { edgeFact, nodeFact } from '../../runtime/graph/facts.mjs';
import { argumentsOf, callsIn, MAX_OPERATIONS, stringValue, view } from './contract-scan.mjs';

export const MESSAGING_SYNTAX = [
  { family: 'producer', names: ['send'], receiver: /producer|kafka|template/i, direction: 'PUBLISHES', channel: 'topic', argument: 0, object: 'topic' },
  { family: 'producer', names: ['send'], preceding: /KafkaProducer\s*\([^)]*\)\.\s*$/, direction: 'PUBLISHES', channel: 'topic', argument: 0 },
  { family: 'producer', names: ['Produce', 'ProduceAsync'], direction: 'PUBLISHES', channel: 'topic', argument: 0 },
  { family: 'consumer', names: ['subscribe'], receiver: /consumer|kafka/i, direction: 'CONSUMES', channel: 'topic', argument: 0, object: 'topic', plural: 'topics' },
  { family: 'consumer', names: ['Subscribe', 'KafkaConsumer'], receiver: /^(?:.*(?:consumer|kafka).*)?$/i, direction: 'CONSUMES', channel: 'topic', argument: 0 },
  { family: 'handler', names: ['KafkaListener'], direction: 'CONSUMES', channel: 'topic', named: 'topics', marker: true },
  { family: 'amqp', names: ['basic_publish'], direction: 'PUBLISHES', channel: 'exchange', named: 'exchange', fallback: 'routing_key', fallbackChannel: 'queue' },
  { family: 'amqp', names: ['publish'], receiver: /channel|amqp/i, direction: 'PUBLISHES', channel: 'exchange', argument: 0, routingKey: 1 },
  { family: 'amqp', names: ['sendToQueue'], direction: 'PUBLISHES', channel: 'queue', argument: 0 },
  { family: 'amqp', names: ['basic_consume'], direction: 'CONSUMES', channel: 'queue', named: 'queue', argument: 0 },
  { family: 'amqp', names: ['consume'], receiver: /channel|queue|amqp/i, direction: 'CONSUMES', channel: 'queue', argument: 0 },
  { family: 'handler', names: ['RabbitListener'], direction: 'CONSUMES', channel: 'queue', named: 'queues', marker: true },
  { family: 'cloud', names: ['sendMessage', 'SendMessage'], direction: 'PUBLISHES', channel: 'queue', object: 'queueurl', named: 'queueurl' },
  { family: 'cloud', names: ['receiveMessage', 'ReceiveMessage'], direction: 'CONSUMES', channel: 'queue', object: 'queueurl', named: 'queueurl' },
  { family: 'cloud', names: ['CreateSender'], direction: 'PUBLISHES', channel: 'queue', argument: 0 },
  { family: 'cloud', names: ['CreateReceiver', 'CreateProcessor'], direction: 'CONSUMES', channel: 'queue', argument: 0 },
  { family: 'cloud', names: ['topic'], direction: 'PUBLISHES', channel: 'topic', argument: 0, followedBy: /^\s*\.\s*publish(?:Message)?\s*\(/ },
  { family: 'nats', names: ['publish', 'Publish'], receiver: /(?:^|\.)(?:nc|conn|js)$|nats|connection|publisher|^$/i, direction: 'PUBLISHES', channel: 'subject', argument: 0, bareNeedsName: true },
  { family: 'nats', names: ['subscribe', 'Subscribe'], receiver: /(?:^|\.)(?:nc|conn|js)$|nats|connection|subscriber|^$/i, direction: 'CONSUMES', channel: 'subject', argument: 0, bareNeedsName: true },
  { family: 'handler', names: ['MessagePattern', 'EventPattern'], direction: 'CONSUMES', channel: 'topic', argument: 0, marker: true },
  { family: 'handler', names: ['QueueTrigger', 'ServiceBusTrigger'], direction: 'CONSUMES', channel: 'queue', argument: 0, marker: true },
];

const DECLARES = /\b(?:function|def|func|fun|sub)\s+$/;
// A callback, lambda, object literal or typed parameter (`subject string`, `String topic`) names no
// channel: `this.items.subscribe((x) => ...)` is no subscription.
const NOT_A_CHANNEL = /=>|^\(?[\w\s,]*\)?\s*->|^(?:function|func|lambda|async|fn)\b|^\{|^[A-Za-z_][\w.]*\s+[*&]?[A-Za-z_][\w.[\]]*$/;

// Most files call none of the names: a text test spares them the lexer.
const TRIGGER = new RegExp(`\\b(?:${[...new Set(MESSAGING_SYNTAX.flatMap((r) => r.names))].join('|')})\\s*\\(`);

export function messagingCandidates(path, text, lang) {
  if (!TRIGGER.test(text)) return [];
  const lx = view(text, lang);
  const out = [];
  for (const call of callsIn(lx)) {
    // `function publish(topic)`, `def publish(subject):` or a method `publish(event) {` declares the name; it is no call.
    if (!call.receiver && (DECLARES.test(call.before) || /^\s*(?::[^;{}()=]*)?\{/.test(lx.code.slice(call.end + 1, call.end + 200)))) continue;
    for (const row of MESSAGING_SYNTAX) {
      if (!row.names.includes(call.name) || (row.receiver && !row.receiver.test(call.receiver))
        || (row.receiver && !call.receiver && /[.>]\s*$/.test(call.before))
        || (row.preceding && !row.preceding.test(call.before))
        || (row.followedBy && !row.followedBy.test(lx.code.slice(call.end + 1)))
        || (row.marker && !/[@\[]\s*(?:[\w.]+\.)?$/.test(call.before))) continue;
      // Prefer the more specific receiver row to a positional fallback.
      if (out.some((c) => c.index === call.index)) continue;
      const object = call.args.positional[0]?.trim();
      const parsedObject = object?.startsWith('{') ? argumentsOf(object.slice(1, -1)) : { named: {}, positional: [] };
      const fields = { ...parsedObject.named };
      for (const shorthand of parsedObject.positional) if (/^[A-Za-z_]\w*$/.test(shorthand)) fields[shorthand.toLowerCase()] = shorthand;
      let raw = call.args.named[row.named] ?? fields[row.object] ?? fields[row.plural] ?? call.args.positional[row.argument];
      let channel = row.channel;
      if (row.fallback && stringValue(raw) === '') { raw = call.args.named[row.fallback]; channel = row.fallbackChannel; }
      if (raw === undefined) continue;
      // Literal arrays in listener/subscription declarations name one contract per channel.
      const list = /^\s*(?:new\s*\[\]\s*)?[\[{]([\s\S]*)[\]}]\s*$/.exec(raw);
      const values = list ? argumentsOf(list[1]).positional : [raw];
      for (const value of values) {
        if (out.length >= MAX_OPERATIONS) break;
        if (NOT_A_CHANNEL.test(value.trim())) continue;
        out.push({ channel, expression: value.trim(), direction: row.direction, line: call.line, index: call.index, slot: out.length,
          ...(row.bareNeedsName && !call.receiver ? { bare: true } : {}),
          ...(row.routingKey !== undefined || row.fallback ? { routing_key: call.args.named.routing_key ?? call.args.positional[row.routingKey] } : {}) });
      }
    }
    if (out.length >= MAX_OPERATIONS) break;
  }
  return out;
}

export function channelFacts(path, candidate, pv, resolve = () => null) {
  const value = stringValue(candidate.expression) ?? resolve(candidate.expression);
  const unresolved = value === null;
  // A bare `publish(x)` is often a local helper whose argument is the message: it names a channel only through a string.
  if (unresolved && candidate.bare) return [];
  const name = unresolved ? `${path}#${candidate.index}:${candidate.slot}` : value;
  const key = `${candidate.channel} ${name}`;
  const attrs = { kind: 'messaging_channel', channel_type: candidate.channel, channel: unresolved ? null : value,
    ...(unresolved ? { channel_unresolved: true, channel_expression: candidate.expression.slice(0, 120) } : {}),
    ...(candidate.routing_key ? { routing_key: stringValue(candidate.routing_key) ?? resolve(candidate.routing_key), routing_key_unresolved: stringValue(candidate.routing_key) === null && resolve(candidate.routing_key) === null } : {}) };
  return [nodeFact('contract', key, { name: key, attrs }, pv(candidate.line)),
    edgeFact(candidate.direction, `module:${path}`, `contract:${key}`, { channel_type: candidate.channel,
      ...(unresolved ? { channel_unresolved: true } : {}) }, pv(candidate.line))];
}

/** Constant facts are authoritative. Same-file definitions win; conflicting names never guess. */
export function constantResolver(factsByFile, path) {
  const local = new Map();
  const all = new Map();
  for (const [file, facts] of factsByFile) for (const f of facts) {
    if (f.kind !== 'edge' || f.type !== 'DEFINES' || !f.to.startsWith('constant:') || !f.attrs?.name) continue;
    for (const map of file === path ? [local, all] : [all]) {
      const key = f.attrs.name;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(f.to.slice('constant:'.length));
    }
  }
  return (expression) => {
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(expression)) return null;
    const name = expression.split('.').pop();
    const values = local.get(name) ?? all.get(name);
    return values?.size === 1 ? [...values][0] : null;
  };
}
