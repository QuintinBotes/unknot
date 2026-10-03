// Frontend detectors (spec §15A.9, §15A.10). The modular frontend monolith is the default
// remedy; micro-frontend findings appear only when there is already more than one app,
// because "Micro Frontend as the Goal" is itself the anti-pattern.

import { analyzeFrontend, featureOf } from '../../decompose/frontend.mjs';

const UI_DEPS = /^dependency:(react|react-dom|vue|@angular\/core|svelte|solid-js|preact|next|nuxt|@remix-run\/react)$/;

function frontendApps(graph) {
  return graph.nodes('package').filter((p) => graph.out(p.id, 'DEPENDS_ON').some((e) => UI_DEPS.test(e.to)));
}

const common = {
  recovery: { type: 'revert' },
  quality_impacts: { changeability: 'high', reliability: 'low', security: 'low' },
  verification: ['Build and route-level smoke tests pass', 'Bundle size per route within budget', 'Accessibility checks unchanged'],
};

const crossFeature = {
  id: 'frontend.cross-feature-imports',
  version: '1.0.0',
  category: 'frontend',
  kinds: ['frontend.cross-feature-imports'],
  detect({ graph, options }) {
    const min = options.min_imports ?? 3;
    const pairs = new Map();
    const fe = analyzeFrontend(graph);
    const set = new Set(fe.modules);
    for (const id of fe.modules) {
      const from = featureOf(graph.node(id).path ?? id.slice(7));
      if (!from) continue;
      for (const e of graph.out(id, 'IMPORTS')) {
        if (!set.has(e.to)) continue;
        const to = featureOf(graph.node(e.to).path ?? e.to.slice(7));
        if (!to || to === from) continue;
        const k = `${from}→${to}`;
        if (!pairs.has(k)) pairs.set(k, []);
        pairs.get(k).push([id, e.to]);
      }
    }
    return [...pairs].filter(([, l]) => l.length >= min).map(([k, l]) => ({
      ...common,
      kind: 'frontend.cross-feature-imports',
      title: `Feature ${k.split('→')[0]} imports ${l.length} module(s) from ${k.split('→')[1]}`,
      scope: [...new Set(l.flat().map((m) => m.slice(7)))],
      key: `xfeature:${k}`,
      evidence: l.slice(0, 5).map(([a, b]) => ({ ref: a, label: 'observed', summary: `imports ${b.slice(7)}` })),
      measurements: { 'frontend.cross_feature_imports': l.length },
      thresholds: { min_imports: min, note: 'heuristic' },
      blast_radius: 'bounded',
      why_accidental: 'Features that reach into each other cannot be changed, tested or owned independently; the folder structure promises a separation the imports do not keep.',
      essential_considerations: ['The imported code may really be shared (entities/shared layer) and only needs to move there'],
      smallest_simplification: 'Move the imported pieces to a shared/entities layer or expose them through the feature\'s public index, then add a lint rule in warn mode.',
      invariants: ['Rendered output and routes unchanged'],
      risks: ['Moving modules changes import paths'],
      factors: { benefit: 3, evidence: 0.8, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 1 },
      uncertainties: [],
      alternatives: [{ id: 'retain', summary: 'Keep it if the features are one feature in practice; merge the folders instead.' }, { id: 'frontend-modular-monolith', summary: 'Enforce feature boundaries with lint rules (T8).' }],
      patterns: ['decomposition.frontend-modular-monolith', 'frontend.feature-sliced-design'],
    }));
  },
};

const layerViolation = {
  id: 'frontend.layer-violation',
  version: '1.0.0',
  category: 'frontend',
  kinds: ['frontend.layer-violation'],
  detect({ graph }) {
    const fe = analyzeFrontend(graph);
    const ups = fe.violations.filter((v) => v.kind === 'upward-layer-import');
    if (!ups.length) return [];
    return [{
      ...common,
      kind: 'frontend.layer-violation',
      title: `${ups.length} import(s) point upward across Feature-Sliced Design layers`,
      scope: [...new Set(ups.map((v) => v.from))].slice(0, 50),
      key: 'fsd-upward',
      evidence: ups.slice(0, 8).map((v) => ({ ref: `module:${v.from}`, label: 'observed', summary: `${v.from_layer} → ${v.to_layer}: ${v.to}` })),
      measurements: { 'layer.violations': ups.length },
      thresholds: {},
      blast_radius: 'bounded',
      why_accidental: 'Lower layers importing higher ones creates hidden cycles and makes shared code depend on page-specific code.',
      essential_considerations: [],
      smallest_simplification: 'Invert each upward import (pass data/callbacks down, or move the shared piece to a lower layer); add the layer rule in warn mode with a baseline.',
      invariants: ['Rendered output unchanged'],
      risks: [],
      factors: { benefit: 3, evidence: 0.9, reversibility: 0.9, blast: 2, cost: 2, uncertainty: 1 },
      uncertainties: [],
      alternatives: [{ id: 'retain', summary: 'Drop FSD naming if the project does not intend layering.' }, { id: 'enforce-layers', summary: 'Warn-mode lint rule with a baseline (T8).' }],
      patterns: ['frontend.feature-sliced-design', 'decomposition.frontend-modular-monolith'],
    }];
  },
};

const megaFrontend = {
  id: 'frontend.mega-frontend',
  version: '1.0.0',
  category: 'frontend',
  kinds: ['frontend.mega-frontend'],
  detect({ graph, options }) {
    const fe = analyzeFrontend(graph);
    const routes = fe.signals['frontend.routes'];
    const teams = fe.signals['frontend.teams'] ?? 0;
    if (routes < (options.min_routes ?? 40) || teams < (options.min_teams ?? 3)) return [];
    return [{
      ...common,
      kind: 'frontend.mega-frontend',
      title: `One frontend with ${routes} routes owned by ${teams} teams`,
      scope: fe.groups.flatMap((g) => g.modules.slice(0, 3)).map((m) => m.slice(7)).slice(0, 50),
      key: 'mega-frontend',
      evidence: fe.groups.slice(0, 6).map((g) => ({ ref: g.routes[0], label: 'observed', summary: `/${g.name}: ${g.routes.length} routes, teams ${g.teams.join(', ') || 'unknown'}` })),
      measurements: { 'frontend.routes': routes, 'frontend.teams': teams },
      thresholds: { min_routes: options.min_routes ?? 40, min_teams: options.min_teams ?? 3, note: 'heuristic' },
      blast_radius: 'high',
      why_accidental: 'Many teams sharing one frontend build and release train turns every release into a coordination exercise.',
      essential_considerations: ['A shared release train can be cheaper than the duplication micro-frontends bring'],
      smallest_simplification: 'Enforce feature boundaries first (T8); consider routing one low-coupling route group separately only with a recorded independent-deploy driver (T7).',
      invariants: ['Routes, auth/session and design system unchanged'],
      risks: ['Premature split duplicates runtime dependencies and breaks soft navigation'],
      factors: { benefit: 3, evidence: 0.6, reversibility: 0.7, blast: 4, cost: 4, uncertainty: 3 },
      uncertainties: ['Navigation analytics were not provided; cross-route navigation cost is unknown'],
      alternatives: [{ id: 'retain', summary: 'Keep one app and invest in build performance.' }, { id: 'frontend-modular-monolith', summary: 'T8 first.' }, { id: 'micro-frontend-by-route', summary: 'T7, only with a driver.' }],
      patterns: ['decomposition.frontend-modular-monolith', 'decomposition.micro-frontend-by-route'],
    }];
  },
};

const mfeOwnershipAndRelease = {
  id: 'frontend.mfe-coupling',
  version: '1.0.0',
  category: 'frontend',
  kinds: ['frontend.mfe-common-ownership', 'frontend.mfe-lockstep-release', 'frontend.nano-frontend'],
  detect({ graph }) {
    const apps = frontendApps(graph);
    if (apps.length < 2) return [];
    const out = [];
    const owners = new Set();
    for (const a of apps) for (const e of graph.out(a.id, 'OWNED_BY')) owners.add(e.to);
    if (owners.size === 1) {
      out.push({
        ...common,
        kind: 'frontend.mfe-common-ownership',
        title: `${apps.length} frontend apps are all owned by one team`,
        scope: apps.map((a) => a.path ?? a.name),
        key: 'mfe-common-ownership',
        evidence: apps.map((a) => ({ ref: a.id, label: 'observed', summary: `owned by ${[...owners][0]}` })),
        measurements: { 'frontend.teams': 1 },
        thresholds: {},
        blast_radius: 'moderate',
        why_accidental: 'Micro-frontends buy team autonomy; one team owning all of them pays the integration cost without the benefit ("Common Ownership" anti-pattern).',
        essential_considerations: ['Separate apps can be justified by different runtimes or release cadences even with one owner'],
        smallest_simplification: 'Record the driver for keeping separate apps; if none, plan a consolidation behind the existing routes.',
        invariants: ['URLs and auth unchanged'],
        risks: ['Consolidation changes build and deploy pipelines'],
        factors: { benefit: 2, evidence: 0.7, reversibility: 0.6, blast: 3, cost: 3, uncertainty: 2 },
        uncertainties: ['Ownership comes from CODEOWNERS/catalog only'],
        alternatives: [{ id: 'retain', summary: 'Keep separate apps if a recorded driver needs them.' }, { id: 'consolidate', summary: 'Merge into one modular frontend (T8).' }],
        patterns: ['decomposition.frontend-modular-monolith', 'anti-pattern.golden-hammer'],
      });
    }
    const together = apps.filter((a) => (a.attrs.co_deployed_with ?? []).length || graph.in(a.id, 'DEPLOYS').some((e) => graph.out(e.from, 'DEPLOYS').length > 1));
    if (together.length >= 2) {
      out.push({
        ...common,
        kind: 'frontend.mfe-lockstep-release',
        title: `${together.length} frontend apps are deployed together`,
        scope: together.map((a) => a.path ?? a.name),
        key: 'mfe-lockstep',
        evidence: together.map((a) => ({ ref: a.id, label: 'inferred', summary: 'deployed by the same job/workflow' })),
        measurements: { 'service.deploy_coupling': 1 },
        thresholds: {},
        blast_radius: 'moderate',
        why_accidental: 'Apps that always release together are one deployable with extra integration seams.',
        essential_considerations: ['Lockstep may be temporary during a migration'],
        smallest_simplification: 'Decouple their pipelines (path filters per app) or merge them; do not keep both costs.',
        invariants: ['Release behaviour of each app unchanged'],
        risks: [],
        factors: { benefit: 2, evidence: 0.5, reversibility: 0.8, blast: 2, cost: 2, uncertainty: 3 },
        uncertainties: ['Deployment coupling is inferred from CI configuration'],
        alternatives: [{ id: 'retain', summary: 'Keep lockstep while a migration is in flight.' }, { id: 'independent-pipelines', summary: 'One pipeline per app.' }],
        patterns: ['decomposition.micro-frontend-by-route', 'anti-pattern.distributed-monolith'],
      });
    }
    for (const a of apps) {
      const routes = graph.nodes('route').filter((r) => graph.out(r.id, 'RENDERS').some((e) => (graph.node(e.to)?.path ?? '').startsWith((a.path ?? '').replace(/package\.json$/, ''))));
      if (routes.length <= 1) {
        out.push({
          ...common,
          kind: 'frontend.nano-frontend',
          title: `${a.name} is a separate frontend app with ${routes.length} route(s)`,
          scope: [a.path ?? a.name],
          key: `nano:${a.id}`,
          evidence: [{ ref: a.id, label: 'observed', summary: `${routes.length} routes` }],
          measurements: { 'frontend.routes': routes.length },
          thresholds: { max_routes: 1 },
          blast_radius: 'bounded',
          why_accidental: 'A whole app for one route carries a build, deployment and dependency set for very little independent change ("Nano Frontend").',
          essential_considerations: ['It may be an embeddable widget with its own consumers'],
          smallest_simplification: 'Fold it into the app that hosts its route, behind the same URL.',
          invariants: ['URL and behaviour unchanged'],
          risks: [],
          factors: { benefit: 2, evidence: 0.6, reversibility: 0.8, blast: 2, cost: 2, uncertainty: 2 },
          uncertainties: [],
          alternatives: [{ id: 'retain', summary: 'Keep it if external consumers embed it.' }, { id: 'fold-in', summary: 'Merge into its host app.' }],
          patterns: ['decomposition.frontend-modular-monolith', 'anti-pattern.nanoservices'],
        });
      }
    }
    return out;
  },
};

export default [crossFeature, layerViolation, megaFrontend, mfeOwnershipAndRelease];
