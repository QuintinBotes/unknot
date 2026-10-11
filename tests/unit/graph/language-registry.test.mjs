import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import generic from '../../../adapters/language/generic/index.mjs';
import {
  LOCAL_ANALYSES, genericGlobs, languages, registerLanguage, unregisterLanguage,
} from '../../../runtime/graph/languages.mjs';
import { loadFixture } from '../adapters/generic/helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// These readers recognise their own file grammars; their syntax rules necessarily mention
// the formats they parse. Every classifier and adapter contract outside this small boundary
// must take language names and source extensions from the registry.
const ALLOWLIST = Object.freeze([
  'runtime/graph/languages.mjs',
  'tests/fixtures/',
  'adapters/language/',
  'adapters/literals/',
  'adapters/contracts/',
  'adapters/database/',
  'adapters/infrastructure/',
  'adapters/delivery/',
  'runtime/patterns/',
  'runtime/artifacts/architecture.mjs', // Diagram node prefix `c`, not the C language id.
  'runtime/core/shell.mjs', // CLI option `shell`, not a source-language identifier.
]);

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(?:mjs|js|py)$/.test(name)) out.push(path);
  }
  return out;
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quoted = (values) => new RegExp(`(["'\\x60])(?:${values.map(escape).sort((a, b) => b.length - a.length || a.localeCompare(b)).join('|')})\\1`, 'g');

test('language ids and source extensions live in the registry', () => {
  const ids = languages().filter((value) => value.generic || value.adapter).map((value) => value.id);
  const extensions = languages().flatMap((value) => value.extensions);
  const idRE = quoted(ids);
  const extensionRE = quoted(extensions);
  const offenders = [];
  const roots = ['adapters', 'runtime', 'schemas', 'tests/fixtures'];
  for (const root of roots) {
    for (const path of filesUnder(join(ROOT, root))) {
      const rel = relative(ROOT, path).split(sep).join('/');
      if (ALLOWLIST.some((allowed) => rel === allowed || rel.startsWith(allowed))) continue;
      const text = readFileSync(path, 'utf8');
      for (const [kind, re] of [['language id', idRE], ['source extension', extensionRE]]) {
        re.lastIndex = 0;
        for (let match; (match = re.exec(text));) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${rel}:${line}: ${kind} ${match[0]}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `move new language facts to runtime/graph/languages.mjs:\n${offenders.join('\n')}`);
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
