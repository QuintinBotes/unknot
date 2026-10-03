// Service-level detectors (spec §11.3, §15A): distributed monolith, chatty calls, god
// orchestrators, nanoservices, shared databases, duplicated capabilities, event soup,
// undocumented and obsolete endpoints, and consumers without idempotency.
//
// They read facts from the runtime, delivery, contracts, language and database adapters.
// Every detector states which evidence it needed; when runtime traces are missing the
// finding says so and carries a lower evidence factor instead of guessing.

/** Defaults for the thresholds below. Every one is a heuristic and is overridable via detector options. */
export const DEFAULTS = Object.freeze({
  chatty_per_request: 5, // heuristic: more than this many calls on one edge per request
  fan_out_p95: 6, // heuristic: downstream services touched per request (spec §11.3)
  nano_max_modules: 3, // heuristic: "very few modules"
  nano_min_services: 3, // a single tiny service is a small system, not a nanoservice
  nano_max_spans: 100, // heuristic: "tiny span volume"
  topic_max_publishers: 3, // event soup: publishers
  topic_max_subscribers: 5, // event soup: subscribers
});

const BUCKETS = new Set(['services', 'apps', 'packages', 'libs', 'svc', 'cmd', 'modules']);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[a-z]+$/i;
const MIGRATION_PATH = /(^|\/)(migrations?|alembic|db\/migrate)\//i;
const IGNORED_TABLES = /(^|\.)(schema_migrations|alembic_version|_prisma_migrations|flyway_schema_history|django_migrations)$/i;
const HEALTHISH = /^\/?(health|healthz|ready|readyz|live|livez|metrics|ping|status)(\/.*)?$/i;
const IDEMPOTENCY = /idempot|dedup|de-dup|processed[_-]?(id|message|event)|inbox|exactly[_-]?once/i;

const num = (opts, key) => (typeof opts?.[key] === 'number' ? opts[key] : DEFAULTS[key]);
const sortedUniq = (xs) => [...new Set(xs)].sort();
const basename = (p) => String(p ?? '').replace(/\/+$/, '').split('/').pop();
const isTestNode = (n) => n.attrs?.is_test === true || TEST_PATH.test(n.path ?? '');

/** Everything that stands for a deployable service we reason about (not a k8s `Service` object). */
function serviceNodes(g) {
  return g.nodes('service').filter((n) => n.attrs.kind !== 'Service' && (n.attrs.code_root || n.attrs.span_count !== undefined || n.attrs.runtime === 'compose'));
}

const rootOfService = (s) => String(s.attrs.code_root ?? '').replace(/\/+$/, '') || null;

/**
 * The code root a path belongs to: a known service's code_root (longest match), else a
 * bucket directory plus its child (`services/orders`), else the first segment.
 * @returns {{key: string, known: boolean}}
 */
function rootFor(path, services) {
  const p = String(path ?? '');
  let best = null;
  for (const s of services) {
    const r = rootOfService(s);
    if (r && (p === r || p.startsWith(`${r}/`)) && (!best || r.length > best.length)) best = r;
  }
  if (best) return { key: best, known: true };
  const parts = p.split('/');
  if (parts.length < 2) return { key: '.', known: false };
  return { key: BUCKETS.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0], known: false };
}

/** The group an actor (module, function, service) belongs to, or null when it is a test or migration. */
function actorKey(g, id, services) {
  const n = g.node(id);
  if (!n || isTestNode(n)) return null;
  if (n.type === 'service') return { key: rootOfService(n) ?? n.id, known: true, node: n };
  if (!n.path || MIGRATION_PATH.test(n.path)) return null;
  const r = rootFor(n.path, services);
  return { ...r, node: n };
}

/** table id -> Map(root key -> {known, edges}) built from MUTATES edges. */
function tableWriters(g, services) {
  const out = new Map();
  for (const e of g.edges('MUTATES')) {
    const t = g.node(e.to);
    if (!t || t.type !== 'table' || IGNORED_TABLES.test(t.name)) continue;
    const a = actorKey(g, e.from, services);
    if (!a) continue;
    if (!out.has(t.id)) out.set(t.id, new Map());
    const m = out.get(t.id);
    if (!m.has(a.key)) m.set(a.key, { known: a.known, edges: [] });
    m.get(a.key).edges.push(e);
  }
  return out;
}

function draft(o) {
  return {
    quality_impacts: { changeability: 'medium', reliability: 'medium', security: 'low' },
    blast_radius: 'moderate',
    recovery: { type: 'revert', notes: 'The change is made behind the existing interface and can be reverted in one release.' },
    uncertainties: [],
    ...o,
  };
}

/** Union-find over names, deterministic. */
function groups(pairs) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of pairs) parent.set(find(a), find(b));
  const out = new Map();
  for (const x of parent.keys()) {
    const r = find(x);
    if (!out.has(r)) out.set(r, []);
    out.get(r).push(x);
  }
  return [...out.values()].map((v) => v.sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Services matching a deployable name from the delivery adapter. */
function servicesNamed(services, name) {
  return services.filter((s) => s.name === name || s.name.endsWith(`/${name}`) || basename(rootOfService(s)) === name);
}

const distributedMonolith = {
  id: 'service.distributed-monolith',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.distributed-monolith'],
  detect({ graph: g, options }) {
    const services = serviceNodes(g);
    if (services.length < 2) return [];
    // Co-deployment: delivery's co_deployed_with plus any single job that deploys several targets.
    const pairs = [];
    for (const d of g.nodes('deployable')) {
      for (const other of d.attrs.co_deployed_with ?? []) pairs.push([d.name, other]);
    }
    for (const j of g.nodes('job')) {
      const t = j.attrs.deploys ?? [];
      for (let i = 1; i < t.length; i++) pairs.push([t[0], t[i]]);
    }
    const writers = tableWriters(g, services);
    const out = [];
    for (const names of groups(pairs)) {
      const members = sortedUniq(names.flatMap((n) => servicesNamed(services, n)).map((s) => s.id)).map((id) => g.node(id));
      if (members.length < 2) continue;
      const memberNames = new Set(members.map((m) => m.name));
      const cycles = members.flatMap((m) => (m.attrs.call_cycles ?? []).map((c) => c.path))
        .filter((p) => new Set(p.split('>').filter((x) => memberNames.has(x))).size >= 2);
      const roots = new Set(members.map((m) => rootOfService(m) ?? m.id));
      const sharedTables = [...writers].filter(([, w]) => [...w.keys()].filter((k) => roots.has(k)).length >= 2).map(([t]) => t).sort();
      if (!cycles.length && !sharedTables.length) continue;
      const evidence = [
        ...members.map((m) => ({ ref: m.id, label: 'observed', summary: `Deployed together with ${members.length - 1} other service(s)`, source_ref: m.provenance?.[0]?.source_ref ?? null })),
        ...sortedUniq(cycles).slice(0, 3).map((c) => ({ ref: members[0].id, label: 'observed', summary: `Synchronous call cycle ${c}`, source_ref: null })),
        ...sharedTables.slice(0, 3).map((t) => ({ ref: t, label: 'observed', summary: 'Mutated by more than one of these services', source_ref: null })),
      ];
      out.push(draft({
        kind: 'service.distributed-monolith',
        title: `${members.length} services release together and are coupled at runtime or through data (${members.map((m) => m.name).join(', ')})`,
        scope: members.map((m) => rootOfService(m) ?? m.id),
        key: `services:${members.map((m) => m.id).join(',')}`,
        evidence,
        measurements: { 'service.count': members.length, 'table.writers': Math.max(0, ...sharedTables.map((t) => writers.get(t).size)) },
        thresholds: { min_services: 2 },
        why_accidental: 'The services are deployed as one unit yet pay the cost of network boundaries; coupling through call cycles or shared tables means none can change or fail independently.',
        essential_considerations: ['Independent release may be intended and the shared coupling a transitional state', 'Regulatory or latency reasons may keep the code separate'],
        smallest_simplification: 'Choose one: merge the lockstep services into one deployable behind modules, or remove the cycle/shared-table coupling so each can release alone. Start with the shared table or cycle.',
        invariants: ['Public API and event contracts unchanged', 'Data remains owned by exactly one writer after the change'],
        risks: ['Merging loses independent scaling', 'Breaking a cycle needs an API or event change'],
        verification: ['Contract tests pass for every endpoint of the affected services', 'Trace comparison shows no new synchronous cycle'],
        quality_impacts: { changeability: 'high', reliability: 'medium', security: 'low' },
        factors: { benefit: 4, evidence: cycles.length && sharedTables.length ? 0.8 : 0.65, reversibility: 0.5, blast: 4, cost: 4, uncertainty: 3 },
        uncertainties: [
          'Co-deployment is inferred from pipeline structure, not release history',
          ...(cycles.length ? [] : ['No runtime call cycle was observed; coupling rests on shared tables']),
          ...(sharedTables.length ? ['Table writers are inferred from static SQL or traces and may include shared libraries'] : []),
        ],
        alternatives: [
          { id: 'retain', summary: 'Keep as is and record why the services must stay separate.' },
          { id: 'merge-into-modular-monolith', summary: 'Merge the services into one deployable with enforced module boundaries.' },
          { id: 'decouple-and-release-independently', summary: 'Remove the cycle and shared writes, then split the pipeline.' },
        ],
        patterns: ['anti-pattern.distributed-monolith', 'architecture.modular-monolith'],
      }));
    }
    return out;
  },
};

const chattyCalls = {
  id: 'service.chatty-calls',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.chatty-calls'],
  detect({ graph: g, options }) {
    const limit = num(options, 'chatty_per_request');
    const out = [];
    for (const e of g.edges('RUNTIME_CALLS').sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const per = e.attrs.per_request_p95;
      if (typeof per !== 'number' || per <= limit) continue;
      const from = g.node(e.from);
      const to = g.node(e.to);
      if (!from || !to) continue;
      out.push(draft({
        kind: 'service.chatty-calls',
        title: `${from.name} calls ${to.name} ${per} times per request (p95)`,
        scope: [rootOfService(from) ?? from.id, rootOfService(to) ?? to.id],
        key: `edge:${e.from}->${e.to}`,
        evidence: [{ ref: e.from, label: 'observed', summary: `${per} calls per request at p95 over ${e.attrs.traces ?? '?'} traces to ${to.name}`, source_ref: e.provenance?.[0]?.source_ref ?? null }],
        measurements: { 'boundary.calls_per_request_p95': per, 'service.count': 2 },
        thresholds: { chatty_per_request: limit, chatty_per_request_is_heuristic: true },
        why_accidental: 'Repeated small calls across a network boundary multiply latency and failure probability; they are usually an N+1 over an API rather than a requirement.',
        essential_considerations: ['Fan-in pagination or streaming may legitimately need several calls'],
        smallest_simplification: 'Add one batch or composite endpoint on the callee and call it once per request; keep the existing endpoint.',
        invariants: ['Existing single-item endpoint keeps working', 'Per-item error semantics are preserved by the batch response'],
        risks: ['Batch size limits and partial failure handling'],
        verification: ['Trace p95 of calls per request drops below the threshold', 'Contract test covers the batch endpoint'],
        quality_impacts: { changeability: 'low', reliability: 'high', security: 'low' },
        blast_radius: 'bounded',
        factors: { benefit: 3, evidence: 0.75, reversibility: 0.8, blast: 2, cost: 2, uncertainty: 2 },
        uncertainties: ['The threshold is a heuristic', 'Per-request counts come from sampled traces'],
        alternatives: [
          { id: 'retain', summary: 'Keep the calls; document why each is needed.' },
          { id: 'batch-endpoint', summary: 'Introduce a batch endpoint and migrate the caller.' },
          { id: 'cache-or-colocate', summary: 'Cache the callee data or move the logic to the caller side.' },
        ],
        patterns: ['anti-pattern.chatty-io', 'distributed.api-composition'],
      }));
    }
    return out;
  },
};

const highFanOut = {
  id: 'service.high-fan-out-orchestrator',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.high-fan-out-orchestrator'],
  detect({ graph: g, options }) {
    const limit = num(options, 'fan_out_p95');
    return serviceNodes(g).filter((s) => typeof s.attrs.fan_out_p95 === 'number' && s.attrs.fan_out_p95 >= limit).map((s) => draft({
      kind: 'service.high-fan-out-orchestrator',
      title: `${s.name} calls ${s.attrs.fan_out_p95} downstream services per request (p95)`,
      scope: [rootOfService(s) ?? s.id],
      key: `service:${s.id}`,
      evidence: [{ ref: s.id, label: 'observed', summary: `fan-out p95 ${s.attrs.fan_out_p95} over ${s.attrs.trace_count ?? '?'} traces, depth p95 ${s.attrs.depth_p95 ?? '?'}`, source_ref: s.provenance?.[0]?.source_ref ?? null }],
      measurements: { 'service.fan_out_p95': s.attrs.fan_out_p95 },
      thresholds: { fan_out_p95: limit, fan_out_p95_is_heuristic: true },
      why_accidental: 'A service that must reach this many peers for one request carries the latency and availability of all of them and tends to absorb their business rules.',
      essential_considerations: ['A deliberate API gateway or BFF is expected to fan out', 'Workflow engines legitimately coordinate many steps'],
      smallest_simplification: 'Move the read-side composition into one purpose-built composer, or let the slowest dependencies be called asynchronously; keep the orchestrator API unchanged.',
      invariants: ['Response contract of the orchestrator unchanged', 'Failure of an optional dependency degrades, not fails, the request'],
      risks: ['Introducing a composer adds a hop', 'Async steps change consistency timing'],
      verification: ['Fan-out p95 and request latency compared before and after in traces'],
      blast_radius: 'moderate',
      factors: { benefit: 3, evidence: 0.7, reversibility: 0.6, blast: 3, cost: 3, uncertainty: 3 },
      uncertainties: ['A gateway or BFF role would make this expected', 'Fan-out counts distinct services per trace and may include fire-and-forget calls'],
      alternatives: [
        { id: 'retain', summary: 'Keep the orchestrator; add timeouts and bulkheads per dependency.' },
        { id: 'extract-composer', summary: 'Extract an explicit composition layer.' },
        { id: 'process-manager', summary: 'Model the flow as an explicit process manager or saga.' },
      ],
      patterns: ['distributed.api-composition', 'distributed.saga-orchestration'],
    }));
  },
};

const nanoservice = {
  id: 'service.nanoservice',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.nanoservice'],
  detect({ graph: g, options }) {
    const services = serviceNodes(g).filter((s) => rootOfService(s));
    if (services.length < num(options, 'nano_min_services')) return [];
    const mods = g.nodes('module').filter((m) => !isTestNode(m));
    const out = [];
    for (const s of services) {
      const root = rootOfService(s);
      const own = mods.filter((m) => m.path === root || m.path?.startsWith(`${root}/`));
      // Without any module under the root the code is simply unmapped; do not guess.
      if (!own.length || own.length > num(options, 'nano_max_modules')) continue;
      const endpointIds = new Set(g.out(s.id, 'EXPOSES').map((e) => e.to));
      for (const m of own) for (const e of g.out(m.id, 'EXPOSES')) endpointIds.add(e.to);
      if (endpointIds.size > 1) continue;
      const spans = s.attrs.span_count;
      if (typeof spans === 'number' && spans > num(options, 'nano_max_spans')) continue;
      out.push(draft({
        kind: 'service.nanoservice',
        title: `${s.name} is ${own.length} module(s) with ${endpointIds.size} endpoint(s)`,
        scope: [root],
        key: `service:${s.id}`,
        evidence: [{ ref: s.id, label: 'inferred', summary: `${own.length} modules, ${endpointIds.size} endpoints${typeof spans === 'number' ? `, ${spans} spans` : ', no runtime volume'}`, source_ref: s.provenance?.[0]?.source_ref ?? null }],
        measurements: { 'service.count': services.length },
        thresholds: { nano_max_modules: num(options, 'nano_max_modules'), nano_max_spans: num(options, 'nano_max_spans'), thresholds_are_heuristics: true },
        why_accidental: 'A deployable this small spends more on pipeline, network and operations than it saves in isolation.',
        essential_considerations: ['A distinct security boundary, scaling profile or owning team can justify a tiny service'],
        smallest_simplification: 'Fold the service into its closest caller as a module; keep its endpoint as a route.',
        invariants: ['Endpoint contract unchanged', 'Data ownership unchanged'],
        risks: ['Loses independent scaling and deploy'],
        verification: ['Contract tests for the endpoint pass against the merged deployable'],
        blast_radius: 'bounded',
        factors: { benefit: 2, evidence: 0.35, reversibility: 0.6, blast: 2, cost: 2, uncertainty: 3 },
        uncertainties: ['Low confidence: size is judged by mapped modules, which may omit generated or non-JS/Python code', 'Traffic volume may come from a short trace window'],
        alternatives: [{ id: 'retain', summary: 'Keep the service and record the isolation reason.' }, { id: 'fold-into-caller', summary: 'Merge into the main caller.' }],
        patterns: ['anti-pattern.nanoservices'],
      }));
    }
    return out;
  },
};

const sharedDatabase = {
  id: 'service.shared-database',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.shared-database'],
  detect({ graph: g }) {
    const services = serviceNodes(g);
    const out = [];
    for (const [tableId, w] of [...tableWriters(g, services)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (w.size < 2) continue;
      const roots = [...w.keys()].sort();
      const allKnown = [...w.values()].every((v) => v.known);
      out.push(draft({
        kind: 'service.shared-database',
        title: `${g.node(tableId).name} is written by ${roots.length} code roots (${roots.join(', ')})`,
        scope: roots,
        key: `table:${tableId}`,
        evidence: [
          { ref: tableId, label: 'observed', summary: `Mutated from ${roots.length} separate roots`, source_ref: null },
          ...roots.map((r) => ({ ref: w.get(r).edges[0].from, label: 'observed', summary: `Writes in ${r}`, source_ref: w.get(r).edges[0].attrs?.line ? `${g.node(w.get(r).edges[0].from).path}:${w.get(r).edges[0].attrs.line}` : null })),
        ],
        measurements: { 'table.writers': roots.length, 'boundary.shared_table_writers': roots.length - 1 },
        thresholds: { max_writers: 1 },
        why_accidental: 'When several boundaries write one table, none owns its invariants and every schema change needs all of them to release together.',
        essential_considerations: ['A shared library may own all writes on behalf of both roots', 'Reporting jobs may legitimately write summaries'],
        smallest_simplification: 'Name one owner for the table and route the other writers through that owner API or event; keep the table as is.',
        invariants: ['Table schema and values unchanged', 'Every previous write remains possible through the owner'],
        risks: ['Added latency for writes that now cross a boundary', 'Transactions spanning both writers need redesign'],
        verification: ['Only one root contains MUTATES edges for the table after the change', 'Existing integration tests for each former writer pass'],
        quality_impacts: { changeability: 'high', reliability: 'medium', security: 'low' },
        factors: { benefit: 4, evidence: allKnown ? 0.8 : 0.5, reversibility: 0.6, blast: 3, cost: 3, uncertainty: 3 },
        uncertainties: [
          allKnown ? 'Writers were attributed to service code roots' : 'Some roots are inferred from top-level directories, which may be packages of one service',
          'Writes through a shared data-access library appear under the library path, not the caller',
        ],
        alternatives: [
          { id: 'retain', summary: 'Keep sharing the table and document the writer contract.' },
          { id: 'single-writer', summary: 'Designate one writer; others call it.' },
          { id: 'split-table', summary: 'Split the table by owner.' },
        ],
        patterns: ['anti-pattern.shared-database'],
      }));
    }
    return out;
  },
};

const duplicateCapability = {
  id: 'service.duplicate-capability',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.duplicate-capability'],
  detect({ graph: g }) {
    const services = serviceNodes(g);
    const out = [];
    for (const ep of g.nodes('endpoint').sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const route = String(ep.name).replace(/^[A-Z]+\s+/, '');
      if (ep.attrs.from_contract && !g.in(ep.id, 'EXPOSES').length) continue;
      if (HEALTHISH.test(route)) continue;
      const by = new Map();
      for (const e of g.in(ep.id, 'EXPOSES')) {
        const a = actorKey(g, e.from, services);
        if (a && !by.has(a.key)) by.set(a.key, e.from);
      }
      if (by.size < 2) continue;
      const roots = [...by.keys()].sort();
      out.push(draft({
        kind: 'service.duplicate-capability',
        title: `${ep.name} is implemented in ${roots.length} places (${roots.join(', ')})`,
        scope: roots,
        key: `endpoint:${ep.id}`,
        evidence: roots.map((r) => ({ ref: by.get(r), label: 'observed', summary: `Exposes ${ep.name}`, source_ref: g.node(by.get(r)).path })),
        measurements: { 'service.count': roots.length },
        thresholds: { min_implementations: 2 },
        why_accidental: 'Two implementations of one route drift apart; callers cannot know which is authoritative.',
        essential_considerations: ['Blue/green or strangler migrations deliberately run both for a time', 'A gateway and a backend can both declare the route'],
        smallest_simplification: 'Pick the authoritative implementation and make the other delegate to it; retire the copy after traffic confirms.',
        invariants: ['Route contract unchanged for callers'],
        risks: ['The copies may already differ in behaviour'],
        verification: ['Contract test passes against the surviving implementation', 'Runtime traces show no traffic to the retired copy'],
        blast_radius: 'moderate',
        factors: { benefit: 3, evidence: 0.6, reversibility: 0.7, blast: 3, cost: 3, uncertainty: 3 },
        uncertainties: ['Path matching is textual; two services behind different gateways may be unrelated'],
        alternatives: [{ id: 'retain', summary: 'Keep both and record which is canonical.' }, { id: 'delegate', summary: 'Make one delegate to the other.' }],
        patterns: ['migration.strangler-fig'],
      }));
    }
    return out;
  },
};

const eventSoup = {
  id: 'service.event-soup',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.event-soup'],
  detect({ graph: g, options }) {
    const services = serviceNodes(g);
    const channels = [...g.nodes('topic'), ...g.nodes('queue')].sort((a, b) => (a.id < b.id ? -1 : 1));
    const contractsExist = channels.some((c) => c.attrs.from_contract);
    const side = (id, type) => {
      const m = new Map();
      for (const e of g.in(id, type)) {
        const a = actorKey(g, e.from, services);
        if (a && !m.has(a.key)) m.set(a.key, e.from);
      }
      return m;
    };
    const out = [];
    for (const c of channels) {
      const pubs = side(c.id, 'PUBLISHES');
      const subs = side(c.id, 'SUBSCRIBES');
      const crowded = pubs.size >= num(options, 'topic_max_publishers') || subs.size >= num(options, 'topic_max_subscribers');
      const uncontracted = contractsExist && !c.attrs.from_contract && subs.size >= 2 && pubs.size >= 1;
      if (!crowded && !uncontracted) continue;
      const roots = sortedUniq([...pubs.keys(), ...subs.keys()]);
      out.push(draft({
        kind: 'service.event-soup',
        title: `${c.name} has ${pubs.size} publisher(s) and ${subs.size} subscriber(s)${uncontracted && !crowded ? ' and no contract' : ''}`,
        scope: roots,
        key: `channel:${c.id}`,
        evidence: [{ ref: c.id, label: 'observed', summary: `${pubs.size} publishing roots, ${subs.size} subscribing roots, contract ${c.attrs.from_contract ? 'present' : 'absent'}`, source_ref: c.path ?? null }],
        measurements: { 'messaging.consumers_known': subs.size > 0 ? 1 : 0, 'contracts.present': c.attrs.from_contract ? 1 : 0 },
        thresholds: { topic_max_publishers: num(options, 'topic_max_publishers'), topic_max_subscribers: num(options, 'topic_max_subscribers'), thresholds_are_heuristics: true },
        why_accidental: 'A channel with many writers or readers and no schema becomes an implicit shared interface nobody owns.',
        essential_considerations: ['A deliberate event bus topic for broadcast notifications legitimately has many readers'],
        smallest_simplification: 'Assign an owner and publish a schema for the channel; split it by event type only if the schema shows distinct concerns.',
        invariants: ['Existing message shape stays readable by current subscribers'],
        risks: ['Subscribers may depend on undocumented fields'],
        verification: ['Schema validation passes against recorded messages', 'Subscriber list is documented'],
        blast_radius: 'moderate',
        factors: { benefit: 3, evidence: crowded ? 0.6 : 0.4, reversibility: 0.8, blast: 3, cost: 2, uncertainty: 3 },
        uncertainties: ['Subscribers and publishers are discovered statically and may miss dynamic topic names', ...(uncontracted && !crowded ? ['Contract absence is judged against other channels having contracts'] : [])],
        alternatives: [{ id: 'retain', summary: 'Keep the channel and document ownership.' }, { id: 'schema-and-owner', summary: 'Add a contract and an owner.' }, { id: 'split-channel', summary: 'Split by event type.' }],
        patterns: ['anti-pattern.event-soup', 'messaging.publish-subscribe'],
      }));
    }
    return out;
  },
};

const undocumentedEndpoints = {
  id: 'service.undocumented-endpoints',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.undocumented-endpoints'],
  detect({ graph: g }) {
    const services = serviceNodes(g);
    const by = new Map();
    for (const ep of g.nodes('endpoint').filter((n) => n.attrs.undocumented === true).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const exp = g.in(ep.id, 'EXPOSES').map((e) => actorKey(g, e.from, services)).find(Boolean);
      const key = exp?.key ?? (ep.path ? rootFor(ep.path, services).key : '(unknown)');
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(ep);
    }
    return [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([root, eps]) => draft({
      kind: 'service.undocumented-endpoints',
      title: `${eps.length} endpoint(s) in ${root} are missing from the API contract`,
      scope: [root],
      key: `root:${root}`,
      evidence: eps.slice(0, 10).map((e) => ({ ref: e.id, label: 'observed', summary: `${e.name} is implemented but absent from the contract`, source_ref: e.path ?? null })),
      measurements: { 'contracts.present': 1 },
      thresholds: { undocumented_count: eps.length },
      why_accidental: 'Callers cannot discover, test or deprecate an endpoint that the contract does not list.',
      essential_considerations: ['Internal or debug routes may be intentionally excluded'],
      smallest_simplification: 'Add the endpoints to the contract (or mark them internal in it); change no code.',
      invariants: ['Runtime behaviour unchanged'],
      risks: ['Documenting an endpoint can imply a support commitment'],
      verification: ['Contract check reports zero undocumented endpoints for this root'],
      blast_radius: 'local',
      factors: { benefit: 2, evidence: 0.8, reversibility: 0.95, blast: 1, cost: 1, uncertainty: 2 },
      uncertainties: ['Matching is by method and normalised path; framework prefixes can cause false mismatches'],
      alternatives: [{ id: 'retain', summary: 'Leave undocumented and mark the routes internal.' }, { id: 'document', summary: 'Add them to the contract.' }],
      patterns: [],
    }));
  },
};

const obsoleteCompat = {
  id: 'service.obsolete-compat-path',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.obsolete-compat-path'],
  detect({ graph: g }) {
    const services = serviceNodes(g);
    const runtimeKnown = g.edges('EXPOSES').some((e) => g.node(e.from)?.type === 'service' && typeof e.attrs.calls === 'number');
    const out = [];
    for (const ep of g.nodes('endpoint').filter((n) => n.attrs.deprecated === true).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const code = g.in(ep.id, 'EXPOSES').filter((e) => g.node(e.from)?.type === 'module' && !isTestNode(g.node(e.from)));
      if (!code.length) continue;
      const traced = g.in(ep.id, 'EXPOSES').filter((e) => g.node(e.from)?.type === 'service' && typeof e.attrs.calls === 'number');
      const calls = traced.reduce((s, e) => s + e.attrs.calls, 0);
      const unused = runtimeKnown && calls === 0;
      out.push(draft({
        kind: 'service.obsolete-compat-path',
        title: `${ep.name} is deprecated in the contract but still implemented${unused ? ' and no traffic was observed' : calls ? ` and still receives ${calls} calls` : ''}`,
        scope: sortedUniq(code.map((e) => g.node(e.from).path)),
        key: `endpoint:${ep.id}`,
        evidence: [
          { ref: ep.id, label: 'observed', summary: 'Marked deprecated by the API contract', source_ref: ep.attrs.contract ?? null },
          { ref: code[0].from, label: 'observed', summary: 'Implementation still present', source_ref: g.node(code[0].from).path },
          ...(runtimeKnown ? [{ ref: ep.id, label: calls ? 'observed' : 'inferred', summary: calls ? `${calls} calls in the trace window` : 'No calls in the trace window', source_ref: null }] : []),
        ],
        measurements: { 'traces.available': runtimeKnown ? 1 : 0 },
        thresholds: { zero_calls_raises_evidence: true },
        why_accidental: 'A deprecated route kept alive without callers adds surface to secure, test and maintain.',
        essential_considerations: ['External consumers may call it outside the trace window', 'The sunset date in the contract may not have passed'],
        smallest_simplification: unused ? 'Make the route return 410 Gone for one release, then delete the implementation.' : 'Announce a sunset date and monitor callers; delete only after they reach zero.',
        invariants: ['Non-deprecated routes unchanged'],
        risks: ['Unknown callers break'],
        verification: ['Runtime traces show zero calls over the agreed window', 'Contract marks the route removed'],
        blast_radius: 'bounded',
        recovery: { type: 'revert', notes: 'Restore the route from version control.' },
        factors: { benefit: 2, evidence: unused ? 0.8 : runtimeKnown && calls ? 0.35 : 0.5, reversibility: 0.8, blast: 2, cost: 2, uncertainty: 2 },
        uncertainties: [runtimeKnown ? 'Trace window may miss infrequent callers' : 'No runtime evidence: usage is unknown'],
        alternatives: [{ id: 'retain', summary: 'Keep the route until the sunset date.' }, { id: 'sunset', summary: 'Return 410 then delete.' }],
        patterns: ['migration.parallel-change'],
      }));
    }
    return out;
  },
};

const missingIdempotency = {
  id: 'service.missing-idempotency',
  version: '1.0.0',
  category: 'service',
  kinds: ['service.missing-idempotency'],
  detect({ graph: g }) {
    const out = [];
    for (const e of g.edges('SUBSCRIBES').sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const m = g.node(e.from);
      const ch = g.node(e.to);
      if (!m || m.type !== 'module' || !ch || isTestNode(m) || !['topic', 'queue'].includes(ch.type)) continue;
      const names = [m.path, ...g.children(m.id).map((c) => c.name), ...(m.attrs.exports ?? []).map((x) => x.name)];
      if (names.some((n) => IDEMPOTENCY.test(String(n ?? '')))) continue;
      out.push(draft({
        kind: 'service.missing-idempotency',
        title: `${m.path} consumes ${ch.name} with no idempotency handling visible`,
        scope: [m.path],
        key: `consumer:${m.id}:${ch.id}`,
        evidence: [{ ref: m.id, label: 'inferred', summary: `Subscribes to ${ch.name}; no function or module name mentions idempotency, deduplication or an inbox`, source_ref: m.path }],
        measurements: { 'messaging.consumers_known': 1, 'data.idempotency': 0 },
        thresholds: { name_based_inference: true },
        why_accidental: 'At-least-once brokers redeliver; a consumer that is not idempotent double-applies effects.',
        essential_considerations: ['Idempotency may be provided by the handler logic or a database constraint under other names', 'The effect may be naturally idempotent'],
        smallest_simplification: 'Record processed message ids in the same transaction as the effect and skip repeats.',
        invariants: ['Message handling result for first delivery unchanged'],
        risks: ['Dedup store growth', 'Key choice must be stable across redelivery'],
        verification: ['A test redelivers the same message twice and asserts a single effect'],
        blast_radius: 'local',
        factors: { benefit: 3, evidence: 0.3, reversibility: 0.8, blast: 1, cost: 2, uncertainty: 4 },
        uncertainties: ['Inference from names only: low confidence', 'Handler bodies are not analysed'],
        alternatives: [{ id: 'retain', summary: 'Keep as is if the effect is naturally idempotent; add a test that proves it.' }, { id: 'idempotent-consumer', summary: 'Add an inbox or processed-id check.' }],
        patterns: ['distributed.idempotent-consumer', 'messaging.guaranteed-delivery'],
      }));
    }
    return out;
  },
};

export default [
  distributedMonolith, chattyCalls, highFanOut, nanoservice, sharedDatabase,
  duplicateCapability, eventSoup, undocumentedEndpoints, obsoleteCompat, missingIdempotency,
];
