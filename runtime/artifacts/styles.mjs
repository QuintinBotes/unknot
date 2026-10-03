// Architecture style classification (spec §10.2, §10.3). Each recognizer looks for
// evidence in the graph and states what it found; nothing is claimed without evidence,
// several styles may hold at once, and evidence that conflicts is reported as such rather
// than resolved silently.
//
// Labels: `observed` = direct structural evidence (nodes/edges); `corroborated` = two
// independent kinds of evidence agree (e.g. layer directory names AND import direction);
// `inferred` = a plausible reading from names or one weak signal; `contradicted` = the
// evidence for the style is outweighed by conflicting evidence; `unknown` = nothing usable.

import { stronglyConnected } from '../graph/algorithms.mjs';
import { Graph } from '../graph/graph.mjs';
import { appModules, dedupe, moduleOf, unitEdges, unitModel, unitOf, WRITE_EDGES } from './model.mjs';

const LAYERS = [
  ['presentation', /^(controllers?|handlers?|routes?|routers?|api|web|presentation|ui|pages|endpoints|resources)$/],
  ['business', /^(services?|application|business|domain|logic|usecases?|use-cases?|core)$/],
  ['data', /^(repositor(y|ies)|dao|daos|persistence|data|db|database|stores?)$/],
];

const HEX = {
  domain: /^(domain|core|entities)$/,
  application: /^(application|usecases?|use-cases?)$/,
  ports: /^ports?$/,
  adapters: /^(adapters?|infrastructure|infra|driven|driving)$/,
};

const segs = (m) => (m.path ?? '').toLowerCase().split('/').slice(0, -1);
const rank = { corroborated: 0, observed: 1, inferred: 2, contradicted: 3, unknown: 4 };
const refs = (list, n = 5) => list.slice(0, n).map((x) => x.id ?? x);
const entry = (style, label, summary, evidence) => ({ style, label, summary, evidence });
const ev = (summary, list = []) => ({ summary, refs: refs(list) });

/** Group app modules by the last directory segment matching one of the named patterns. */
function bucketModules(mods, table) {
  const out = new Map(table.map(([name]) => [name, []]));
  const of = new Map();
  for (const m of mods) {
    const s = segs(m);
    for (let i = s.length - 1; i >= 0; i--) {
      const hit = table.find(([, re]) => re.test(s[i]));
      if (hit) { out.get(hit[0]).push(m); of.set(m.id, hit[0]); break; }
    }
  }
  return { out, of };
}

function importPairs(graph, of) {
  const pairs = [];
  for (const e of graph.edges('IMPORTS')) {
    const a = of.get(e.from);
    const b = of.get(e.to);
    if (a && b) pairs.push({ a, b, e });
  }
  return pairs;
}

function layered(graph, mods) {
  const { out, of } = bucketModules(mods, LAYERS);
  const present = LAYERS.map(([n]) => n).filter((n) => out.get(n).length);
  if (present.length < 3) return null;
  const order = LAYERS.map(([n]) => n);
  let down = 0;
  let up = 0;
  const upEdges = [];
  for (const { a, b, e } of importPairs(graph, of)) {
    const d = order.indexOf(b) - order.indexOf(a);
    if (d > 0) down++;
    else if (d < 0) { up++; upEdges.push(e); }
  }
  const evidence = [ev(`layer directories present: ${present.map((n) => `${n} (${out.get(n).length} modules)`).join(', ')}`, present.flatMap((n) => out.get(n)))];
  if (down + up === 0) return entry('layered', 'inferred', 'Layer-named directories exist, but no imports between layers were observed.', evidence);
  evidence.push(ev(`${down} imports point down the layers, ${up} point up`, upEdges));
  if (up === 0) return entry('layered', 'corroborated', 'Layer-named directories and strictly one-directional imports agree.', evidence);
  if (up / (up + down) <= 0.1) return entry('layered', 'observed', 'Layer-named directories with mostly one-directional imports; a few upward imports violate the layering.', evidence);
  return entry('layered', 'contradicted', 'Layer-named directories exist but imports run both ways between layers.', evidence);
}

function hexagonal(graph, mods) {
  const { out, of } = bucketModules(mods, Object.entries(HEX));
  const cats = Object.keys(HEX).filter((k) => out.get(k).length);
  if (!out.get('domain').length || cats.length < 3) return null;
  const evidence = [ev(`directories present: ${cats.map((c) => `${c} (${out.get(c).length})`).join(', ')}`, cats.flatMap((c) => out.get(c)))];
  const pairs = importPairs(graph, of);
  const violations = pairs.filter((p) => p.a === 'domain' && p.b === 'adapters');
  const inward = pairs.filter((p) => p.a === 'adapters' && ['domain', 'application', 'ports'].includes(p.b));
  if (violations.length) {
    evidence.push(ev(`${violations.length} import(s) from domain code into adapters/infrastructure break the dependency rule`, violations.map((v) => v.e)));
    return entry('hexagonal/clean', 'contradicted', 'Ports/adapters/domain directories exist, but domain code depends on infrastructure.', evidence);
  }
  if (inward.length) {
    evidence.push(ev(`${inward.length} adapter import(s) point inward and none point from domain outward`, inward.map((v) => v.e)));
    return entry('hexagonal/clean', 'corroborated', 'Directory structure and the inward-only dependency rule agree.', evidence);
  }
  return entry('hexagonal/clean', 'inferred', 'Hexagonal/clean directory names are present; dependency direction could not be confirmed from imports.', evidence);
}

function mvc(graph, mods) {
  const { out, of } = bucketModules(mods, [
    ['controllers', /^controllers?$/], ['views', /^(views?|templates?)$/], ['models', /^models?$/], ['viewmodels', /^view-?models?$/],
  ]);
  const has = (k) => out.get(k).length > 0;
  const kind = has('viewmodels') && has('views') ? 'MVVM' : has('controllers') && has('views') && has('models') ? 'MVC' : null;
  if (!kind) return null;
  const mid = kind === 'MVVM' ? 'viewmodels' : 'controllers';
  const names = [mid, 'views', 'models'].filter(has);
  const evidence = [ev(`directories present: ${names.map((c) => `${c} (${out.get(c).length})`).join(', ')}`, names.flatMap((c) => out.get(c)))];
  const pairs = importPairs(graph, of);
  const midToModel = pairs.filter((p) => p.a === mid && p.b === 'models');
  const viewToModel = pairs.filter((p) => p.a === 'views' && p.b === 'models');
  if (midToModel.length) {
    evidence.push(ev(`${midToModel.length} import(s) from ${mid} to models${viewToModel.length ? `; ${viewToModel.length} view(s) also import models directly` : ''}`, midToModel.map((p) => p.e)));
    return entry(kind, viewToModel.length && kind === 'MVVM' ? 'contradicted' : 'corroborated', `${kind} directories and ${mid}-to-model imports agree.`, evidence);
  }
  return entry(kind, 'inferred', `${kind}-style directory names are present; no confirming imports.`, evidence);
}

function microkernel(graph, mods) {
  const plugins = mods.filter((m) => segs(m).some((s) => /^(plugins?|extensions?|addons?)$/.test(s)));
  if (plugins.length < 2) return null;
  const isPlugin = new Set(plugins.map((m) => m.id));
  const registryRe = /(registry|plugin[-_]?(manager|loader|host)|extension[-_]?host)/i;
  const registry = [...mods, ...graph.nodes('class')].filter((n) => !isPlugin.has(n.id) && registryRe.test(`${n.name ?? ''} ${n.path ?? ''}`));
  const evidence = [ev(`${plugins.length} modules live in a plugins/extensions directory`, plugins)];
  if (!registry.length) return entry('microkernel/plugin', 'inferred', 'A plugin directory exists, but no registry or loader was found.', evidence);
  evidence.push(ev('registry/loader found outside the plugin directory', registry));
  const registryMods = new Set(registry.map((r) => moduleOf(graph, r.id)?.id ?? r.id));
  const toCore = graph.edges('IMPORTS').filter((e) => isPlugin.has(e.from) && (registryMods.has(e.to) || (!isPlugin.has(e.to) && graph.node(e.to)?.type === 'module')));
  if (toCore.length) {
    evidence.push(ev(`${toCore.length} plugin import(s) of the core/registry`, toCore));
    return entry('microkernel/plugin', 'corroborated', 'Plugins register against a core; directory structure and imports agree.', evidence);
  }
  return entry('microkernel/plugin', 'observed', 'A plugin directory and a registry/loader both exist.', evidence);
}

/** Producers and consumers of a channel node, as unit ids when known else node ids. */
function channelActors(graph, ch, primary) {
  const label = (id) => unitOf(graph, primary, id) ?? id;
  const pubs = graph.in(ch.id, 'PUBLISHES').map((e) => ({ id: label(e.from), e }));
  const subs = graph.in(ch.id, ['SUBSCRIBES', 'CONSUMES']).map((e) => ({ id: label(e.from), e }));
  return { pubs, subs };
}

function eventDriven(graph, primary) {
  const topics = [...graph.nodes('topic'), ...graph.nodes('event')];
  if (!topics.length) return null;
  const wired = [];
  const actors = new Set();
  const edges = [];
  for (const t of topics) {
    const { pubs, subs } = channelActors(graph, t, primary);
    if (pubs.length && subs.length) {
      wired.push(t);
      for (const a of [...pubs, ...subs]) { actors.add(a.id); edges.push(a.e); }
    }
  }
  if (!wired.length) {
    return entry('event-driven', 'inferred', 'Topics/events exist, but none has both a publisher and a subscriber in the graph.', [ev(`${topics.length} topic/event node(s) without a complete publisher-subscriber pair`, topics)]);
  }
  const evidence = [ev(`${wired.length} of ${topics.length} topics have publishers and subscribers (${actors.size} distinct actors)`, wired)];
  const label = edges.some((e) => e.label === 'corroborated') ? 'corroborated' : actors.size >= 2 ? 'observed' : 'inferred';
  return entry('event-driven', label, 'Components communicate through topics with observed publishers and subscribers.', evidence);
}

function webQueueWorker(graph, primary) {
  const endpoints = graph.nodes('endpoint');
  const queues = graph.nodes('queue');
  if (!endpoints.length || !queues.length) return null;
  const wired = queues.filter((q) => {
    const { pubs, subs } = channelActors(graph, q, primary);
    return pubs.length && subs.length;
  });
  if (!wired.length) return null;
  const jobs = graph.nodes('job');
  const evidence = [ev(`${endpoints.length} HTTP endpoint(s)`, endpoints), ev(`${wired.length} queue(s) with producers and consumers`, wired)];
  if (jobs.length) {
    evidence.push(ev(`${jobs.length} job node(s)`, jobs));
    return entry('web-queue-worker', 'observed', 'Endpoints enqueue work that background jobs consume.', evidence);
  }
  return entry('web-queue-worker', 'inferred', 'Endpoints and a produced/consumed queue exist; no job nodes identify the worker side.', evidence);
}

function serverless(graph) {
  const fns = graph.nodes('cloud_function');
  if (!fns.length) return null;
  const servers = graph.nodes('workload').length + graph.nodes('compute').length;
  const evidence = [ev(`${fns.length} function resource(s)`, fns)];
  if (servers) evidence.push(ev(`${servers} workload/compute node(s) also exist (hybrid)`, [...graph.nodes('workload'), ...graph.nodes('compute')]));
  return entry('serverless', 'observed', servers ? 'Functions are deployed alongside long-running workloads.' : 'Compute is declared as cloud functions.', evidence);
}

function pipelines(graph) {
  const jobs = graph.nodes('job');
  if (!jobs.length) return null;
  const isJob = new Set(jobs.map((j) => j.id));
  const next = new Map(jobs.map((j) => [j.id, new Set()]));
  for (const e of graph.edges('DEPENDS_ON')) if (isJob.has(e.from) && isJob.has(e.to)) next.get(e.to).add(e.from);
  // A job that publishes to a channel feeds every job subscribed to it.
  for (const ch of [...graph.nodes('topic'), ...graph.nodes('queue')]) {
    const pubs = graph.in(ch.id, 'PUBLISHES').map((e) => e.from).filter((x) => isJob.has(x));
    const subs = graph.in(ch.id, ['SUBSCRIBES', 'CONSUMES']).map((e) => e.from).filter((x) => isJob.has(x));
    for (const p of pubs) for (const s of subs) if (p !== s) next.get(p).add(s);
  }
  const memo = new Map();
  const longest = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 1;
    seen.add(id);
    let best = 1;
    for (const n of next.get(id) ?? []) best = Math.max(best, 1 + longest(n, seen));
    seen.delete(id);
    memo.set(id, best);
    return best;
  };
  const depth = Math.max(...jobs.map((j) => longest(j.id)));
  const evidence = [ev(`${jobs.length} job node(s); longest chain ${depth}`, jobs)];
  if (depth >= 3) return entry('pipes-and-filters/batch', 'observed', 'Jobs form a chain of three or more stages.', evidence);
  return entry('pipes-and-filters/batch', 'inferred', 'Batch jobs exist but do not form a multi-stage chain.', evidence);
}

function deployUnitSignals(graph, model) {
  const deploy = model.deploy;
  const units = deploy.units;
  const signals = [];
  // Co-deployment: one pipeline/build target ships several units.
  for (const n of [...graph.nodes('pipeline'), ...graph.nodes('build_target'), ...graph.nodes('builder')]) {
    const targets = dedupe(graph.out(n.id, ['BUILDS', 'DEPLOYS', 'DEPLOYS_TO']).map((e) => unitOf(graph, deploy, e.to)).filter(Boolean));
    if (targets.length >= 2) signals.push({ kind: 'co-deployment', text: `${n.name} builds or deploys ${targets.length} units together`, refs: [n.id] });
  }
  // Shared persistence: one table written by several units.
  const writers = new Map();
  for (const e of graph.edges()) {
    if (!WRITE_EDGES.includes(e.type)) continue;
    const t = graph.node(e.to);
    if (!t || !['table', 'collection'].includes(t.type)) continue;
    const u = unitOf(graph, deploy, e.from);
    if (!u) continue;
    if (!writers.has(t.id)) writers.set(t.id, new Set());
    writers.get(t.id).add(u);
  }
  const shared = [...writers].filter(([, s]) => s.size >= 2);
  if (shared.length) signals.push({ kind: 'shared-tables', text: `${shared.length} table(s) are written by more than one unit`, refs: shared.map(([id]) => id) });
  // Synchronous call cycles between units.
  const g = new Graph();
  for (const u of units) g.addNode(u.id, 'service');
  for (const w of unitEdges(graph, deploy, ['RUNTIME_CALLS']).values()) g.addEdge('IMPORTS', w.from, w.to);
  const cycles = stronglyConnected(g);
  if (cycles.length) signals.push({ kind: 'call-cycle', text: `${cycles.length} call cycle(s) between units`, refs: cycles[0] });
  // Change coupling across unit boundaries.
  const strong = graph.edges('CO_CHANGES').filter((e) => {
    const a = unitOf(graph, deploy, e.from);
    const b = unitOf(graph, deploy, e.to);
    return a && b && a !== b && (e.attrs.degree ?? 0) >= 0.5 && (e.attrs.shared ?? 0) >= 5;
  });
  if (strong.length >= 3) signals.push({ kind: 'co-change', text: `${strong.length} module pair(s) in different units change together`, refs: strong.slice(0, 5).map((e) => e.from) });
  return signals;
}

function services(graph, model) {
  const units = model.deploy.units;
  const out = [];
  if (units.length < 2) return out;
  const calls = [...unitEdges(graph, model.deploy, ['RUNTIME_CALLS']).values()];
  const manifests = new Set(units.flatMap((u) => u.nodeIds.map((id) => graph.node(id)?.path).filter(Boolean)));
  const signals = deployUnitSignals(graph, model);
  if (units.length >= 3) {
    const evidence = [ev(`${units.length} deployable units: ${units.slice(0, 6).map((u) => u.name).join(', ')}`, units.flatMap((u) => u.nodeIds))];
    if (calls.length) evidence.push(ev(`${calls.length} service-to-service RUNTIME_CALLS edge(s)`, calls.flatMap((c) => c.edges)));
    if (manifests.size >= 3) evidence.push(ev(`${manifests.size} distinct deployment manifests`, units.flatMap((u) => u.nodeIds)));
    let label = calls.length && manifests.size >= 3 ? 'corroborated' : calls.length || manifests.size >= 3 ? 'observed' : 'inferred';
    let summary = 'Several independently deployable services that call each other.';
    if (signals.length >= 2) {
      label = 'contradicted';
      summary = 'Several deployable services exist, but co-deployment, shared tables or call cycles contradict independence.';
      evidence.push(...signals.map((s) => ev(`conflicting: ${s.text}`, s.refs)));
    }
    out.push(entry('microservices', label, summary, evidence));
  } else {
    out.push(entry('service-based', calls.length ? 'observed' : 'inferred', `${units.length} deployable units${calls.length ? ' with observed calls' : ''}.`, [ev(`${units.length} units: ${units.map((u) => u.name).join(', ')}`, units.flatMap((u) => u.nodeIds))]));
  }
  if (signals.length) {
    out.push(entry('distributed monolith', signals.length >= 2 ? 'corroborated' : 'inferred',
      signals.length >= 2 ? 'Independent signals indicate services that must change and ship together.' : 'One coupling signal between deployable units; not enough to conclude.',
      signals.map((s) => ev(s.text, s.refs))));
  }
  return out;
}

function modularMonolith(graph, mods, model) {
  const deployUnits = model.deploy.units;
  if (deployUnits.length > 1) return null;
  const set = model.pkg.units.length >= 3 ? model.pkg : model.dirs;
  const populated = set.units.filter((u) => u.moduleCount > 0);
  if (populated.length < 3) return null;
  const imports = graph.edges('IMPORTS').filter((e) => set.moduleUnit.has(e.from) && set.moduleUnit.has(e.to));
  if (imports.length < 5) return null;
  const cross = imports.filter((e) => set.moduleUnit.get(e.from) !== set.moduleUnit.get(e.to)).length;
  const ratio = cross / imports.length;
  if (ratio > 0.35) return null;
  const declared = set === model.pkg;
  const evidence = [
    ev(`${populated.length} ${declared ? 'declared packages' : 'top-level directories'} with modules`, populated.flatMap((u) => u.nodeIds)),
    ev(`${(ratio * 100).toFixed(0)}% of ${imports.length} imports cross a boundary`, []),
  ];
  if (deployUnits.length === 1) evidence.push(ev(`a single deployable unit: ${deployUnits[0].name}`, deployUnits[0].nodeIds));
  const label = deployUnits.length === 1 ? (declared ? 'corroborated' : 'observed') : 'inferred';
  const summary = deployUnits.length === 1 ? 'One deployable with low coupling between internal boundaries.' : 'Low coupling between internal boundaries; no deployment topology was observed, so single-deployable is assumed.';
  return entry('modular monolith', label, summary, evidence);
}

/**
 * @param {import('../graph/graph.mjs').Graph} graph
 * @returns {{style: string, label: string, summary: string, evidence: {summary: string, refs: string[]}[]}[]}
 */
export function classifyStyles(graph) {
  const mods = appModules(graph);
  const model = unitModel(graph);
  const found = [
    layered(graph, mods),
    hexagonal(graph, mods),
    mvc(graph, mods),
    microkernel(graph, mods),
    modularMonolith(graph, mods, model),
    ...services(graph, model),
    eventDriven(graph, model.deploy.units.length ? model.deploy : model.primary),
    webQueueWorker(graph, model.deploy.units.length ? model.deploy : model.primary),
    serverless(graph),
    pipelines(graph),
  ].filter(Boolean);
  const claimed = found.filter((s) => s.label !== 'contradicted' && s.label !== 'unknown');
  if (claimed.length >= 2) {
    found.push(entry('hybrid', 'inferred', `Evidence supports several styles at once: ${claimed.map((s) => s.style).join(', ')}.`, [ev('combination of the styles above', [])]));
  }
  if (!found.length) {
    return [entry('unknown', 'unknown', 'The graph holds too little structure to classify an architecture style.', [ev(`${mods.length} source module(s) and ${graph.size.edges} edge(s) analysed`, [])])];
  }
  return found.sort((a, b) => rank[a.label] - rank[b.label]);
}
