// The single registry for facts that vary by programming or file language.  Consumers derive
// their extension maps, adapter globs and analysis expectations from these rows rather than
// maintaining parallel lists.  Parser implementations may still contain syntax-specific code;
// this module says which syntax that code is asked to handle.

export const LOCAL_ANALYSES = Object.freeze(['size', 'complexity', 'nesting', 'member_count']);

export const LANGUAGE_IDS = Object.freeze({
  JAVASCRIPT: 'javascript',
  TYPESCRIPT: 'typescript',
  PYTHON: 'python',
  GO: 'go',
  JAVA: 'java',
  KOTLIN: 'kotlin',
  SCALA: 'scala',
  CSHARP: 'csharp',
  RUST: 'rust',
  RUBY: 'ruby',
  PHP: 'php',
  SWIFT: 'swift',
  DART: 'dart',
  C: 'c',
  CPP: 'cpp',
  VUE: 'vue',
  SVELTE: 'svelte',
  SHELL: 'shell',
  POWERSHELL: 'powershell',
  BATCH: 'batch',
  SQL: 'sql',
  HCL: 'hcl',
  BICEP: 'bicep',
  YAML: 'yaml',
  JSON: 'json',
  TOML: 'toml',
  XML: 'xml',
  INI: 'ini',
  MARKDOWN: 'markdown',
  RST: 'rst',
  PROTOBUF: 'protobuf',
  GRAPHQL: 'graphql',
  PRISMA: 'prisma',
  DOCKERFILE: 'dockerfile',
  MAKE: 'make',
  GROOVY: 'groovy',
});

export const QUALITY_FAMILIES = Object.freeze({
  C: 'c',
  PYTHON: 'python',
  RUBY: 'ruby',
  PHP: 'php',
  RUST: 'rust',
});

const ids = LANGUAGE_IDS;

const row = (value) => {
  const extensions = [...new Set((value.extensions ?? []).map((extension) => String(extension).toLowerCase()))];
  const declarations = value.declarations ?? {};
  const genericSyntax = value.genericSyntax ?? {};
  const genericFramework = value.genericFramework ?? {};
  return Object.freeze({
    code: false,
    adapter: null,
    generic: false,
    lexical: false,
    script: false,
    frontend: false,
    frontendByDirectory: false,
    qualityFamily: null,
    config: false,
    documentation: false,
    ...value,
    extensions: Object.freeze(extensions),
    globs: Object.freeze(value.globs ?? extensions.map((extension) => `**/*${extension}`)),
    analyses: Object.freeze(value.analyses ?? (value.code ? LOCAL_ANALYSES : [])),
    lexer: Object.freeze({ ...(value.lexer ?? {}) }),
    declarations: Object.freeze({
      typePatterns: Object.freeze([...(declarations.typePatterns ?? [])]),
      functionPatterns: Object.freeze([...(declarations.functionPatterns ?? [])]),
    }),
    testPathPatterns: Object.freeze([...(value.testPathPatterns ?? [])]),
    testGlobs: Object.freeze([...(value.testGlobs ?? [])]),
    generatedGlobs: Object.freeze([...(value.generatedGlobs ?? [])]),
    longLineGeneratedExtensions: Object.freeze([...(value.longLineGeneratedExtensions ?? [])]),
    pathMentionExtensions: Object.freeze([...(value.pathMentionExtensions ?? [])]),
    flatSibling: value.flatSibling ? Object.freeze({
      ...value.flatSibling,
      candidates: Object.freeze([...(value.flatSibling.candidates ?? [])]),
    }) : null,
    importPatterns: Object.freeze((value.importPatterns ?? []).map((pattern) => Object.freeze({ ...pattern }))),
    genericSyntax: Object.freeze({ ...genericSyntax }),
    genericFramework: Object.freeze({ ...genericFramework }),
    ecosystems: Object.freeze([...(value.ecosystems ?? [])]),
    frontendExtensions: Object.freeze([...(value.frontendExtensions ?? [])]),
    affinityTerms: Object.freeze([...(value.affinityTerms ?? [])]),
    qualityFamily: value.qualityFamily ?? null,
  });
};

const rows = new Map();
const byExtension = new Map();
const builtins = new Set();

/** Add a row. Tests can use this to prove a new language needs no parallel edits. */
export function registerLanguage(value, { builtin = false } = {}) {
  if (!value || !/^[a-z][a-z0-9_]*$/.test(value.id ?? '')) throw new TypeError('language id must be lowercase snake case');
  if (rows.has(value.id)) throw new TypeError(`language already registered: ${value.id}`);
  const normalized = row(value);
  for (const extension of normalized.extensions) {
    if (!/^\.[a-z0-9]+$/.test(extension)) throw new TypeError(`bad source extension: ${extension}`);
    if (byExtension.has(extension)) throw new TypeError(`source extension already registered: ${extension}`);
  }
  rows.set(normalized.id, normalized);
  for (const extension of normalized.extensions) byExtension.set(extension, normalized);
  if (builtin) builtins.add(normalized.id);
  return normalized;
}

/** Remove a test-only row. Built-in rows are immutable for the lifetime of a map. */
export function unregisterLanguage(id) {
  const key = String(id);
  if (builtins.has(key)) throw new TypeError(`cannot unregister built-in language: ${key}`);
  const value = rows.get(key);
  if (!value) return false;
  rows.delete(key);
  for (const extension of value.extensions) byExtension.delete(extension);
  return true;
}

export const language = (id) => rows.get(String(id)) ?? null;
export const languages = () => [...rows.values()];
export const languageForExtension = (extension) => byExtension.get(String(extension).toLowerCase()) ?? null;

/** The registry's filename and extension classification, before a parser applies syntax heuristics. */
export function languageForPath(path) {
  const base = String(path).split('/').at(-1) ?? '';
  for (const value of rows.values()) {
    if (value.fileNames?.some((name) => name === base)) return value;
    if (value.fileNamePatterns?.some((pattern) => pattern.test(base))) return value;
  }
  const dot = base.lastIndexOf('.');
  return dot < 0 ? null : languageForExtension(base.slice(dot));
}

const select = (ids_) => {
  const wanted = ids_ === undefined ? null : new Set([].concat(ids_).map(String));
  return languages().filter((value) => wanted === null || wanted.has(value.id));
};

export const extensionsFor = (ids_) => select(ids_).flatMap((value) => value.extensions);
export const globsFor = (ids_) => select(ids_).flatMap((value) => value.globs);
export const adapterGlobs = (adapter) => languages().filter((value) => value.adapter === adapter).flatMap((value) => value.globs);
export const genericGlobs = () => languages().filter((value) => value.generic).flatMap((value) => value.globs);
export const codeLanguageIds = () => languages().filter((value) => value.code).map((value) => value.id);
export const lexicalLanguageIds = () => languages().filter((value) => value.lexical).map((value) => value.id);
export const scriptLanguageIds = () => languages().filter((value) => value.script).map((value) => value.id);
export const frontendLanguageIds = () => languages().filter((value) => value.frontend).map((value) => value.id);
export const frontendExtensions = () => languages().flatMap((value) => value.frontendExtensions);
export const frontendDirectoryLanguageIds = () => languages().filter((value) => value.frontendByDirectory).map((value) => value.id);
export const affinityTerms = () => languages().flatMap((value) => value.affinityTerms);
export const qualityGlobs = () => {
  const extensions = languages().filter((value) => value.qualityFamily).flatMap((value) => value.extensions.map((extension) => extension.slice(1)));
  return extensions.length ? [`**/*.{${extensions.join(',')}}`] : [];
};
export const configLanguageIds = () => languages().filter((value) => value.config).map((value) => value.id);
export const documentationLanguageIds = () => languages().filter((value) => value.documentation).map((value) => value.id);
export const generatedGlobs = () => languages().flatMap((value) => value.generatedGlobs);
export const testGlobs = () => languages().flatMap((value) => value.testGlobs);
export const longLineGeneratedExtensions = () => languages().flatMap((value) => value.longLineGeneratedExtensions);
export const pathMentionExtensions = () => languages().flatMap((value) => value.pathMentionExtensions);
export const analysesFor = (id) => language(id)?.analyses ?? [];
export const analysisNames = () => [...new Set(languages().flatMap((value) => value.analyses))];
export const languagesForEcosystem = (ecosystem) => languages().filter((value) => value.ecosystems.includes(ecosystem)).map((value) => value.id);

const code = { code: true, analyses: LOCAL_ANALYSES };
const generic = { ...code, adapter: 'generic', generic: true, lexical: true };

[
  {
    ...code,
    id: ids.JAVASCRIPT,
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    resolverExtensions: ['.js', '.jsx', '.mjs', '.cjs'],
    adapter: 'javascript',
    frontend: true,
    frontendByDirectory: true,
    frontendExtensions: ['.jsx'],
    affinityTerms: ['js', 'mjs', 'cjs', 'jsx'],
    qualityFamily: QUALITY_FAMILIES.C,
    lexer: { sq: true, backtick: true },
    generatedGlobs: ['**/*.min.js'],
    longLineGeneratedExtensions: ['.js', '.mjs', '.cjs'],
    pathMentionExtensions: ['.js', '.mjs', '.cjs', '.jsx', '.mjsx'],
  },
  {
    ...code,
    id: ids.TYPESCRIPT,
    extensions: ['.ts', '.mts', '.cts', '.tsx'],
    resolverExtensions: ['.ts', '.tsx', '.mts', '.cts'],
    noJsxExtensions: ['.ts', '.mts', '.cts'],
    tsconfigPriorityExtensions: ['.ts', '.tsx'],
    swapFrom: {
      [ids.JAVASCRIPT]: {
        '.js': ['.ts', '.tsx'],
        '.jsx': ['.tsx'],
        '.mjs': ['.mts'],
        '.cjs': ['.cts'],
      },
    },
    adapter: 'javascript',
    frontend: true,
    frontendByDirectory: true,
    frontendExtensions: ['.tsx'],
    affinityTerms: ['ts', 'tsx'],
    qualityFamily: QUALITY_FAMILIES.C,
    lexer: { sq: true, backtick: true },
    generatedGlobs: ['**/*.pb.ts'],
    pathMentionExtensions: ['.ts', '.mts', '.cts', '.tsx', '.mtsx'],
  },
  {
    ...code,
    id: ids.PYTHON,
    extensions: ['.py', '.pyi'],
    adapter: 'python',
    qualityFamily: QUALITY_FAMILIES.PYTHON,
    pathMentionExtensions: ['.py'],
    affinityTerms: ['py'],
    lexer: { sq: true, tq: true, hash: true, noSlash: true },
    testGlobs: ['**/*_test.py', '**/test_*.py', '**/conftest.py'],
    testPathPatterns: [/(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$|(^|\/)tests?\//],
    generatedGlobs: ['**/*_pb2.py', '**/*_pb2_grpc.py'],
    flatSibling: { separator: '.', segment: /^[A-Za-z_]\w*$/, candidates: ['{module}{extension}', '{module}/__init__{extension}'] },
  },
  {
    ...generic,
    id: ids.GO,
    extensions: ['.go'],
    lexer: { char: true, backtick: true, rawTick: true },
    declarations: { functionPatterns: [
      /(?<![\w.])func\s*\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\(/gd,
      /(?<![\w.])func\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/gd,
    ] },
    testGlobs: ['**/*_test.go'],
    testPathPatterns: [/_test\.go$/],
    generatedGlobs: ['**/*.pb.go'],
    ecosystems: ['go'],
    qualityFamily: QUALITY_FAMILIES.C,
    affinityTerms: ['go'],
    genericSyntax: {
      packagePattern: /^[ \t]*package\s+(\w+)/m,
      importStyle: 'quoted_block',
      typeStyle: 'type_blocks',
      // The package is the unit: files of one directory reference each other without importing.
      packageUnit: true,
      exported: 'capitalized',
      functionReceiverGroup: 2,
      resolver: 'module_paths',
      directoryIndex: true,
      sameDirectoryMembers: true,
      callKeywords: ['go'],
      memberReserved: ['go'],
      routeKeywords: ['go', 'make'],
      parameterNamePosition: 'first',
      metrics: { noTernary: true },
    },
    genericFramework: {
      routes: 'router',
      routeGroups: true,
      security: {
        patterns: [{ pattern: /\bexec\.Command(?:Context)?\(\s*(?:[\w.]+\s*,\s*)?"(?:sh|bash|zsh|cmd(?:\.exe)?)"\s*,\s*"(?:-c|\/c)"/g, kind: 'command_exec' }],
      },
    },
  },
  {
    ...generic,
    id: ids.JAVA,
    extensions: ['.java'],
    lexer: { char: true, tq: true },
    declarations: { typePatterns: [/(?<![.\w])(@interface|class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g] },
    inheritance: 'extends_implements',
    braceFunctions: true,
    testGlobs: ['**/*Test.java'],
    testPathPatterns: [/(?:^|\/)src\/test\//, /(?:Tests?|IT|Spec|Suite)\.java$/],
    ecosystems: ['maven', 'gradle'],
    qualityFamily: QUALITY_FAMILIES.C,
    affinityTerms: ['java'],
    genericSyntax: {
      packagePattern: /^[ \t]*package\s+([\w.]+)\s*;/m,
      importStyle: 'dotted_static',
      exported: 'public',
      resolver: 'qualified_type',
      sourceConvention: /(?:^|\/)src\/(?:main|test)\/java\/(.+)\.java$/,
    },
    genericFramework: {
      markers: { kind: 'annotation', style: 'at' },
      orm: { style: 'entity_annotation', pattern: /@(Entity|Table)\b(?:\s*\(((?:"(?:[^"\\\n]|\\.)*"|[^)"])*)\))?/g },
      security: {
        patterns: [
          { pattern: /\bRuntime\.getRuntime\(\)\s*\.exec\(/g, kind: 'command_exec' },
          { pattern: /\bnew\s+ProcessBuilder\(\s*"(?:sh|bash|cmd)"/g, kind: 'command_exec' },
        ],
      },
    },
  },
  {
    ...generic,
    id: ids.KOTLIN,
    extensions: ['.kt', '.kts'],
    lexer: { char: true, tq: true, nested: true },
    declarations: {
      typePatterns: [/(?<![.\w:])(class|interface|object)\s+([A-Za-z_]\w*)/g],
      functionPatterns: [/(?<![\w.])fun\s+(?:<[^>\n]*>\s*)?(?:[\w<>?,. ]+\.)?([A-Za-z_]\w*)\s*\(/gd],
    },
    inheritance: 'colon',
    testPathPatterns: [/(?:^|\/)src\/test\//, /(?:Tests?|IT|Spec|Suite)\.(?:kt|kts)$/],
    ecosystems: ['maven', 'gradle'],
    qualityFamily: QUALITY_FAMILIES.C,
    affinityTerms: ['kt'],
    genericSyntax: {
      packagePattern: /^[ \t]*package\s+([\w.]+)/m,
      importStyle: 'dotted',
      exported: 'not_private_internal',
      resolver: 'qualified_type',
      sourceConvention: /(?:^|\/)src\/(?:main|test)\/kotlin\/(.+)\.kt$/,
      functionExpressionBodies: true,
    },
    genericFramework: {
      markers: { kind: 'annotation', style: 'at', functionPattern: /\bfun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/d },
      orm: { style: 'entity_annotation', pattern: /@(Entity|Table)\b(?:\s*\(((?:"(?:[^"\\\n]|\\.)*"|[^)"])*)\))?/g },
    },
  },
  {
    ...generic,
    id: ids.SCALA,
    extensions: ['.scala'],
    lexer: { char: true, tq: true, nested: true },
    declarations: {
      typePatterns: [/(?<![.\w])(class|trait|object)\s+([A-Za-z_]\w*)/g],
      functionPatterns: [/(?<![\w.])def\s+([A-Za-z_]\w*|[+\-*/%<>=!&|^~:]+)/gd],
    },
    inheritance: 'with_bases',
    testPathPatterns: [/(?:^|\/)src\/test\//, /(?:Tests?|IT|Spec|Suite)\.scala$/],
    ecosystems: ['maven', 'gradle'],
    qualityFamily: QUALITY_FAMILIES.C,
    genericSyntax: {
      packagePattern: /^[ \t]*package\s+([\w.]+)/m,
      importStyle: 'grouped_dot',
      exported: 'not_private',
      resolver: 'qualified_type',
      sourceConvention: /(?:^|\/)src\/(?:main|test)\/scala\/(.+)\.scala$/,
      functionSkipBracketGenerics: true,
      functionExpressionBodies: true,
    },
  },
  {
    ...generic,
    id: ids.CSHARP,
    extensions: ['.cs'],
    lexer: { char: true, tq: true, verbatim: true },
    declarations: { typePatterns: [/(?<![.\w@])(class|interface|struct|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/g] },
    inheritance: 'colon',
    braceFunctions: true,
    testGlobs: ['**/*Tests.cs'],
    testPathPatterns: [/Tests?\.cs$/, /(?:^|\/)[^/]*\.Tests?\//, /(?:^|\/)Tests?\//],
    generatedGlobs: ['**/*.g.cs'],
    ecosystems: ['dotnet'],
    qualityFamily: QUALITY_FAMILIES.C,
    affinityTerms: ['cs'],
    genericSyntax: {
      namespacePattern: /\bnamespace\s+([\w.]+)\s*[;{]/g,
      importStyle: 'using_directives',
      annotationStyle: 'bracket',
      exported: 'public',
      resolver: 'namespace',
      memberLinker: 'namespace',
    },
    genericFramework: {
      markers: { kind: 'attribute', style: 'bracket' },
      orm: { style: 'table_attribute', pattern: /\[\s*(Table)\b(?:\s*\(((?:@?"(?:[^"\\\n]|\\.)*"|[^)"])*)\))?/g },
      routes: 'minimal_api',
      routeGroups: true,
      security: {
        patterns: [{ pattern: /\bProcess\.Start\((?=[^;]*(?:\+|\$"|[Ss]tring\.Format))/g, kind: 'command_exec' }],
      },
    },
  },
  {
    ...generic,
    id: ids.RUST,
    extensions: ['.rs'],
    lexer: { char: true, nested: true, rustRaw: true, multi: true },
    declarations: {
      typePatterns: [/(?<![.\w])(struct|enum|trait)\s+([A-Za-z_]\w*)/g],
      functionPatterns: [/(?<![\w.])fn\s+([A-Za-z_]\w*)\s*(?:<[^(){};]*>)?\s*\(/gd],
    },
    inheritance: 'trait_bounds',
    testPathPatterns: [/(?:^|\/)tests\//],
    ecosystems: ['cargo'],
    qualityFamily: QUALITY_FAMILIES.RUST,
    affinityTerms: ['rs'],
    genericSyntax: {
      importStyle: 'module_tree',
      dropSelfParam: true,
      implBlocks: true,
      testBlocks: true,
      resolver: 'crate',
      exported: 'pub',
      metrics: { noTernary: true, matchArrows: true },
    },
    genericFramework: {
      routes: 'attributes',
      security: {
        patterns: [{ pattern: /\bCommand::new\(\s*"(?:sh|bash|cmd(?:\.exe)?)"\s*\)/g, kind: 'command_exec' }],
      },
    },
  },
  {
    ...generic,
    id: ids.RUBY,
    extensions: ['.rb'],
    lexer: { ruby: true, sq: true, multi: true, hash: true, backtick: true },
    testGlobs: ['**/*_spec.rb'],
    testPathPatterns: [/_(?:spec|test)\.rb$/, /(?:^|\/)(?:spec|test)\//],
    ecosystems: ['bundler'],
    qualityFamily: QUALITY_FAMILIES.RUBY,
    affinityTerms: ['rb'],
    genericSyntax: {
      endDelimited: true,
      importStyle: 'requires',
      resolver: 'require',
      metrics: { reducedDecisions: true, wordLogic: true },
    },
    genericFramework: {
      orm: { style: 'active_record' },
      routes: 'end_routes',
      security: {
        patterns: [
          { pattern: /(?<![\w.:@$])(?:system|exec|spawn|popen3?)\b\s*[("'\w]/g, kind: 'command_exec' },
          { pattern: /(?<![\w.:@$])(?:eval|instance_eval|class_eval)\b\s*[("'\w]/g, kind: 'code_eval' },
          { pattern: /%x[({[]/g, kind: 'command_exec' },
        ],
        backtickCommand: true,
      },
    },
  },
  {
    ...generic,
    id: ids.PHP,
    extensions: ['.php'],
    lexer: { php: true, sq: true, multi: true, hash: true, backtick: true },
    declarations: {
      typePatterns: [/(?<![\w:>$\\])(class|interface|trait|enum)\s+([A-Za-z_]\w*)/g],
      functionPatterns: [/(?<![\w$>:])function\s+&?\s*([A-Za-z_]\w*)\s*\(/gd],
    },
    inheritance: 'extends_implements',
    testPathPatterns: [/Test\.php$/, /(?:^|\/)tests?\//],
    ecosystems: ['composer'],
    qualityFamily: QUALITY_FAMILIES.PHP,
    affinityTerms: ['php'],
    genericSyntax: {
      namespacePattern: /^[ \t]*namespace\s+([\w\\]+)\s*[;{]/gm,
      importStyle: 'php_uses',
      exported: 'not_private',
      resolver: 'psr4',
      namespaceIndex: true,
      metrics: { wordLogic: true },
    },
    genericFramework: {
      orm: { style: 'model_property' },
      routes: 'laravel',
      security: {
        patterns: [
          { pattern: /(?<![\w$>:])eval\s*\(/g, kind: 'code_eval' },
          { pattern: /(?<![\w$>:])(?:shell_exec|system|exec|passthru|popen|proc_open)\s*\(/g, kind: 'command_exec' },
        ],
        backtickCommand: true,
        sqlInjectionInput: true,
      },
    },
  },
  {
    ...generic,
    id: ids.SWIFT,
    extensions: ['.swift'],
    lexer: { tq: true, nested: true },
    declarations: {
      typePatterns: [/(?<![.\w])(class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/g],
      functionPatterns: [/(?<![\w.])func\s+([A-Za-z_]\w*|[+\-*/%<>=!&|^~.]+)\s*(?:<[^>\n]*>\s*)?\(/gd, /(?<![\w.])(init)\??\s*\(/gd],
    },
    inheritance: 'colon',
    testPathPatterns: [/Tests?\.swift$/, /(?:^|\/)Tests\//],
    ecosystems: ['swiftpm'],
    qualityFamily: QUALITY_FAMILIES.C,
    genericSyntax: {
      importStyle: 'plain_dotted',
      exported: 'public_or_open',
      extensionBlocks: true,
      resolver: 'targets',
    },
  },
  {
    ...generic,
    id: ids.DART,
    extensions: ['.dart'],
    lexer: { sq: true, tq: true },
    declarations: { typePatterns: [/(?<![.\w@])(class|mixin|enum|extension)\s+([A-Za-z_]\w*)/g] },
    inheritance: 'extends_implements',
    braceFunctions: true,
    generatedGlobs: ['**/*.g.dart'],
  },
  {
    ...generic,
    id: ids.C,
    extensions: ['.c', '.h'],
    lexer: { char: true },
    declarations: { typePatterns: [/(?<![.\w])(struct|enum|union)\s+([A-Za-z_]\w*)/g] },
    braceFunctions: true,
    // A header can be either language; only a header that plainly uses C++ is read as C++.
    header: { extensions: ['.h'], language: ids.CPP },
    qualityFamily: QUALITY_FAMILIES.C,
    testPathPatterns: [/(?:_tests?|Tests?)\.(?:c|cc|cpp|cxx|hxx)$/, /(?:^|\/)test_[^/]*\.(?:c|cc|cpp|cxx|hxx)$/, /(?:^|\/)tests?\//],
    ecosystems: ['cmake'],
    genericSyntax: {
      importStyle: 'includes',
      typeStyle: 'strict_brace',
      typedefTypes: true,
      exported: 'not_static',
      resolver: 'includes',
      systemIncludePattern: /^(?:std\w+|string|math|time|errno|assert|ctype|limits|signal|stdarg|stddef|unistd|fcntl)\.h$/,
    },
  },
  {
    ...generic,
    id: ids.CPP,
    extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
    lexer: { char: true, cppRaw: true },
    declarations: { typePatterns: [/(?<![.\w])(enum\s+(?:class|struct)|class|struct|enum|union)\s+([A-Za-z_]\w*)/g] },
    inheritance: 'colon',
    braceFunctions: true,
    ecosystems: ['cmake'],
    testPathPatterns: [/(?:_tests?|Tests?)\.(?:c|cc|cpp|cxx|hxx)$/, /(?:^|\/)test_[^/]*\.(?:c|cc|cpp|cxx|hxx)$/, /(?:^|\/)tests?\//],
    qualityFamily: QUALITY_FAMILIES.C,
    genericSyntax: {
      namespacePattern: /\bnamespace\s+([\w:]+)\s*\{/g,
      importStyle: 'includes',
      typeStyle: 'strict_brace',
      allowTypeSuffix: true,
      typedefTypes: true,
      exported: 'not_static',
      resolver: 'includes',
      systemIncludePattern: /^(?:std\w+|string|math|time|errno|assert|ctype|limits|signal|stdarg|stddef|unistd|fcntl)\.h$/,
    },
  },
  { ...code, id: ids.VUE, extensions: ['.vue'], adapter: 'javascript', frontend: true, frontendExtensions: ['.vue'] },
  { ...code, id: ids.SVELTE, extensions: ['.svelte'], globs: ['**/+page.svelte'], adapter: 'javascript', frontend: true, frontendExtensions: ['.svelte'] },
  { ...code, id: ids.SHELL, extensions: ['.sh', '.bash', '.zsh'], script: true, pathMentionExtensions: ['.sh'] },
  { ...code, id: ids.POWERSHELL, extensions: ['.ps1'], script: true },
  { ...code, id: ids.BATCH, extensions: ['.bat', '.cmd'], script: true },
  { id: ids.SQL, extensions: ['.sql'], config: true },
  { id: ids.HCL, extensions: ['.tf', '.hcl'], config: true },
  { id: ids.BICEP, extensions: ['.bicep'], config: true },
  { id: ids.YAML, extensions: ['.yaml', '.yml'], config: true },
  { id: ids.JSON, extensions: ['.json'], config: true },
  { id: ids.TOML, extensions: ['.toml'], config: true },
  { id: ids.XML, extensions: ['.xml'], config: true },
  { id: ids.INI, extensions: ['.ini'], config: true },
  { id: ids.MARKDOWN, extensions: ['.md'], documentation: true },
  { id: ids.RST, extensions: ['.rst'], documentation: true },
  { id: ids.PROTOBUF, extensions: ['.proto'], config: true },
  { id: ids.GRAPHQL, extensions: ['.graphql', '.gql'], config: true },
  { id: ids.PRISMA, extensions: ['.prisma'], config: true },
  { id: ids.DOCKERFILE, extensions: ['.dockerfile'], config: true, fileNamePatterns: [/^Dockerfile(?:\..+)?$/i] },
  { id: ids.MAKE, config: true, fileNames: ['Makefile', 'GNUmakefile'] },
  { id: ids.GROOVY, config: true, fileNames: ['Jenkinsfile'], lexer: { sq: true, tq: true } },
].forEach((value) => registerLanguage(value, { builtin: true }));
