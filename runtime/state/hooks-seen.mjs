// Which Unknot releases' hooks ran in this project lately. A hook notes its version and the
// newest store migration it knows (at most once a minute per version); a newer CLI reads the
// list before a migration older releases cannot live with, and `doctor` compares it with its
// own version. A plain JSON file beside the store, so any release can read and write it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'hooks.json';
const KEEP_MS = 24 * 3600_000;
// An active session's hooks refresh their entry every minute; one idle this long has ended or
// will reload before it touches the store again.
export const FRESH_MS = 15 * 60_000;

function read(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Best effort: a hook must never fail because this file could not be written. */
export function noteHook(stateDir, { version, schema, now = Date.now() }) {
  try {
    const seen = read(stateDir);
    const prev = seen[version];
    if (prev && prev.schema === schema && now - Date.parse(prev.at) < 60_000) return;
    seen[version] = { schema, at: new Date(now).toISOString() };
    for (const [v, e] of Object.entries(seen)) if (!(now - Date.parse(e?.at) < KEEP_MS)) delete seen[v];
    mkdirSync(stateDir, { recursive: true });
    const tmp = join(stateDir, `${FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(seen, null, 2)}\n`);
    renameSync(tmp, join(stateDir, FILE));
  } catch {
    // ignored
  }
}

/** @returns {{version: string, schema: number, at: string}[]} hooks seen within `within` ms */
export function hooksSeen(stateDir, { now = Date.now(), within = FRESH_MS } = {}) {
  return Object.entries(read(stateDir))
    .filter(([, e]) => e && Number.isFinite(e.schema) && now - Date.parse(e.at) < within)
    .map(([version, e]) => ({ version, schema: e.schema, at: e.at }))
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}
