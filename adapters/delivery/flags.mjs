// Feature-flag definitions from LaunchDarkly exports, Unleash exports and plain flag files.
// Only definitions are read; flag values that look like credentials are never recorded
// because attrs hold just the default, archive state and a last-modified marker.

import { parseYAML } from '../../runtime/core/yaml.mjs';
import { nodeFact } from '../../runtime/graph/facts.mjs';
import { P, clean, isObj, asArray, capFacts } from './util.mjs';

const scalar = (v) => (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' ? v : undefined);

function defaultOf(f) {
  if (!isObj(f)) return scalar(f);
  for (const k of ['default', 'defaultValue', 'enabled', 'on', 'value']) if (scalar(f[k]) !== undefined) return f[k];
  if (isObj(f.defaults) && scalar(f.defaults.onVariation) !== undefined) return f.defaults.onVariation;
  if (isObj(f.environments)) {
    // LaunchDarkly: report the first environment's on/off so the flag has some default.
    const first = Object.keys(f.environments).sort()[0];
    if (first !== undefined && scalar(f.environments[first]?.on) !== undefined) return f.environments[first].on;
  }
  return undefined;
}

const modified = (f) => (isObj(f) ? scalar(f._lastModified ?? f.lastModified ?? f.last_modified ?? f.lastSeenAt ?? f.createdAt ?? f.creationDate) : undefined);

/** Normalise the three shapes into [{key, source, flag}]. */
function entries(doc) {
  if (!isObj(doc)) return [];
  if (Array.isArray(doc.features)) return doc.features.filter(isObj).map((f) => ({ key: f.name, source: 'unleash', flag: f }));
  if (Array.isArray(doc.items)) return doc.items.filter(isObj).map((f) => ({ key: f.key, source: 'launchdarkly', flag: f }));
  if (Array.isArray(doc.flags)) return doc.flags.filter(isObj).map((f) => ({ key: f.key ?? f.name, source: 'generic', flag: f }));
  const map = isObj(doc.flags) ? doc.flags : isObj(doc.featureFlags) ? doc.featureFlags : doc;
  // A bare {key: value} file only counts when every value is a flag-like scalar or object.
  return Object.entries(map).map(([key, flag]) => ({ key, source: 'generic', flag }))
    .filter((e) => scalar(e.flag) !== undefined || isObj(e.flag));
}

export function parseFlags(path, text) {
  const doc = path.endsWith('.json') ? JSON.parse(text) : parseYAML(text, { filename: path });
  const facts = [];
  const seen = new Set();
  for (const { key, source, flag } of entries(doc)) {
    if (typeof key !== 'string' || !key || seen.has(key)) continue;
    seen.add(key);
    facts.push(nodeFact('feature_flag', key, {
      name: key,
      path,
      attrs: clean({
        source,
        default: defaultOf(flag),
        archived: isObj(flag) && typeof flag.archived === 'boolean' ? flag.archived : false,
        last_modified: modified(flag),
        tags: isObj(flag) ? asArray(flag.tags).filter((t) => typeof t === 'string').sort() : undefined,
        temporary: isObj(flag) && typeof flag.temporary === 'boolean' ? flag.temporary : undefined,
      }),
    }, P(path, 1, source === 'generic' ? 'medium' : 'high')));
  }
  return capFacts(facts);
}
