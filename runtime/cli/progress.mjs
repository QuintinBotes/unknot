// Progress for long commands, on stderr only. Shown on a terminal, or anywhere with --progress;
// a run shorter than AFTER_MS prints nothing unless forced, and updates are at most one per EVERY_MS.

const AFTER_MS = 5000;
const EVERY_MS = 5000;

/** `(done, total, phase) => void`, or null when progress is not wanted. One plain line per update. */
export function progressFor(flags, { stream = process.stderr, now = Date.now } = {}) {
  const forced = Boolean(flags.progress) && flags.progress !== 'false';
  if (!forced && !stream.isTTY) return null;
  const started = now();
  let last = forced ? -Infinity : started;
  return (done, total, phase) => {
    const t = now();
    if (t - last < EVERY_MS || (!forced && t - started < AFTER_MS)) return;
    last = t;
    stream.write(`unknot: ${phase}: ${done} of ${total}, ${Math.round((t - started) / 1000)} s\n`);
  };
}
