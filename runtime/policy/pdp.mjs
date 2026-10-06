// The policy decision point (spec §6.1: "agents may propose operations; only the
// deterministic runtime authorizes them"). Pure decisions over an operation, the active
// run, the actor's capability and the effective config. Recording and budget charging
// happen in the caller, so this module is easy to test exhaustively.

import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { matchAny } from '../core/glob.mjs';
import { isInside, isSecretPath, realpathLenient, toPosix } from '../core/paths.mjs';
import { unknotHome } from '../core/project.mjs';
import { profileFor } from './capability.mjs';
import { COMMANDS } from '../state/runs.mjs';
import { basenameOf, effectiveCommands, parseShell } from '../core/shell.mjs';
import { judgeShell } from './commands.mjs';
import { modeRank } from './defaults.mjs';

export const DOC_PATHS = Object.freeze(['docs/architecture/**', 'docs/adr/**', 'docs/decisions/**', 'docs/runbooks/**', '.unknot/docs/**']);

// Tools that neither read project content nor change anything outside the conversation.
const INERT_TOOLS = new Set([
  'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'AskUserQuestion',
  'ToolSearch', 'Skill', 'EnterPlanMode', 'ExitPlanMode', 'ListMcpResourcesTool',
]);
// Scheduling a later turn (wake-ups, monitors, cron, remote triggers) or leaving a command
// running in the background would let work continue after the run's turn ends, where the run
// no longer applies. These are unknown tools during a run, so they are denied by default.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NET_TOOLS = new Set(['WebFetch', 'WebSearch']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);

const allow = (policy, extra = {}) => ({ decision: 'allow', reasons: [], policy_ids: [policy], ...extra });
const deny = (policy, reason, extra = {}) => ({ decision: 'deny', reasons: [reason], policy_ids: [policy], ...extra });

/** Translate a Claude Code tool call into an Unknot operation. */
export function toOperation(toolName, input = {}, cwd) {
  const at = (p) => (p ? (isAbsolute(p) ? p : resolve(cwd ?? process.cwd(), p)) : null);
  if (READ_TOOLS.has(toolName)) return { op: 'fs.read', tool: toolName, paths: [at(input.file_path ?? input.path ?? input.notebook_path ?? '.')] };
  if (WRITE_TOOLS.has(toolName)) return { op: 'fs.write', tool: toolName, paths: [at(input.file_path ?? input.notebook_path)] };
  if (toolName === 'Bash') return { op: 'exec', tool: toolName, command: String(input.command ?? ''), ...(input.run_in_background === true && { background: true }) };
  if (NET_TOOLS.has(toolName)) {
    let domain = 'web-search';
    if (toolName === 'WebFetch') {
      try {
        domain = new URL(input.url).hostname;
      } catch {
        domain = '<invalid>';
      }
    }
    return { op: 'net', tool: toolName, domain };
  }
  if (AGENT_TOOLS.has(toolName)) return { op: 'agent.spawn', tool: toolName, agent_type: input.subagent_type ?? null };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return { op: 'mcp', tool: toolName, server: mcp[1], name: mcp[2] };
  if (INERT_TOOLS.has(toolName)) return { op: 'inert', tool: toolName };
  return { op: 'unknown', tool: toolName };
}

/**
 * Protections that apply whenever the project is initialised, run or no run: the
 * runtime's own state, configuration, decisions and keys are never model-writable.
 */
const HUMAN_ONLY_TEXT = /\bunknot\b[^\n;|&]*\b(approve|keys|config\s+accept|run\s+end|policy\s+sign|shred|unlock|lane\s+(?:approve|revoke))\b/;
// Commands whose arguments and input are data: words in them name nothing that runs. Anything
// else (a shell, eval, xargs, an interpreter, a package runner) may run text as code.
const DATA_ONLY = new Set(['cat', 'echo', 'printf', 'tee', 'gh', 'git', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'ls', 'mkdir', 'touch', 'cp', 'mv', 'diff', 'jq', 'true', 'cd', 'pwd', 'test', '[']);

/**
 * Does this command run a human-only unknot subcommand? Judged on the commands that would run
 * (wrappers such as `bash -c`, `eval`, `env` and `sudo` unwrapped), so a heredoc body or a quoted
 * argument that only mentions one is data. When the text mentions one and the command cannot be
 * read that precisely (unparseable, a computed command word, an interpreter, a git alias), it
 * counts as running it.
 */
function humanOnlyCommand(cmd) {
  if (!HUMAN_ONLY_TEXT.test(cmd)) return false;
  const parsed = parseShell(cmd);
  if (!parsed.ok) return true;
  for (const c of effectiveCommands(parsed)) {
    const word = c.argv[0];
    if (!word || word.dynamic) return true;
    const name = basenameOf(word);
    if (name === 'unknot') {
      if (HUMAN_ONLY_TEXT.test(`unknot ${c.argv.slice(1).map((w) => w.value).join(' ')}`)) return true;
      continue;
    }
    if (!DATA_ONLY.has(name)) return true;
    // git and gh run shell text through aliases (`!cmd`) and git rebase --exec.
    if ((name === 'git' || name === 'gh') && c.argv.some((w) => /alias|^!|^--exec|^-x$/.test(w.value))) return true;
  }
  return false;
}

export function alwaysOn(ctx, op, { pluginRoot } = {}) {
  const home = realpathLenient(unknotHome());
  if (op.op === 'fs.read' || op.op === 'fs.write') {
    for (const p of op.paths) {
      if (!p) continue;
      const real = realpathLenient(p);
      if (isInside(home, real)) return deny('keys.protected', 'Unknot key material is not readable or writable by agents');
      if (op.op === 'fs.write') {
        const rel = relFrom(ctx.root, real);
        if (rel !== null && isStatePath(rel)) {
          return deny('state.protected', `${rel} is Unknot state; it changes only through the unknot CLI (config changes need a human: unknot config accept)`);
        }
      }
    }
  }
  if (op.op === 'exec') {
    const cmd = op.command;
    if (humanOnlyCommand(cmd)) {
      return deny('approval.human_only', "approvals, lanes, keys, config acceptance and ending runs are done by a person in a separate terminal window (Claude Code's ! prefix is not interactive); give the user the block headed 'For you, in your own terminal:' from unknot status");
    }
    if (/(^|[\s;|&])(sqlite3?|python3?|node|perl|ruby)\b[^\n]*\.unknot\/state/.test(cmd) || /\.config\/unknot|UNKNOT_HOME=/.test(cmd)) {
      return deny('state.protected', 'direct access to Unknot state or key material is not allowed');
    }
    const shell = judgeShell(cmd, { pluginRoot, projectRoot: ctx.root });
    // Files a command writes, and trees it acts on as a whole (removing, moving, re-permissioning
    // a directory reaches the state inside it; writing a file into a directory does not). Each
    // target keeps the role it plays, so a refusal can name the operand that caused it.
    const files = shell.writes.map((t) => [t, 'the redirect target']);
    const trees = [];
    const cwd = op.cwd ?? ctx.root;
    for (const c of shell.commands) {
      const name = c.argv[0]?.value?.split('/').pop();
      const literal = c.argv.slice(1).filter((w) => !w.dynamic).map((w) => w.value);
      if (name === 'cp' && cpOperands(c)) files.push(...cpTargets(c, cwd).map((t) => [t, 'the copy destination']));
      else if (TREE_WRITERS.has(name)) trees.push(...literal.map((t) => [t, `the ${name} operand`]));
      else if (TARGET_WRITERS.has(name) || ['cp', 'dd'].includes(name)) files.push(...literal.map((t) => [t, `the ${name} operand`]));
    }
    for (const [t, role, tree] of [...files.map(([f, r]) => [f, r, false]), ...trees.map(([f, r]) => [f, r, true])]) {
      const rel = relFrom(ctx.root, realpathLenient(resolve(cwd, t)));
      if (rel === null) continue;
      if (tree ? coversState(rel) : writesState(rel)) return deny('state.protected', `${role} ${rel || 'the project root'} ${isStatePath(rel) ? 'is' : 'contains'} Unknot state; use the unknot CLI`);
    }
    // The precise check above names the operand; this fallback is for programs it cannot analyse.
    // Any program could rewrite Unknot's state (`sed -i`, `perl -pi`, an interpreter,
    // `cd .unknot && ... >`); only commands that pass the read-only rules may mention it.
    if (mentionsState(cmd, shell) && !shell.allow) {
      return deny('state.protected', `commands that mention .unknot must be read-only; Unknot state changes only through the unknot CLI (here: ${shell.reasons.join('; ')})`);
    }
  }
  return null;
}

const STATE_MENTION = /\.unknot(\/|\b)/i;
// Programs whose every argument is a path they may write (options included, harmlessly).
const TARGET_WRITERS = new Set(['rm', 'mv', 'tee', 'truncate', 'chmod', 'chown', 'ln', 'touch', 'install', 'mkdir', 'rmdir']);
// Of those, the ones that act on a directory as a whole.
const TREE_WRITERS = new Set(['rm', 'rmdir', 'mv', 'chmod', 'chown', 'ln', 'rsync']);
// Programs that only print what they are given (no option of theirs writes a file).
const PRINTERS = new Set(['cat', 'echo', 'printf']);

// `cp` reads every operand but the last: a copy out of .unknot reads it, a copy into it writes.
// With -t (target directory first) the operands cannot be told apart, so it gets no exemption.
// A computed destination is accepted only when it starts in the home or temp directory, which
// Unknot's state never is; one that names .unknot is refused by the mention check.
const OUTSIDE_PREFIX = /^(~\/|\$\{?(HOME|TMPDIR|TMP|TEMP)\}?\/|\/tmp\/)/;
const cpOperands = (c) => {
  const args = c.argv.slice(1);
  if (args.some((w) => /^(-[a-zA-Z]*t|--target-directory)/.test(w.value))) return null;
  const ops = args.filter((w) => !w.value.startsWith('-'));
  if (ops.length < 2 || ops.slice(0, -1).some((w) => w.dynamic || w.glob)) return null;
  const dest = ops.at(-1);
  return dest.glob || (dest.dynamic && !OUTSIDE_PREFIX.test(dest.value)) ? null : ops;
};

/** The files a copy writes: into a directory, each source under its own name. */
function cpTargets(c, cwd) {
  const ops = cpOperands(c);
  const dest = ops.at(-1).value;
  if (OUTSIDE_PREFIX.test(dest)) return [];
  let dir = dest.endsWith('/');
  try {
    dir ||= statSync(resolve(cwd, dest)).isDirectory();
  } catch {
    // a new file
  }
  return dir ? ops.slice(0, -1).map((w) => join(dest, basename(w.value))) : [dest];
}

/**
 * Whether a shell command mentions .unknot where a program could act on it. A command line made
 * only of plain printers writing to literal files (`cat >> notes.md <<EOF` with .unknot in the
 * body), and plain copies, cannot change what they only read, so for those only redirect
 * targets, program names and a copy's destination count. Anything else counts every mention,
 * in the raw text or in any parsed word (quotes removed, so `.unk''not` is seen).
 */
function mentionsState(cmd, shell) {
  const parsed = !shell.commands.some((c) => c.argv[0]?.value === '<unparseable-shell>');
  const words = (c) => [...c.argv.map((w) => w.value), ...c.assignments.map((a) => a.value.value), ...c.redirects.map((r) => r.target?.value ?? ''), ...c.redirects.map((r) => r.heredoc ?? '')];
  const mentioned = STATE_MENTION.test(cmd) || (parsed && shell.commands.some((c) => words(c).some((t) => STATE_MENTION.test(t))));
  if (!mentioned) return false;
  if (!parsed || !shell.commands.length) return true;
  const nameOf = (c) => c.argv[0]?.value?.split('/').pop();
  const readsOnly = shell.commands.every((c) => {
    const name = nameOf(c);
    const ctx = c.context ?? {};
    if (ctx.pipeline || ctx.substitution || ctx.viaWrapper || ctx.fromStdin || c.assignments.length) return false;
    if (!c.redirects.every((r) => (r.heredoc !== undefined ? !r.heredocDynamic : !r.target?.dynamic && !r.target?.glob))) return false;
    if (PRINTERS.has(name)) return !(name === 'printf' && c.argv.some((w) => /^-v/.test(w.value)));
    if (name === 'cp') return Boolean(cpOperands(c));
    // Every argument of these is a path they write: the write check judges each one.
    return TARGET_WRITERS.has(name) && c.argv.slice(1).every((w) => !w.dynamic && !w.glob);
  });
  if (!readsOnly) return true;
  return shell.commands.some((c) => [c.argv[0]?.value ?? '', ...c.redirects.filter((r) => r.heredoc === undefined).map((r) => r.target?.value ?? ''), ...(nameOf(c) === 'cp' ? [cpOperands(c).at(-1).value] : [])].some((t) => STATE_MENTION.test(t)));
}

// A path that is Unknot state, or a directory holding some (`rm -rf .unknot`, `chmod -R .`).
const STATE_ROOTS = ['.unknot/config.yaml', '.unknot/decisions.jsonl', '.unknot/.gitignore', '.unknot/state', '.unknot/cas', '.unknot/runs', '.unknot/campaigns', '.unknot/slices', '.unknot/telemetry', '.unknot/decompositions'];
/** A file write that lands on Unknot state (a file of it, or one of its directories by name). */
function writesState(rel) {
  const r = rel.toLowerCase().replace(/\/+$/, '');
  return isStatePath(r) || STATE_ROOTS.includes(r);
}

function coversState(rel) {
  const r = rel.toLowerCase().replace(/\/+$/, '');
  return isStatePath(r) || STATE_ROOTS.some((s) => s === r || r === '' || s.startsWith(`${r}/`));
}

// Compared case-insensitively: on case-insensitive filesystems `.unknot/DECISIONS.jsonl`
// is the decisions file, even before it exists.
function isStatePath(rel) {
  const r = rel.toLowerCase();
  return (
    r === '.unknot/config.yaml' ||
    r === '.unknot/decisions.jsonl' ||
    r === '.unknot/.gitignore' ||
    matchAny(r, ['.unknot/state/**', '.unknot/cas/**', '.unknot/runs/**', '.unknot/campaigns/**', '.unknot/slices/**', '.unknot/telemetry/**', '.unknot/decompositions/**'])
  );
}

function relFrom(root, abs) {
  const r = realpathLenient(root);
  if (!isInside(r, abs)) return null;
  return toPosix(relative(r, abs));
}

/**
 * Decide an operation inside an active run.
 * @param {object} p
 * @param {object} p.ctx project context
 * @param {object} p.config effective config
 * @param {object} p.run active run row
 * @param {object|null} p.slice the run's slice row (body parsed) when the run is apply
 * @param {{agent_id?: string, agent_type?: string}} p.actor
 * @param {object|null} p.capability the subagent's grant, if any
 * @param {object} p.op from toOperation
 */
export function decide({ ctx, config, run, slice = null, actor = {}, capability = null, op, pluginRoot }) {
  const profile = actor.agent_id ? profileFor(actor.agent_type) : mainProfile(run.command);
  const base = { risk: 'low', profile: profile.name };
  const permits = (name) => (capability ? capability.ops.includes(name) : profile.ops.includes(name));

  switch (op.op) {
    case 'inert':
      return allow('tool.inert', base);
    case 'unknown':
      return deny('tool.unknown', `${op.tool} is not permitted during an Unknot run (deny by default)`, base);
    case 'fs.read': {
      if (!permits('fs.read')) return deny('capability.read', `${profile.name} may not read files`, base);
      for (const p of op.paths) {
        const real = realpathLenient(p);
        const inRoot = isInside(realpathLenient(ctx.root), real);
        const inPlugin = pluginRoot && isInside(realpathLenient(pluginRoot), real);
        if (!inRoot && !inPlugin) return deny('scope.read_outside', `reading outside the project is not allowed during a run: ${p}`, base);
        if (inRoot) {
          const rel = relFrom(ctx.root, real);
          if (rel && isSecretPath(rel)) return deny('secrets.read', `${rel} looks like a credential file; Unknot does not read secrets into model context`, base);
        }
      }
      return allow('fs.read', base);
    }
    case 'fs.write':
      return decideWrite({ ctx, config, run, slice, profile, capability, op, base });
    case 'exec': {
      if (op.background) return deny('exec.background', 'commands run in the foreground during an Unknot run: a background command would outlive the run that governs it', base);
      const verdict = judgeShell(op.command, { pluginRoot, projectRoot: ctx.root });
      if (!verdict.allow) return deny('exec.shell', verdict.reasons.join('; '), base);
      const home = realpathLenient(unknotHome());
      const root = realpathLenient(ctx.root);
      for (const r of [...verdict.reads, ...(verdict.args ?? [])]) {
        if (r === '/dev/null' || r === '-' || r === '.' || r === '..') continue;
        if (!r.includes('/') && !r.startsWith('.') && !existsSync(resolve(op.cwd ?? ctx.root, r))) continue; // a pattern or word, not a path
        const real = realpathLenient(resolve(op.cwd ?? ctx.root, r));
        if (isInside(home, real)) return deny('keys.protected', 'Unknot key material is not readable by agents', base);
        const inRoot = isInside(root, real);
        const inPlugin = pluginRoot && isInside(realpathLenient(pluginRoot), real);
        if (!inRoot && !inPlugin) return deny('scope.read_outside', `reading outside the project is not allowed during a run: ${r}`, base);
        const rel = inRoot ? relFrom(ctx.root, real) : null;
        if (rel && isSecretPath(rel)) return deny('secrets.read', `${rel} looks like a credential file`, base);
      }
      return allow('exec.read_only', { ...base, commands: verdict.commands.length });
    }
    case 'net': {
      const allowed = config.network.allowed_domains ?? [];
      if (config.limits.max_network_requests === 0) return deny('network.disabled', 'network access is disabled for this project (limits.max_network_requests: 0)', base);
      if (!allowed.some((d) => d === op.domain || (d.startsWith('*.') && op.domain.endsWith(d.slice(1))))) {
        return deny('network.domain', `${op.domain} is not in network.allowed_domains`, base);
      }
      return allow('network.allowlisted', { ...base, charge: { network_requests: 1 } });
    }
    case 'mcp': {
      if (/^plugin_unknot_/.test(op.server)) return allow('mcp.self', base);
      if (!(config.mcp.allowed_servers ?? []).includes(op.server)) {
        return deny('mcp.server', `MCP server ${op.server} is not in mcp.allowed_servers; its responses are untrusted`, base);
      }
      return allow('mcp.allowlisted', base);
    }
    case 'agent.spawn': {
      const depth = actor.agent_id ? 2 : 1;
      const max = config.limits.max_delegation_depth ?? 2;
      if (depth > max) return deny('budget.delegation_depth', `delegation depth ${depth} exceeds max_delegation_depth ${max}`, base);
      return allow('agent.spawn', base);
    }
    default:
      return deny('tool.unknown', `unrecognised operation ${op.op}`, base);
  }
}

function mainProfile(command) {
  if (command === 'apply' || command === 'lane') return { name: `main:${command}`, ops: ['fs.read', 'fs.write', 'unknot.cli'] };
  if (command === 'plan' || command === 'architecture') return { name: `main:${command}`, ops: ['fs.read', 'fs.write.docs', 'unknot.cli'] };
  return { name: `main:${command}`, ops: ['fs.read', 'unknot.cli'] };
}

function decideWrite({ ctx, config, run, slice, profile, capability, op, base }) {
  // The command's write ceiling bounds every actor in the run, subagents included.
  const ceiling = COMMANDS[run.command]?.writes ?? 'none';
  const canDocs = (ceiling === 'docs' || ceiling === 'artifacts') && (profile.ops.includes('fs.write.docs') || (capability?.write ?? []).includes('<docs>') || profile.name === 'documentation-curator');
  const canCode = ceiling === 'worktree' && profile.ops.includes('fs.write') && profile.name !== 'documentation-curator';
  for (const p of op.paths) {
    if (!p) return deny('write.no_path', 'write without a path', base);
    const real = realpathLenient(p);
    const rel = relFrom(ctx.root, real);
    if (rel === null) return deny('scope.write_outside', `writes outside the project are never allowed: ${p}`, base);
    if (rel === '.git' || rel.startsWith('.git/') || /(^|\/)\.git(\/|$)/.test(rel)) return deny('write.git', 'git internals are not writable', base);
    if (isSecretPath(rel)) return deny('secrets.write', `${rel} is a credential path`, base);

    if (canDocs && modeRank(config.mode) >= modeRank('plan') && matchAny(rel, DOC_PATHS)) continue;

    if (!canCode) return deny('capability.write', `${profile.name} may not modify source (${run.command} is a ${modeRank(config.mode) >= 1 ? 'planning' : 'read-only'} command)`, base);
    if (modeRank(config.mode) < modeRank('assist')) return deny('mode.write', `mode ${config.mode} does not permit source changes; a human must set mode: assist (or higher) in .unknot/config.yaml`, base);
    if (!slice || slice.state !== 'PATCHING' || !slice.worktree) {
      return deny('slice.not_patching', 'source changes happen only for one approved slice in PATCHING, inside its worktree (run /unknot:apply <slice>)', base);
    }
    const wt = realpathLenient(slice.worktree);
    if (!isInside(wt, real)) return deny('scope.worktree', `writes must be inside the slice worktree ${toPosix(relative(ctx.root, wt))}/, not ${rel}`, base);
    const inner = toPosix(relative(wt, real));
    if (inner === '.git' || inner.startsWith('.git/')) return deny('write.git', 'git internals are not writable', base);
    if (/^\.unknot(\/|$)/i.test(inner)) return deny('state.protected', 'a slice cannot change Unknot configuration or state, even in its worktree', base);
    const body = slice.body ?? {};
    const include = body.scope?.include ?? [];
    const exclude = body.scope?.exclude ?? [];
    if (matchAny(inner, exclude) || (include.length && !matchAny(inner, include))) {
      return deny('scope.slice', `${inner} is outside slice ${slice.id} scope (include: ${include.join(', ') || '—'}; exclude: ${exclude.join(', ') || '—'})`, base);
    }
    if (matchAny(inner, config.generated_paths) || matchAny(inner, ['**/vendor/**', '**/node_modules/**', '**/dist/**'])) {
      return deny('scope.generated', `${inner} is generated or vendored; it is not edited as source`, base);
    }
    if (matchAny(inner, config.scope?.exclude ?? [])) return deny('scope.excluded', `${inner} is excluded from Unknot's scope (config scope.exclude)`, base);
    if (matchAny(inner, config.protected_paths, { nocase: true })) {
      const named = include.some((g) => matchAny(inner, [g]) && !g.includes('**'));
      if (!named || !['high', 'critical'].includes(slice.risk)) {
        return deny('scope.protected', `${inner} is a protected path; it can change only when the slice names it explicitly and is approved as high risk`, { ...base, risk: 'high' });
      }
    }
    if (capability && !(capability.write ?? []).some((g) => g === '<worktree-scope>' || matchAny(inner, [g]))) {
      return deny('capability.write', `capability ${capability.id} does not cover ${inner}`, base);
    }
  }
  return allow('fs.write.scoped', base);
}

