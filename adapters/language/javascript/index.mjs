// JavaScript / TypeScript discovery adapter (spec §9, §11.1, §15A.10, §22).
//
// Reads text only: it never executes repository code and never touches the network. The
// tokenizer, structural pass, framework detectors and resolver live beside this file; this
// module is the adapter contract (adapters/README.md) that ties them together.

import { extractFile } from './extract.mjs';
import { linkFacts } from './link.mjs';

export default {
  id: 'javascript',
  version: '0.1.11',
  kind: 'language',
  capabilities: {
    files: [
      '**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
      '**/package.json',
      '**/tsconfig*.json',
      '**/jsconfig.json',
      '**/+page.svelte',
    ],
    executes: [],
    network: false,
  },

  /** Per-file extraction: pure, deterministic, cached by the runtime. */
  extract(file, text, ctx) {
    return extractFile(file, text, ctx);
  },

  /** Cross-file linking over the cached per-file facts. */
  link(ctx) {
    return linkFacts(ctx);
  },
};
