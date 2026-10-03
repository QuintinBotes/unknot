import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFact } from '../../../../runtime/graph/facts.mjs';
import { summarizeRuntime } from '../../../../adapters/runtime/index.mjs';
import { parseCollapsed, parseSpeedscope, hotspots } from '../../../../adapters/runtime/profiles.mjs';
import { parseMetrics } from '../../../../adapters/runtime/metrics.mjs';
import { edge, find, NOW, run, runFixtures } from './helpers.mjs';

test('metrics: Prometheus snapshot aggregates per service', async () => {
  const facts = await runFixtures({ metrics: ['metrics.prom'] });
  facts.forEach(assertFact);
  const c = find(facts, 'service:checkout');
  assert.equal(c.attrs.cpu_cores_p95, 1.1); // pods of one service add up
  assert.equal(c.attrs.memory_bytes_p95, 536870912);
  assert.equal(c.attrs.replicas, 3);
  assert.equal(c.attrs.error_ratio, 0.0099); // 90 / 9090 from the code="500" series
  assert.equal(c.provenance.confidence, 'medium');
  assert.equal(c.provenance.source_type, 'trace');
  // Snapshot without sample timestamps is observed "now".
  assert.deepEqual(c.attrs.observed_window, { start: NOW, end: NOW });
  assert.equal(c.attrs.expires_at, '2026-09-19T00:00:00.000Z');
  assert.equal(find(facts, 'service:pricing').attrs.error_ratio, 0);
});

test('metrics: CSV time series yields p95 and request-rate CV', async () => {
  const facts = await runFixtures({ metrics: ['metrics.csv'] });
  const inv = find(facts, 'service:inventory');
  assert.equal(inv.attrs.request_rate_p95, 95);
  assert.ok(inv.attrs.request_rate_cv > 1, 'bursty traffic has high CV');
  assert.equal(inv.attrs.error_ratio, 0.02);
  assert.equal(find(facts, 'service:pricing').attrs.request_rate_cv, 0); // flat traffic
  assert.equal(inv.attrs.observed_window.start, '2026-09-01T00:00:00.000Z');
  assert.equal(inv.attrs.observed_window.end, '2026-09-01T00:07:00.000Z');
});

test('metrics: JSON rows, counters to rates, unknown metrics ignored', () => {
  const rows = [
    { service: 's', metric: 'http_requests_total', timestamp: 0, value: 0 },
    { service: 's', metric: 'http_requests_total', timestamp: 60, value: 600 },
    { service: 's', metric: 'http_requests_total', timestamp: 120, value: 1800 },
    { service: 's', metric: 'secret_metric', timestamp: 120, value: 1 },
    { labels: { service: 't' }, metric: 'replicas', timestamp: '2026-09-01T00:00:00Z', value: 2 },
  ];
  const { format, samples } = parseMetrics(JSON.stringify(rows));
  assert.equal(format, 'json');
  assert.equal(samples.length, 4);
});

test('metrics: JSON counter rates feed request_rate_p95', async () => {
  const rows = [0, 600, 1800].map((v, i) => ({ service: 's', metric: 'http_requests_total', timestamp: i * 60, value: v }));
  const facts = await run({ metrics: ['m.json'] }, { 'm.json': JSON.stringify(rows) });
  assert.equal(find(facts, 'service:s').attrs.request_rate_p95, 20); // rates 10/s then 20/s
});

test('profiles: collapsed stacks, top-50 cap, service_map names the node', async () => {
  const facts = await runFixtures({ profiles: ['checkout.collapsed.txt'] }, { service_map: { checkout: 'services/checkout' } });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, 'service:checkout');
  assert.equal(facts[0].attrs.code_root, 'services/checkout');
  assert.deepEqual(facts[0].attrs.hotspots[0], { frame: 'serialize_json', self_pct: 50 });
  const synthetic = await runFixtures({ profiles: ['checkout.collapsed.txt'] });
  assert.equal(synthetic[0].id, 'module:~profile/checkout');
  assert.equal(synthetic[0].attrs.synthetic, true);

  const many = Array.from({ length: 120 }, (_, i) => `main;f${i} ${i + 1}`).join('\n');
  assert.equal(hotspots(parseCollapsed(many)).length, 50);
});

test('profiles: speedscope sampled and evented', () => {
  const sampled = parseSpeedscope({
    shared: { frames: [{ name: 'a' }, { name: 'b' }] },
    profiles: [{ type: 'sampled', samples: [[0, 1], [0], [0, 1]], weights: [1, 1, 2] }],
  });
  assert.deepEqual(hotspots(sampled), [{ frame: 'b', self_pct: 75 }, { frame: 'a', self_pct: 25 }]);
  const evented = parseSpeedscope({
    shared: { frames: [{ name: 'a' }, { name: 'b' }] },
    profiles: [{ type: 'evented', events: [{ type: 'O', frame: 0, at: 0 }, { type: 'O', frame: 1, at: 2 }, { type: 'C', frame: 1, at: 8 }, { type: 'C', frame: 0, at: 10 }] }],
  });
  assert.deepEqual(hotspots(evented), [{ frame: 'b', self_pct: 60 }, { frame: 'a', self_pct: 40 }]);
});

test('catalog: services, teams, SLOs, dependencies; YAML skipped; unsafe repo_path refused', async () => {
  const facts = await runFixtures({ catalogs: ['catalog.json'] });
  facts.forEach(assertFact);
  const c = find(facts, 'service:checkout');
  assert.equal(c.provenance.source_type, 'catalog');
  assert.deepEqual([c.attrs.owner, c.attrs.tier, c.attrs.code_root], ['team-orders', 'tier-1', 'services/checkout']);
  assert.deepEqual(c.attrs.slo, { availability: 99.95, latency_p95_ms: 250 });
  assert.equal(find(facts, 'service:pricing').attrs.code_root, undefined); // '../escape' refused
  assert.ok(edge(facts, 'OWNED_BY', 'service:checkout', 'team:team-orders'));
  assert.ok(edge(facts, 'DEPENDS_ON', 'service:pricing', 'service:inventory'));
  assert.ok(edge(facts, 'DESCRIBED_BY', 'service:checkout', 'slo:checkout'));
  assert.equal(find(facts, 'slo:inventory'), undefined); // no slo declared
  assert.equal(c.attrs.observed_window.end, '2026-09-01T00:00:00.000Z'); // the export time, not "now"

  const yaml = await run({ catalogs: ['catalog-info.yaml'] }, { 'catalog-info.yaml': 'kind: Component' });
  assert.deepEqual(yaml, []);
  assert.deepEqual(yaml.failures, []);
});

test('facts per file are capped and flagged', async () => {
  const services = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, owner: 'o' }));
  const facts = await run({ catalogs: ['c.json'] }, { 'c.json': JSON.stringify({ services }) }, { max_facts_per_file: 10 });
  assert.equal(facts.length, 10);
  assert.ok(facts.every((f) => f.attrs.truncated === true));
});

test('summarizeRuntime: services, chatty edges, error hotspots, staleness', async () => {
  const facts = await runFixtures({ traces: ['traces.otlp.json'], metrics: ['metrics.prom'], catalogs: ['catalog.json'] });
  const fresh = summarizeRuntime(facts, '2026-09-02T00:00:00.000Z');
  assert.deepEqual([...new Set(fresh.services.map((s) => s.name))], ['checkout', 'inventory', 'pricing']);
  assert.equal(fresh.chatty_edges[0].calls, 3);
  assert.equal(fresh.chatty_edges[0].from, 'service:checkout');
  assert.ok(fresh.error_hotspots.length > 0);
  assert.ok(fresh.error_hotspots.every((h) => h.error_rate > 0));
  assert.equal(fresh.windows.length, 3);
  assert.deepEqual(fresh.stale_files, []);

  const old = summarizeRuntime(facts, '2027-01-01T00:00:00.000Z');
  assert.deepEqual(old.stale_files, ['catalog.json', 'metrics.prom', 'traces.otlp.json']);
  assert.ok(old.windows.every((w) => w.stale === true && w.age_days > 100));
  assert.equal(summarizeRuntime(facts).windows[0].stale, null);
  assert.deepEqual(summarizeRuntime([]).services, []);
});
