// A project context: the root, its paths, its store and its keys, opened once per process.
// Everything that touches project state takes one of these.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomId } from './core/canonical.mjs';
import { UnknotError } from './core/errors.mjs';
import { auditPublicKeyPem, ensureProjectKeys } from './core/keys.mjs';
import { findProjectRoot, isInitialized, projectPaths } from './core/project.mjs';
import { openStore } from './state/store.mjs';

const STATE_GITIGNORE = `# Local Unknot state. Config, campaigns, slices, decisions and docs are meant to be committed.
state/
cas/
runs/
worktrees/
telemetry/
config.proposed.yaml
`;

/**
 * @param {string} [cwd]
 * @param {{create?: boolean, readOnly?: boolean}} [opts]
 */
export function openProject(cwd = process.cwd(), { create = false, readOnly = false } = {}) {
  const root = findProjectRoot(cwd);
  const paths = projectPaths(root);
  if (!isInitialized(root)) {
    if (!create) {
      throw new UnknotError('UK_NOT_INITIALIZED', `no .unknot directory at ${root}; run /unknot:init. It writes only a proposal, and a read-only assessment (map, diagnose, decompose, explain) needs nothing else`, {
        details: { root },
      });
    }
    mkdirSync(paths.base, { recursive: true });
  }
  if (!existsSync(join(paths.base, '.gitignore'))) {
    try {
      writeFileSync(join(paths.base, '.gitignore'), STATE_GITIGNORE, { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  const store = openStore(paths.db, { readOnly: readOnly && existsSync(paths.db) });
  let projectId = store.meta('project_id');
  if (!projectId && !readOnly) {
    projectId = store.tx(() => store.meta('project_id') ?? store.meta('project_id', `p-${randomId(8)}`));
  }
  if (projectId && !readOnly) {
    ensureProjectKeys(projectId);
    if (!store.meta('audit_public_key')) store.meta('audit_public_key', auditPublicKeyPem(projectId));
  }
  return { root, paths, store, projectId };
}

/** Like openProject, but returns null instead of throwing for an uninitialised project. */
export function tryOpenProject(cwd, opts) {
  try {
    const root = findProjectRoot(cwd);
    if (!isInitialized(root)) return null;
    return openProject(cwd, opts);
  } catch (err) {
    if (err instanceof UnknotError && err.code === 'UK_NOT_INITIALIZED') return null;
    throw err;
  }
}
