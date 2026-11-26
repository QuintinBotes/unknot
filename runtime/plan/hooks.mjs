// The repository's own git-hook checks. Slice commits run with core.hooksPath=/dev/null, so
// these run as proof obligations through the broker sandbox instead (docs/security-model.md).

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// `scoped` builds the argv for the slice's changed paths at verify time (#137). The paths come
// from git and are untrusted: each is one argv element, and none can read as an option.
const SYSTEMS = [
  { system: 'pre-commit', files: ['.pre-commit-config.yaml'], argv: ['pre-commit', 'run', '--all-files'], scoped: (paths) => ['pre-commit', 'run', '--files', ...paths.map((p) => (p.startsWith('-') ? `./${p}` : p))] },
  { system: 'husky', files: ['.husky/pre-commit'], argv: ['sh', '.husky/pre-commit'] },
  { system: 'lefthook', files: ['lefthook.yml', 'lefthook.yaml', 'lefthook.json', 'lefthook.toml', '.lefthook.yml', '.lefthook.yaml', '.lefthook.json', '.lefthook.toml'], argv: ['lefthook', 'run', 'pre-commit'], scoped: (paths) => ['lefthook', 'run', 'pre-commit', ...paths.map((p) => `--file=${p}`)] },
];

/** @returns {{system: string, argv: string[], scoped: boolean}[]} the hook systems a repository configures */
export const detectHookSystems = (root) => SYSTEMS.filter((s) => s.files.some((f) => existsSync(join(root, f)))).map(({ system, argv, scoped }) => ({ system, argv, scoped: Boolean(scoped) }));

/** The argv that runs `system`'s checks on just `paths`, or null when it has no file-list mode. */
export const scopedHookArgv = (system, paths) => SYSTEMS.find((s) => s.system === system)?.scoped?.(paths) ?? null;

/** True when `bin` is an executable file in a PATH directory; looked up, never run. */
export const onPath = (bin, pathVar = process.env.PATH ?? '') => pathVar.split(delimiter).some((d) => {
  try { const f = join(d || '.', bin); accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; }
});
