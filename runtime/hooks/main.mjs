// Hook entry: dispatch one event, and fail closed for mutations when something breaks.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot, isInitialized } from '../core/project.mjs';
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
    if (root && name === 'PreToolUse' && MUTATING.test(event.tool_name ?? '')) {
      respond(preToolDeny(`Unknot could not evaluate policy (${err?.code ?? 'error'}: ${err?.message ?? err}); mutations are blocked until \`unknot doctor\` passes. Details: .unknot/state/hook-errors.log`));
      return;
    }
    respond(null);
  }
}
