// Turns normalised spans into graph facts: services, observed service-to-service calls,
// endpoints, tables, topics, and per-trace shape statistics (fan-out, depth, cycles).
// Aggregation is per trace and bounded: only compact per-span records are retained.

import { edgeFact, nodeFact } from '../../runtime/graph/facts.mjs';
import {
  ascending, codeRootOf, percentile, round, sortFacts, stamper, toIso,
} from './util.mjs';

const MAX_WALK = 64; // ancestor walk bound for cycle detection
const MAX_CYCLES = 20;
const NS_PER_MS = 1e6;

const ms = (ns) => ns / NS_PER_MS;

/** Pull table names out of an already-redacted statement. */
export function tablesOf(statement) {
  const out = new Set();
  const re = /\b(?:from|join|into|update)\s+(?:only\s+)?((?:[`"]?[A-Za-z_][\w$]*[`"]?\.)?[`"]?[A-Za-z_][\w$]*[`"]?)/gi;
  for (const m of statement.matchAll(re)) {
    const name = m[1].replace(/[`"]/g, '').toLowerCase();
    if (!['select', 'set', 'values', 'lateral', 'unnest'].includes(name)) out.add(name);
  }
  return [...out];
}

export function verbOf(statement) {
  const w = /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i.exec(statement)?.[1]?.toLowerCase();
  return ['insert', 'update', 'delete', 'merge', 'replace', 'upsert', 'truncate'].includes(w) ? 'MUTATES' : 'QUERIES';
}

function tableKey(name) {
  return name.includes('.') ? name : `public.${name}`;
}

function summarise(durs, errors, count) {
  const sorted = ascending(durs);
  return {
    calls: count,
    error_rate: round(count ? errors / count : 0, 4),
    p50_ms: round(ms(percentile(sorted, 50) ?? 0)),
    p95_ms: round(ms(percentile(sorted, 95) ?? 0)),
  };
}

/**
 * @param {Iterable<object>} spanStream normalised spans (see traces.mjs)
 * @param {{truncated:boolean}} meta filled in by the parser as the stream is consumed
 * @param {{file:string, options:object, now:string, ttlDays:number}} env
 */
export function deriveTraceFacts(spanStream, meta, { file, options, now, ttlDays }) {
  const traces = new Map(); // trace id -> Map(span key -> span)
  const dupes = new Map(); // service -> dropped duplicates
  let minStart = Infinity;
  let maxEnd = -Infinity;

  for (const s of spanStream) {
    if (s.id === '') continue;
    let t = traces.get(s.trace);
    if (!t) { t = new Map(); traces.set(s.trace, t); }
    // Same id from a different kind/service is a shared span (Zipkin), not a duplicate.
    let key = s.id;
    const prior = t.get(key);
    if (prior) {
      if (prior.kind === s.kind && prior.service === s.service) {
        dupes.set(s.service, (dupes.get(s.service) ?? 0) + 1);
        continue;
      }
      key = `${s.id}~${s.kind}~${s.service}`;
      if (t.has(key)) { dupes.set(s.service, (dupes.get(s.service) ?? 0) + 1); continue; }
    }
    t.set(key, s);
    if (s.start_ns > 0) {
      if (s.start_ns < minStart) minStart = s.start_ns;
      const end = s.start_ns + s.duration_ns;
      if (end > maxEnd) maxEnd = end;
    }
  }

  const window = Number.isFinite(minStart)
    ? { start: toIso(Math.floor(ms(minStart))), end: toIso(Math.ceil(ms(maxEnd))) }
    : { start: now, end: now };
  const st = stamper({ file, sourceType: 'trace', window, ttlDays });

  const svc = new Map(); // service -> aggregate
  const getSvc = (name) => {
    let a = svc.get(name);
    if (!a) {
      a = { count: 0, errors: 0, serverDurs: [], allDurs: [], traces: 0, fanOuts: [], depths: [], cc: [], cycles: new Map() };
      svc.set(name, a);
    }
    return a;
  };
  const edges = new Map(); // from\0to -> aggregate
  const endpoints = new Map(); // service\0endpoint key -> aggregate
  const tables = new Map(); // service\0verb\0table -> aggregate
  const topics = new Map(); // service\0PUBLISHES|SUBSCRIBES\0topic -> aggregate
  const nodeAttrs = { table: new Map(), topic: new Map(), endpoint: new Map() };
  const cycleTotals = new Map(); // signature -> traces

  const bump = (map, key, init, span) => {
    let a = map.get(key);
    if (!a) { a = { ...init, count: 0, errors: 0, durs: [] }; map.set(key, a); }
    a.count += 1;
    if (span.error) a.errors += 1;
    a.durs.push(span.duration_ns);
    return a;
  };

  for (const t of traces.values()) {
    const recs = [...t.values()];
    const parentOf = (c) => {
      const p = c.parent ? t.get(c.parent) : undefined;
      return p === c ? undefined : p;
    };
    const calls = [];

    for (const c of recs) {
      const a = getSvc(c.service);
      a.count += 1;
      if (c.error) a.errors += 1;
      a.allDurs.push(c.duration_ns);
      if (c.kind === 'SERVER' || c.kind === 'CONSUMER') a.serverDurs.push(c.duration_ns);

      const p = parentOf(c);
      c.link = Boolean(p && p.service !== c.service && p.kind !== 'PRODUCER' && c.kind !== 'CONSUMER');
      if (c.link) {
        p.crossed = true;
        calls.push({ from: p.service, to: c.service, dur: p.kind === 'CLIENT' ? p.duration_ns : c.duration_ns, error: c.error || (p.kind === 'CLIENT' && p.error), observed: true });
      }

      const at = c.attrs;
      if (c.kind === 'SERVER') {
        const method = at['http.method'];
        const route = at['http.route'] ?? at['http.target'] ?? at['url.path'];
        let key = null;
        if (method && route) key = `${method} ${route}`;
        else if (at['rpc.service'] && at['rpc.method']) key = `RPC ${at['rpc.service']}/${at['rpc.method']}`;
        if (key) {
          bump(endpoints, `${c.service}\0${key}`, { service: c.service, key }, c);
          nodeAttrs.endpoint.set(key, method ? { method, route } : { rpc_service: at['rpc.service'], rpc_method: at['rpc.method'] });
        }
      }
      if (at['db.system'] && c.kind !== 'SERVER') {
        const stmt = at['db.statement'] ?? '';
        const names = at['db.sql.table'] ? [at['db.sql.table'].toLowerCase()] : tablesOf(stmt);
        const rel = stmt ? verbOf(stmt) : 'QUERIES';
        for (const n of names) {
          const tk = tableKey(n);
          const a = bump(tables, `${c.service}\0${rel}\0${tk}`, { service: c.service, rel, table: tk, shape: null }, c);
          if (stmt && (a.shape === null || stmt < a.shape)) a.shape = stmt;
          if (!nodeAttrs.table.has(tk)) nodeAttrs.table.set(tk, { db_system: at['db.system'], db_name: at['db.name'] });
        }
      }
      const dest = at['messaging.destination'];
      if (dest && (c.kind === 'PRODUCER' || c.kind === 'CONSUMER')) {
        const rel = c.kind === 'PRODUCER' ? 'PUBLISHES' : 'SUBSCRIBES';
        bump(topics, `${c.service}\0${rel}\0${dest}`, { service: c.service, rel, topic: dest }, c);
        if (!nodeAttrs.topic.has(dest)) nodeAttrs.topic.set(dest, { messaging_system: at['messaging.system'] });
      }
    }

    // A CLIENT span naming its peer is a call even when the callee exported no spans.
    for (const c of recs) {
      const peer = c.attrs['peer.service'];
      if (c.kind === 'CLIENT' && peer && !c.crossed && !c.attrs['db.system'] && peer !== c.service) {
        calls.push({ from: c.service, to: peer, dur: c.duration_ns, error: c.error, observed: false });
      }
    }

    // Service-hop depth, memoised iteratively (traces can be deep and may contain loops).
    let maxDepth = 0;
    for (const r of recs) {
      if (r.depth !== undefined) continue;
      const chain = [];
      let cur = r;
      while (cur && cur.depth === undefined && !cur.visiting) {
        cur.visiting = true;
        chain.push(cur);
        cur = parentOf(cur);
      }
      let d = cur && cur.depth !== undefined ? cur.depth : 0;
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const c = chain[i];
        c.depth = d + (c.link ? 1 : 0);
        d = c.depth;
        if (d > maxDepth) maxDepth = d;
      }
    }

    // Synchronous call cycles: a service reappearing on its own ancestor chain.
    const sigs = new Set();
    for (const c of recs) {
      if (!c.link) continue;
      const path = [c.service];
      let cur = c;
      for (let step = 0; step < MAX_WALK; step += 1) {
        if (cur.kind === 'CONSUMER') break;
        const p = parentOf(cur);
        if (!p || p.kind === 'PRODUCER') break;
        if (p.service === c.service && path.length > 1) { sigs.add([...path, c.service].reverse().join('>')); break; }
        if (p.service !== path[path.length - 1]) path.push(p.service);
        cur = p;
      }
    }
    for (const sig of sigs) {
      cycleTotals.set(sig, (cycleTotals.get(sig) ?? 0) + 1);
      for (const name of new Set(sig.split('>'))) {
        const m = getSvc(name).cycles;
        m.set(sig, (m.get(sig) ?? 0) + 1);
      }
    }

    // Per-trace edge counts and service shape.
    const perEdge = new Map();
    const callees = new Map();
    for (const call of calls) {
      const k = `${call.from}\0${call.to}`;
      let e = edges.get(k);
      if (!e) { e = { from: call.from, to: call.to, count: 0, errors: 0, durs: [], perTrace: [], observed: false }; edges.set(k, e); }
      e.count += 1;
      if (call.error) e.errors += 1;
      e.durs.push(call.dur);
      if (call.observed) e.observed = true;
      perEdge.set(k, (perEdge.get(k) ?? 0) + 1);
      if (!callees.has(call.from)) callees.set(call.from, new Set());
      callees.get(call.from).add(call.to);
    }
    for (const [k, n] of perEdge) edges.get(k).perTrace.push(n);
    const present = new Set(recs.map((r) => r.service));
    for (const name of present) {
      const a = getSvc(name);
      a.traces += 1;
      a.fanOuts.push(callees.get(name)?.size ?? 0);
      a.depths.push(maxDepth);
      a.cc.push(calls.length);
    }
  }

  // ---- facts -------------------------------------------------------------------------
  const services = [];
  const callEdges = [];
  const others = [];
  const nodes = new Map();
  const addNode = (type, key, name, extra) => {
    const id = `${type}:${key}`;
    if (!nodes.has(id)) nodes.set(id, nodeFact(type, key, { name }, st.prov(`${type}/${key}`, 'high')));
    if (extra) Object.assign(nodes.get(id).attrs, extra);
    return nodes.get(id);
  };

  for (const [name, a] of [...svc].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const durs = ascending(a.serverDurs.length ? a.serverDurs : a.allDurs);
    const cycles = [...a.cycles].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, MAX_CYCLES)
      .map(([path, n]) => ({ path, traces: n }));
    const attrs = st.attrs({
      span_count: a.count,
      trace_count: a.traces,
      error_rate: round(a.count ? a.errors / a.count : 0, 4),
      p50_ms: round(ms(percentile(durs, 50) ?? 0)),
      p95_ms: round(ms(percentile(durs, 95) ?? 0)),
      p99_ms: round(ms(percentile(durs, 99) ?? 0)),
      fan_out_p95: percentile(ascending(a.fanOuts), 95),
      depth_p95: percentile(ascending(a.depths), 95),
      cross_calls_per_trace_p95: percentile(ascending(a.cc), 95),
      call_cycles: cycles.length ? cycles : null,
      code_root: codeRootOf(options, name),
      duplicate_spans: dupes.get(name) ?? null,
      truncated: meta.truncated ? true : null,
    });
    services.push(nodeFact('service', name, { name }, st.prov(`service/${name}`, 'medium')));
    services[services.length - 1].attrs = attrs;
  }

  for (const e of [...edges.values()].sort((x, y) => (`${x.from}\0${x.to}` < `${y.from}\0${y.to}` ? -1 : 1))) {
    const perTrace = ascending(e.perTrace);
    callEdges.push(edgeFact('RUNTIME_CALLS', `service:${e.from}`, `service:${e.to}`, st.attrs({
      ...summarise(e.durs, e.errors, e.count),
      per_request_p95: percentile(perTrace, 95),
      traces: e.perTrace.length,
      truncated: meta.truncated ? true : null,
    }), st.prov(`edge/${e.from}->${e.to}`, e.observed ? 'high' : 'medium')));
  }

  for (const a of endpoints.values()) {
    const node = addNode('endpoint', a.key, a.key);
    Object.assign(node.attrs, nodeAttrs.endpoint.get(a.key));
    others.push(edgeFact('EXPOSES', `service:${a.service}`, node.id, st.attrs(summarise(a.durs, a.errors, a.count)),
      st.prov(`endpoint/${a.service}/${a.key}`, 'high')));
  }
  for (const a of tables.values()) {
    const node = addNode('table', a.table, a.table);
    Object.assign(node.attrs, nodeAttrs.table.get(a.table));
    others.push(edgeFact(a.rel, `service:${a.service}`, node.id, st.attrs({ ...summarise(a.durs, a.errors, a.count), statement_shape: a.shape }),
      st.prov(`table/${a.service}/${a.rel}/${a.table}`, 'high')));
  }
  for (const a of topics.values()) {
    const node = addNode('topic', a.topic, a.topic);
    Object.assign(node.attrs, nodeAttrs.topic.get(a.topic));
    others.push(edgeFact(a.rel, `service:${a.service}`, node.id, st.attrs(summarise(a.durs, a.errors, a.count)),
      st.prov(`topic/${a.service}/${a.rel}/${a.topic}`, 'high')));
  }
  for (const n of nodes.values()) n.attrs = st.attrs(n.attrs);

  return [...sortFacts(services), ...sortFacts(callEdges), ...sortFacts([...nodes.values(), ...others])];
}
