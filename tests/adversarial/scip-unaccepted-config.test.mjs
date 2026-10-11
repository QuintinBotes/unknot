import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as K from '../helpers/kernel.mjs';

// A hostile repository can commit .unknot/config.yaml. Running SCIP indexers can execute the
// repository's build, so a file nobody accepted must not be able to turn it on.
test('an unaccepted config cannot enable adapters.scip.run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-scip-unaccepted-'));
  try {
    const config = join(dir, 'config.yaml');
    writeFileSync(config, 'version: 1\nadapters:\n  scip:\n    run: true\n    languages: [csharp]\n');
    const ctx = { paths: { config }, store: { meta: () => null } };
    const loaded = K.configMod.loadConfig(ctx);
    assert.equal(loaded.config.adapters?.scip?.run, false);
    assert.deepEqual(loaded.config.adapters?.scip?.languages, ['csharp'], 'the rest of the adapter settings still apply');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
