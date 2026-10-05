// CI/CD pipeline extraction. Every CI system is parsed into one neutral model
// ({workflow, jobs, dependencies}) and emitted by a single function, so GitHub Actions,
// GitLab, CircleCI, Azure, Buildkite, Bitbucket and Jenkins all produce the same
// workflow / job / dependency / deployable scheme (spec §9.4 step 10, §11.4).
//
// Confidence: GitHub Actions is structured and documented (high); the other systems are
// parsed from YAML by convention (medium); Jenkinsfiles are Groovy read by regex (low).
// Deployable names are always an inference (low) - a deploy job rarely states what it ships.

import { parseYAML } from '../../runtime/core/yaml.mjs';
import { nodeFact, edgeFact } from '../../runtime/graph/facts.mjs';
import {
  P, clean, isObj, asArray, uniqSorted, lineOf, slug, capFacts,
} from './util.mjs';

/** Words that signal a job ships something (spec task: deploy|release|publish|...). */
export const DEPLOY_RE = /(?:^|[^a-z0-9])(deploy(?:ment|s|ing)?|release|publish|helm\s+(?:upgrade|install)|kubectl\s+apply|terraform\s+apply|cdk\s+deploy|serverless\s+deploy|sls\s+deploy|docker\s+push)(?![a-z0-9])/i;

const SHA_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^v?\d+\.\d+\.\d+$/;
// Directory names that hold deployables rather than being one.
const CONTAINERS = new Set(['services', 'service', 'apps', 'app', 'packages', 'projects', 'cmd', 'modules', 'svc', 'functions', 'workers']);
// Directory names that are never a deployable name.
const IGNORED = new Set([
  '.', '..', 'src', 'lib', 'libs', 'docs', 'doc', 'test', 'tests', 'dist', 'build', 'infra', 'k8s', 'kubernetes',
  'manifests', 'overlays', 'base', 'charts', 'chart', 'helm', 'terraform', 'scripts', 'config', 'staging', 'prod',
  'production', 'dev', 'deploy', 'deployments', 'shared', 'common',
]);
const MATRIX_KEYS = new Set(['service', 'services', 'app', 'apps', 'target', 'targets', 'project', 'projects', 'component', 'components', 'package', 'module', 'name']);
const PLACEHOLDER = /[$`{]/;

/** True when a value is usable as a literal name (no unresolved expression). */
const literal = (v) => typeof v === 'string' && v.length > 0 && !PLACEHOLDER.test(v);

/** `services/checkout/**` -> `checkout`; `libs/x/**` -> null. Low-confidence naming. */
export function targetFromDir(p) {
  if (!literal(p)) return null;
  const segs = [];
  for (const s of p.replace(/^\.\//, '').split('/')) {
    if (s === '' || /[*?{[]/.test(s)) break;
    segs.push(s);
  }
  if (segs.length === 0 || segs[0].startsWith('.')) return null;
  const name = segs.length >= 2 && CONTAINERS.has(segs[0]) ? segs[1] : segs[0];
  return IGNORED.has(name) || CONTAINERS.has(name) ? null : name;
}

/** `k8s/checkout/deploy.yaml` -> `checkout`; skips generic directory names. */
function targetFromManifest(p) {
  if (!literal(p)) return null;
  for (const s of p.replace(/^\.\//, '').split('/')) {
    const n = s.replace(/\.(ya?ml|json)$/, '');
    if (n && !IGNORED.has(n) && !n.startsWith('.')) return n;
  }
  return null;
}

const HELM_VALUE_FLAGS = new Set(['-n', '--namespace', '-f', '--values', '--set', '--set-string', '--version', '--timeout', '--kube-context', '--create-namespace=false', '-o']);

/** An actual deployment step: deploy commands or an action whose reference says deploy. */
const DEPLOY_CMD_RE = /\b(kubectl\s+(apply|set\s+image|rollout)|helm\s+(upgrade|install)|terraform\s+apply|tofu\s+apply|cdk\s+deploy|(serverless|sls)\s+deploy|docker\s+push|(fly|flyctl)\s+deploy|gcloud\b[^\n]*\bdeploy|aws\s+(ecs\s+update-service|deploy)|az\s+(webapp|containerapp)\b[^\n]*\b(deploy|up)|ssh\s|scp\s|rsync\s|git\s+push\s+(heroku|dokku))/i;
// Directories are not verbs: `./deploy/backup/restore-drill.sh` lives in a deploy folder but
// deploys nothing (an unfamiliar repository's backup drill was read as a deploy job), while
// `./scripts/deploy.sh` is named for what it does, so file names are kept.
const withoutPaths = (cmd) => String(cmd)
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ') // URLs: a download path is not a verb
  .replace(/(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g, (p) => ` ${p.slice(p.lastIndexOf('/') + 1)} `);
export const hasDeployStep = (steps) => steps.some((s) => (s.run && (DEPLOY_CMD_RE.test(String(s.run)) || DEPLOY_RE.test(withoutPaths(s.run)))) || (s.uses && DEPLOY_RE.test(String(s.uses))));

/** Service names named in deploy commands. Heuristic; callers record confidence low. */
export function commandTargets(run) {
  const out = new Set();
  const add = (v) => { if (literal(v)) out.add(v.toLowerCase()); };
  const lines = String(run).replace(/\\\r?\n/g, ' ').split(/\r?\n|&&|;/);
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    for (let i = 0; i < t.length; i++) {
      if (t[i] === 'helm' && (t[i + 1] === 'upgrade' || t[i + 1] === 'install')) {
        for (let j = i + 2; j < t.length; j++) {
          if (t[j].startsWith('-')) { if (HELM_VALUE_FLAGS.has(t[j])) j++; continue; }
          add(t[j]);
          break;
        }
      } else if (t[i] === 'kubectl') {
        const rest = t.slice(i + 1).join(' ');
        const img = /set image (?:deployment|deploy)\/([\w.-]+)/.exec(rest) ?? /rollout restart (?:deployment|deploy)\/([\w.-]+)/.exec(rest);
        if (img) add(img[1]);
        const f = /\bapply\b.*?(?:-f|-k|--filename)[ =](\S+)/.exec(rest);
        if (f) { const n = targetFromManifest(f[1]); if (n) add(n); }
      } else if (t[i] === 'docker' && t[i + 1] === 'push') {
        const ref = t.slice(i + 2).find((x) => !x.startsWith('-'));
        if (ref && literal(ref)) add(ref.split('/').pop().split(':')[0]);
      } else if (t[i] === 'cdk' && t[i + 1] === 'deploy') {
        const n = t.slice(i + 2).find((x) => !x.startsWith('-'));
        if (n) add(n);
      } else if ((t[i] === 'serverless' || t[i] === 'sls') && t[i + 1] === 'deploy') {
        const k = t.indexOf('--service', i);
        if (k !== -1) add(t[k + 1]);
      } else if (t[i] === 'gcloud' && t[i + 1] === 'run' && t[i + 2] === 'deploy') {
        add(t[i + 3]);
      } else if ((t[i] === 'flyctl' || t[i] === 'fly') && t[i + 1] === 'deploy') {
        const k = t.findIndex((x) => x === '--app' || x === '-a');
        if (k !== -1) add(t[k + 1]);
      }
    }
  }
  return [...out];
}

/** `deploy-checkout-prod` -> `checkout`; generic ids such as `deploy` give null. */
function targetFromJobName(id) {
  const rest = String(id)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    // Letters and digits only: emoji and punctuation in job names (`🚀 deploy`) are decoration,
    // not a target (an unknown-repository test found deployables named `🚀`).
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !/^(deploy|deployment|release|publish|to|prod|production|staging|stage|dev|job|ci|cd|push|and|all|ship|apply|run|go|live|matrix|terraform|build|review|preview|test|tests|qa|uat|canary)$/.test(w))
    .join('-');
  return rest && literal(rest) ? rest : null;
}

/**
 * Infer what a deploy job ships. Tiered: explicit job evidence (matrix, working directory,
 * command arguments) wins; the job name and the workflow's path filters are fallbacks.
 */
export function inferTargets(job, workflowFilters) {
  const evidence = new Set();
  const targets = new Set();
  const take = (kind, names) => {
    for (const n of names) if (n) { targets.add(n); evidence.add(kind); }
  };
  for (const [k, vals] of Object.entries(job.matrix ?? {})) {
    if (!MATRIX_KEYS.has(k)) continue;
    take('matrix', asArray(vals).filter((v) => typeof v === 'string' && literal(v)).map((v) => v.toLowerCase()));
  }
  take('working_directory', (job.workingDirectories ?? []).map(targetFromDir));
  take('command', job.steps.flatMap((s) => (s.run ? commandTargets(s.run) : [])));
  if (targets.size === 0) take('job_name', [targetFromJobName(job.id)]);
  if (targets.size === 0) take('path_filter', [...(job.pathFilters ?? []), ...workflowFilters].map(targetFromDir));
  return { targets: uniqSorted([...targets]), evidence: uniqSorted([...evidence]) };
}

/** Normalised step signature used for duplicate-pipeline detection. */
export function stepSignature(s) {
  if (s.uses) return `uses:${String(s.uses).split('@')[0].toLowerCase()}`;
  const run = String(s.run ?? s.name ?? '').toLowerCase().replace(/\$\{\{[^}]*\}\}/g, '$').replace(/\s+/g, ' ').trim();
  return `run:${run.slice(0, 120)}`;
}

function imageParts(image) {
  const s = String(image);
  const digest = s.indexOf('@sha256:');
  if (digest !== -1) return { repo: s.slice(0, digest), ref: s.slice(digest + 1), pinned: /^sha256:[0-9a-f]{64}$/.test(s.slice(digest + 1)) };
  const slash = s.lastIndexOf('/');
  const colon = s.indexOf(':', slash + 1);
  if (colon === -1) return { repo: s, ref: 'latest', pinned: false };
  return { repo: s.slice(0, colon), ref: s.slice(colon + 1), pinned: false };
}

const imageDep = (image) => {
  const { repo, ref, pinned } = imageParts(image);
  return { id: `image:${repo}`, ref, pinned, local: false, ecosystem: 'container-image' };
};

// ---- emitter ------------------------------------------------------------------------------

/**
 * Emit the facts for one parsed pipeline file.
 * @param {object} m neutral model: {path, system, confidence, name, line, triggers, pathFilters,
 *   attrs, deps, jobs: [{id, name, needs, environment, runsOn, steps, deps, matrix,
 *   workingDirectories, conditional, permissionsBroad, dangerous, secrets, envNames, pathFilters,
 *   attrs, extraSignal, line}]}
 */
export function emitPipeline(m) {
  const facts = [];
  const conf = m.confidence;
  const wfId = `workflow:${m.path}`;
  const depNodes = new Map();
  const addDep = (d, fromId, edgeAttrs, line) => {
    const prev = depNodes.get(d.id);
    if (!prev) depNodes.set(d.id, { ...d, refs: [d.ref], line });
    else {
      prev.refs.push(d.ref);
      prev.pinned = prev.pinned && d.pinned;
    }
    facts.push(edgeFact('DEPENDS_ON', fromId, `dependency:${d.id}`, clean({ ref: d.ref, pinned: d.pinned, ...edgeAttrs }), P(m.path, line, conf)));
  };

  const jobIds = new Set(m.jobs.map((j) => j.id));
  const signatures = new Set();
  const allDeploys = new Set();
  const allSecrets = new Set(m.secrets ?? []);
  const dangerous = new Set(m.dangerous ?? []);
  const jobFacts = [];

  for (const job of m.jobs) {
    const jobId = `job:${m.path}#${job.id}`;
    const signalText = [job.id, job.name, job.environment, job.extraSignal, ...job.steps.flatMap((s) => [s.name, s.uses, s.run])]
      .filter(Boolean).join('\n');
    const deploySignal = Boolean(job.environment) || DEPLOY_RE.test(signalText);
    const inferred = deploySignal ? inferTargets(job, m.pathFilters ?? []) : { targets: [], evidence: [] };
    for (const t of inferred.targets) allDeploys.add(t);
    for (const s of job.steps) signatures.add(stepSignature(s));
    for (const d of job.deps ?? []) signatures.add(`uses:${d.id}`);
    for (const s of job.secrets ?? []) allSecrets.add(s);
    for (const d of job.dangerous ?? []) dangerous.add(d);

    jobFacts.push(nodeFact('job', `${m.path}#${job.id}`, {
      name: job.name ?? job.id,
      path: m.path,
      attrs: clean({
        workflow: wfId,
        system: m.system,
        runs_on: job.runsOn,
        steps: job.steps.length,
        environment: job.environment,
        needs: job.needs?.length ? uniqSorted(job.needs) : undefined,
        conditional: job.conditional || undefined,
        deploy_signal: deploySignal,
        deploy_step: deploySignal ? (!job.steps.length || hasDeployStep(job.steps)) : undefined,
        deploys: inferred.targets.length ? inferred.targets : undefined,
        deploy_evidence: inferred.evidence.length ? inferred.evidence : undefined,
        path_filters: job.pathFilters?.length ? uniqSorted(job.pathFilters) : undefined,
        permissions_broad: job.permissionsBroad,
        dangerous_patterns: job.dangerous?.length ? uniqSorted(job.dangerous) : undefined,
        secrets: job.secrets?.length ? uniqSorted(job.secrets) : undefined,
        env_names: job.envNames?.length ? uniqSorted(job.envNames) : undefined,
        matrix: job.matrix && Object.keys(job.matrix).length ? job.matrix : undefined,
        ...job.attrs,
      }),
    }, P(m.path, job.line, conf)));
    facts.push(edgeFact('CONTAINS', wfId, jobId, {}, P(m.path, job.line, conf)));
    for (const n of job.needs ?? []) {
      if (jobIds.has(n)) facts.push(edgeFact('DEPENDS_ON', jobId, `job:${m.path}#${n}`, { via: 'needs' }, P(m.path, job.line, conf)));
    }
    for (const d of job.deps ?? []) addDep(d, jobId, {}, job.line);
    for (const t of inferred.targets) {
      facts.push(nodeFact('deployable', t, { name: t, attrs: { inferred: true } }, P(m.path, job.line, 'low', 'inference')));
      facts.push(edgeFact('DEPLOYS', jobId, `deployable:${t}`, { evidence: inferred.evidence }, P(m.path, job.line, 'low', 'inference')));
    }
  }
  for (const d of m.deps ?? []) addDep(d, wfId, { via: 'include' }, m.line);

  facts.unshift(nodeFact('workflow', m.path, {
    name: m.name ?? m.path,
    path: m.path,
    attrs: clean({
      system: m.system,
      triggers: m.triggers?.length ? uniqSorted(m.triggers) : undefined,
      path_filters: uniqSorted(m.pathFilters ?? []),
      permissions: m.permissions,
      permissions_broad: m.permissionsBroad,
      concurrency: m.concurrency,
      env_names: m.envNames?.length ? uniqSorted(m.envNames) : undefined,
      secrets: allSecrets.size ? uniqSorted([...allSecrets]) : undefined,
      dangerous_patterns: dangerous.size ? uniqSorted([...dangerous]) : undefined,
      jobs: m.jobs.map((j) => j.id),
      deploys: allDeploys.size ? uniqSorted([...allDeploys]) : undefined,
      step_signatures: uniqSorted([...signatures]).slice(0, 500),
      ...m.attrs,
    }),
  }, P(m.path, m.line, conf)));
  facts.push(...jobFacts);
  for (const [id, d] of [...depNodes].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    facts.push(nodeFact('dependency', id, {
      name: id,
      attrs: clean({ ecosystem: d.ecosystem, ref: d.refs[0], refs: uniqSorted(d.refs), pinned: d.pinned, local: d.local || undefined }),
    }, P(m.path, d.line, conf)));
  }
  return capFacts(facts);
}

// ---- GitHub Actions -----------------------------------------------------------------------

const PR_HEAD_RE = /github\.event\.pull_request\.head|github\.head_ref|pull_request\.head\.(?:sha|ref)/;

function ghaUses(uses) {
  const s = String(uses);
  if (s.startsWith('./')) return { id: `gha:${s}`, ref: 'local', pinned: true, local: true, ecosystem: 'github-actions' };
  if (s.startsWith('docker://')) {
    const d = imageDep(s.slice('docker://'.length));
    return { ...d, id: `gha:${s.split(':')[0]}:${d.id}` };
  }
  const at = s.lastIndexOf('@');
  const name = at === -1 ? s : s.slice(0, at);
  const ref = at === -1 ? '' : s.slice(at + 1);
  const [owner, repo] = name.split('/');
  return { id: `gha:${owner}/${repo ?? ''}`, ref, pinned: SHA_RE.test(ref), local: false, ecosystem: 'github-actions' };
}

export function parseGithubActions(path, text) {
  const doc = parseYAML(text, { filename: path });
  if (!isObj(doc)) return [];
  const on = doc.on ?? doc.true;
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : isObj(on) ? Object.keys(on) : [];
  const pathFilters = [];
  if (isObj(on)) for (const ev of ['push', 'pull_request', 'pull_request_target']) pathFilters.push(...asArray(on[ev]?.paths));
  const topPerm = doc.permissions;
  const defaultWd = doc.defaults?.run?.['working-directory'];
  const jobsDoc = isObj(doc.jobs) ? doc.jobs : {};
  const jobs = [];
  for (const [id, j] of Object.entries(jobsDoc)) {
    if (!isObj(j)) continue;
    const steps = asArray(j.steps).filter(isObj).map((s) => ({
      name: s.name, uses: s.uses, run: s.run, wd: s['working-directory'], with: isObj(s.with) ? s.with : {},
    }));
    const deps = [];
    if (j.uses) deps.push(ghaUses(j.uses));
    for (const s of steps) if (s.uses) deps.push(ghaUses(s.uses));
    const perm = j.permissions ?? topPerm;
    const matrix = {};
    const mx = j.strategy?.matrix;
    if (isObj(mx)) {
      for (const [k, v] of Object.entries(mx)) if (Array.isArray(v)) matrix[k] = v.filter((x) => typeof x === 'string');
      for (const inc of asArray(mx.include)) {
        if (isObj(inc)) for (const [k, v] of Object.entries(inc)) if (typeof v === 'string') (matrix[k] ??= []).push(v);
      }
    }
    const env = typeof j.environment === 'string' ? j.environment : j.environment?.name;
    const dangerous = triggers.includes('pull_request_target')
      && steps.some((s) => /^actions\/checkout(@|$)/.test(String(s.uses ?? '')) && PR_HEAD_RE.test(String(s.with.ref ?? '')) )
      ? ['pull_request_target_checkout_pr_head'] : [];
    const jobText = JSON.stringify(j);
    jobs.push({
      id,
      name: j.name,
      needs: asArray(j.needs),
      environment: typeof env === 'string' ? env : undefined,
      runsOn: Array.isArray(j['runs-on']) ? j['runs-on'].join(',') : isObj(j['runs-on']) ? (j['runs-on'].group ?? j['runs-on'].labels?.join?.(',')) : j['runs-on'],
      steps,
      deps,
      matrix,
      workingDirectories: [...steps.map((s) => s.wd), j.defaults?.run?.['working-directory'] ?? defaultWd].filter(Boolean),
      conditional: j.if !== undefined,
      permissionsBroad: perm === undefined || perm === 'write-all',
      dangerous,
      secrets: secretNames(jobText),
      envNames: isObj(j.env) ? Object.keys(j.env) : [],
      line: lineOf(text, id),
    });
  }
  const allBroad = jobs.length > 0 && jobs.every((j) => j.permissionsBroad === false);
  const conc = doc.concurrency;
  return emitPipeline({
    path,
    system: 'github-actions',
    confidence: 'high',
    name: doc.name,
    line: 1,
    triggers,
    pathFilters,
    permissions: typeof topPerm === 'string' ? topPerm : isObj(topPerm) ? topPerm : undefined,
    // Missing or write-all at the top is broad unless every job narrows it itself.
    permissionsBroad: (topPerm === undefined || topPerm === 'write-all') && !allBroad,
    concurrency: typeof conc === 'string' ? { group: conc } : isObj(conc) ? { group: conc.group, cancel_in_progress: conc['cancel-in-progress'] } : undefined,
    envNames: isObj(doc.env) ? Object.keys(doc.env) : [],
    secrets: secretNames(JSON.stringify(doc.env ?? {})),
    dangerous: [],
    jobs,
  });
}

/** Names only - a secret value never appears in workflow text, and we never read one. */
function secretNames(text) {
  const out = new Set();
  for (const m of text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
  return [...out];
}

// ---- GitLab CI ----------------------------------------------------------------------------

const GITLAB_RESERVED = new Set(['stages', 'include', 'variables', 'default', 'workflow', 'image', 'services', 'cache', 'before_script', 'after_script']);

export function parseGitlab(path, text) {
  const doc = parseYAML(text, { filename: path });
  if (!isObj(doc)) return [];
  const hidden = {};
  const jobs = [];
  const filters = [];
  for (const [k, v] of Object.entries(doc)) if (k.startsWith('.') && isObj(v)) hidden[k] = v;
  for (const [id, raw] of Object.entries(doc)) {
    if (GITLAB_RESERVED.has(id) || id.startsWith('.') || !isObj(raw)) continue;
    let j = raw;
    for (const e of asArray(raw.extends)) if (hidden[e]) j = { ...hidden[e], ...j };
    if (!('script' in j || 'trigger' in j || 'extends' in j || 'run' in j)) continue;
    const jf = [];
    for (const r of asArray(j.rules)) if (isObj(r)) jf.push(...asArray(Array.isArray(r.changes) ? r.changes : r.changes?.paths));
    const only = j.only;
    if (isObj(only)) jf.push(...asArray(Array.isArray(only.changes) ? only.changes : []));
    filters.push(...jf);
    const image = typeof j.image === 'string' ? j.image : j.image?.name ?? (typeof doc.image === 'string' ? doc.image : doc.image?.name);
    const env = typeof j.environment === 'string' ? j.environment : j.environment?.name;
    const deps = image && literal(image) ? [imageDep(image)] : [];
    jobs.push({
      id,
      name: id,
      needs: asArray(j.needs).map((n) => (isObj(n) ? n.job : n)).filter(Boolean),
      environment: typeof env === 'string' ? env : undefined,
      steps: [...asArray(j.before_script), ...asArray(j.script), ...asArray(j.after_script)].filter((s) => typeof s === 'string').map((run) => ({ run })),
      deps,
      pathFilters: jf.filter((x) => typeof x === 'string'),
      conditional: j.rules !== undefined || j.only !== undefined || j.when === 'manual' || undefined,
      attrs: clean({
        stage: j.stage ?? 'test',
        image,
        image_pinned: image ? imageParts(image).pinned : undefined,
        manual: j.when === 'manual' || undefined,
      }),
      line: lineOf(text, id),
    });
  }
  const deps = [];
  for (const inc of asArray(doc.include)) {
    const o = typeof inc === 'string' ? { local: inc } : inc;
    if (!isObj(o)) continue;
    if (o.project) deps.push({ id: `gitlab:${o.project}`, ref: o.ref ?? 'HEAD', pinned: SHA_RE.test(String(o.ref ?? '')), local: false, ecosystem: 'gitlab-include' });
    else if (o.remote) deps.push({ id: `gitlab:${o.remote}`, ref: 'remote', pinned: false, local: false, ecosystem: 'gitlab-include' });
    else if (o.template) deps.push({ id: `gitlab:template/${o.template}`, ref: 'bundled', pinned: false, local: false, ecosystem: 'gitlab-include' });
  }
  return emitPipeline({
    path,
    system: 'gitlab-ci',
    confidence: 'medium',
    name: path,
    line: 1,
    triggers: ['pipeline'],
    pathFilters: filters.filter((x) => typeof x === 'string'),
    deps,
    jobs,
    attrs: clean({
      stages: Array.isArray(doc.stages) ? doc.stages : undefined,
      includes: asArray(doc.include).map((i) => (typeof i === 'string' ? i : i?.local ?? i?.project ?? i?.remote ?? i?.template)).filter(Boolean),
    }),
  });
}

// ---- CircleCI -----------------------------------------------------------------------------

export function parseCircleci(path, text) {
  const doc = parseYAML(text, { filename: path });
  if (!isObj(doc)) return [];
  const needs = {};
  const flagged = new Set();
  const order = [];
  for (const [wname, w] of Object.entries(isObj(doc.workflows) ? doc.workflows : {})) {
    if (!isObj(w)) continue;
    for (const item of asArray(w.jobs)) {
      const [name, cfg] = typeof item === 'string' ? [item, {}] : Object.entries(item)[0] ?? [];
      if (!name) continue;
      order.push([wname, name]);
      (needs[name] ??= new Set());
      for (const r of asArray(cfg?.requires)) needs[name].add(r);
      if (cfg?.filters || cfg?.type === 'approval') flagged.add(name);
    }
  }
  const jobs = [];
  for (const [id, j] of Object.entries(isObj(doc.jobs) ? doc.jobs : {})) {
    if (!isObj(j)) continue;
    const steps = asArray(j.steps).map((s) => {
      if (typeof s === 'string') return { name: s };
      const [k, v] = Object.entries(s)[0] ?? [];
      if (k === 'run') return typeof v === 'string' ? { run: v } : { name: v?.name, run: v?.command };
      return { name: k };
    });
    const images = asArray(j.docker).map((d) => d?.image).filter((i) => literal(i));
    jobs.push({
      id,
      name: id,
      needs: [...(needs[id] ?? [])],
      steps,
      deps: images.map(imageDep),
      conditional: flagged.has(id) || undefined,
      attrs: clean({ executor: typeof j.executor === 'string' ? j.executor : undefined, image: images[0] }),
      line: lineOf(text, id),
    });
  }
  const deps = Object.entries(isObj(doc.orbs) ? doc.orbs : {}).filter(([, v]) => typeof v === 'string').map(([, v]) => {
    const [name, ref = 'volatile'] = v.split('@');
    return { id: `circleci:${name}`, ref, pinned: /^\d+\.\d+\.\d+$/.test(ref), local: false, ecosystem: 'circleci-orb' };
  });
  return emitPipeline({
    path, system: 'circleci', confidence: 'medium', name: path, line: 1, triggers: ['workflows'], deps, jobs,
    attrs: { workflows: uniqSorted(order.map(([w]) => w)) },
  });
}

// ---- Azure Pipelines ----------------------------------------------------------------------

export function parseAzure(path, text) {
  const doc = parseYAML(text, { filename: path });
  if (!isObj(doc)) return [];
  const filters = [];
  for (const k of ['trigger', 'pr']) {
    const t = doc[k];
    if (isObj(t)) filters.push(...asArray(isObj(t.paths) ? t.paths.include : t.paths));
  }
  const raw = [];
  for (const s of asArray(doc.stages)) {
    if (isObj(s)) for (const j of asArray(s.jobs)) raw.push([s.stage, j]);
  }
  for (const j of asArray(doc.jobs)) raw.push([undefined, j]);
  if (doc.steps) raw.push([undefined, { job: 'build', steps: doc.steps }]);
  const taskDeps = new Map();
  const jobs = [];
  const seen = new Set();
  for (const [stage, j] of raw) {
    if (!isObj(j)) continue;
    const base = String(j.job ?? j.deployment ?? 'job');
    const id = seen.has(base) ? `${stage ?? 'stage'}.${base}` : base;
    seen.add(base);
    const strat = j.strategy ?? {};
    const stepList = [
      ...asArray(j.steps),
      ...asArray(strat.runOnce?.deploy?.steps),
      ...asArray(strat.rolling?.deploy?.steps),
      ...asArray(strat.canary?.deploy?.steps),
    ];
    const deps = [];
    const steps = stepList.filter(isObj).map((s) => {
      if (s.task) {
        const [tname, tver = ''] = String(s.task).split('@');
        const d = { id: `azure-task:${tname}`, ref: tver, pinned: /^\d+\.\d+\.\d+$/.test(tver), local: false, ecosystem: 'azure-task' };
        deps.push(d);
        taskDeps.set(d.id, d);
        return { name: s.displayName ?? s.task, uses: s.task, run: [s.inputs?.command, s.inputs?.script].filter(Boolean).join(' ') || undefined };
      }
      return { name: s.displayName, run: s.script ?? s.bash ?? s.pwsh ?? s.powershell };
    });
    const env = typeof j.environment === 'string' ? j.environment : j.environment?.name;
    jobs.push({
      id,
      name: base,
      needs: asArray(j.dependsOn),
      environment: typeof env === 'string' ? env.split('.')[0] : undefined,
      steps,
      deps,
      conditional: j.condition !== undefined || undefined,
      attrs: clean({ stage, kind: j.deployment ? 'deployment' : 'job', strategy: Object.keys(strat)[0] }),
      extraSignal: j.deployment ? 'deployment' : undefined,
      line: lineOf(text, j.job ? 'job' : 'deployment'),
    });
  }
  return emitPipeline({
    path, system: 'azure-pipelines', confidence: 'medium', name: doc.name ?? path, line: 1,
    triggers: ['trigger', 'pr'].filter((k) => doc[k] !== undefined), pathFilters: filters, jobs,
  });
}

// ---- Buildkite ----------------------------------------------------------------------------

export function parseBuildkite(path, text) {
  const doc = parseYAML(text, { filename: path });
  if (!isObj(doc) || !Array.isArray(doc.steps)) return [];
  const flat = [];
  const walk = (list) => {
    for (const s of list) {
      if (!isObj(s)) continue;
      if (Array.isArray(s.steps)) walk(s.steps);
      else if (s.command || s.commands || s.trigger) flat.push(s);
    }
  };
  walk(doc.steps);
  const ids = new Set();
  const jobs = flat.map((s, i) => {
    let id = s.key ?? (slug(s.label ?? s.name ?? '') || `step-${i + 1}`);
    while (ids.has(id)) id += '-2';
    ids.add(id);
    const deps = [];
    for (const pl of asArray(s.plugins)) {
      const name = typeof pl === 'string' ? pl : Object.keys(pl ?? {})[0];
      if (!name) continue;
      const [pn, pv = ''] = name.split('#');
      deps.push({ id: `buildkite:${pn}`, ref: pv, pinned: SEMVER_RE.test(pv), local: false, ecosystem: 'buildkite-plugin' });
    }
    return {
      id,
      name: s.label ?? s.name ?? id,
      needs: asArray(s.depends_on).map((d) => (isObj(d) ? d.step : d)),
      steps: [...asArray(s.command), ...asArray(s.commands)].filter((c) => typeof c === 'string').map((run) => ({ run })),
      deps,
      conditional: s.branches !== undefined || s.if !== undefined || undefined,
      line: lineOf(text, s.key ? 'key' : 'label'),
    };
  });
  return emitPipeline({ path, system: 'buildkite', confidence: 'medium', name: path, line: 1, triggers: ['build'], jobs });
}

// ---- Bitbucket Pipelines ------------------------------------------------------------------

export function parseBitbucket(path, text) {
  const doc = parseYAML(text, { filename: path });
  if (!isObj(doc) || !isObj(doc.pipelines)) return [];
  const jobs = [];
  const ids = new Set();
  const triggers = [];
  const filters = [];
  const visit = (trigger, list, always) => {
    for (const item of asArray(list)) {
      if (!isObj(item)) continue;
      if (item.parallel) {
        visit(trigger, Array.isArray(item.parallel) ? item.parallel : item.parallel.steps, always);
        continue;
      }
      const s = item.step;
      if (!isObj(s)) continue;
      let id = slug(s.name ?? '') || `step-${jobs.length + 1}`;
      while (ids.has(id)) id += '-2';
      ids.add(id);
      const deps = [];
      const steps = [];
      for (const sc of asArray(s.script)) {
        if (typeof sc === 'string') steps.push({ run: sc });
        else if (isObj(sc) && typeof sc.pipe === 'string') {
          const cut = sc.pipe.lastIndexOf(':');
          const name = cut === -1 ? sc.pipe : sc.pipe.slice(0, cut);
          const ref = cut === -1 ? '' : sc.pipe.slice(cut + 1);
          deps.push({ id: `bitbucket-pipe:${name}`, ref, pinned: SEMVER_RE.test(ref), local: false, ecosystem: 'bitbucket-pipe' });
          steps.push({ name: `pipe ${name}`, uses: sc.pipe });
        }
      }
      const jf = asArray(s.condition?.changesets?.includePaths);
      filters.push(...jf);
      const image = typeof s.image === 'string' ? s.image : s.image?.name;
      if (image && literal(image)) deps.push(imageDep(image));
      jobs.push({
        id, name: s.name ?? id, steps, deps, environment: typeof s.deployment === 'string' ? s.deployment : undefined,
        pathFilters: jf, conditional: !always || undefined, attrs: clean({ trigger, image }), line: lineOf(text, 'name'),
      });
    }
  };
  for (const [kind, v] of Object.entries(doc.pipelines)) {
    if (kind === 'default') { triggers.push('default'); visit('default', v, true); }
    else if (isObj(v)) for (const [pat, list] of Object.entries(v)) { triggers.push(`${kind}:${pat}`); visit(`${kind}:${pat}`, list, false); }
  }
  return emitPipeline({ path, system: 'bitbucket-pipelines', confidence: 'medium', name: path, line: 1, triggers, pathFilters: filters, jobs });
}

// ---- Jenkinsfile --------------------------------------------------------------------------

export function parseJenkinsfile(path, text) {
  const stageRe = /\bstage\s*\(\s*(['"])(.+?)\1\s*\)/g;
  const marks = [...text.matchAll(stageRe)];
  const ids = new Set();
  const jobs = marks.map((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const seg = text.slice(mk.index, end);
    const steps = [];
    for (const sm of seg.matchAll(/\b(?:sh|bat|powershell|pwsh)\s*\(?\s*(?:script\s*:\s*)?('''|"""|'|")([\s\S]*?)\1/g)) steps.push({ run: sm[2] });
    const wds = [...seg.matchAll(/\bdir\s*\(\s*['"]([^'"$]+)['"]/g)].map((x) => x[1]);
    const base = slug(mk[2]) || `stage-${i + 1}`;
    let id = base;
    while (ids.has(id)) id += '-2';
    ids.add(id);
    return {
      id,
      name: mk[2],
      steps,
      workingDirectories: wds,
      conditional: /\bwhen\s*\{/.test(seg) || undefined,
      extraSignal: mk[2],
      line: text.slice(0, mk.index).split('\n').length,
    };
  });
  const deps = [];
  for (const lm of text.matchAll(/@Library\(\s*\[?\s*['"]([^'"@]+)(?:@([^'"]+))?['"]/g)) {
    const ref = lm[2] ?? 'default';
    deps.push({ id: `jenkins-lib:${lm[1]}`, ref, pinned: SHA_RE.test(ref) || SEMVER_RE.test(ref), local: false, ecosystem: 'jenkins-library' });
  }
  return emitPipeline({ path, system: 'jenkins', confidence: 'low', name: path, line: 1, triggers: ['jenkins'], deps, jobs });
}
