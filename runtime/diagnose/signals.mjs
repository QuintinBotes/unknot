// Measured signals for the pattern engine (patterns/README.md vocabulary). Global signals
// describe what evidence exists at all; scope signals describe the nodes a finding is
// about. A signal that cannot be measured is left out, never defaulted.

import { contractEvidence } from '../decompose/contracts.mjs';

const DRIVERS = ['independent_deploy', 'independent_scale', 'availability_isolation', 'security_isolation', 'team_autonomy', 'technology_divergence', 'build_time'];

export function globalSignals(graph, config) {
  const s = {};
  s['traces.available'] = graph.edges('RUNTIME_CALLS').length > 0 || graph.nodes('service').some((n) => n.attrs.span_count) ? 1 : 0;
  s['metrics.available'] = graph.nodes('service').some((n) => n.attrs.cpu_cores_p95 != null || n.attrs.request_rate_p95 != null) ? 1 : 0;
  s['ci.present'] = graph.nodes('workflow').length > 0 ? 1 : 0;
  s['service.count'] = graph.nodes('service').length;
  const teams = new Set(graph.edges('OWNED_BY').map((e) => e.to));
  if (teams.size) s['team.count'] = teams.size;
  const recorded = new Set((config.decomposition?.drivers ?? []).map((d) => d.id));
  for (const d of DRIVERS) s[`driver.${d}`] = recorded.has(d) ? 1 : 0;
  s['driver.any'] = recorded.size > 0 ? 1 : 0;
  return s;
}

/** Signals about a set of nodes (a finding's subject or a decomposition candidate). */
export function scopeSignals(graph, ids) {
  const set = new Set(ids);
  const s = {};
  let tests = 0;
  const owners = new Set();
  const consumers = new Set();
  for (const id of set) {
    for (const e of graph.in(id, 'TESTS')) tests++;
    for (const e of graph.out(id, 'OWNED_BY')) owners.add(e.to);
    for (const e of graph.in(id, 'IMPORTS')) if (!set.has(e.from)) consumers.add(e.from);
  }
  s['tests.present'] = tests;
  if (owners.size) s['owners.count'] = owners.size;
  s['module.consumers'] = consumers.size;
  const contract = contractEvidence(graph, set);
  s['contracts.present'] = contract.present ? 1 : 0;
  if (contract.present) s['clients.count'] = contract.clients;
  return s;
}
