// Imports under `if TYPE_CHECKING:` never run, so they are marked type_only and stay out of
// runtime cycles, whichever reader (the AST extractor or the lexical fallback) saw the file.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { lexicalAnalyze } from '../../../../adapters/language/python/lexical.mjs';
import { EXTRACT_PY, hasPython } from './helpers.mjs';

const SOURCE = [
  'import typing',
  'from typing import TYPE_CHECKING',
  'if TYPE_CHECKING:',
  '    from plugins import base',
  '    import models as m',
  'else:',
  '    base = None',
  'if typing.TYPE_CHECKING:',
  '    from a import b',
  'import real',
  '',
].join('\n');

const flags = (imports) => Object.fromEntries(imports.map((i) => [i.module, i.type_only]));

test('lexical reader marks imports under if TYPE_CHECKING and ends the mark with the block', () => {
  const f = flags(lexicalAnalyze('t.py', SOURCE).imports);
  assert.equal(f.plugins, true);
  assert.equal(f.models, true);
  assert.equal(f.a, true);
  assert.equal(f.real, undefined);
  assert.equal(f.typing, undefined);
});

test('extract.py marks imports under TYPE_CHECKING, typing.TYPE_CHECKING and nested blocks', (t) => {
  if (!hasPython) return t.skip('python3 not available');
  const nested = SOURCE.replace('    import models as m', '    if True:\n        import models');
  const r = spawnSync('python3', ['-I', '-S', EXTRACT_PY], { input: JSON.stringify([{ path: 't.py', text: nested }]), encoding: 'utf8', shell: false });
  const f = flags(JSON.parse(r.stdout.split('\n').filter(Boolean)[0]).imports);
  assert.equal(f.plugins, true);
  assert.equal(f.models, true);
  assert.equal(f.a, true);
  assert.equal(f.real, undefined);
});
