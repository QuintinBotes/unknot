// Wiring adapter: source files that configuration starts by path (a plugin's hooks.json,
// package.json scripts, CI steps, Makefiles, Dockerfiles, Procfiles). Such a module is an
// entry point even though nothing imports it (dogfood FB16: Claude Code hook scripts were
// reported as unreferenced). Extraction records the path-like strings a config file
// mentions; link keeps the ones that name a file in the repository.

import { edgeFact, nodeFact, prov } from '../../runtime/graph/facts.mjs';

const ID = 'wiring';
const VERSION = '0.1.2';
const EXTRACTOR = `${ID}@${VERSION}`;
const MAX_BYTES = 512 * 1024;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|bun\.lockb?)$/;
// A relative path ending in a source or script extension, optionally behind `./` or a
// variable such as ${CLAUDE_PLUGIN_ROOT}/ or $(pwd)/.
const MENTION = /(?:\$\{?\(?[A-Za-z_][A-Za-z0-9_]*\)?\}?\/|\.\/)?((?:[\w@.-]+\/)*[\w@.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|py|sh|bash|rb|go|php|pl|ps1))(?![\w/])/g;

const P = (path) => prov({ source_type: 'config', source_ref: `${path}:1`, extractor: EXTRACTOR, confidence: 'medium' });

export function mentions(text) {
  const out = new Set();
  for (const m of text.matchAll(MENTION)) {
    const p = m[1];
    if (p.startsWith('.') && !p.startsWith('./')) continue; // dotfiles and ../ escapes
    if (/^(https?|node_modules)\b/.test(p) || p.includes('node_modules/')) continue;
    out.add(p);
    if (out.size >= 500) break;
  }
  return [...out].sort();
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export default {
  id: ID,
  version: VERSION,
  kind: 'delivery',
  capabilities: {
    files: ['**/package.js', '**/.meteor/release', '**/*.json', '**/*.{yml,yaml,toml}', '**/Makefile', '**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile', '**/Procfile', '**/Justfile', '**/justfile', '**/Taskfile.{yml,yaml}'],
    executes: [],
    network: false,
  },

  extract(file, text) {
    if (LOCKFILES.test(file.path) || text.length > MAX_BYTES) return [];
    // A Meteor app: `private/` holds server assets and `public/` static files, not modules.
    if (/(^|\/)\.meteor\/release$/.test(file.path)) return [nodeFact('file', file.path, { path: file.path, attrs: { meteor_app: dirOf(dirOf(file.path)) } }, P(file.path))];
    const isPackageJs = /(^|\/)package\.js$/.test(file.path);
    // A Meteor package manifest (api.mainModule, api.addFiles) is the package's entry point;
    // any other package.js is ordinary code and not ours.
    if (isPackageJs && !/\bPackage\.(describe|onUse)\s*\(/.test(text)) return [];
    const list = mentions(text);
    // package.json `meteor.mainModule` switches a Meteor app from eager loading (every file
    // outside imports/ runs) to explicit entry modules.
    let meteor = null;
    if (/(^|\/)package\.json$/.test(file.path)) {
      try {
        const m = JSON.parse(text)?.meteor;
        if (m && typeof m === 'object') meteor = { meteor_main_module: Boolean(m.mainModule) };
      } catch {
        // Not JSON we can read: mentions still count.
      }
    }
    if (!list.length && !isPackageJs && !meteor) return [];
    return [nodeFact('file', file.path, { path: file.path, attrs: { mentions: list, ...(isPackageJs && { manifest: 'meteor-package' }), ...meteor } }, P(file.path))];
  },

  link(ctx) {
    const out = [];
    for (const path of [...ctx.factsByFile.keys()].sort()) {
      for (const f of ctx.factsByFile.get(path)) {
        if (f.kind !== 'node' || f.type !== 'file' || !Array.isArray(f.attrs?.mentions) || f.provenance?.extractor !== EXTRACTOR) continue;
        const dir = dirOf(path);
        for (const m of f.attrs.mentions) {
          const rel = m.replace(/^\.\//, '');
          const target = [dir ? `${dir}/${rel}` : rel, rel].find((c) => ctx.files.has(c));
          if (target && target !== path) out.push(edgeFact('REFERENCES', `file:${path}`, `module:${target}`, { via: 'config path' }, P(path)));
        }
      }
    }
    return out;
  },
};
