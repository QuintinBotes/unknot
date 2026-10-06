// Hook entry: dispatch one event, and fail closed for mutations when something breaks.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot, isInitialized, unknotHome } from '../core/project.mjs';
import { preToolDeny, readEvent, respond } from './io.mjs';

const MUTATING = /^(Edit|Write|MultiEdit|NotebookEdit|Bash|WebFetch|WebSearch|Task|Agent|mcp__.*)$/;

export async function main(eventName) {
  const event = await readEvent();
  const name = eventName ?? event.hook_event_name;
  // Note this release before anything opens the store, so a newer CLI in the same project
  // can see that this session runs it (state/hooks-seen.mjs).
  if (name === 'PreToolUse') {
    try {
      const root = findProjectRoot(event.cwd ?? process.cwd());
      if (isInitialized(root)) {
        const [{ noteHook }, { VERSION }, { LATEST_SCHEMA_VERSION }] = await Promise.all([import('../state/hooks-seen.mjs'), import('../core/version.mjs'), import('../state/migrations.mjs')]);
        noteHook(join(root, '.unknot', 'state'), { version: VERSION, schema: LATEST_SCHEMA_VERSION });
      }
    } catch {
      // best effort
    }
  }
  try {
    const { HANDLERS } = await import('./handlers.mjs');
    const handler = HANDLERS[name];
    respond(handler ? await handler(event) : null);
  } catch (err) {
    let root = null;
    try {
      root = findProjectRoot(event.cwd ?? process.cwd());
      if (isInitialized(root)) {
        const dir = join(root, '.unknot', 'state');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'hook-errors.log'), `${new Date().toISOString()} ${name} ${err?.stack ?? err}\n`);
      } else root = null;
    } catch {
      // Logging is best effort; the decision below is not.
    }
    // An initialised project whose state cannot be judged gets no mutations: the safe
    // way to be wrong. Reads stay allowed so the user can still investigate.
    const target = event.tool_input?.file_path ?? event.tool_input?.path ?? event.tool_input?.notebook_path ?? null;
    if (root && name === 'PreToolUse' && target) {
      const { isSecretPath } = await import('../core/paths.mjs');
      const { relative } = await import('node:path');
      const { isAbsolute, resolve } = await import('node:path');
      const abs = isAbsolute(String(target)) ? String(target) : resolve(event.cwd ?? process.cwd(), String(target));
      const home = unknotHome();
      // While policy cannot be evaluated, nothing outside the project and no credential
      // path is read, wherever UNKNOT_HOME points.
      const rel = relative(root, abs);
      if (rel.startsWith('..') || isAbsolute(rel) || isSecretPath(rel) || abs === home || abs.startsWith(`${home}/`) || /\.config\/unknot|\.ssh\//.test(abs)) {
        respond(preToolDeny('Unknot could not evaluate policy and will not expose credential paths meanwhile; run `unknot doctor`.'));
        return;
      }
    }
    // The store was written by a newer release than this session loaded (or needs a change an
    // older session cannot live with): what touches no state still runs, and the fix is named.
    if (root && name === 'PreToolUse' && err?.code === 'UK_STATE_CONFLICT') {
      const { VERSION } = await import('../core/version.mjs');
      const why = `Unknot ${VERSION} hooks in this session cannot use the project's state (${err.message}). Reload plugins or start a new session; read-only commands still run.`;
      if (event.tool_name === 'Bash') {
        const { judgeShell } = await import('../policy/commands.mjs');
        const { isSecretPath } = await import('../core/paths.mjs');
        const v = judgeShell(String(event.tool_input?.command ?? ''), { pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null, projectRoot: root });
        // Changing directory changes no state; the commands that follow are judged as usual.
        const reasons = v.reasons.filter((r) => !/^`(cd|pushd|popd)` is not in the read-only set/.test(r));
        const secret = [...(v.args ?? []), ...(v.reads ?? [])].some((a) => isSecretPath(a) || /(^|\/)\.ssh\/|\.config\/unknot/.test(a));
        respond(!reasons.length && !secret ? null : preToolDeny(why));
        return;
      }
      respond(MUTATING.test(event.tool_name ?? '') ? preToolDeny(why) : null);
      return;
    }
    if (root && name === 'PreToolUse' && MUTATING.test(event.tool_name ?? '')) {
      respond(preToolDeny(`Unknot could not evaluate policy (${err?.code ?? 'error'}: ${err?.message ?? err}); mutations are blocked until \`unknot doctor\` passes. Details: .unknot/state/hook-errors.log`));
      return;
    }
    respond(null);
  }
}
