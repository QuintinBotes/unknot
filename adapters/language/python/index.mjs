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

const isPython = (path) => path.endsWith('.py');

/** Facts for one file from the lexical reader (plus manifest facts for setup.py and friends). */
function lexicalFacts(path, text) {
  const facts = isPython(path) ? buildFacts(path, lexicalAnalyze(path, text), text, 'lexical') : [];
  if (manifestKind(path)) facts.push(...manifestFacts(path, text));
  return facts;
}

/** Run extract.py once for a batch; returns Map<path, record>, empty when python3 is not usable. */
async function runPython(items, ctx) {
  const records = new Map();
  if (typeof ctx?.exec !== 'function' || !items.length) return records;
  let res;
  try {
    res = await ctx.exec(['python3', '-I', '-S', SCRIPT], {
      input: JSON.stringify(items.map(({ file, text }) => ({ path: file.path, text }))),
      timeoutMs: EXEC_TIMEOUT_MS,
    });
  } catch {
    return records; // UK_ADAPTER_UNSUPPORTED, timeout or spawn failure: the lexical reader covers it
  }
  if (!res || res.exitCode !== 0) return records;
  for (const line of String(res.stdout).split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.path === 'string') records.set(rec.path, rec);
    } catch {
      // A malformed line loses that file to the fallback; it must not sink the batch.
    }
  }
  return records;
}

export default {
  id: 'python',
  version: '0.1.1',
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
