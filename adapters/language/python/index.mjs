// Python discovery adapter (spec §9, §11.1, §14.3). Structure comes from extract.py run by
// the broker (`python3 -I -S`, which only ever calls ast.parse on text we pipe in), and from
// a pure-JS lexical reader whenever python3 is unavailable. The adapter itself never opens
// files or spawns anything: it asks ctx.exec, which the runtime allowlists.

import { fileURLToPath } from 'node:url';

import { EXTRACTOR, buildFacts } from './build.mjs';
import { lexicalAnalyze } from './lexical.mjs';
import { link } from './link.mjs';
import { manifestFacts, manifestKind } from './manifests.mjs';

const SCRIPT = fileURLToPath(new URL('./extract.py', import.meta.url));
const EXEC_TIMEOUT_MS = 60_000;
// Small enough that a slow machine times out one part, not the batch, and that a part's output
// stays under the broker's 16 MiB cap (files after a cut would silently lose their AST record).
const BATCH_FILES = 300;
const BATCH_BYTES = 1_500_000;

const isPython = (path) => path.endsWith('.py');

/** Facts for one file from the lexical reader (plus manifest facts for setup.py and friends). */
function lexicalFacts(path, text) {
  const facts = isPython(path) ? buildFacts(path, lexicalAnalyze(path, text), text, 'lexical') : [];
  if (manifestKind(path)) facts.push(...manifestFacts(path, text));
  return facts;
}

/**
 * Run extract.py over a batch, in parts small enough that a slow machine times out one part,
 * not the batch. A part that times out is retried once with twice the time; a part that still
 * fails is read lexically, and the map says how many files that was.
 * @returns {Promise<Map<string, object>>} empty when python3 is not usable
 */
async function runPython(items, ctx) {
  const records = new Map();
  if (typeof ctx?.exec !== 'function' || !items.length) return records;
  const parts = batches(items);
  let lost = 0;
  let reason = null;
  for (const p of parts) {
    let res = await runPart(p, ctx, EXEC_TIMEOUT_MS);
    if (res.timedOut) res = await runPart(p, ctx, EXEC_TIMEOUT_MS * 2);
    if (res.unavailable) {
      // python3 missing or refused: every part would fail the same way.
      ctx.notes?.push(`python AST extractor unavailable (${res.reason}); Python files were read lexically, with lower confidence`);
      return records;
    }
    if (res.reason) {
      lost += p.length;
      reason ??= res.reason;
      continue;
    }
    for (const [k, v] of res.records) records.set(k, v);
  }
  if (lost) ctx.notes?.push(`python AST extractor failed for ${lost} of ${items.length} Python files (${reason}); those were read lexically, with lower confidence`);
  return records;
}

/** Splits files into runs of at most BATCH_FILES files and about BATCH_BYTES of text, in order. */
export function batches(items) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= BATCH_FILES || bytes + it.text.length > BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function runPart(items, ctx, timeoutMs) {
  let res;
  try {
    res = await ctx.exec(['python3', '-I', '-S', SCRIPT], {
      input: JSON.stringify(items.map(({ file, text }) => ({ path: file.path, text }))),
      timeoutMs,
    });
  } catch (err) {
    // UK_ADAPTER_UNSUPPORTED, timeout or spawn failure: the lexical reader covers it, and the
    // map says so (a silent fallback hid degraded analysis in live sessions).
    const reason = String(err?.message ?? err).slice(0, 200);
    return { unavailable: true, reason };
  }
  if (!res || res.exitCode !== 0) {
    const reason = `exited ${res?.exitCode ?? '?'}: ${String(res?.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`;
    return res?.record?.timed_out ? { timedOut: true, reason: `timed out after ${timeoutMs / 1000} s` } : { reason };
  }
  // A cut-off output would leave the files after the cut without a record; read the part lexically.
  if (res.record?.truncated) return { reason: 'output above the command output limit' };
  const records = new Map();
  for (const line of String(res.stdout).split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.path === 'string') records.set(rec.path, rec);
    } catch {
      // A malformed line loses that file to the fallback; it must not sink the batch.
    }
  }
  return { records };
}

export default {
  id: 'python',
  version: '0.1.11',
  kind: 'language',
  capabilities: {
    files: ['**/*.py', '**/pyproject.toml', '**/setup.cfg', '**/setup.py', '**/requirements*.txt'],
    executes: ['python3'],
    network: false,
  },

  extract(file, text) {
    return lexicalFacts(file.path, text);
  },

  /**
   * @param {Array<{file: {path: string}, text: string}>} items cache misses
   * @param {{exec?: Function}} ctx
   * @returns {Promise<Map<string, object[]>>}
   */
  async extractBatch(items, ctx) {
    const result = new Map();
    const pyItems = items.filter(({ file }) => isPython(file.path));
    const records = await runPython(pyItems, ctx);
    for (const { file, text } of items) {
      const path = file.path;
      const rec = records.get(path);
      const facts = [];
      if (isPython(path)) facts.push(...(rec ? buildFacts(path, rec, text, 'ast') : buildFacts(path, lexicalAnalyze(path, text), text, 'lexical')));
      if (manifestKind(path)) facts.push(...manifestFacts(path, text));
      result.set(path, facts);
    }
    return result;
  },

  link,
};

export { EXTRACTOR };
