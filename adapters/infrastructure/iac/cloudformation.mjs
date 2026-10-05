// CloudFormation (YAML/JSON, CDK synth output), ARM JSON, Bicep and Pulumi YAML -> graph
// facts, using the same resource/typed-node scheme as Terraform so downstream detectors do
// not care which tool declared a thing. Bicep is extracted lexically (it has no stable
// machine-readable grammar here), so its facts carry `confidence: 'medium'`.

import { posix as pp } from 'node:path';
import { edgeFact, nodeFact, prov } from '../../../runtime/graph/facts.mjs';
import { parseYAML } from '../../../runtime/core/yaml.mjs';
import { dirOf } from './terraform.mjs';
import {
  analyzeResourcePolicies, classifyResource, ingressSummary, isAdminRole, isPublicCidr, pick, safeAttrs,
} from './analysis.mjs';

const EXTRACTOR = 'iac@0.1.1';
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const ADMIN_GUIDS = ['8e3af657-a8ff-443c-a75c-2fe8c4bcb635', 'b24988ac-6180-42a0-ab88-20f7382dd24c', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9'];

/** Key prefix: root-level files stay bare, others are qualified by path so templates never collide. */
function pathPrefix(path) {
  if (!path.includes('/')) return '';
  return `${path.replace(/\.(template\.)?(json|ya?ml|bicep)$/i, '')}.`;
}

function lineOfKey(text, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^\\s*["']?${esc}["']?\\s*:`, 'm').exec(text);
  return m ? text.slice(0, m.index).split('\n').length : 1;
}

/** Emit the resource node, its typed twin, and ingress endpoints. */
function emitResource(facts, P, { tool, key, name, path, attrs, cls, ingress, line }) {
  facts.push(nodeFact('resource', key, { name, path, attrs }, P(line)));
  if (!cls.node) return;
  facts.push(nodeFact(cls.node, key, { name, path, attrs }, P(line)));
  facts.push(edgeFact('PROVISIONS', `resource:${key}`, `${cls.node}:${key}`, {}, P(line)));
  if (ingress) {
    for (const c of ingress.cidrs.slice(0, 10)) {
      facts.push(nodeFact('net_endpoint', c, { name: c, attrs: { public: isPublicCidr(c) } }, P(line)));
      facts.push(edgeFact('ALLOWS_INGRESS_FROM', `${cls.node}:${key}`, `net_endpoint:${c}`, {}, P(line)));
    }
  }
  void tool;
}

function applyAnalysis(attrs, type, props, cls) {
  const pol = analyzeResourcePolicies(props);
  if (pol) {
    attrs.wildcard_actions = pol.wildcard_actions;
    attrs.wildcard_resources = pol.wildcard_resources;
    attrs.admin = pol.admin;
    attrs.principals = pol.principals;
    attrs.public_principal = pol.public_principal;
    attrs.policy_literal = pol.literal;
    attrs.policy_statements = pol.statements;
  }
  let ingress = null;
  if (cls.node === 'firewall_rule') {
    ingress = ingressSummary(type, props);
    attrs.public_ingress = ingress.public_ingress;
    attrs.ports = ingress.ports;
    attrs.wildcard_ports = ingress.wildcard_ports;
    attrs.cidrs = ingress.cidrs;
  }
  return { pol, ingress };
}

// ---------------------------------------------------------------------------------------
// CloudFormation

/** Logical ids referenced via Ref, Fn::GetAtt and Fn::Sub (`${Id}` / `${Id.Attr}`) anywhere in a value. */
export function collectCfnRefs(value, known, acc = new Set(), depth = 0) {
  if (depth > 40 || value === null || value === undefined) return acc;
  if (Array.isArray(value)) {
    for (const v of value) collectCfnRefs(v, known, acc, depth + 1);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'Ref' && typeof v === 'string' && known.has(v)) acc.add(v);
      else if (k === 'Fn::GetAtt') {
        const id = Array.isArray(v) ? v[0] : String(v).split('.')[0];
        if (known.has(id)) acc.add(id);
      } else if (k === 'Fn::Sub') {
        const s = Array.isArray(v) ? v[0] : v;
        if (typeof s === 'string') for (const m of s.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[\w.]+)?\}/g)) if (known.has(m[1])) acc.add(m[1]);
        if (Array.isArray(v)) collectCfnRefs(v[1], known, acc, depth + 1);
      } else collectCfnRefs(v, known, acc, depth + 1);
    }
  }
  return acc;
}

/** Values of every `Resource` key inside policy documents, for GRANTS targets. */
function policyResourceValues(value, out = [], depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'Resource') out.push(v);
    else policyResourceValues(v, out, depth + 1);
  }
  return out;
}

function isCfn(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  if (typeof doc.AWSTemplateFormatVersion === 'string' || doc.AWSTemplateFormatVersion instanceof Date) return true;
  const r = doc.Resources;
  return Boolean(r && typeof r === 'object' && Object.values(r).some((x) => typeof x?.Type === 'string' && /^(AWS|Custom|Alexa)::|^Custom::/.test(x.Type)));
}

function isArm(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (typeof doc.$schema === 'string' && /deploymentTemplate/i.test(doc.$schema)) return true;
  return Array.isArray(doc.resources) && doc.resources.some((r) => typeof r?.type === 'string' && /^Microsoft\./.test(r.type));
}

function parseDoc(path, text) {
  const t = text.trimStart();
  try {
    if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(text);
    return parseYAML(text, { tags: 'cloudformation' });
  } catch {
    return null;
  }
}

function extractCfn(path, text, doc) {
  const facts = [];
  const P = (line, confidence = 'high') => prov({ source_type: 'config', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });
  const pre = pathPrefix(path);
  const resources = doc.Resources && typeof doc.Resources === 'object' ? doc.Resources : {};
  const known = new Set(Object.keys(resources));
  const keyOf = (id) => `cfn.${pre}${id}`;
  const analysed = new Map();
  for (const id of Object.keys(resources).sort()) {
    const res = resources[id];
    if (!res || typeof res.Type !== 'string') continue;
    const props = res.Properties && typeof res.Properties === 'object' ? res.Properties : {};
    const type = res.Type;
    const line = lineOfKey(text, id);
    const cls = classifyResource(type);
    const refs = collectCfnRefs([props, res.Condition], known);
    for (const d of asArray(res.DependsOn)) if (known.has(d)) refs.add(d);
    refs.delete(id);
    const attrs = {
      provider: 'aws', type, name: id, logical_id: id, file: path, line, dir: dirOf(path) || '.',
      template: path, data: false,
      cdk: path.includes('cdk.out') || Boolean(res.Metadata?.['aws:cdk:path']),
      tags: Array.isArray(props.Tags) ? props.Tags.length > 0 : Boolean(props.Tags),
      conditional: res.Condition !== undefined,
      ...(res.DeletionPolicy ? { deletion_policy: res.DeletionPolicy } : {}),
      ...(res.UpdateReplacePolicy ? { update_replace_policy: res.UpdateReplacePolicy } : {}),
      ...(refs.size ? { refs: [...refs].sort() } : {}),
      ...safeAttrs(props),
    };
    if (cls.node) attrs.classified_as = cls.node;
    if (cls.stateful) attrs.stateful = true;
    const { pol, ingress } = applyAnalysis(attrs, type, props, cls);
    const resRefs = pol ? [...collectCfnRefs(policyResourceValues(props), known)].sort() : [];
    if (resRefs.length) attrs.resource_refs = resRefs;
    analysed.set(id, { attrs, resRefs, props, type });
    emitResource(facts, P, { tool: 'cfn', key: keyOf(id), name: id, path, attrs, cls, ingress, line });
    for (const r of [...refs].sort()) facts.push(edgeFact('DEPENDS_ON', `resource:${keyOf(id)}`, `resource:${keyOf(r)}`, { via: 'reference' }, P(line)));
  }
  // GRANTS: a role (or the role a policy attaches to) gains access to what its statements name.
  for (const [id, a] of analysed) {
    if (!a.resRefs.length) continue;
    const roles = a.type === 'AWS::IAM::Role' ? [id] : [...collectCfnRefs(a.props.Roles, known)].filter((r) => resources[r]?.Type === 'AWS::IAM::Role');
    for (const role of roles) {
      for (const target of a.resRefs) {
        if (target === role) continue;
        facts.push(edgeFact('GRANTS', `role:${keyOf(role)}`, `resource:${keyOf(target)}`, { via: id, wildcard_actions: a.attrs.wildcard_actions ?? [] }, P(a.attrs.line)));
      }
    }
  }
  const params = doc.Parameters && typeof doc.Parameters === 'object' ? Object.keys(doc.Parameters).length : 0;
  const outputs = doc.Outputs && typeof doc.Outputs === 'object' ? Object.keys(doc.Outputs).length : 0;
  facts.push(nodeFact('file', path, {
    name: path, path, attrs: { iac_template: { kind: 'cloudformation', resources: known.size, parameters: params, outputs, transform: doc.Transform ?? null, cdk: path.includes('cdk.out') } },
  }, P(1)));
  return facts;
}

// ---------------------------------------------------------------------------------------
// ARM

function armResources(list, out = [], depth = 0) {
  if (depth > 8) return out;
  for (const r of asArray(list)) {
    if (!r || typeof r !== 'object') continue;
    out.push(r);
    armResources(r.resources, out, depth + 1);
  }
  return out;
}

function extractArm(path, text, doc) {
  const facts = [];
  const P = (line, confidence = 'high') => prov({ source_type: 'config', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });
  const pre = pathPrefix(path);
  const list = armResources(doc.resources).filter((r) => typeof r.type === 'string');
  const keyFor = (r) => `arm.${pre}${r.type}/${String(r.name ?? '').replace(/[\s]+/g, '')}`;
  const byTypeName = new Map(list.map((r) => [`${r.type.toLowerCase()}|${String(r.name ?? '')}`, r]));
  for (const r of list) {
    const props = r.properties && typeof r.properties === 'object' ? r.properties : {};
    const cls = classifyResource(r.type);
    const key = keyFor(r);
    const line = lineOfKey(text, 'type');
    const attrs = {
      provider: 'azure', type: r.type, name: String(r.name ?? ''), api_version: r.apiVersion ?? null, file: path, line, dir: dirOf(path) || '.',
      template: path, data: false, tags: Boolean(r.tags), ...safeAttrs({ ...props, location: r.location }),
    };
    if (cls.node) attrs.classified_as = cls.node;
    if (cls.stateful) attrs.stateful = true;
    const { ingress } = applyAnalysis(attrs, r.type, props, cls);
    if (/roleassignments/i.test(r.type)) {
      const rd = JSON.stringify(props.roleDefinitionId ?? '');
      if (ADMIN_GUIDS.some((g) => rd.includes(g))) attrs.admin = true;
    }
    emitResource(facts, P, { tool: 'arm', key, name: `${r.type}/${attrs.name}`, path, attrs, cls, ingress, line });
    for (const dep of asArray(r.dependsOn)) {
      if (typeof dep !== 'string') continue;
      const m = /resourceId\(\s*'([^']+)'\s*,\s*(.+?)\s*\)\s*\]?$/.exec(dep);
      const target = m ? byTypeName.get(`${m[1].toLowerCase()}|[${m[2]}]`) ?? [...byTypeName.values()].find((x) => x.type.toLowerCase() === m[1].toLowerCase() && String(x.name).includes(m[2].replace(/'/g, '').trim())) : undefined;
      if (target && target !== r) facts.push(edgeFact('DEPENDS_ON', `resource:${key}`, `resource:${keyFor(target)}`, { via: 'dependsOn' }, P(line, 'medium')));
    }
  }
  facts.push(nodeFact('file', path, { name: path, path, attrs: { iac_template: { kind: 'arm', resources: list.length, parameters: Object.keys(doc.parameters ?? {}).length, outputs: Object.keys(doc.outputs ?? {}).length } } }, P(1)));
  return facts;
}

// ---------------------------------------------------------------------------------------
// Bicep (lexical)

/** Index just past the bracket matching the opener at `at`, skipping Bicep strings. */
function matchBracket(s, at) {
  const open = s[at];
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0;
  for (let j = at; j < s.length; j++) {
    const c = s[j];
    if (c === "'") {
      j++;
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return s.length;
}

function stripBicepComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += c;
  }
  return out;
}

function bicepScalar(raw) {
  const t = raw.trim().replace(/,$/, '');
  let m = /^'([^'$]*)'$/.exec(t);
  if (m) return m[1];
  if (t === 'true') return true;
  if (t === 'false') return false;
  m = /^-?\d+(\.\d+)?$/.exec(t);
  return m ? Number(t) : undefined;
}

/** Scalar `key: value` lines of a Bicep object body as nested plain objects (expressions are skipped). */
export function bicepProps(body) {
  const root = {};
  const stack = [root];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '{' || line === '[') {
      stack.push({});
      continue;
    }
    if (/^[}\]]/.test(line)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const m = /^([\w$-]+|'[^']+')\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/^'|'$/g, '');
    const rest = m[2].trim();
    const cur = stack[stack.length - 1];
    if (/[{[]$/.test(rest) && !/[}\]]$/.test(rest.slice(0, -1))) {
      const child = cur[key] && typeof cur[key] === 'object' ? cur[key] : {};
      cur[key] = child;
      stack.push(child);
    } else {
      const v = bicepScalar(rest);
      if (v !== undefined) cur[key] = v;
    }
  }
  return root;
}

function extractBicep(path, rawText) {
  const text = stripBicepComments(rawText);
  const facts = [];
  const P = (line, confidence = 'medium') => prov({ source_type: 'config', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });
  const pre = pathPrefix(path);
  const dir = dirOf(path);
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;
  const decls = [];
  const resRe = /^[ \t]*resource\s+(\w+)\s+'([^']+)'\s*(existing\s*)?=\s*(?:if\s*\([^)]*\)\s*)?/gm;
  let m;
  while ((m = resRe.exec(text))) {
    let at = resRe.lastIndex;
    while (text[at] === ' ') at++;
    let bodyText = '';
    if (text[at] === '{') bodyText = text.slice(at, matchBracket(text, at));
    else if (text.startsWith('[for', at) || text[at] === '[') {
      const end = matchBracket(text, at);
      const inner = text.indexOf('{', at);
      bodyText = inner >= 0 && inner < end ? text.slice(inner, matchBracket(text, inner)) : '';
    }
    decls.push({ sym: m[1], full: m[2], existing: Boolean(m[3]), body: bodyText, line: lineAt(m.index), index: m.index });
  }
  const syms = new Set(decls.map((d) => d.sym));
  const keyOf = (sym) => `bicep.${pre}${sym}`;
  for (const d of decls) {
    const [type, apiVersion] = d.full.split('@');
    const props = bicepProps(d.body.replace(/^\{/, '').replace(/\}$/, ''));
    const leaves = {};
    const walk = (o, depth = 0) => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') {
          if (depth < 4) walk(v, depth + 1);
        } else if (!(k in leaves)) leaves[k] = v;
      }
    };
    walk(props);
    const cls = classifyResource(type);
    const refs = new Set();
    for (const s of syms) {
      if (s !== d.sym && new RegExp(`\\b${s}\\b(?!\\s*:)`).test(d.body)) refs.add(s);
    }
    const attrs = {
      provider: 'azure', type, name: typeof props.name === 'string' ? props.name : d.sym, symbolic_name: d.sym, api_version: apiVersion ?? null,
      file: path, line: d.line, dir: dir || '.', data: d.existing, existing: d.existing, template: path,
      tags: Boolean(props.tags), ...(refs.size ? { refs: [...refs].sort() } : {}), ...safeAttrs(leaves),
    };
    if (cls.node) attrs.classified_as = cls.node;
    if (cls.stateful && !d.existing) attrs.stateful = true;
    // Inline NSG rules: pull each `{ ... }` out of `securityRules: [...]`.
    let ingressProps = leaves;
    const sr = d.body.indexOf('securityRules:');
    if (sr >= 0) {
      const open = d.body.indexOf('[', sr);
      if (open >= 0) {
        const end = matchBracket(d.body, open);
        const rules = [];
        for (let j = open + 1; j < end; j++) {
          if (d.body[j] === '{') {
            const stop = matchBracket(d.body, j);
            rules.push(bicepProps(d.body.slice(j + 1, stop - 1)));
            j = stop - 1;
          }
        }
        ingressProps = { securityRules: rules };
      }
    }
    const { ingress } = d.existing ? { ingress: null } : applyAnalysis(attrs, type, ingressProps, cls);
    if (/roleassignments/i.test(type) && ADMIN_GUIDS.some((g) => d.body.includes(g)) || /roleDefinitionId[^\n]*'(Owner|Contributor)'/.test(d.body)) attrs.admin = true;
    if (/roleassignments/i.test(type) && isAdminRole(leaves.roleDefinitionName)) attrs.admin = true;
    if (!d.existing) emitResource(facts, P, { tool: 'bicep', key: keyOf(d.sym), name: d.sym, path, attrs, cls, ingress, line: d.line });
    else facts.push(nodeFact('resource', keyOf(d.sym), { name: d.sym, path, attrs }, P(d.line)));
    for (const r of [...refs].sort()) facts.push(edgeFact('DEPENDS_ON', `resource:${keyOf(d.sym)}`, `resource:${keyOf(r)}`, { via: 'reference' }, P(d.line)));
  }
  // Modules: `module name './x.bicep' = {` -> iac_module + DEPENDS_ON from this file's stack.
  const modRe = /^[ \t]*module\s+(\w+)\s+'([^']+)'/gm;
  const stackId = `iac_module:${dir || '.'}`;
  let modules = 0;
  while ((m = modRe.exec(text))) {
    modules++;
    const src = m[2];
    const local = /^\.{1,2}\//.test(src);
    const target = local ? pp.normalize(pp.join(dir || '.', src)) : src;
    facts.push(nodeFact('iac_module', target, { name: target, attrs: { source: target, local, remote: !local, kind: 'bicep' } }, P(lineAt(m.index))));
    facts.push(edgeFact('DEPENDS_ON', stackId, `iac_module:${target}`, { call: m[1], source: src, file: path }, P(lineAt(m.index))));
  }
  const params = (text.match(/^[ \t]*param\s+\w+/gm) ?? []).length;
  const outputs = (text.match(/^[ \t]*output\s+\w+/gm) ?? []).length;
  facts.push(nodeFact('file', path, {
    name: path, path, attrs: { iac_template: { kind: 'bicep', resources: decls.length, parameters: params, outputs, modules } },
  }, P(1)));
  return facts;
}

// ---------------------------------------------------------------------------------------
// Pulumi YAML

function extractPulumiYaml(path, text, doc) {
  const facts = [];
  const P = (line, confidence = 'high') => prov({ source_type: 'config', source_ref: `${path}:${line}`, extractor: EXTRACTOR, confidence });
  const pre = pathPrefix(path);
  const resources = doc.resources && typeof doc.resources === 'object' ? doc.resources : {};
  const known = new Set(Object.keys(resources));
  const keyOf = (n) => `pulumi.${pre}${n}`;
  for (const name of Object.keys(resources).sort()) {
    const r = resources[name];
    if (!r || typeof r.type !== 'string') continue;
    const props = r.properties && typeof r.properties === 'object' ? r.properties : {};
    const cls = classifyResource(r.type);
    const line = lineOfKey(text, name);
    const refs = new Set();
    for (const m of JSON.stringify([props, r.options ?? {}]).matchAll(/\$\{([A-Za-z0-9_-]+)(?:\.[\w.-]+)?\}/g)) if (known.has(m[1]) && m[1] !== name) refs.add(m[1]);
    const attrs = {
      provider: r.type.split(':')[0], type: r.type, name, file: path, line, dir: dirOf(path) || '.', template: path, data: false,
      tags: Boolean(props.tags), ...(refs.size ? { refs: [...refs].sort() } : {}), ...safeAttrs(props),
    };
    if (cls.node) attrs.classified_as = cls.node;
    if (cls.stateful) attrs.stateful = true;
    if (r.options?.protect === true) attrs.lifecycle = { prevent_destroy: true };
    const { ingress } = applyAnalysis(attrs, r.type, props, cls);
    emitResource(facts, P, { tool: 'pulumi', key: keyOf(name), name, path, attrs, cls, ingress, line });
    for (const x of [...refs].sort()) facts.push(edgeFact('DEPENDS_ON', `resource:${keyOf(name)}`, `resource:${keyOf(x)}`, { via: 'reference' }, P(line)));
  }
  facts.push(nodeFact('file', path, {
    name: path, path, attrs: { iac_template: { kind: 'pulumi-yaml', resources: known.size, runtime: doc.runtime ?? null, name: doc.name ?? null } },
  }, P(1)));
  return facts;
}

/**
 * Extract facts from a CloudFormation/CDK/ARM/Bicep/Pulumi-YAML file. Files that match the
 * glob but are none of these (a plain JSON config under `cloudformation/`) yield no facts.
 * @param {{path: string}} file
 * @param {string} text
 * @returns {object[]}
 */
export function extractCloudFormation(file, text) {
  const path = file.path;
  if (/\.bicep$/i.test(path)) return extractBicep(path, text);
  const doc = parseDoc(path, text);
  if (!doc || typeof doc !== 'object') return [];
  if (/(^|\/)Pulumi\.ya?ml$/i.test(path)) return doc.resources && typeof doc.resources === 'object' ? extractPulumiYaml(path, text, doc) : [];
  if (isCfn(doc)) return extractCfn(path, text, doc);
  if (isArm(doc)) return extractArm(path, text, doc);
  return [];
}
