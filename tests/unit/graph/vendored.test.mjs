import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { census, looksVendored } from '../../../runtime/graph/census.mjs';

test('looksVendored: bundle banners and unchecked third-party headers, not ordinary project files', () => {
  assert.equal(looksVendored('/*! @license DOMPurify 3.4.14 | (c) Cure53 | Apache-2.0 */\n(function(){})();'), true);
  assert.equal(looksVendored('/* eslint-disable */\n// @ts-nocheck\n\n/**\n * Slightly modified emscripten bindings of a library\n */\nexport const a = 1;'), true);
  assert.equal(looksVendored('/* eslint-disable */\n// @ts-nocheck\n// copied from https://example.org/lib\nexport const a = 1;'), true);
  // A lone @ts-nocheck, lint disabled alone, a plain license header and a `/*!` note without a license are project code.
  assert.equal(looksVendored('// @ts-nocheck\nexport const a = 1;'), false);
  assert.equal(looksVendored('/* eslint-disable */\nexport const a = 1;'), false);
  assert.equal(looksVendored('/**\n * Copyright (c) 2024 Acme. Licensed under MIT.\n */\nexport const a = 1;'), false);
  assert.equal(looksVendored('/*! note: keep this */\nexport const a = 1;'), false);
});

test('census: vendored libraries are recognised by banner, header and directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'unknot-census-'));
  try {
    const put = (p, c) => {
      mkdirSync(join(root, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      writeFileSync(join(root, p), c);
    };
    put('Content/js/purify.js', '/*! @license DOMPurify 3.4.14 | (c) Cure53 */\nvar a = 1;\n');
    put('src/wasm.ts', '/* eslint-disable */\n// @ts-nocheck\n// emscripten output\nexport const a = 1;\n');
    put('js/tiny_mce/themes/mobile/theme.js', 'var a = 1;\n');
    put('js/tinymce/plugins/x.js', 'var a = 1;\n');
    put('web/wwwroot/lib/jquery/jquery.js', 'var a = 1;\n');
    put('src/own.ts', '// @ts-nocheck\nexport const a = 1;\n');
    const { files } = census(root, { config: {} });
    const by = Object.fromEntries(files.map((f) => [f.path, f.kind]));
    for (const p of ['Content/js/purify.js', 'src/wasm.ts', 'js/tiny_mce/themes/mobile/theme.js', 'js/tinymce/plugins/x.js', 'web/wwwroot/lib/jquery/jquery.js']) assert.equal(by[p], 'vendored', p);
    assert.equal(by['src/own.ts'], 'source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
