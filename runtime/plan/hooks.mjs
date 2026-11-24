// The repository's own git-hook checks. Slice commits run with core.hooksPath=/dev/null, so
// these run as proof obligations through the broker sandbox instead (docs/security-model.md).

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const SYSTEMS = [
  { system: 'pre-commit', files: ['.pre-commit-config.yaml'], argv: ['pre-commit', 'run', '--all-files'] },
  { system: 'husky', files: ['.husky/pre-commit'], argv: ['sh', '.husky/pre-commit'] },
  { system: 'lefthook', files: ['lefthook.yml', 'lefthook.yaml', 'lefthook.json', 'lefthook.toml', '.lefthook.yml', '.lefthook.yaml', '.lefthook.json', '.lefthook.toml'], argv: ['lefthook', 'run', 'pre-commit'] },
];

/** @returns {{system: string, argv: string[]}[]} the hook systems a repository configures */
export const detectHookSystems = (root) => SYSTEMS.filter((s) => s.files.some((f) => existsSync(join(root, f)))).map(({ system, argv }) => ({ system, argv }));

/** True when `bin` is an executable file in a PATH directory; looked up, never run. */
export const onPath = (bin, pathVar = process.env.PATH ?? '') => pathVar.split(delimiter).some((d) => {
  try { const f = join(d || '.', bin); accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; }
});
