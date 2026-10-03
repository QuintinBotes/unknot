// Runtime evidence adapter (spec §9.4 step 7): imports exported traces, metrics,
// profiles and service catalogs the user supplied. It never touches the network or the
// live system; everything arrives as text through ctx.readText.

import { parseTraces } from './traces.mjs';
import { deriveTraceFacts } from './derive.mjs';
import { deriveMetricFacts } from './metrics.mjs';
import { deriveProfileFacts } from './profiles.mjs';
import { deriveCatalogFacts } from './catalogs.mjs';
import { MAX_FACTS_PER_FILE, MAX_SPANS, capFacts, ttlOf } from './util.mjs';

export { summarizeRuntime } from './summary.mjs';

const YAML = /\.ya?ml$/i;
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

export default {
  id: 'runtime',
  version: '0.1.0',
  kind: 'runtime',
  capabilities: { files: [], executes: [], network: false },

  /**
   * A file that cannot be read or parsed is skipped, reported through `ctx.warn` when
   * present and listed in the returned array's `failures` property, so one corrupt export
   * does not discard the facts of the others and the failure is still explicit.
   */
  async discover(ctx) {
    const ev = ctx.evidence ?? {};
    const options = ctx.options ?? {};
    const now = ctx.now ?? new Date().toISOString();
    const ttlDays = ttlOf(options);
    const maxSpans = posInt(options.max_spans_per_file, MAX_SPANS);
    const maxFacts = posInt(options.max_facts_per_file, MAX_FACTS_PER_FILE);
    const facts = [];
    const failures = [];

    const jobs = [
      ['traces', (text, file) => {
        const { spans, meta } = parseTraces(text, { maxSpans });
        return deriveTraceFacts(spans, meta, { file, options, now, ttlDays });
      }],
      ['metrics', (text, file) => deriveMetricFacts(text, { file, options, now, ttlDays })],
      ['profiles', (text, file) => deriveProfileFacts(text, { file, options, now, ttlDays })],
      ['catalogs', (text, file) => deriveCatalogFacts(text, { file, options, now, ttlDays })],
    ];
    for (const [group, run] of jobs) {
      for (const file of [...(ev[group] ?? [])].sort()) {
        if (group === 'catalogs' && YAML.test(file)) continue; // Backstage YAML is not handled here
        try {
          const text = await ctx.readText(file);
          facts.push(...capFacts(run(String(text), file), maxFacts));
        } catch (err) {
          failures.push({ file, error: String(err?.message ?? err) });
          if (typeof ctx.warn === 'function') ctx.warn(`runtime: ${file}: ${err?.message ?? err}`);
        }
      }
    }
    Object.defineProperty(facts, 'failures', { value: failures, enumerable: false });
    return facts;
  },
};
