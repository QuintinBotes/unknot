import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import * as K from '../../helpers/kernel.mjs';
import { diagnose } from '../../../runtime/diagnose/engine.mjs';
import { mapRepository } from '../../../runtime/graph/builder.mjs';
import { extractParallel } from '../../../runtime/graph/pool.mjs';

Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false' });
after(() => K.cleanup());

test('parallel extraction returns results in file order however the batches finish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uk-pool-'));
  mkdirSync(join(dir, 'src'));
  const files = [];
  for (let i = 0; i < 300; i++) {
    writeFileSync(join(dir, 'src', `f${i}.txt`), String(i));
    files.push({ path: `src/f${i}.txt` });
  }
  // The first batch is the slowest, so it completes after the later ones.
  const mod = join(dir, 'slow-adapter.mjs');
  writeFileSync(mod, `export default { extract(file) { if (/f[0-9]\\.txt$/.test(file.path)) { const end = Date.now() + 15; while (Date.now() < end); } return [{ file: file.path }]; } };\n`);
  const out = await extractParallel({ moduleURL: pathToFileURL(mod).href, root: dir, files, commit: null, options: {}, workers: 4, batch: 10 });
  assert.deepEqual(out.map((r) => r.path), files.map((f) => f.path));
});

/** Facts in insertion order (without observation time), nodes, edges and finding fingerprints of one cold map and diagnose. */
async function snapshot(files, workers) {
  const p = K.makeProject({ files });
  const config = K.cfg({ mode: 'plan', limits: { workers } });
  const run = K.runs.startRun(p.ctx, { command: 'map', actor: 'human:test', config, configDigest: 'd' });
  const map = await mapRepository(p.ctx, { config, configDigest: 'd', run, history: false });
  const diag = await diagnose(p.ctx, { config, run });
  const rows = (sql) => p.ctx.store.all(sql).map((r) => JSON.stringify(r));
  return {
    map,
    facts: rows('SELECT id, kind, subject, predicate, object, attrs, path FROM facts ORDER BY rowid'),
    nodes: rows('SELECT * FROM nodes ORDER BY id'),
    edges: rows('SELECT * FROM edges ORDER BY id'),
    findings: diag.findings.map((f) => f.fingerprint).sort(),
  };
}

test('mapping the same repository with parallel extraction gives the same facts, graph and findings every time', async () => {
  const files = {};
  // Enough files to cross the parallel threshold, with imports, shared names and a hub.
  for (let i = 0; i < 450; i++) {
    const dep = [(i * 7 + 1) % 450, (i * 13 + 5) % 450, 0].filter((d) => d !== i);
    files[`src/m${i}.js`] = `${dep.map((d) => `import { v${d} } from './m${d}.js';`).join('\n')}\nexport const v${i} = ${i};\nexport function dup() { return ${dep.map((d) => `v${d}`).join(' + ')}; }\n`;
  }
  const runs = [];
  for (const workers of [4, 4, 2, 1]) runs.push(await snapshot(files, workers));
  assert.ok(runs[0].map.files >= 450);
  assert.ok(runs[0].facts.length > 450, 'the fixture produced facts');
  for (const r of runs.slice(1)) {
    assert.deepEqual(r.facts, runs[0].facts);
    assert.deepEqual(r.nodes, runs[0].nodes);
    assert.deepEqual(r.edges, runs[0].edges);
    assert.deepEqual(r.findings, runs[0].findings);
  }
});
