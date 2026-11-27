// Compares two accuracy.json reports (scripts/accuracy.mjs): the change in precision, factual
// accuracy and seeded recall, overall and per detector, and the release gate on those changes.
// Pure functions; scripts/accuracy-compare.mjs is the command line around them.

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

// Release gate (#247; docs/release.md). A detector whose precision or seeded recall fell by more
// than maxDropPoints fails the release unless corpus/accuracy-explained.json explains it for this
// release; a precision drop counts only on at least minLabelled labelled findings in both reports,
// a recall drop on at least minSeeded seeded defects. The owner tunes these values.
export const GATE = { maxDropPoints: 10, minLabelled: 10, minSeeded: 1 };

const corpusKey = (r) => JSON.stringify([r.seed, r.sample, Boolean(r.quick), (r.repositories ?? []).map((e) => `${e.name}@${e.sha}`).sort()]);

/** Explanations as committed: [{ detector, release, reason }]; anything else is an error, not a pass. */
export function checkExplanations(list) {
  if (!Array.isArray(list)) throw new Error('the explanations file must hold a JSON array');
  for (const [i, e] of list.entries()) {
    for (const k of ['detector', 'release', 'reason']) {
      if (typeof e?.[k] !== 'string' || !e[k].trim()) throw new Error(`explanation ${i + 1} has no ${k}`);
    }
  }
  return list;
}

/** Judges each detector's drop. previous may be null. Returns { ok, note, checks }. */
export function gateReports(previous, current, explanations = [], limits = GATE) {
  if (!previous) return { ok: true, note: 'No previous release report to compare with; nothing to judge.', checks: [] };
  if (corpusKey(previous) !== corpusKey(current)) {
    return { ok: true, note: 'The two reports were measured on a different corpus, seed or sample size; the gate does not judge them.', checks: [] };
  }
  const release = String(current.unknot ?? '').replace(/^v/, '');
  const checks = [];
  const judge = (metric, prevMap, curMap, value, count, min) => {
    for (const detector of Object.keys(curMap ?? {}).sort()) {
      const p = prevMap?.[detector];
      const c = curMap[detector];
      const before = p ? value(p) : null;
      const after = value(c);
      if (before === null || after === null) continue;
      const drop = Math.round((before - after) * 100);
      if (drop <= limits.maxDropPoints) continue;
      const small = Math.min(count(p), count(c)) < min;
      const explanation = explanations.find((e) => e.detector === detector && e.release.replace(/^v/, '') === release)?.reason ?? null;
      checks.push({ metric, detector, before, after, beforeN: count(p), afterN: count(c), drop, small, explanation, fails: !small && !explanation });
    }
  };
  judge('precision', previous.precision?.by_detector, current.precision?.by_detector, (v) => v.precision ?? null, (v) => v.labelled ?? 0, limits.minLabelled);
  judge('seeded recall', previous.recall?.by_detector, current.recall?.by_detector, (v) => (v.total ? v.found / v.total : null), (v) => v.total ?? 0, limits.minSeeded);
  return { ok: !checks.some((c) => c.fails), note: null, checks };
}

export function renderGate(g, limits = GATE) {
  const L = ['## Release gate', '', `A drop of more than ${limits.maxDropPoints} points fails, on at least ${limits.minLabelled} labelled findings (precision) or ${limits.minSeeded} seeded defect${limits.minSeeded === 1 ? '' : 's'} (recall) in both reports, unless \`corpus/accuracy-explained.json\` explains it for this release.`, ''];
  if (g.note) L.push(g.note);
  else if (!g.checks.length) L.push('No detector dropped by more than the threshold.');
  for (const c of g.checks) {
    const unit = c.metric === 'precision' ? 'labelled' : 'seeded';
    const what = `${c.detector} ${c.metric} fell from ${pct(c.before)} (${c.beforeN} ${unit}) to ${pct(c.after)} (${c.afterN} ${unit}), ${c.drop} points`;
    if (c.fails) L.push(`- FAIL: ${what}, and no explanation for this release.`);
    else if (c.explanation) L.push(`- explained: ${what}: ${c.explanation}`);
    else L.push(`- too small to judge: ${what}.`);
  }
  L.push('', g.ok ? 'Gate: pass.' : 'Gate: FAIL.');
  return `${L.join('\n')}\n`;
}
