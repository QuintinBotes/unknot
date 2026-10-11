import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

import generic from '../../../adapters/language/generic/index.mjs';
import {
  LANGUAGE_IDS, LOCAL_ANALYSES, genericGlobs, languageForPath, languages, registerLanguage, unregisterLanguage,
} from '../../../runtime/graph/languages.mjs';
import { loadFixture } from '../adapters/generic/helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// A parser may spell the grammar it reads. Every exception is one file and says why; all other
// production modules, including literals, contracts, database, infrastructure, delivery and
// patterns, are scanned.
const ALLOWLIST = new Map([
  ['adapters/contracts/idl.mjs', 'Parses GraphQL and Protocol Buffers IDL syntax.'],
  ['adapters/contracts/index.mjs', 'Selects contract parsers from their source-file formats.'],
  ['adapters/database/index.mjs', 'Interprets database migration and ORM dialect labels.'],
  ['adapters/database/migrations.mjs', 'Parses migration formats and dialect-specific change syntax.'],
  ['adapters/delivery/build.mjs', 'Parses Make build declarations.'],
  ['adapters/delivery/flags.mjs', 'Parses JSON feature-flag exports.'],
  ['adapters/infrastructure/iac/cloudformation.mjs', 'Parses Bicep declaration syntax.'],
  ['adapters/infrastructure/iac/plan.mjs', 'Recognises Bicep plan input.'],
  ['adapters/infrastructure/k8s/config_mgmt.mjs', 'Parses shell and batch configuration-management module names.'],
  ['adapters/language/javascript/extract.mjs', 'Implements JavaScript-family parser internals.'],
  ['adapters/language/javascript/frameworks.mjs', 'Implements JavaScript-family framework parser internals.'],
  ['adapters/language/javascript/resolver.mjs', 'Implements JavaScript-family module resolution.'],
  ['adapters/language/python/extract.py', 'Implements Python parser internals.'],
  ['adapters/language/python/manifests.mjs', 'Parses Python project manifests.'],
  ['adapters/literals/index.mjs', 'Selects literal lexing rules for source and configuration formats.'],
  ['adapters/runtime/metrics.mjs', 'Parses JSON runtime evidence.'],
  ['adapters/security/index.mjs', 'Parses JSON scanner reports.'],
  ['runtime/artifacts/architecture.mjs', 'Uses a diagram node prefix that happens to equal a language id.'],
  ['runtime/cli/commands/decompose.mjs', 'Defines a CLI output-format switch.'],
  ['runtime/cli/commands/init.mjs', 'Recognises a build executable, not a source language.'],
  ['runtime/cli/util.mjs', 'Defines CLI output-format switches.'],
  ['runtime/core/shell.mjs', 'Uses shell-option and process-argument spellings, not language selectors.'],
  ['runtime/graph/languages.mjs', 'Defines the authoritative registry values.'],
  ['runtime/graph/pool.mjs', 'Uses a worker-message batching term, not a language selector.'],
  ['runtime/patterns/engine.mjs', 'Loads pattern-card YAML files.'],
]);

const SCAN_ROOTS = Object.freeze(['adapters', 'runtime', 'schemas']);

function filesUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(?:mjs|js|py)$/.test(name)) out.push(path);
  }
  return out;
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literalSource = (values) => `(["'\\x60])(?:${values.map(escape).sort((a, b) => b.length - a.length || a.localeCompare(b)).join('|')})\\1`;
const quoted = (values) => new RegExp(literalSource(values), 'g');

function languageReferences(text, ids) {
  const literal = quoted(ids);
  const contexts = [
    ['comparison', new RegExp(`(?:===|!==|==|!=)\\s*${literalSource(ids)}`, 'g')],
    ['switch case', new RegExp(`\\bcase\\s+${literalSource(ids)}\\s*:`, 'g')],
    ['collection check', new RegExp(`\\.(?:has|includes)\\s*\\(\\s*${literalSource(ids)}`, 'g')],
  ];
  const references = new Map();
  for (const [kind, re] of contexts) {
    for (let match; (match = re.exec(text));) {
      literal.lastIndex = 0;
      const value = literal.exec(match[0]);
      if (!value) continue;
      references.set(match.index + value.index, { kind: `language id ${kind}`, literal: value[0] });
    }
  }
  literal.lastIndex = 0;
  for (let match; (match = literal.exec(text));) {
    if (!references.has(match.index)) references.set(match.index, { kind: 'language id', literal: match[0] });
  }
  return [...references].sort(([a], [b]) => a - b).map(([index, value]) => ({ index, ...value }));
}

function strayLanguageFacts(root, roots = SCAN_ROOTS) {
  const ids = languages().map((value) => value.id);
  const extensions = languages().flatMap((value) => value.extensions);
  const extensionRE = quoted(extensions);
  const offenders = [];
  for (const sourceRoot of roots) {
    for (const path of filesUnder(join(root, sourceRoot))) {
      const rel = relative(root, path).split(sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      const text = readFileSync(path, 'utf8');
      const lineAt = (index) => text.slice(0, index).split('\n').length;
      for (const match of languageReferences(text, ids)) offenders.push(`${rel}:${lineAt(match.index)}: ${match.kind} ${match.literal}`);
      extensionRE.lastIndex = 0;
      for (let match; (match = extensionRE.exec(text));) offenders.push(`${rel}:${lineAt(match.index)}: source extension ${match[0]}`);
    }
  }
  return offenders;
}

test('language ids and source extensions live in the registry', () => {
  for (const [path, reason] of ALLOWLIST) {
    assert.ok(!path.endsWith('/'), `allowlist entry must name one file: ${path}`);
    assert.match(reason, /\.$/, `allowlist entry needs a one-line reason: ${path}`);
    assert.ok(existsSync(join(ROOT, path)), `allowlist entry must exist: ${path}`);
  }
  const offenders = strayLanguageFacts(ROOT);
  assert.deepEqual(offenders, [], `move new language facts to runtime/graph/languages.mjs:\n${offenders.join('\n')}`);
});

test('language registry guard catches comparisons, switch cases and collection checks', () => {
  const temp = mkdtempSync(join(tmpdir(), 'unknot-language-registry-'));
  const rel = 'adapters/language/generic/structure.mjs';
  const copy = join(temp, rel);
  try {
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, `${readFileSync(join(ROOT, rel), 'utf8')}\nconst comparison = lang === 'rust';\nswitch (lang) { case 'go': break; }\nnew Set().has('dart');\n`);
    const offenders = strayLanguageFacts(temp, ['adapters']).join('\n');
    assert.match(offenders, /language id comparison 'rust'/);
    assert.match(offenders, /language id switch case 'go'/);
    assert.match(offenders, /language id collection check 'dart'/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('registry pins the extension additions from the language-table refactor', () => {
  const cases = [
    ['types/example.pyi', LANGUAGE_IDS.PYTHON],
    ['src/example.hxx', LANGUAGE_IDS.CPP],
    ['scripts/build.bat', LANGUAGE_IDS.BATCH],
    ['scripts/build.cmd', LANGUAGE_IDS.BATCH],
  ];
  for (const [path, id] of cases) assert.equal(languageForPath(path)?.id, id, path);
});

test('a registered generic language needs no parallel analysis or import changes', () => {
  const fake = registerLanguage({
    id: 'fixture_lang',
    extensions: ['.reg'],
    code: true,
    generic: true,
    lexical: true,
    analyses: LOCAL_ANALYSES,
    lexer: { char: true },
    declarations: { typePatterns: [/(?<![.\w])(class)\s+([A-Za-z_]\w*)/g] },
    braceFunctions: true,
    importPatterns: [{ pattern: /^[ \t]*import\s+([A-Za-z_]\w*)\s*;/gm }],
    flatSibling: { separator: '.', segment: /^[A-Za-z_]\w*$/, candidates: ['{module}{extension}'] },
  });
  try {
    assert.ok(generic.capabilities.files.includes('**/*.reg'), 'adapter capability derives from the row');
    assert.ok(genericGlobs().includes('**/*.reg'), 'generic file glob derives from the row');
    const fixture = loadFixture('registry');
    const module = fixture.node('module:consumer.reg');
    const cls = fixture.node('class:consumer.reg#Consumer');
    const method = fixture.node('method:consumer.reg#Consumer.process');
    assert.deepEqual(module?.attrs.analyses, LOCAL_ANALYSES, 'size and structural analyses are declared from the row');
    assert.ok(module?.attrs.loc > 0, 'size analysis ran');
    assert.equal(method?.attrs.max_nesting, 1, 'nesting analysis ran');
    assert.equal(cls?.attrs.methods, 1, 'member-count analysis ran');
    assert.ok(fixture.hasEdge('IMPORTS', 'module:consumer.reg', 'module:helper.reg'), 'the row supplies import syntax and local resolution');
  } finally {
    assert.equal(unregisterLanguage(fake.id), true);
  }
});
