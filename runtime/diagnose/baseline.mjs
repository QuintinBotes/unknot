// The findings a base commit has, for `diagnose --baseline <ref>` (#101). The base is checked out
// in a detached worktree outside the project and mapped into its own store (state/baseline.db, so
// a later base reuses its extraction cache), leaving the project's graph and findings untouched.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../apply/git.mjs';
import { UnknotError } from '../core/errors.mjs';
import { mapRepository } from '../graph/builder.mjs';
import { openStore } from '../state/store.mjs';
import { diagnose } from './engine.mjs';

/** @returns {Promise<{ref: string, commit: string, fingerprints: Set<string>, findings: number}>} */
export async function baselineFindings(ctx, { ref, config, configDigest, only = null }) {
  // A ref starting with `-` would be read as an option.
  const sha = /^-/.test(ref) ? { status: 1 } : git(ctx.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false });
  if (sha.status !== 0) throw new UnknotError('UK_BASELINE_INVALID', `the base ${ref} is not a commit of this repository`);
  const commit = sha.stdout.trim();
  // The project may sit below the repository root (a monorepo); the base maps the same directory.
  const prefix = git(ctx.root, ['rev-parse', '--show-prefix']).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'unknot-base-'));
  try {
    // No network (#101): Git LFS would fetch objects, so the base keeps its pointer files (not source).
    git(ctx.root, ['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'worktree', 'add', '--detach', '--quiet', dir, commit]);
    const root = join(dir, prefix);
    const base = { root, paths: { ...ctx.paths, root }, store: openStore(join(ctx.paths.state, 'baseline.db')), projectId: ctx.projectId };
    await mapRepository(base, { config, configDigest });
    const res = await diagnose(base, { config, only, all: true });
    return { ref, commit, fingerprints: new Set(res.findings.map((f) => f.fingerprint)), findings: res.findings.length };
  } catch (err) {
    if (err instanceof UnknotError && err.code === 'UK_BASELINE_INVALID') throw err;
    throw new UnknotError('UK_BASELINE_INVALID', `the base ${ref} (${commit.slice(0, 12)}) could not be mapped: ${err.message}`);
  } finally {
    git(ctx.root, ['worktree', 'remove', '--force', dir], { check: false });
    rmSync(dir, { recursive: true, force: true });
  }
}
