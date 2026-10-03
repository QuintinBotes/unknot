// Configuration management: Ansible, Puppet, Chef and Salt (spec §15.2). Each file becomes
// an `iac_module:<path>` node with counts that matter for review (shell escape hatches,
// privilege escalation, secrets without `no_log`).
//
// SECRECY: only module names, role names and counts are recorded. Variable and parameter
// values are never read into facts; "password-like" is decided from key names/keywords.

import { posix } from 'node:path';
import { nodeFact, edgeFact } from '../../../runtime/graph/facts.mjs';
import { isObj, asArray, asString, uniqSorted, provMaker, dirOf, parseDocs, resolveRel } from './util.mjs';

const TASK_KEYWORDS = new Set([
  'name', 'when', 'register', 'tags', 'become', 'become_user', 'become_method', 'vars', 'loop', 'loop_control', 'notify',
  'ignore_errors', 'ignore_unreachable', 'no_log', 'delegate_to', 'delegate_facts', 'args', 'environment', 'block', 'rescue',
  'always', 'changed_when', 'failed_when', 'until', 'retries', 'delay', 'listen', 'run_once', 'check_mode', 'diff',
  'connection', 'any_errors_fatal', 'throttle', 'timeout', 'remote_user', 'collections', 'module_defaults', 'local_action',
]);
const SHELL_MODULES = new Set(['shell', 'command', 'raw', 'script', 'win_shell', 'win_command']);
const PASSWORD_LIKE = /(pass(word|wd)?\b|passphrase|secret|token|api_?key|private_?key)/i;
const truthy = (v) => v === true || (typeof v === 'string' && /^(yes|true)$/i.test(v));

/** Strip a collection prefix: `ansible.builtin.shell` -> `shell`. */
const moduleBase = (k) => k.split('.').pop();

function walkTasks(tasks, ctx, inheritedBecome) {
  for (const t of asArray(tasks)) {
    if (!isObj(t)) continue;
    const become = 'become' in t ? truthy(t.become) : inheritedBecome;
    for (const sec of ['block', 'rescue', 'always']) if (t[sec]) walkTasks(t[sec], ctx, become);
    const modKey = Object.keys(t).find((k) => !TASK_KEYWORDS.has(k));
    if (!modKey) continue; // pure block container
    ctx.tasks += 1;
    const mod = moduleBase(modKey);
    if (SHELL_MODULES.has(mod)) ctx.shell += 1;
    if (become) ctx.privileged += 1;
    if (mod === 'include_role' || mod === 'import_role') {
      const n = isObj(t[modKey]) ? asString(t[modKey].name) : null;
      if (n) ctx.roles.add(n);
    }
    if (mod === 'import_playbook' || mod === 'include_playbook') ctx.imports.add(String(t[modKey]));
    // Decide "password-like" from key names and the argument text, then discard both.
    const args = t[modKey];
    const keys = [...Object.keys(isObj(args) ? args : {}), ...Object.keys(isObj(t.vars) ? t.vars : {}), ...Object.keys(isObj(t.args) ? t.args : {})];
    const looksSecret = keys.some((k) => PASSWORD_LIKE.test(k)) || (typeof args === 'string' && PASSWORD_LIKE.test(args));
    if (looksSecret && !truthy(t.no_log)) ctx.missingNoLog += 1;
  }
}

/** Regex fallback when Jinja in unquoted scalars defeats the YAML parser. */
function ansibleFallback(text) {
  const count = (re) => (text.match(re) ?? []).length;
  return {
    plays: count(/^\s*-\s*hosts:/gm),
    tasks: count(/^\s+-\s+(name:|[\w.]+:)/gm),
    shell: count(/^\s+(-\s+)?(ansible\.builtin\.)?(shell|command|raw|script):/gm),
    privileged: count(/^\s*(-\s+)?become:\s*(true|yes)\b/gm),
  };
}

const role = (p) => /(^|\/)roles\/[^/]+\/(tasks|handlers|meta)\/[^/]+\.ya?ml$/.test(p);

/** Is this path an Ansible file this module handles? */
export function isAnsiblePath(path) {
  const base = posix.basename(path);
  return /^playbook.*\.ya?ml$/.test(base) || role(path);
}

/** @returns {object[]} facts for one Ansible playbook or role file */
export function extractAnsible(path, text) {
  const mk = provMaker(path);
  const dir = dirOf(path);
  const ctx = { tasks: 0, shell: 0, privileged: 0, missingNoLog: 0, roles: new Set(), imports: new Set() };
  const hosts = new Set();
  let plays = 0;
  let becomePlays = 0;
  let fallback = false;
  const [first] = parseDocs(text);
  if (first?.error) {
    fallback = true;
    const f = ansibleFallback(text);
    plays = f.plays; ctx.tasks = f.tasks; ctx.shell = f.shell; ctx.privileged = f.privileged;
  } else if (Array.isArray(first?.doc)) {
    for (const item of first.doc) {
      if (!isObj(item)) continue;
      if ('import_playbook' in item) { ctx.imports.add(String(item.import_playbook)); continue; }
      if ('hosts' in item) {
        plays += 1;
        for (const h of asArray(item.hosts)) { const s = asString(h); if (s) hosts.add(s); }
        const pb = truthy(item.become);
        if (pb) becomePlays += 1;
        for (const r of asArray(item.roles)) {
          const n = isObj(r) ? asString(r.role ?? r.name) : asString(r);
          if (n) ctx.roles.add(n);
        }
        for (const sec of ['pre_tasks', 'tasks', 'post_tasks', 'handlers']) walkTasks(item[sec], ctx, pb);
      } else {
        walkTasks([item], ctx, false);
      }
    }
  } else if (isObj(first?.doc) && /\/meta\/[^/]+\.ya?ml$/.test(path)) {
    for (const d of asArray(first.doc.dependencies)) {
      const n = isObj(d) ? asString(d.role ?? d.name) : asString(d);
      if (n) ctx.roles.add(n);
    }
    if (ctx.roles.size === 0) return [];
  } else {
    return [];
  }
  if (!fallback && plays === 0 && ctx.tasks === 0 && ctx.roles.size === 0 && ctx.imports.size === 0) return [];
  const facts = [nodeFact('iac_module', path, {
    name: path,
    path,
    attrs: {
      tool: 'ansible', hosts: [...hosts].sort(), plays, become_plays: becomePlays,
      tasks: ctx.tasks, shell_tasks: ctx.shell, privileged_tasks: ctx.privileged,
      missing_no_log_tasks: ctx.missingNoLog, roles: [...ctx.roles].sort(),
      parse_fallback: fallback || undefined,
      role_file: role(path),
    },
  }, mk(1, fallback ? { confidence: 'medium' } : {}))];
  for (const imp of [...ctx.imports].sort()) {
    const rel = resolveRel(dir, imp);
    if (rel) facts.push(edgeFact('DEPENDS_ON', `iac_module:${path}`, `iac_module:${rel}`, { via: 'import_playbook' }, mk(1)));
  }
  return facts;
}

const stripHashComments = (text) => text.replace(/^\s*#.*$/gm, '');

/** @returns {object[]} facts for a Puppet manifest */
export function extractPuppet(path, text) {
  const t = stripHashComments(text);
  const classes = [...t.matchAll(/^\s*class\s+([\w:]+)/gm)].map((m) => m[1]);
  const defines = [...t.matchAll(/^\s*define\s+([\w:]+)/gm)].map((m) => m[1]);
  const nodes = [...t.matchAll(/^\s*node\s+['"]?([\w.\-/]+)['"]?/gm)].map((m) => m[1]);
  const skip = new Set(['class', 'define', 'node', 'if', 'unless', 'case', 'else', 'elsif', 'default', 'include', 'require']);
  const resources = [...t.matchAll(/^\s*(@{0,2}[a-z][\w:]*)\s*\{\s*(?:'[^']*'|"[^"]*"|\$[\w:]+|\[[^\]]*\])\s*:/gm)]
    .map((m) => m[1].replace(/^@+/, '')).filter((r) => !skip.has(r));
  if (!classes.length && !defines.length && !resources.length && !nodes.length) return [];
  const mk = provMaker(path);
  const shell = resources.filter((r) => r === 'exec').length;
  return [nodeFact('iac_module', path, {
    name: path,
    path,
    attrs: {
      tool: 'puppet', hosts: uniqSorted(nodes), classes: classes.length, defines: defines.length, class_names: uniqSorted(classes),
      resources: resources.length, shell_tasks: shell,
      privileged_tasks: (t.match(/\buser\s*=>\s*['"]?root['"]?/g) ?? []).length,
    },
  }, mk(1, { confidence: 'medium' }))];
}

/** @returns {object[]} facts for a Chef recipe */
export function extractChef(path, text) {
  const t = stripHashComments(text);
  const resources = [...t.matchAll(/^[ \t]*([a-z][a-z_]*)[ \t]+(?:['"%:(\[]|[a-z_@]+\b)[^\n]*?\bdo[ \t]*(\|[^|\n]*\|)?[ \t]*$/gm)]
    .map((m) => m[1]).filter((r) => !['if', 'unless', 'while', 'until', 'case', 'loop', 'begin', 'lambda', 'proc'].includes(r));
  if (!resources.length) return [];
  const mk = provMaker(path);
  const shell = resources.filter((r) => ['execute', 'bash', 'script', 'powershell_script', 'batch'].includes(r)).length;
  return [nodeFact('iac_module', path, {
    name: path,
    path,
    attrs: {
      tool: 'chef', hosts: [], resources: resources.length, resource_types: uniqSorted(resources),
      shell_tasks: shell,
      privileged_tasks: (t.match(/\b(user|group)\s+['"]root['"]|\bsudo\b/g) ?? []).length,
    },
  }, mk(1, { confidence: 'medium' }))];
}

/** @returns {object[]} facts for a Salt state file; regex based because sls is Jinja-first */
export function extractSalt(path, text) {
  const t = stripHashComments(text);
  const states = [...t.matchAll(/^\s+-?\s*([a-z_]+\.[a-z_]+)\s*:?\s*$/gm)].map((m) => m[1]);
  const ids = [...t.matchAll(/^([^\s#{%\-][^\n]*?):\s*$/gm)].length;
  if (!states.length && !ids) return [];
  const mk = provMaker(path);
  return [nodeFact('iac_module', path, {
    name: path,
    path,
    attrs: {
      tool: 'salt', hosts: [], state_ids: ids, states: states.length, state_modules: uniqSorted(states.map((s) => s.split('.')[0])),
      shell_tasks: states.filter((s) => /^cmd\.(run|script|wait|call)$/.test(s)).length,
      privileged_tasks: (t.match(/\b(runas|user):\s*root\b/g) ?? []).length,
    },
  }, mk(1, { confidence: 'medium' }))];
}
