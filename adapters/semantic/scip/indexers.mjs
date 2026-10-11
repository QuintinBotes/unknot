// The complete language-specific surface of the opt-in SCIP runner. Keep command shapes,
// marker files and safety classifications here: adding an indexer must be a table row, not a
// branch elsewhere in the runtime.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { matchAny } from '../../../runtime/core/glob.mjs';

export const OUTPUT = '{output}';
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MEMORY_MB = 2_048;
export const MIN_MEMORY_MB = 128;
export const MAX_MEMORY_MB = 16_384;

const row = (value) => Object.freeze({ ...value, languages: Object.freeze(value.languages ?? [value.language]), extensions: Object.freeze(value.extensions), markers: Object.freeze(value.markers), argv: Object.freeze(value.argv) });

/**
 * A pinned command template uses `{output}` exactly once. The broker accepts only these
 * templates, after substituting the private cache path for that token.
 */
export const INDEXERS = Object.freeze([
  row({
    language: 'csharp',
    // Some indexers leave a document's language empty; its extension then names it.
    extensions: { '.cs': 'csharp' },
    languages: ['csharp'],
    markers: ['**/*.sln', '**/*.csproj'],
    executable: 'scip-dotnet',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
  row({
    language: 'typescript',
    extensions: { '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript' },
    languages: ['typescript', 'javascript'],
    markers: ['**/tsconfig.json', '**/package.json'],
    executable: 'scip-typescript',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: false,
  }),
  row({
    language: 'java',
    extensions: { '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala' },
    languages: ['java', 'kotlin', 'scala'],
    markers: ['**/pom.xml', '**/build.gradle*', '**/build.sbt'],
    executable: 'scip-java',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
  row({
    language: 'python',
    extensions: { '.py': 'python', '.pyi': 'python' },
    markers: ['**/pyproject.toml', '**/setup.py', '**/setup.cfg'],
    executable: 'scip-python',
    argv: ['index', '.', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: false,
  }),
  row({
    language: 'go',
    extensions: { '.go': 'go' },
    markers: ['**/go.mod'],
    executable: 'scip-go',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: true,
  }),
  row({
    language: 'rust',
    extensions: { '.rs': 'rust' },
    markers: ['**/Cargo.toml'],
    executable: 'rust-analyzer',
    argv: ['scip', '.', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: false,
  }),
  row({
    language: 'ruby',
    extensions: { '.rb': 'ruby' },
    markers: ['**/Gemfile'],
    executable: 'scip-ruby',
    argv: ['.', '--index-file', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
  row({
    language: 'cpp',
    extensions: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp' },
    languages: ['c', 'cpp'],
    markers: ['**/compile_commands.json'],
    executable: 'scip-clang',
    argv: ['--compdb-path', 'compile_commands.json', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: false,
  }),
  row({
    language: 'dart',
    extensions: { '.dart': 'dart' },
    markers: ['**/pubspec.yaml'],
    executable: 'scip_dart',
    argv: ['.', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: true,
  }),
  row({
    language: 'php',
    extensions: { '.php': 'php' },
    markers: ['**/composer.json'],
    executable: 'scip-php',
    argv: ['--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
]);

const LANGUAGE_BY_EXTENSION = new Map(INDEXERS.flatMap((entry) => Object.entries(entry.extensions)));

/**
 * A SCIP document's language: the one it declares, else the one its extension names in the
 * table. scip-typescript, for one, writes every document with an empty language.
 */
export function documentLanguage(document) {
  const declared = String(document?.language ?? '').toLowerCase();
  if (declared) return declared;
  const path = String(document?.relative_path ?? '');
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : (LANGUAGE_BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? '');
}

export const INDEXER_EXECUTABLES = Object.freeze([...new Set(INDEXERS.map((entry) => entry.executable))]);

export function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function runBudgets(options = {}) {
  return {
    timeoutMs: clamp(options.timeout_ms, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    memoryMb: clamp(options.memory_mb, DEFAULT_MEMORY_MB, MIN_MEMORY_MB, MAX_MEMORY_MB),
  };
}

/** The pinned argv for one row and one output file. */
export function indexerArgv(entry, output) {
  if (!INDEXERS.includes(entry)) throw new TypeError('unknown SCIP indexer row');
  if (typeof output !== 'string' || !output) throw new TypeError('SCIP output path must be a non-empty string');
  return [entry.executable, ...entry.argv.map((part) => part.replace(OUTPUT, output))];
}

const outputPart = (template, actual) => {
  const at = template.indexOf(OUTPUT);
  if (at === -1) return template === actual ? '' : null;
  const before = template.slice(0, at);
  const after = template.slice(at + OUTPUT.length);
  if (!actual.startsWith(before) || !actual.endsWith(after)) return null;
  const value = actual.slice(before.length, actual.length - after.length);
  return value && !value.startsWith('-') && value.endsWith('.scip') && !value.includes('\0') ? value : null;
};

/**
 * Recognise only a complete, pinned registry invocation. Returns its row and output path, or
 * null; a caller must not treat a prefix as an allowed command.
 */
export function pinnedIndexerInvocation(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return null;
  const entry = INDEXERS.find((candidate) => candidate.executable === argv[0]);
  if (!entry || argv.length !== entry.argv.length + 1) return null;
  let output = null;
  for (let i = 0; i < entry.argv.length; i++) {
    const got = outputPart(entry.argv[i], argv[i + 1]);
    if (got === null) return null;
    if (got) {
      if (output !== null) return null;
      output = got;
    }
  }
  return output ? { entry, output } : null;
}

/** Rows whose marker files occur in a repository, narrowed by adapters.scip.languages. */
export function indexersForPaths(paths, options = {}) {
  const requested = Array.isArray(options.languages) && options.languages.length ? new Set(options.languages.map(String)) : null;
  return INDEXERS.filter((entry) => {
    if (!paths.some((path) => matchAny(path, entry.markers))) return false;
    return !requested || entry.languages.some((language) => requested.has(language)) || requested.has(entry.language);
  });
}

/** Source-language ids that this row has a chance to cover in the supplied census entries. */
export function presentLanguages(entry, files) {
  const seen = new Set([...files.values()].map((file) => String(file.language ?? '').toLowerCase()));
  return entry.languages.filter((language) => seen.has(language));
}

/** A bare executable's resolved path, or null. This is a diagnostic only; execution stays brokered. */
export function executableOnPath(name, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Try the next PATH element.
    }
  }
  return null;
}
