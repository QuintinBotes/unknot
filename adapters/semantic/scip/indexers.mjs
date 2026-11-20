// The complete language-specific surface of the opt-in SCIP runner. Keep command shapes,
// marker files and safety classifications here: adding an indexer must be a table row, not a
// branch elsewhere in the runtime.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { matchAny } from '../../../runtime/core/glob.mjs';
import { LANGUAGE_IDS, extensionsFor } from '../../../runtime/graph/languages.mjs';

export const OUTPUT = '{output}';
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MEMORY_MB = 2_048;
export const MIN_MEMORY_MB = 128;
export const MAX_MEMORY_MB = 16_384;

const row = (value) => {
  const languages = Object.freeze(value.languages ?? [value.language]);
  const extensions = Object.freeze(Object.fromEntries(languages.flatMap((language) => extensionsFor([language]).map((extension) => [extension, language]))));
  return Object.freeze({ ...value, languages, extensions, markers: Object.freeze(value.markers), argv: Object.freeze(value.argv) });
};

/**
 * A pinned command template uses `{output}` exactly once. The broker accepts only these
 * templates, after substituting the private cache path for that token.
 */
export const INDEXERS = Object.freeze([
  row({
    language: LANGUAGE_IDS.CSHARP,
    // Some indexers leave a document's language empty; its extension then names it.
    markers: ['**/*.sln', '**/*.csproj'],
    // An attribute on a member is a reference to its constructor (`JsonPropertyAttribute#`.ctor`().`).
    // A framework reads such a member by reflection, except where the attribute asks a container to
    // inject it (the C# injection attributes of the member syntax): that is a write.
    annotation: /Attribute#(?:`\.ctor`\([^)]*\)\.)?$/,
    injection: /[/#.](?:Dependency|Inject|FromServices|Import|ImportMany|Autowired)Attribute#/,
    // Templates the indexer does not read, which name members (Razor views: `Model.X`, `asp-for="X"`).
    templates: ['**/*.cshtml', '**/*.razor'],
    executable: 'scip-dotnet',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
  row({
    language: LANGUAGE_IDS.TYPESCRIPT,
    languages: [LANGUAGE_IDS.TYPESCRIPT, LANGUAGE_IDS.JAVASCRIPT],
    markers: ['**/tsconfig.json', '**/package.json'],
    executable: 'scip-typescript',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: false,
  }),
  row({
    language: LANGUAGE_IDS.JAVA,
    languages: [LANGUAGE_IDS.JAVA, LANGUAGE_IDS.KOTLIN, LANGUAGE_IDS.SCALA],
    markers: ['**/pom.xml', '**/build.gradle*', '**/build.sbt'],
    executable: 'scip-java',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
  row({
    language: LANGUAGE_IDS.PYTHON,
    markers: ['**/pyproject.toml', '**/setup.py', '**/setup.cfg'],
    executable: 'scip-python',
    argv: ['index', '.', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: false,
  }),
  row({
    language: LANGUAGE_IDS.GO,
    markers: ['**/go.mod'],
    executable: 'scip-go',
    argv: ['index', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: true,
  }),
  row({
    language: LANGUAGE_IDS.RUST,
    markers: ['**/Cargo.toml'],
    executable: 'rust-analyzer',
    argv: ['scip', '.', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: false,
  }),
  row({
    language: LANGUAGE_IDS.RUBY,
    markers: ['**/Gemfile'],
    executable: 'scip-ruby',
    argv: ['.', '--index-file', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
  row({
    language: LANGUAGE_IDS.CPP,
    languages: [LANGUAGE_IDS.C, LANGUAGE_IDS.CPP],
    markers: ['**/compile_commands.json'],
    executable: 'scip-clang',
    argv: ['--compdb-path', 'compile_commands.json', '--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: false,
  }),
  row({
    language: LANGUAGE_IDS.DART,
    markers: ['**/pubspec.yaml'],
    executable: 'scip_dart',
    argv: ['.', '--output', OUTPUT],
    executesRepositoryCode: false,
    needsNetwork: true,
  }),
  row({
    language: LANGUAGE_IDS.PHP,
    markers: ['**/composer.json'],
    executable: 'scip-php',
    argv: ['--output', OUTPUT],
    executesRepositoryCode: true,
    needsNetwork: true,
  }),
]);

const LANGUAGE_BY_EXTENSION = new Map(INDEXERS.flatMap((entry) => Object.entries(entry.extensions)));
const KNOWN_LANGUAGES = new Set(Object.values(LANGUAGE_IDS));

/**
 * A SCIP document's language: the one it declares when that is a language id, else the one its
 * extension names in the table. scip-typescript, for one, writes every document with an empty
 * language, and scip-dotnet writes "C#".
 */
export function documentLanguage(document) {
  const declared = String(document?.language ?? '').toLowerCase();
  if (declared && KNOWN_LANGUAGES.has(declared)) return declared;
  const path = String(document?.relative_path ?? '');
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : (LANGUAGE_BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? '');
}

/** For a language: the symbols an annotation on a member references, and those of injection annotations. */
export function annotationRulesFor(language) {
  const row = INDEXERS.find((entry) => entry.languages.includes(language));
  return row?.annotation ? { annotation: row.annotation, injection: row.injection ?? null } : null;
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

function requestedLanguages(options) {
  return Array.isArray(options.languages) && options.languages.length ? new Set(options.languages.map(String)) : null;
}

function selected(entry, requested) {
  return !requested || entry.languages.some((language) => requested.has(language)) || requested.has(entry.language);
}

/** The project-marker row selection used by the runner. */
export function indexersForPaths(paths, options = {}) {
  const requested = requestedLanguages(options);
  return INDEXERS.filter((entry) => paths.some((path) => matchAny(path, entry.markers)) && selected(entry, requested));
}

/** Rows whose source languages occur in repository paths, narrowed by adapters.scip.languages. */
export function indexersForSourcePaths(paths, options = {}) {
  const languages = new Set(paths.map((path) => documentLanguage({ relative_path: path })).filter(Boolean));
  const requested = requestedLanguages(options);
  return INDEXERS.filter((entry) => entry.languages.some((language) => languages.has(language)) && selected(entry, requested));
}

/** The first project marker for a registry row that exists in repository paths, or null. */
export function projectMarker(entry, paths) {
  if (!INDEXERS.includes(entry)) throw new TypeError('unknown SCIP indexer row');
  return entry.markers.find((marker) => paths.some((path) => matchAny(path, [marker]))) ?? null;
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
