// Delivery adapter: CI/CD pipelines, build topology and feature flags (spec §9.4 steps 5 and
// 10, §11.4, §15.11). Per-file extraction is pure text -> facts; `link` derives the
// cross-file findings the spec asks for: deployables that always release together, and
// duplicated pipelines.

import { nodeFact, edgeFact } from '../../runtime/graph/facts.mjs';
import {
  ID, VERSION, P, basename, keyOf, uniqSorted,
} from './util.mjs';
import {
  parseGithubActions, parseGitlab, parseCircleci, parseAzure, parseBuildkite, parseBitbucket, parseJenkinsfile,
} from './ci.mjs';
import {
  parseMakefile, parseNx, parseNxProject, parseTurbo, parseLerna, parsePnpmWorkspace, parseRush, parseBazelBuild, parseBazelWorkspace,
} from './build.mjs';
import { parseFlags } from './flags.mjs';

/** Jaccard threshold above which two pipelines count as duplicates. */
export const DUPLICATE_THRESHOLD = 0.85;
const MIN_SIGNATURES = 3;

/** Pick the parser for a path, or null when the file is not ours. */
function classify(path) {
  const base = basename(path);
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return parseGithubActions;
  if (path === '.gitlab-ci.yml') return parseGitlab;
  if (path === '.circleci/config.yml') return parseCircleci;
  if (path === 'azure-pipelines.yml') return parseAzure;
  if (/^\.buildkite\/.*\.ya?ml$/.test(path)) return parseBuildkite;
  if (base === 'bitbucket-pipelines.yml') return parseBitbucket;
  if (base === 'Jenkinsfile') return parseJenkinsfile;
  if (base === 'Makefile') return parseMakefile;
  if (base === 'nx.json') return parseNx;
  if (base === 'project.json') return parseNxProject;
  if (base === 'turbo.json') return parseTurbo;
  if (base === 'lerna.json') return parseLerna;
  if (base === 'pnpm-workspace.yaml') return parsePnpmWorkspace;
  if (base === 'rush.json') return parseRush;
  if (base === 'BUILD' || base === 'BUILD.bazel') return parseBazelBuild;
  if (base === 'WORKSPACE') return parseBazelWorkspace;
  if (/(^|\/)\.launchdarkly\//.test(path) && /\.(json|ya?ml)$/.test(path)) return parseFlags;
  if (/^flags\.(json|ya?ml)$/.test(base) || /^unleash.*\.(json|ya?ml)$/.test(base)) return parseFlags;
  return null;
}

function jaccard(a, b) {
  const B = new Set(b);
  let inter = 0;
  for (const x of a) if (B.has(x)) inter++;
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

const allNodes = (factsByFile) => {
  const out = [];
  for (const path of [...factsByFile.keys()].sort()) for (const f of factsByFile.get(path)) if (f.kind === 'node') out.push(f);
  return out;
};

export default {
  id: ID,
  version: VERSION,
  kind: 'delivery',
  capabilities: {
    files: [
      '.github/workflows/*.{yml,yaml}', '.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', '.buildkite/**',
      'Jenkinsfile', 'bitbucket-pipelines.yml', '**/Makefile', 'nx.json', '**/project.json', 'turbo.json', 'lerna.json',
      'pnpm-workspace.yaml', 'rush.json', '**/BUILD', '**/BUILD.bazel', 'WORKSPACE', '**/.launchdarkly/**',
      '**/flags.{json,yaml,yml}', '**/unleash*.{json,yaml}',
    ],
    executes: [],
    network: false,
  },

  /** @param {{path: string}} file @param {string} text */
  extract(file, text) {
    const parse = classify(file.path);
    return parse ? parse(file.path, text) : [];
  },

  /** Cross-file findings; reads only cached facts so it stays cheap. */
  link(ctx) {
    const nodes = allNodes(ctx.factsByFile);
    const out = [];

    // -- Co-deployment (spec §11.4): same job, or same workflow with no path filter -------------
    const jobsByWorkflow = new Map();
    const workflows = [];
    for (const n of nodes) {
      if (n.type === 'workflow' && n.attrs.step_signatures) workflows.push(n);
      if (n.type === 'job' && n.attrs.deploys?.length) {
        if (!jobsByWorkflow.has(n.attrs.workflow)) jobsByWorkflow.set(n.attrs.workflow, []);
        jobsByWorkflow.get(n.attrs.workflow).push(n);
      }
    }
    const together = new Map(); // deployable -> Set of partners
    const source = new Map();
    const group = (names, srcNode) => {
      if (names.length < 2) return;
      for (const a of names) {
        if (!together.has(a)) together.set(a, new Set());
        if (!source.has(a)) source.set(a, srcNode);
        for (const b of names) if (a !== b) together.get(a).add(b);
      }
    };
    for (const wf of workflows) {
      const jobs = jobsByWorkflow.get(wf.id) ?? [];
      for (const j of jobs) group(j.attrs.deploys, j);
      if (!(wf.attrs.path_filters?.length)) {
        // Unconditional jobs of an unfiltered workflow run on every trigger, hence together.
        const names = uniqSorted(jobs.filter((j) => !j.attrs.conditional).flatMap((j) => j.attrs.deploys));
        group(names, jobs[0] ?? wf);
      }
    }
    for (const [name, partners] of [...together].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const s = source.get(name);
      out.push(nodeFact('deployable', name, {
        name,
        attrs: { co_deployed_with: [...partners].sort(), inferred: true },
      }, P(s.path ?? '', Number(String(s.provenance.source_ref).split(':').pop()) || 1, 'medium', 'inference')));
    }

    // -- Duplicated pipelines: Jaccard over normalised step signatures -------------------------
    const sorted = workflows.filter((w) => w.attrs.step_signatures.length >= MIN_SIGNATURES).sort((a, b) => (a.id < b.id ? -1 : 1));
    const dupOf = new Map();
    const dupBy = new Map();
    for (let i = 0; i < sorted.length; i++) {
      for (let k = i + 1; k < sorted.length; k++) {
        const sim = jaccard(sorted[i].attrs.step_signatures, sorted[k].attrs.step_signatures);
        if (sim < DUPLICATE_THRESHOLD) continue;
        // The lexicographically first workflow is canonical; later ones are its duplicates.
        if (!dupOf.has(sorted[k].id)) dupOf.set(sorted[k].id, { of: sorted[i].id, sim });
        if (!dupBy.has(sorted[i].id)) dupBy.set(sorted[i].id, []);
        dupBy.get(sorted[i].id).push(sorted[k].id);
      }
    }
    for (const wf of sorted) {
      const d = dupOf.get(wf.id);
      const by = dupBy.get(wf.id);
      if (!d && !by) continue;
      out.push(nodeFact('workflow', keyOf(wf.id), {
        name: wf.name,
        path: wf.path,
        attrs: {
          ...(d ? { duplicate_of: d.of, duplicate_similarity: Math.round(d.sim * 100) / 100 } : {}),
          ...(by ? { duplicated_by: by.sort() } : {}),
        },
      }, P(wf.path, 1, 'medium', 'inference')));
    }

    // -- Feature-flag references recorded by language adapters (`attrs.flags`) -----------------
    const flagNodes = new Map(nodes.filter((n) => n.type === 'feature_flag').map((n) => [keyOf(n.id), n]));
    if (flagNodes.size) {
      const refs = new Map();
      for (const n of nodes) {
        if (n.type !== 'module' || !Array.isArray(n.attrs.flags)) continue;
        for (const key of n.attrs.flags) {
          if (!flagNodes.has(key)) continue;
          if (!refs.has(key)) refs.set(key, []);
          refs.get(key).push(n);
        }
      }
      for (const [key, mods] of [...refs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const flag = flagNodes.get(key);
        out.push(nodeFact('feature_flag', key, {
          name: flag.name,
          path: flag.path,
          attrs: { referenced_in: uniqSorted(mods.map((m) => m.path ?? keyOf(m.id))), reference_count: mods.length },
        }, P(flag.path ?? '', 1, 'medium', 'inference')));
        for (const m of mods) out.push(edgeFact('DEPENDS_ON', m.id, flag.id, { via: 'flag_reference' }, P(m.path ?? '', 1, 'medium', 'inference')));
      }
    }
    return out;
  },
};
