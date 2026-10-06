// CLI plumbing shared by every command: argument parsing, who is acting, run lifecycle,
// output (always redacted), and TTY-only prompts for human decisions.

import { openSync, readSync, closeSync, writeSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnknotError } from '../core/errors.mjs';
import { redact } from '../core/redact.mjs';

/**
 * The Claude Code session this CLI runs inside, or null in a person's own terminal. A run
 * started here governs that session (and its subagents) only, not other sessions that open the
 * repository (issue #32).
 */
export function agentSession(env = process.env) {
  return env.CLAUDECODE && env.CLAUDE_CODE_SESSION_ID ? String(env.CLAUDE_CODE_SESSION_ID) : null;
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-/g, '_');
      if (eq !== -1) flags[key] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
      if (Array.isArray(flags[`${key}[]`])) flags[`${key}[]`].push(flags[key]);
      else flags[`${key}[]`] = [flags[key]];
    } else positional.push(a);
  }
  return { positional, flags };
}

/**
 * Who is running this command. A human is someone at an interactive terminal; an agent's
 * shell has no TTY, and environment variables are not evidence (a model can unset
 * CLAUDECODE), so only the TTY test can make an actor human.
 */
export function currentActor() {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty || process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return process.env.CI && !tty ? 'ci:pipeline' : 'model:main';
  let name = 'user';
  try {
    name = userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user';
  } catch {
    // no passwd entry
  }
  return `human:${name}`;
}

export const isHuman = (actor) => actor.startsWith('human:');

/** Absolute path of this plugin's `bin/unknot`. */
export const cliPath = () => fileURLToPath(new URL('../../bin/unknot', import.meta.url));

/** The `unknot` executable on PATH, or null. Inside Claude Code this is the versioned plugin bin. */
export function unknotOnPath(env = process.env) {
  for (const d of (env.PATH ?? '').split(delimiter)) {
    const f = d && join(d, 'unknot');
    if (f && existsSync(f)) return f;
  }
  return null;
}

/** The `unknot` on PATH when it is a stable command: not a plugin checkout's or version's own bin/ (those move on upgrade). */
export function stableUnknot(env = process.env) {
  const found = unknotOnPath(env);
  try {
    return found && !existsSync(join(dirname(realpathSync(found)), '..', 'runtime', 'cli', 'main.mjs')) ? found : null;
  } catch {
    return null;
  }
}

/**
 * The command a person should run in a terminal, plus how to reach the CLI when `unknot`
 * is not a stable command there: the plugin's bin/ is on PATH only inside Claude Code and
 * its installed path changes with every version.
 */
export function humanCommand(args = '') {
  const a = Array.isArray(args) ? args.join(' ') : String(args);
  if (stableUnknot() || shimInstalled()) return `unknot${a ? ` ${a}` : ''}`;
  // Until the stable command exists, a bare `unknot` fails in a normal terminal, so the full
  // path comes first; installing the command is offered once, and never for the install itself.
  const abs = cliPath();
  const full = `node ${abs}${a ? ` ${a}` : ''}`;
  return /^cli\s+install\b/.test(a) ? full : `${full}\n(To type just \`unknot ...\` next time, install the command once: node ${abs} cli install)`;
}

/** Whether `unknot cli install` wrote its shim to the default directory (what `unknot cli status` reports). */
export function shimInstalled(dir = join(process.env.HOME || homedir(), '.local', 'bin')) {
  try {
    return readFileSync(join(dir, 'unknot'), 'utf8').includes('// unknot-cli-shim');
  } catch {
    return false;
  }
}

export function requireHumanTTY(what, { args = process.argv.slice(2) } = {}) {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const agent = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);
  if (tty && !agent) return;
  const [cmd, ...rest] = humanCommand(args).split('\n');
  const why = !tty
    ? 'no interactive terminal detected'
    : 'this looks like an agent session (CLAUDECODE or CLAUDE_CODE_ENTRYPOINT is set), and approvals are for a person';
  const message = `${what} must be done by a human in an interactive terminal: ${why}. Run \`${cmd}\` in a separate terminal window${tty ? '' : " (Claude Code's `!` prefix is not interactive)"}.`;
  throw new UnknotError('UK_POLICY_DENIED', [message, ...rest].join('\n'), { details: { policy: 'approval.human_only' } });
}

/** Read a line from the controlling terminal, optionally without echo. */
export function prompt(question, { secret = false } = {}) {
  writeSync(1, question);
  if (secret && process.stdin.isTTY) process.stdin.setRawMode(true);
  const fd = openSync('/dev/tty', 'r');
  const buf = Buffer.alloc(1);
  let out = '';
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString('utf8');
      if (ch === '\r' || ch === '\n') break;
      if (ch === '\u0003') throw new UnknotError('UK_POLICY_DENIED', 'cancelled');
      if (ch === '\u007f') out = out.slice(0, -1);
      else out += ch;
    }
  } finally {
    closeSync(fd);
    if (secret && process.stdin.isTTY) process.stdin.setRawMode(false);
    if (secret) writeSync(1, '\n');
  }
  return out;
}

export function output(value, { json = false, redactPatterns = [] } = {}) {
  const text = json ? `${JSON.stringify(value, null, 2)}\n` : typeof value === 'string' ? `${value.replace(/\n?$/, '\n')}` : `${JSON.stringify(value, null, 2)}\n`;
  process.stdout.write(redact(text, { extraPatterns: redactPatterns }).text);
}

const ID_COLUMNS = new Set(['id', 'from', 'to', 'src', 'dst']);
const NODE_ID = /^[a-z][a-z_]*:\S+$/;

/** Rows as aligned columns. Cells cap at 60 characters, except ids: the tail of an id is what tells two apart. */
export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const text = (v) => String(v ?? '');
  const whole = (c, v) => ID_COLUMNS.has(c) || NODE_ID.test(text(v));
  const cell = (c, v) => (whole(c, v) ? text(v) : text(v).slice(0, 60));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(c, r[c]).length)));
  const fmt = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(columns), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => fmt(columns.map((c) => cell(c, r[c]))))].join('\n');
}

/**
 * Use the active run when there is one for this command family; otherwise start one and
 * end it when `fn` finishes, so a human-terminal invocation never leaves a run open.
 */
export async function withRun(ctx, cfg, command, { actor, scope = [], slice_id = null, campaign_id = null, persist = false }, fn) {
  const { activeRun, startRun, endRun, setRunSlice } = await import('../state/runs.mjs');
  const existing = activeRun(ctx.store);
  if (existing) {
    if (slice_id && existing.slice_id !== slice_id) setRunSlice(ctx, existing.id, slice_id, actor, { mode: cfg.config.mode });
    return fn(activeRun(ctx.store));
  }
  const run = startRun(ctx, { command, actor, scope, slice_id, campaign_id, session_id: agentSession(), config: cfg.config, configDigest: cfg.digest });
  const telemetry = await import('../telemetry/otel.mjs');
  telemetry.configureTelemetry(cfg.config, { root: ctx.root });
  const t0 = Date.now();
  let outcome = 'completed';
  let keep = persist && !isHuman(actor);
  try {
    return await telemetry.withSpan('unknot.run', { 'unknot.command': command, 'unknot.mode': cfg.config.mode }, () => fn(run));
  } catch (err) {
    outcome = err?.code === 'UK_BUDGET_EXCEEDED' ? 'budget_exceeded' : 'failed';
    keep = false;
    throw err;
  } finally {
    telemetry.metric('unknot.run.duration', Date.now() - t0, { 'unknot.outcome': outcome });
    telemetry.metric('unknot.run.count', 1, { 'unknot.outcome': outcome });
    await telemetry.flush();
    // An agent's apply keeps its run (and so the hooks' enforcement) until the Stop hook
    // ends it; a human's terminal command never leaves a run behind.
    if (!keep) endRun(ctx, run.id, { outcome, actor });
  }
}
