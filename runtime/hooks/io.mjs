// Hook I/O. Every hook reads one JSON event and writes at most one JSON answer, always
// exiting 0: a hook that crashes or exits non-zero with nothing on stdout is a hook whose
// decision Claude Code never sees, and for PreToolUse that means the tool call proceeds.

const MAX_FIELD = 8000;

export async function readEvent() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function trim(value) {
  if (typeof value === 'string') return value.length <= MAX_FIELD ? value : `${value.slice(0, MAX_FIELD)} [...truncated]`;
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
  return value;
}

/** Write the answer and exit once stdout has drained (pipes are asynchronous). */
export function respond(payload) {
  const done = () => process.exit(0);
  if (payload && Object.keys(payload).length) {
    const line = `${JSON.stringify(trim(payload))}\n`;
    if (!process.stdout.write(line)) {
      process.stdout.once('drain', done);
      setTimeout(done, 2000);
      return;
    }
  }
  done();
}

export const preToolDeny = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

export const preToolAsk = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
});

export const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

export const block = (reason) => ({ decision: 'block', reason });

export const permissionDeny = (message) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
});
