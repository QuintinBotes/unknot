// Extraction worker: loads one adapter module and runs its pure `extract` over batches of
// files it reads itself (paths were validated by the parent). Facts cross back by
// structured clone, so they must be plain data, which the adapter contract requires.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { sha256 } from '../core/canonical.mjs';

const adapter = (await import(workerData.moduleURL)).default;

parentPort.on('message', ({ id, root, items, commit, options }) => {
  const results = [];
  for (const file of items) {
    try {
      const buf = readFileSync(join(root, file.path));
      const blob = file.blob ?? `sha256:${sha256(buf)}`;
      const facts = adapter.extract({ ...file, blob }, buf.toString('utf8'), { commit, options });
      results.push({ path: file.path, blob, bytes: buf.length, facts });
    } catch (err) {
      results.push({ path: file.path, error: String(err?.message ?? err) });
    }
  }
  parentPort.postMessage({ id, results });
});
