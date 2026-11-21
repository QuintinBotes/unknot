// The findings a base commit has, for `diagnose --baseline <ref>` (#101). The base is checked out
// in a detached worktree outside the project and mapped into a store of its own, leaving the
// project's graph and findings untouched.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../apply/git.mjs';
import { digest } from '../core/canonical.mjs';
import { UnknotError } from '../core/errors.mjs';
import { mapRepository } from '../graph/builder.mjs';
import { IMPORT_KEYS } from '../graph/runtime-imports.mjs';
import { openStore } from '../state/store.mjs';
import { diagnose } from './engine.mjs';

/** The commit `ref` names, or UK_BASELINE_INVALID. */
export function baseCommit(ctx, ref) {
  // A ref starting with `-` would be read as an option.
  const sha = /^-/.test(ref) ? { status: 1 } : git(ctx.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false });
  if (sha.status !== 0) throw new UnknotError('UK_BASELINE_INVALID', `the base ${ref} is not a commit of this repository`);
  return sha.stdout.trim();
}

/**
 * Every fingerprint a list of findings stands for: its own, those it folded in (`replaces`), and
 * those of its `related_kinds` on the same key, so a finding that changed which kind leads, or
 * stopped being folded, is not new.
 */
export function standsFor(findings) {
  return new Set(findings.flatMap((f) => [f.fingerprint, ...(f.replaces ?? []), ...(f.related_kinds ?? []).map((kind) => digest({ kind, key: f.key }))]));
}

/** @returns {Promise<{fingerprints: Set<string>, findings: number, failures: number}>} */
export async function baselineFindings(ctx, { ref, commit, config, configDigest, only = null }) {
  // The project may sit below the repository root (a monorepo); the base maps the same directory.
  const prefix = git(ctx.root, ['rev-parse', '--show-prefix']).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'unknot-base-'));
  let store = null;
  try {
    // No network (#101): Git LFS would fetch objects, so the base keeps its pointer files (not source).
    // shortcut: only the lfs filter is turned off; another required filter the user configured still runs.
    git(ctx.root, ['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'worktree', 'add', '--detach', '--quiet', join(dir, 'tree'), commit]);
    const root = join(dir, 'tree', prefix);
    // A base from before the project's directory existed has no findings.
    if (!existsSync(root)) return { fingerprints: new Set(), findings: 0, failures: 0 };
    // A store of its own per run (concurrent runs cannot mix bases), seeded with the project's
    // extraction cache, so every file the base shares with the tree is not read again.
    store = openStore(join(dir, 'base.db'));
    store.db.prepare('ATTACH DATABASE ? AS project').run(ctx.paths.db);
    store.db.exec('INSERT OR IGNORE INTO file_index SELECT * FROM project.file_index; DETACH DATABASE project;');
    // Imported runtime, database and delivery evidence lives in the store, not the commit: the base sees it too.
    // shortcut: an uncommitted SCIP index describes the tree only, so the base is read lexically; compare without one until the base can be indexed.
    for (const key of IMPORT_KEYS) if (ctx.store.meta(key)) store.meta(key, ctx.store.meta(key));
    const base = { root, paths: { ...ctx.paths, root }, store, projectId: ctx.projectId };
    const mapped = await mapRepository(base, { config, configDigest });
    const res = await diagnose(base, { config, only, all: true });
    return { fingerprints: standsFor(res.findings), findings: res.findings.length, failures: mapped.failure_count ?? 0 };
  } catch (err) {
    throw new UnknotError('UK_BASELINE_INVALID', `the base ${ref} (${commit.slice(0, 12)}) could not be mapped: ${err.message}`);
  } finally {
    store?.close();
    git(ctx.root, ['worktree', 'remove', '--force', join(dir, 'tree')], { check: false });
    rmSync(dir, { recursive: true, force: true });
  }
}
