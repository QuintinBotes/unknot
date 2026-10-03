// Time comes from here so tests can pin it. Deliberately not configurable from the
// environment: approval expiry depends on the clock, and an environment variable is
// something a model with a shell can set.

let source = () => new Date();

export const now = () => source();
export const nowISO = () => source().toISOString();

export function setClock(fn) {
  source = fn;
}

export function resetClock() {
  source = () => new Date();
}

/** Parse a duration like `30m`, `12h`, `7d`, `90s` into milliseconds. */
export function parseDuration(text) {
  const m = /^(\d+)\s*(ms|s|m|h|d|w)$/.exec(String(text).trim());
  if (!m) throw new TypeError(`bad duration ${text}`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2]];
}

export function addMs(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}
