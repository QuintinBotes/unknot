// The cloud IaC adapter: declarations (Terraform/OpenTofu, CloudFormation/CDK, ARM, Bicep,
// Pulumi YAML) come from `extract`/`link`; imported evidence (plans, recorded state, actual
// inventory) comes from `discover`. Adapters are powerless by design: this one never runs
// terraform or reaches a cloud, it only reads files the runtime hands it (spec §15.4, §22.2).

import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { extractTerraform, linkTerraform } from './terraform.mjs';
import { extractCloudFormation } from './cloudformation.mjs';
import { normalizePlan, planSummary } from './plan.mjs';
import { parseState } from './state.mjs';
import { detectDrift } from './drift.mjs';

const ID = 'iac';
const VERSION = '0.1.1';
const EXTRACTOR = `${ID}@${VERSION}`;

const catalogProv = (ref, confidence = 'high') => prov({ source_type: 'catalog', source_ref: ref, extractor: EXTRACTOR, confidence });
const ruleProv = (ref) => prov({ source_type: 'inference', source_ref: ref, extractor: EXTRACTOR, confidence: 'high' });

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const pathOf = (e) => (typeof e === 'string' ? e : e?.path);

/** Baseline policies a plan action can violate; nodes are emitted so the edges never dangle. */
const POLICIES = Object.freeze({
  'no-public-ingress': 'Security rules must not open ports to the whole internet',
  'no-wildcard-iam': 'IAM changes must not grant wildcard actions or admin',
  'stateful-destroy-review': 'Destroying or replacing stateful resources needs recovery evidence',
});

function declaredFromFacts(factsByFile) {
  const out = [];
  for (const facts of factsByFile.values()) for (const f of facts) if (f.kind === 'node' && f.type === 'resource') out.push(f);
  return out;
}

async function loadDeclared(ctx) {
  if (Array.isArray(ctx.declared)) return ctx.declared;
  if (ctx.factsByFile instanceof Map) return declaredFromFacts(ctx.factsByFile);
  const census = Array.isArray(ctx.census) ? ctx.census : ctx.census?.files ?? [];
  const facts = [];
  for (const entry of census) {
    const p = pathOf(entry);
    if (!p || !/\.tf(\.json)?$/.test(p) || typeof ctx.readText !== 'function') continue;
    try {
      facts.push(...extractTerraform({ path: p }, await ctx.readText(p)));
    } catch {
      // A file that cannot be read is simply not declared evidence.
    }
  }
  return facts.filter((f) => f.kind === 'node' && f.type === 'resource');
}

async function readJson(ctx, path, facts) {
  try {
    return JSON.parse(await ctx.readText(path));
  } catch (e) {
    facts.push(nodeFact('finding', `iac/invalid-evidence/${path}`, {
      name: `unreadable infrastructure evidence ${path}`, path, attrs: { reason: String(e?.message ?? e).slice(0, 200), evidence: path },
    }, catalogProv(`${path}:1`, 'high')));
    return null;
  }
}

function shortOf(address) {
  return String(address).replace(/^(?:module\.[^.\[]+(?:\[[^\]]*\])?\.)+/, '').replace(/\[[^\]]*\]$/, '');
}

/**
 * A committed dependency lock file pins every provider of its root module to an exact
 * version and checksums, whatever the version constraints say (an unfamiliar-repository
 * test ranked "unpinned providers" first while the lock file pinned them).
 */
function lockFacts(file, text) {
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const locked = [...text.matchAll(/provider\s+"([^"]+)"\s*\{[^}]*?\bversion\s*=\s*"([^"]+)"/g)].map((m) => ({ source: m[1].replace(/^registry\.(?:terraform\.io|opentofu\.org)\//, ''), version: m[2] }));
  if (!locked.length) return [];
  const label = dir || '.';
  return [nodeFact('iac_module', label, { name: label, path: dir || null, attrs: { lock_file: file.path, locked_providers: locked } }, prov({ source_type: 'config', source_ref: `${file.path}:1`, extractor: EXTRACTOR, confidence: 'high' }))];
}

export default {
  id: ID,
  version: VERSION,
  kind: 'infrastructure',
  capabilities: {
    files: [
      '**/*.tf', '**/*.tf.json', '**/*.hcl', '**/*.bicep', '**/*.template.{json,yaml,yml}', '**/cloudformation/**',
      '**/cdk.out/*.template.json', '**/Pulumi.yaml', '**/azuredeploy.json',
    ],
    executes: [],
    network: false,
  },

  extract(file, text) {
    const p = file.path;
    if (/\.tf(\.json)?$/.test(p) || (/\.hcl$/.test(p) && !/\.terraform\.lock\.hcl$/.test(p))) return extractTerraform(file, text);
    if (/\.terraform\.lock\.hcl$/.test(p)) return lockFacts(file, text);
    return extractCloudFormation(file, text);
  },

  link(ctx) {
    return linkTerraform(ctx);
  },

  async discover(ctx) {
    const facts = [];
    const ev = ctx.evidence ?? {};
    const opts = ctx.options ?? {};
    const planOpts = asList(opts.plans);
    const declared = await loadDeclared(ctx);
    const preventDestroy = declared.filter((f) => f.attrs?.lifecycle?.prevent_destroy).map((f) => f.attrs.address);

    // Recorded state first: a plan is only "tied to a state serial" if we know one.
    const states = [];
    for (const e of asList(ev.infra_state)) {
      const path = pathOf(e);
      if (!path) continue;
      const json = await readJson(ctx, path, facts);
      if (!json) continue;
      const st = parseState(json);
      states.push(st);
      facts.push(nodeFact('state_backend', `recorded/${st.lineage ?? path}`, {
        name: `recorded state ${path}`, path,
        attrs: {
          recorded: true, serial: st.serial, lineage: st.lineage, version: st.version, terraform_version: st.terraform_version,
          resource_count: st.resource_count, instance_count: st.instance_count, output_count: st.outputs.length,
          redacted_attribute_count: st.redacted_attribute_count, source: path,
        },
      }, catalogProv(`${path}:1`)));
    }

    // Actual inventory + drift.
    for (const e of asList(ev.infra_inventory)) {
      const path = pathOf(e);
      if (!path) continue;
      const actual = await readJson(ctx, path, facts);
      if (!actual) continue;
      const items = detectDrift({ declared, recorded: states[0] ?? null, actual });
      for (const item of items) {
        const ident = item.address ?? item.id ?? 'unknown';
        facts.push(nodeFact('resource', `drift/${item.kind}/${ident}`, {
          name: `${item.kind}: ${ident}`, path,
          attrs: { drift: item, finding_input: true, provider: actual.provider ?? null, source: path },
        }, catalogProv(`${path}:1`, 'medium')));
      }
    }
    if (!asList(ev.infra_inventory).length && states[0] && declared.length) {
      // No inventory: declared-vs-recorded drift is still computable.
      for (const item of detectDrift({ declared, recorded: states[0] })) {
        const ident = item.address ?? item.id ?? 'unknown';
        facts.push(nodeFact('resource', `drift/${item.kind}/${ident}`, {
          name: `${item.kind}: ${ident}`, attrs: { drift: item, finding_input: true },
        }, catalogProv('state:1', 'medium')));
      }
    }

    // Plans.
    const policyUsed = new Set();
    for (const e of asList(ev.infra_plans)) {
      const path = pathOf(e);
      if (!path) continue;
      const po = { ...(typeof e === 'object' ? e : {}), ...(planOpts.find((p) => p.path === path) ?? {}) };
      const json = await readJson(ctx, path, facts);
      if (!json) continue;
      const plan = normalizePlan(json, {
        tool: po.tool, workspace: po.workspace, environment: po.environment,
        state_serial: po.state_serial ?? (states.length === 1 ? states[0].serial : undefined),
        prevent_destroy: preventDestroy,
      });
      const base = `${plan.plan_hash}`;
      const pv = catalogProv(`${path}:1`);
      facts.push(nodeFact('plan_action', `${base}/(plan)`, {
        name: `plan ${base.slice(0, 12)}`, path, attrs: { summary: planSummary(plan), source: path },
      }, pv));
      for (const c of plan.changes) {
        const id = `${base}/${c.address}`;
        facts.push(nodeFact('plan_action', id, {
          name: `${c.action} ${c.address}`, path,
          attrs: { ...c, plan_hash: plan.plan_hash, tool: plan.tool, workspace: plan.workspace, environment: plan.environment, state_serial: plan.state_serial },
        }, pv));
        if (c.action !== 'noop' && c.action !== 'read') {
          let candidates = declared.filter((d) => (plan.tool === 'cloudformation' ? d.attrs.logical_id === c.address : d.attrs.address === shortOf(c.address)));
          // A plan is for one stack; `dir` (per-plan option) says which, else every match is a low-confidence candidate.
          if (po.dir) candidates = candidates.filter((d) => d.attrs.dir === po.dir);
          if (candidates.length) {
            const ambiguous = candidates.length > 1;
            for (const cand of candidates) {
              facts.push(edgeFact('PROVISIONS', `plan_action:${id}`, cand.id, { action: c.action, ambiguous }, catalogProv(`${path}:1`, ambiguous ? 'low' : 'high')));
            }
          } else if (plan.tool === 'terraform' || plan.tool === 'opentofu') {
            facts.push(edgeFact('PROVISIONS', `plan_action:${id}`, `resource:${c.address}`, { action: c.action, ambiguous: false }, catalogProv(`${path}:1`, 'medium')));
          }
        }
        const violations = [];
        if (c.network_delta?.public_ingress_added) violations.push('no-public-ingress');
        if (c.wildcard_privilege_added) violations.push('no-wildcard-iam');
        if (c.destructive && c.stateful) violations.push('stateful-destroy-review');
        for (const v of violations) {
          policyUsed.add(v);
          facts.push(edgeFact('VIOLATES_POLICY', `plan_action:${id}`, `policy:iac-baseline/${v}`, { reason: v }, ruleProv(`${path}:1`)));
        }
      }
    }
    for (const v of [...policyUsed].sort()) {
      facts.push(nodeFact('policy', `iac-baseline/${v}`, { name: v, attrs: { builtin: true, description: POLICIES[v] } }, ruleProv('iac:baseline')));
    }
    return facts;
  },
};
