import { readFileSync } from 'node:fs';
import adapter from '../../../../adapters/runtime/index.mjs';

export const FIXTURES = new URL('../../../fixtures/runtime/', import.meta.url);
export const NOW = '2026-09-05T00:00:00.000Z';

export function fixture(name) {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/** Run the adapter over in-memory files: `files` maps repo path -> text. */
export async function run(evidence, files, options = {}, now = NOW) {
  const readText = (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  };
  const full = { traces: [], metrics: [], profiles: [], catalogs: [], ...evidence };
  return adapter.discover({ evidence: full, readText, options, now });
}

/** Run over fixture files directly. */
export function runFixtures(evidence, options = {}, now = NOW) {
  const files = {};
  for (const list of Object.values(evidence)) for (const f of list) files[f] = fixture(f);
  return run(evidence, files, options, now);
}

/** Facts with the evidence-file part of source_ref removed, for cross-format comparison. */
export function normalised(facts) {
  return facts.map((f) => ({ ...f, provenance: { ...f.provenance, source_ref: f.provenance.source_ref.split('#')[1] } }));
}

export const find = (facts, id) => facts.find((f) => f.id === id);
export const edge = (facts, type, from, to) => facts.find((f) => f.kind === 'edge' && f.type === type && f.from === from && f.to === to);
