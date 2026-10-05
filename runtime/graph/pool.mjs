// A small worker pool for per-file extraction (spec §28: bounded by configured workers).

import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

export function defaultWorkers(configured) {
  if (configured) return Math.max(1, Math.floor(configured));
  return Math.max(1, Math.min(8, availableParallelism() - 1));
}

/**
 * Run `adapter.extract` over `files` in `workers` threads, `batch` files per message.
 * @returns {Promise<Array<{path, blob, bytes, facts} | {path, error}>>}
 */
export async function extractParallel({ moduleURL, root, files, commit, options, workers, batch = 64 }) {
  const queue = [];
  for (let i = 0; i < files.length; i += batch) queue.push(files.slice(i, i + batch));
  const results = [];
  const pool = Array.from({ length: Math.min(workers, queue.length) }, () => new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { moduleURL } }));
  let next = 0;
  try {
    await Promise.all(
      pool.map(
        (w) =>
          new Promise((resolve, reject) => {
            const send = () => {
              if (next >= queue.length) return resolve();
              const id = next++;
              w.postMessage({ id, root, items: queue[id], commit, options });
            };
            w.on('message', (msg) => {
              results.push(...msg.results);
              send();
            });
            w.on('error', reject);
            // A worker that dies without an error event (native crash, exit) would otherwise
            // leave its share of the queue unfinished and the map waiting forever.
            w.on('exit', (code) => reject(new Error(`extraction worker exited (code ${code}) before finishing`)));
            send();
          }),
      ),
    );
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
  return results;
}
