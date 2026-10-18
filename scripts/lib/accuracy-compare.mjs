// Compares two accuracy.json reports (scripts/accuracy.mjs): the change in precision, factual
// accuracy and seeded recall, overall and per detector. Pure functions; scripts/accuracy-compare.mjs
// is the command line around them.

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const recallRate = (v) => (v && v.total ? v.found / v.total : null);

function delta(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return null;
  return Math.round((after - before) * 100);
}

function row(name, before, after) {
  return { name, before, after, delta: delta(before, after) };
}

/** Rows for one metric over the union of names, sorted by name. */
function rows(prevMap, curMap, pick) {
  const names = [...new Set([...Object.keys(prevMap ?? {}), ...Object.keys(curMap ?? {})])].sort();
  return names.map((n) => row(n, pick(prevMap?.[n]), pick(curMap?.[n])));
}

const sumRecall = (m) => Object.values(m ?? {}).reduce((a, v) => ({ found: a.found + v.found, total: a.total + v.total }), { found: 0, total: 0 });

/** previous may be null (no earlier result). Returns { previous, current, overall, precision, factual, recall }. */
export function compareReports(previous, current) {
  const pPrec = previous?.precision;
  const cPrec = current.precision;
  const pRec = previous?.recall?.by_detector;
  const cRec = current.recall?.by_detector;
  return {
    previous: previous ? { unknot: previous.unknot, generated: previous.generated } : null,
    current: { unknot: current.unknot, generated: current.generated },
    overall: {
      precision: row('Overall precision', pPrec?.overall?.precision ?? null, cPrec?.overall?.precision ?? null),
      factual: row('Overall factual accuracy', pPrec?.overall?.factual ?? null, cPrec?.overall?.factual ?? null),
      recall: row('Seeded recall', previous ? recallRate(sumRecall(pRec)) : null, recallRate(sumRecall(cRec))),
    },
    precision: rows(pPrec?.by_detector, cPrec?.by_detector, (v) => v?.precision ?? null),
    factual: rows(pPrec?.by_detector, cPrec?.by_detector, (v) => v?.factual ?? null),
    recall: rows(pRec, cRec, recallRate),
  };
}

function fmtDelta(d) {
  if (d === null) return 'n/a';
  return d > 0 ? `+${d} points` : d < 0 ? `${d} points` : 'no change';
}

/** Markdown for the comparison; a null previous says so instead of failing. */
export function renderComparison(cmp) {
  if (!cmp.previous) return '## Change since the previous result\n\nNo previous result to compare with.\n';
  const L = ['## Change since the previous result', '', `Previous: version ${cmp.previous.unknot}, ${cmp.previous.generated}. This run: version ${cmp.current.unknot}, ${cmp.current.generated}.`, '', '| | Before | After | Change |', '|---|---:|---:|---:|'];
  for (const r of Object.values(cmp.overall)) L.push(`| ${r.name} | ${pct(r.before)} | ${pct(r.after)} | ${fmtDelta(r.delta)} |`);
  const table = (title, list) => {
    L.push('', `### ${title}`, '', '| Detector | Before | After | Change |', '|---|---:|---:|---:|');
    for (const r of list) L.push(`| ${r.name} | ${pct(r.before)} | ${pct(r.after)} | ${fmtDelta(r.delta)} |`);
  };
  table('Precision by detector', cmp.precision);
  table('Factual accuracy by detector', cmp.factual);
  if (cmp.recall.length) table('Seeded recall by detector', cmp.recall);
  return `${L.join('\n')}\n`;
}
