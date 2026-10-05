// Hook entry: dispatch one event, and fail closed for mutations when something breaks.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot, isInitialized, unknotHome } from '../core/project.mjs';
import { preToolDeny, readEvent, respond } from './io.mjs';

const MUTATING = /^(Edit|Write|MultiEdit|NotebookEdit|Bash|WebFetch|WebSearch|Task|Agent|mcp__.*)$/;

export async function main(eventName) {
  const event = await readEvent();
  const name = eventName ?? event.hook_event_name;
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
    if (root && name === 'PreToolUse' && MUTATING.test(event.tool_name ?? '')) {
      respond(preToolDeny(`Unknot could not evaluate policy (${err?.code ?? 'error'}: ${err?.message ?? err}); mutations are blocked until \`unknot doctor\` passes. Details: .unknot/state/hook-errors.log`));
      return;
    }
    respond(null);
  }
}
