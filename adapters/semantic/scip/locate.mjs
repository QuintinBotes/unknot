// Where the SCIP index is, whether it is behind the code, and how to make one. Used by the
// adapter (to find the file) and by `unknot doctor`. Unknot never runs an indexer: producing the
// index is the person's step, with the indexer's own command.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { UnknotError } from '../../../runtime/core/errors.mjs';
import { isSecretPath, resolveInside } from '../../../runtime/core/paths.mjs';
import { git, isRepo } from '../../../runtime/apply/git.mjs';
import { projectPrefix } from './analyze.mjs';
import { scipRecords } from './reader.mjs';

export const DEFAULT_INDEX = 'index.scip';

/** The indexers' own commands (see each project's README); Unknot runs none of them. */
export const HOW_TO = Object.freeze([
  'C# (Roslyn): `dotnet tool install --global scip-dotnet`, then `scip-dotnet index` in the solution folder (scip-dotnet'
  + ' builds the projects itself, so it needs the .NET SDK and restored packages)',
  'TypeScript and JavaScript: `npm install -g @sourcegraph/scip-typescript`, then `scip-typescript index` in the project folder'
  + ' (`--yarn-workspaces`, `--pnpm-workspaces` or `--infer-tsconfig` as the project needs)',
  'Java and Kotlin: scip-java; Python: scip-python (see each indexer\'s README)',
]);

/**
 * The index files for `adapters.scip.index` (a path or a list of paths relative to the repository),
 * else `index.scip` at the repository root when present. A configured path that is missing is
 * reported as `missing`, not skipped silently.
 * @returns {{configured: boolean, entries: {rel: string, abs: string, size: number, mtimeMs: number}[], missing: string[]}}
 */
export function locateIndexes(root, options = {}) {
  const configured = options.index !== undefined && options.index !== null;
  const wanted = configured ? [].concat(options.index).map(String) : [DEFAULT_INDEX];
  const entries = [];
  const missing = [];
  for (const w of wanted) {
    const { abs, rel } = resolveInside(root, w);
    if (isSecretPath(rel)) throw new UnknotError('UK_POLICY_DENIED', `${rel} is a credential path`);
    let st = null;
    try {
      st = statSync(abs);
    } catch {
      st = null;
    }
    if (st?.isFile()) entries.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
    else if (configured) missing.push(rel);
  }
  return { configured, entries, missing };
}

/** Repository paths of the files an index covers (documents only are decoded: cheap). */
export function coveredPaths(root, entry) {
  const out = [];
  let prefix = '';
  for (const rec of scipRecords(entry.abs, { pathsOnly: true })) {
    if (rec.type === 'metadata' && rec.value.project_root) prefix = projectPrefix(root, rec.value.project_root);
    else if (rec.type === 'document' && rec.value.relative_path) out.push(prefix ? `${prefix}/${rec.value.relative_path}` : rec.value.relative_path);
  }
  return out;
}

const CHUNK = 400;

/**
 * Time (seconds) and commit of the latest commit touching any covered file, or null when the
 * repository has none of them or is not a git repository.
 */
export function lastCommitTouching(root, paths) {
  if (!isRepo(root) || !paths.length) return null;
  let best = null;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const r = git(root, ['log', '-1', '--format=%ct %H', '--', ...paths.slice(i, i + CHUNK).map((p) => `:(literal)${p}`)], { check: false });
    const [t, sha] = r.stdout.trim().split(' ');
    if (t && (!best || Number(t) > best.time)) best = { time: Number(t), sha };
  }
  return best;
}

const day = 86_400_000;
const ago = (ms) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : ms < day ? `${Math.round(ms / 3_600_000)} hours` : `${Math.round(ms / day)} days`);

/**
 * The doctor checks for the SCIP index: `[{ name, level, detail }]`.
 * stale = the index file is older than the last commit that touched a file it covers.
 */
export function scipChecks(root, options = {}) {
  const checks = [];
  const how = HOW_TO.map((h) => `  ${h}`).join('\n');
  let found;
  try {
    found = locateIndexes(root, options);
  } catch (err) {
    return [{ name: 'scip index', level: 'warn', detail: String(err.message ?? err) }];
  }
  if (found.missing.length) checks.push({ name: 'scip index', level: 'warn', detail: `configured but not found: ${found.missing.join(', ')}. Produce it with the indexer's own command:\n${how}` });
  if (!found.entries.length && !found.missing.length) {
    checks.push({ name: 'scip index', level: 'info', detail: `none configured and no ${DEFAULT_INDEX} at the repository root (optional: without it C# and other languages are read lexically). To add one, run the indexer yourself (Unknot does not run builds); these are the indexers' own commands:\n${how}\nThen set adapters.scip.index in the config if it is not at ${DEFAULT_INDEX}.` });
  }
  for (const e of found.entries) {
    let detail = `${e.rel} (${(e.size / 1048576).toFixed(1)} MB, written ${new Date(e.mtimeMs).toISOString()})`;
    let level = 'ok';
    try {
      const paths = coveredPaths(root, e);
      const last = lastCommitTouching(root, paths);
      detail += `, covers ${paths.length} files`;
      if (last && last.time * 1000 > e.mtimeMs) {
        level = 'warn';
        detail += `; stale: ${last.sha.slice(0, 12)} changed covered files ${ago(last.time * 1000 - e.mtimeMs)} after it was written; run the indexer again:\n${how}`;
      } else if (last) detail += `; current with the last commit touching covered files (${last.sha.slice(0, 12)})`;
      else detail += '; age against HEAD unknown (not a git repository, or no covered file is tracked)';
    } catch (err) {
      level = 'warn';
      detail += `; unreadable: ${err.message}`;
    }
    checks.push({ name: 'scip index', level, detail });
  }
  return checks;
}

/**
 * Why an index cannot be evidence for this code, or null. An index committed to the repository
 * is repository content (anyone who can push could write it, and Unknot treats repository text
 * as data); one older than a commit or a working-tree change to a file it covers describes other
 * code. Either way its facts would be trusted as compiler-resolved, so it is set aside.
 */
export function indexTrustProblem(root, entry, coveredFiles) {
  if (isRepo(root) && git(root, ['ls-files', '--error-unmatch', '--', `:(literal)${entry.rel}`], { check: false }).status === 0) {
    return `${entry.rel} is committed to the repository; produce it locally and keep it out of git (add it to .gitignore)`;
  }
  const last = lastCommitTouching(root, coveredFiles);
  if (last && last.time * 1000 > entry.mtimeMs) return `${entry.rel} is older than commit ${last.sha.slice(0, 12)}, which changed files it covers; run the indexer again`;
  for (const f of coveredFiles) {
    let m = 0;
    try {
      m = statSync(join(root, f)).mtimeMs;
    } catch {
      continue;
    }
    if (m > entry.mtimeMs) return `${f} changed after ${entry.rel} was written; run the indexer again`;
  }
  return null;
}
