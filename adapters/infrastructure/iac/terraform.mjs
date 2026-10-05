// Terraform / OpenTofu source -> graph facts (spec §15.3, §15.5).
//
// `extractTerraform` is per-file and pure. Anything that needs the whole directory (reference
// resolution, stack nodes, implicit backends, near-duplicate stacks) is `linkTerraform`,
// computed from the cached per-file facts. Facts are declarations, so source_type is
// `config`; guesses (implicit local backend, implicit providers) say `inference`/medium.

import { posix as pp } from 'node:path';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { blocksOf, bodyToPlain, isExpr, parseHCL } from './hcl.mjs';
import {
  analyzePolicyDocument, analyzeResourcePolicies, classifyResource, collectRefs, ingressSummary, isAdminRole,
  isPublicCidr, policyFromStatementBlocks, refsIn, safeAttrs,
} from './analysis.mjs';

export const EXTRACTOR = 'iac@0.1.1';
const MAX_FACTS = 5000;
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** `modules/<x>` stacks are qualified `module.<x>.`; other non-root dirs by path (they would collide otherwise). */
export function keyPrefix(dir) {
  if (!dir || dir === '.') return '';
  const m = /(?:^|\/)modules\/([^/]+)/.exec(dir);
  return m ? `module.${m[1]}.` : `${dir}/`;
}

export function dirOf(path) {
  const d = pp.dirname(path);
  return d === '.' ? '' : d;
}

/** Version constraint -> exact | ~> | range | unpinned. */
export function classifyConstraint(c) {
  if (typeof c !== 'string' || !c.trim()) return 'unpinned';
  const t = c.trim();
  if (/^=?\s*v?\d[\w.+-]*$/.test(t)) return 'exact';
  if (t.startsWith('~>')) return '~>';
  if (/<|!=/.test(t) && />|~>/.test(t)) return 'range';
  if (/^<=?\s*\d/.test(t)) return 'range';
  return 'unpinned';
}

/** `.tf.json` -> the same body model the HCL parser yields. */
function jsonToBody(obj) {
  const body = { attributes: {}, blocks: [] };
  const objBody = (o) => {
    const b = { attributes: {}, blocks: [] };
    if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) b.attributes[k] = { value: v, line: 1 };
    return b;
  };
  const add = (type, labels, o) => body.blocks.push({ type, labels, body: objBody(o), line: 1 });
  if (!obj || typeof obj !== 'object') return body;
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue;
    if (k === 'resource' || k === 'data') {
      for (const [t, names] of Object.entries(v)) {
        if (names && typeof names === 'object') for (const [n, item] of Object.entries(names)) for (const i of asArray(item)) add(k, [t, n], i);
      }
    } else if (['module', 'variable', 'output', 'provider'].includes(k)) {
      for (const [n, item] of Object.entries(v)) for (const i of asArray(item)) add(k, [n], i);
    } else if (['terraform', 'moved', 'import', 'locals'].includes(k)) {
      for (const i of asArray(v)) add(k, [], i);
    }
  }
  return body;
}

function lit(v) {
  return isExpr(v) ? undefined : v;
}

function backendFrom(plain) {
  const first = asArray(plain.backend)[0] ?? (plain.cloud ? { __labels: ['cloud'], ...asArray(plain.cloud)[0] } : undefined);
  if (!first || typeof first !== 'object') return null;
  let type;
  let cfg;
  if (Array.isArray(first.__labels)) {
    type = first.__labels[0];
    cfg = first;
  } else {
    [type] = Object.keys(first);
    cfg = first[type] && typeof first[type] === 'object' ? first[type] : {};
  }
  if (!type) return null;
  const encrypt = lit(cfg.encrypt);
  const locking = Boolean(cfg.dynamodb_table || cfg.use_lockfile === true || cfg.lock_table);
  const base = { type, remote: type !== 'local' };
  switch (type) {
    case 'local':
      return { ...base, encrypt: false, locking: false, lock_mechanism: null };
    case 's3':
      return { ...base, encrypt: encrypt === true, locking, lock_mechanism: cfg.dynamodb_table ? 'dynamodb' : cfg.use_lockfile === true ? 's3_lockfile' : null };
    case 'gcs':
    case 'azurerm':
    case 'remote':
    case 'cloud':
    case 'pg':
      return { ...base, encrypt: true, locking: true, lock_mechanism: 'backend_native', encrypt_source: 'provider_default' };
    default:
      return { ...base, encrypt: encrypt === true, locking: locking || type === 'consul', lock_mechanism: null };
  }
}

/**
 * Extract Terraform/OpenTofu facts from one file.
 * @param {{path: string}} file
 * @param {string} text
 * @returns {object[]}
 */
export function extractTerraform(file, text) {
  const path = file.path;
  const dir = dirOf(path);
  const pre = keyPrefix(dir);
  const stackId = `iac_module:${dir || '.'}`;
  let body;
  let errors = [];
  if (/\.tf\.json$/.test(path)) {
    try {
      body = jsonToBody(JSON.parse(text));
    } catch (e) {
      body = { attributes: {}, blocks: [] };
      errors = [{ line: 1, message: `invalid JSON: ${e.message}` }];
    }
  } else ({ body, errors } = parseHCL(text));

  const P = (line, confidence = 'high', source_type = 'config') => prov({ source_type, source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });
  /** @type {object[]} */
  const facts = [];
  const summary = {
    dir, variables: 0, outputs: 0, locals: 0, providers: 0, modules: [], moved: [], imports: [],
    resources: 0, data_sources: 0, required_providers: [], backend: null,
  };

  // Policy documents defined in this file, so `policy = data.aws_iam_policy_document.x.json` resolves.
  const policyDocs = new Map();
  for (const b of blocksOf(body, 'data')) {
    if (b.labels[0] === 'aws_iam_policy_document') {
      const plain = bodyToPlain(b.body);
      policyDocs.set(b.labels[1], policyFromStatementBlocks(plain.statement));
    }
  }
  const resolveLocal = (plain) => {
    const out = { ...plain };
    for (const [k, v] of Object.entries(out)) {
      if (!isExpr(v)) continue;
      const m = /^data\.aws_iam_policy_document\.([\w-]+)\.json$/.exec(v.expr.trim());
      if (m && policyDocs.has(m[1])) out[k] = policyDocs.get(m[1]);
    }
    return out;
  };

  const emitEndpoint = (cidr, fromId, line) => {
    const id = `net_endpoint:${cidr}`;
    facts.push(nodeFact('net_endpoint', cidr, { name: cidr, attrs: { public: isPublicCidr(cidr) } }, P(line)));
    facts.push(edgeFact('ALLOWS_INGRESS_FROM', fromId, id, {}, P(line)));
  };

  const emitResource = (block, isData) => {
    const [type, name] = block.labels;
    if (!type || !name) return;
    const plain = bodyToPlain(block.body);
    const address = isData ? `data.${type}.${name}` : `${type}.${name}`;
    const key = `${pre}${address}`;
    const attrs = {
      provider: type.split('_')[0], type, name, address, file: path, line: block.line, dir: dir || '.',
      data: isData, count: 'count' in block.body.attributes, for_each: 'for_each' in block.body.attributes,
      tags: Boolean(plain.tags || plain.tags_all || plain.labels || plain.tag),
    };
    const life = asArray(plain.lifecycle)[0];
    if (life) {
      attrs.lifecycle = {
        prevent_destroy: life.prevent_destroy === true,
        create_before_destroy: life.create_before_destroy === true,
        ignore_changes: asArray(life.ignore_changes).map((x) => (isExpr(x) ? x.expr : String(x))).sort(),
      };
    }
    const self = address;
    const refs = [...collectRefs(plain)].filter((r) => r !== self);
    if (refs.length) attrs.refs = refs;
    Object.assign(attrs, safeAttrs(plain));
    if (typeof plain.type === 'string' && /security_group_rule|network_security_rule/.test(type)) attrs.rule_type = plain.type;

    const cls = classifyResource(type);
    if (cls.node) attrs.classified_as = cls.node;
    if (cls.stateful) attrs.stateful = true;

    const resolved = resolveLocal(plain);
    const pol = analyzeResourcePolicies(resolved);
    if (pol) {
      attrs.wildcard_actions = pol.wildcard_actions;
      attrs.wildcard_resources = pol.wildcard_resources;
      attrs.admin = pol.admin;
      attrs.principals = pol.principals;
      attrs.public_principal = pol.public_principal;
      attrs.policy_literal = pol.literal;
      attrs.policy_statements = pol.statements;
      if (pol.resource_refs.length) attrs.resource_refs = pol.resource_refs;
    }
    // Heredoc policies keep `${ref}` holes as text; the references are still evidence for GRANTS.
    if (pol) {
      const holes = new Set(pol.resource_refs);
      for (const v of Object.values(plain)) {
        if (typeof v === 'string' && v.trimStart().startsWith('{')) for (const m of v.matchAll(/\$\{([^}]*)\}/g)) for (const r of refsIn(m[1])) holes.add(r);
      }
      pol.resource_refs = [...holes].sort();
      if (pol.resource_refs.length) attrs.resource_refs = pol.resource_refs;
      const hr = new Set(attrs.refs ?? []);
      for (const r of holes) if (r !== self) hr.add(r);
      if (hr.size) attrs.refs = [...hr].sort();
    }
    // Role -> policy bindings: record which role and which policy so link() can draw GRANTS.
    if (!isData && cls.node === 'policy') {
      const roleRefs = [...collectRefs([plain.role, plain.roles])].filter((r) => r.startsWith('aws_iam_role.'));
      if (roleRefs.length) attrs.role_refs = roleRefs;
      const polRefs = [...collectRefs([plain.policy_arn, plain.policy])].filter((r) => r.startsWith('aws_iam_policy.') || r.startsWith('data.aws_iam_policy_document.'));
      if (polRefs.length) attrs.policy_refs = polRefs;
    }
    if (!isData && type === 'aws_iam_role' && pol?.resource_refs.length) attrs.role_refs = [self];
    if (cls.node === 'policy' || cls.node === 'role') {
      const roleName = plain.role ?? plain.role_definition_name;
      if (typeof roleName === 'string' && isAdminRole(roleName)) attrs.admin = true;
      const members = [...asArray(plain.members), ...asArray(plain.member)].filter((m) => typeof m === 'string');
      if (members.length) attrs.principals = [...new Set([...(attrs.principals ?? []), ...members])].sort();
    }
    let ingress = null;
    if (cls.node === 'firewall_rule') {
      ingress = ingressSummary(type, plain);
      attrs.public_ingress = ingress.public_ingress;
      attrs.ports = ingress.ports;
      attrs.wildcard_ports = ingress.wildcard_ports;
      attrs.cidrs = ingress.cidrs;
    }
    if (isData) delete attrs.stateful;

    facts.push(nodeFact('resource', key, { name: address, path, attrs }, P(block.line)));
    if (cls.node && !isData) {
      facts.push(nodeFact(cls.node, key, { name: address, path, attrs }, P(block.line)));
      facts.push(edgeFact('PROVISIONS', `resource:${key}`, `${cls.node}:${key}`, {}, P(block.line)));
      if (ingress) for (const c of ingress.cidrs.slice(0, 10)) emitEndpoint(c, `${cls.node}:${key}`, block.line);
    } else if (cls.node === 'policy' && isData) {
      facts.push(nodeFact('policy', key, { name: address, path, attrs }, P(block.line)));
    }
    if (isData) summary.data_sources++;
    else summary.resources++;
  };

  for (const b of body.blocks) {
    if (facts.length > MAX_FACTS) break;
    switch (b.type) {
      case 'resource':
        emitResource(b, false);
        break;
      case 'data':
        emitResource(b, true);
        break;
      case 'variable':
        summary.variables++;
        break;
      case 'output':
        summary.outputs++;
        break;
      case 'locals':
        summary.locals += Object.keys(b.body.attributes).length;
        break;
      case 'provider':
        summary.providers++;
        break;
      case 'moved': {
        const p = bodyToPlain(b.body);
        summary.moved.push({ from: p.from?.expr ?? String(p.from), to: p.to?.expr ?? String(p.to), line: b.line });
        break;
      }
      case 'import': {
        const p = bodyToPlain(b.body);
        summary.imports.push({ to: p.to?.expr ?? String(p.to), line: b.line });
        break;
      }
      case 'module': {
        const p = bodyToPlain(b.body);
        const callName = b.labels[0];
        const source = typeof p.source === 'string' ? p.source : null;
        if (!source) break;
        const local = /^\.{1,2}\//.test(source);
        const target = local ? pp.normalize(pp.join(dir || '.', source)) : source;
        const version = typeof p.version === 'string' ? p.version : null;
        let pinned;
        if (local) pinned = 'local';
        else if (/^(git::|github\.com|bitbucket\.org|git@)/.test(source) || /\?ref=/.test(source)) pinned = /[?&]ref=[\w.\/-]+/.test(source) ? 'ref' : 'unpinned';
        else pinned = classifyConstraint(version);
        const mid = `iac_module:${target}`;
        facts.push(nodeFact('iac_module', target, {
          name: target, attrs: { source: target, local, remote: !local, pinned, version_pinned: pinned === 'exact' || pinned === 'ref' || pinned === '~>' },
        }, P(b.line)));
        facts.push(edgeFact('DEPENDS_ON', stackId, mid, {
          call: callName, source, version, pinned, file: path, line: b.line, count: 'count' in b.body.attributes, for_each: 'for_each' in b.body.attributes,
        }, P(b.line)));
        summary.modules.push({ name: callName, key: target, id: mid });
        break;
      }
      case 'terraform': {
        const p = bodyToPlain(b.body);
        const rp = asArray(p.required_providers)[0];
        if (rp && typeof rp === 'object') {
          for (const [name, spec] of Object.entries(rp)) {
            if (name === '__labels') continue;
            const constraint = typeof spec === 'string' ? spec : lit(spec?.version);
            const source = typeof spec === 'object' ? lit(spec?.source) : null;
            const pinned = classifyConstraint(constraint);
            const id = `${dir || '.'}#provider.${name}`;
            summary.required_providers.push(name);
            facts.push(nodeFact('dependency', id, {
              name: `provider ${name}`, path, attrs: { kind: 'provider', provider: name, source: source ?? `hashicorp/${name}`, constraint: constraint ?? null, pinned, dir: dir || '.' },
            }, P(b.line)));
            facts.push(edgeFact('DEPENDS_ON', stackId, `dependency:${id}`, { pinned }, P(b.line)));
          }
        }
        const be = backendFrom(p);
        if (be) {
          summary.backend = be.type;
          const attrs = { ...be, file: path, line: b.line, dir: dir || '.' };
          const cfg = asArray(p.backend)[0];
          const bcfg = cfg && Array.isArray(cfg.__labels) ? cfg : cfg?.[be.type];
          if (bcfg && typeof bcfg === 'object') {
            if (typeof bcfg.bucket === 'string') attrs.bucket = bcfg.bucket;
            if (typeof bcfg.region === 'string') attrs.region = bcfg.region;
            if (typeof bcfg.path === 'string') attrs.state_path = bcfg.path;
          }
          const sid = dir || '.';
          facts.push(nodeFact('state_backend', sid, { name: `${be.type} backend (${sid})`, path, attrs }, P(b.line)));
          facts.push(edgeFact('MANAGES_STATE_FOR', `state_backend:${sid}`, stackId, {}, P(b.line)));
        }
        if (typeof lit(p.required_version) === 'string') summary.required_version = p.required_version;
        break;
      }
      default:
        break;
    }
  }

  const fileAttrs = { iac: summary };
  if (errors.length) fileAttrs.parse_errors = errors.slice(0, 5).map((e) => `${e.line}: ${e.message}`);
  if (facts.length > MAX_FACTS) {
    facts.length = MAX_FACTS;
    fileAttrs.truncated = true;
  }
  facts.push(nodeFact('file', path, { name: path, path, attrs: fileAttrs }, P(1, errors.length ? 'medium' : 'high')));
  return facts;
}

/** Multiset Jaccard: sum of mins over sum of maxes. */
export function multisetJaccard(a, b) {
  let min = 0;
  let max = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return max === 0 ? 0 : min / max;
}

const STACK_DIR_RE = /(?:^|\/)(?:envs|environments)\/[^/]+$/;

/**
 * Cross-file Terraform facts: stack nodes, reference edges, implicit backends/providers,
 * GRANTS edges and near-duplicate stack detection.
 * @param {{factsByFile: Map<string, object[]>}} ctx
 */
export function linkTerraform(ctx) {
  const out = [];
  /** @type {Map<string, {summary: object, path: string}>} */
  const dirs = new Map();
  const resourcesByDir = new Map();
  const callCount = new Map();
  const paths = [...ctx.factsByFile.keys()].sort();
  for (const path of paths) {
    for (const f of ctx.factsByFile.get(path)) {
      if (f.kind === 'node' && f.type === 'file' && f.attrs.iac) {
        const d = f.attrs.iac.dir;
        const cur = dirs.get(d);
        if (!cur) dirs.set(d, { summary: structuredClone(f.attrs.iac), paths: [path] });
        else {
          const s = cur.summary;
          for (const k of ['variables', 'outputs', 'locals', 'providers', 'resources', 'data_sources']) s[k] += f.attrs.iac[k];
          for (const k of ['modules', 'moved', 'imports', 'required_providers']) s[k].push(...f.attrs.iac[k]);
          s.backend ??= f.attrs.iac.backend;
          cur.paths.push(path);
        }
      } else if (f.kind === 'node' && f.type === 'resource' && f.attrs?.dir !== undefined) {
        const d = f.attrs.dir === '.' ? '' : f.attrs.dir;
        (resourcesByDir.get(d) ?? resourcesByDir.set(d, []).get(d)).push(f);
      } else if (f.kind === 'edge' && f.type === 'DEPENDS_ON' && f.from.startsWith('iac_module:') && f.attrs.call) {
        callCount.set(f.to, (callCount.get(f.to) ?? 0) + 1);
      }
    }
  }

  // Type multisets for the duplicate detector, per stack-looking directory.
  const multisets = new Map();
  for (const [d, res] of resourcesByDir) {
    if (!STACK_DIR_RE.test(d)) continue;
    const m = new Map();
    for (const r of res) if (!r.attrs.data) m.set(r.attrs.type, (m.get(r.attrs.type) ?? 0) + 1);
    if (m.size) multisets.set(d, m);
  }
  const dupOf = new Map();
  const sims = new Map();
  const stackDirs = [...multisets.keys()].sort();
  for (const a of stackDirs) {
    for (const b of stackDirs) {
      if (a === b) continue;
      const j = multisetJaccard(multisets.get(a), multisets.get(b));
      if (j >= 0.8) {
        (dupOf.get(a) ?? dupOf.set(a, []).get(a)).push(`iac_module:${b}`);
        sims.set(a, Math.max(sims.get(a) ?? 0, Math.round(j * 1000) / 1000));
      }
    }
  }

  const refTargets = new Map();
  for (const [d, res] of resourcesByDir) {
    const m = new Map();
    for (const r of res) m.set(r.attrs.address, r);
    refTargets.set(d, m);
  }

  for (const d of [...dirs.keys()].sort()) {
    const { summary, paths: dpaths } = dirs.get(d);
    const res = resourcesByDir.get(d) ?? [];
    const label = d || '.';
    const underModules = /(?:^|\/)modules\//.test(d);
    const uses = callCount.get(`iac_module:${label}`) ?? 0;
    const attrs = {
      kind: underModules ? 'module' : 'stack', dir: label, root: !underModules,
      resources: summary.resources, data_sources: summary.data_sources, variables: summary.variables, outputs: summary.outputs,
      module_calls: summary.modules.length, moved_blocks: summary.moved.length, import_blocks: summary.imports.length,
      moved: summary.moved.slice(0, 50), imports: summary.imports.slice(0, 50),
      backend: summary.backend ?? 'local (implicit)', uses,
      // Child modules (under modules/ or called by another module) declare minimum provider
      // versions; their callers' lock files pin them.
      child_module: underModules || uses > 0,
    };
    if (underModules) {
      attrs.one_use = uses === 1;
      attrs.unused = uses === 0;
      attrs.wrapper = summary.resources === 0 && summary.modules.length > 0;
    }
    if (dupOf.has(d)) {
      attrs.duplicate_of = dupOf.get(d).sort();
      attrs.duplicate_similarity = sims.get(d);
    }
    const p0 = prov({ source_type: 'config', source_ref: `${dpaths[0]}:1`, extractor: EXTRACTOR, confidence: 'high' });
    const pInfer = prov({ source_type: 'inference', source_ref: `${dpaths[0]}:1`, extractor: EXTRACTOR, confidence: 'medium' });
    const stackId = `iac_module:${label}`;
    out.push(nodeFact('iac_module', label, { name: label, path: d || null, attrs }, p0));
    for (const r of res) if (!r.attrs.data) out.push(edgeFact('PROVISIONS', stackId, r.id, {}, p0));

    // Root stacks that define resources but declare no backend keep state on local disk.
    if (!underModules && summary.resources > 0 && !summary.backend) {
      out.push(nodeFact('state_backend', label, {
        name: `local backend (${label})`, attrs: { type: 'local', remote: false, encrypt: false, locking: false, implicit: true, dir: label },
      }, pInfer));
      out.push(edgeFact('MANAGES_STATE_FOR', `state_backend:${label}`, stackId, {}, pInfer));
    }
    // Providers used but never declared in required_providers are unpinned by definition.
    const declared = new Set(summary.required_providers);
    const used = new Set(res.map((r) => r.attrs.provider));
    for (const prov0 of [...used].sort()) {
      if (declared.has(prov0)) continue;
      const id = `${label}#provider.${prov0}`;
      out.push(nodeFact('dependency', id, {
        name: `provider ${prov0}`, attrs: { kind: 'provider', provider: prov0, source: `hashicorp/${prov0}`, constraint: null, pinned: 'unpinned', implicit: true, dir: label },
      }, pInfer));
      out.push(edgeFact('DEPENDS_ON', stackId, `dependency:${id}`, { pinned: 'unpinned' }, pInfer));
    }

    // Reference edges, scoped to this directory (a Terraform module's namespace).
    const targets = refTargets.get(d) ?? new Map();
    const pre = keyPrefix(d);
    const calls = new Map(summary.modules.map((m) => [m.name, m.id]));
    for (const r of res) {
      const pr = prov({ source_type: 'config', source_ref: `${r.attrs.file}:${r.attrs.line}`, extractor: EXTRACTOR, confidence: 'high' });
      for (const ref of r.attrs.refs ?? []) {
        if (ref.startsWith('module.')) {
          const id = calls.get(ref.slice(7));
          if (id) out.push(edgeFact('DEPENDS_ON', r.id, id, { via: 'reference' }, pr));
        } else if (targets.has(ref)) {
          out.push(edgeFact('DEPENDS_ON', r.id, `resource:${pre}${ref}`, { via: 'reference' }, pr));
        }
      }
      // GRANTS: the role gains access to whatever the attached policy names.
      if (r.attrs.role_refs?.length) {
        const resRefs = new Set(r.attrs.resource_refs ?? []);
        for (const pref of r.attrs.policy_refs ?? []) for (const x of targets.get(pref)?.attrs.resource_refs ?? []) resRefs.add(x);
        for (const role of r.attrs.role_refs) {
          const roleNode = targets.get(role);
          if (!roleNode) continue;
          let any = false;
          for (const tref of [...resRefs].sort()) {
            if (tref === role || !targets.has(tref)) continue;
            any = true;
            out.push(edgeFact('GRANTS', `role:${pre}${role}`, `resource:${pre}${tref}`, {
              via: r.attrs.address, wildcard_actions: r.attrs.wildcard_actions ?? [],
            }, pr));
          }
          if (!any && r.attrs.type !== 'aws_iam_role') out.push(edgeFact('GRANTS', `role:${pre}${role}`, `policy:${pre}${r.attrs.address}`, {}, pr));
        }
      }
    }
  }
  return out;
}

export { analyzePolicyDocument };
