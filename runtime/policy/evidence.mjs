// What a slice's evidence rests on (#146). At planning, a slice records the gaps of its source
// findings and of the map's coverage of its scope, and how strong its supporting evidence is
// (risk reads that). At apply, a non-test slice whose scope was mostly read lexically is refused
// until semantic evidence exists or a person opts the campaign in through the accepted config.

import { UnknotError } from '../core/errors.mjs';
import { matcher } from '../core/glob.mjs';
import { analysisGapLines, readAnalysisCoverage } from '../diagnose/analysis-coverage.mjs';
import { isTestFile, languageOf } from '../graph/census.mjs';

const WEAK_LABELS = new Set(['inferred', 'unknown', 'contradicted']);
const CONFIDENCE = ['low', 'medium', 'high'];

/** Module nodes inside a slice scope, with their parse quality. */
function scopeModules(ctx, scope = {}) {
  const inc = matcher(scope.include ?? []);
  const exc = matcher(scope.exclude ?? []);
  return ctx.store.all("SELECT path, json_extract(attrs, '$.parse_quality') AS quality FROM nodes WHERE type = 'module' AND path IS NOT NULL")
    .filter((m) => inc(m.path) && !exc(m.path));
}

function lexicalShare(modules) {
  const lexical = modules.filter((m) => m.quality === 'lexical');
  const languages = [...new Set(lexical.map((m) => languageOf(m.path)).filter(Boolean))].sort();
  return { lexical: lexical.length, modules: modules.length, languages };
}

/**
 * Gaps and evidence strength for a slice being planned.
 * @returns {{gaps: string[], strength: {confidence?: string, inferred: number, evidence: number}}}
 */
export function sliceEvidence(ctx, body) {
  const gaps = [];
  const confidences = [];
  let inferred = 0;
  let evidence = 0;
  for (const src of body.sources ?? []) {
    const row = /^F-/.test(src) ? ctx.store.get('SELECT body FROM findings WHERE id = ?', src) : null;
    if (!row) continue;
    const f = JSON.parse(row.body);
    for (const u of f.uncertainties ?? []) gaps.push(`${src}: ${u}`);
    const all = f.evidence ?? [];
    const weak = all.filter((e) => WEAK_LABELS.has(e.label));
    if (weak.length) gaps.push(`${src}: ${weak.length} of ${all.length} evidence entries are ${[...new Set(weak.map((e) => e.label))].join('/')}, not observed (${weak.slice(0, 3).map((e) => e.ref).join(', ')}${weak.length > 3 ? ', ...' : ''})`);
    if (!f.confidence) gaps.push(`${src}: no confidence recorded`);
    inferred += weak.length;
    evidence += all.length;
    if (f.confidence) confidences.push(f.confidence);
  }
  const modules = scopeModules(ctx, body.scope);
  const lex = lexicalShare(modules);
  if (lex.lexical) gaps.push(`${lex.lexical} of ${lex.modules} modules in scope were read lexically (${lex.languages.join(', ') || 'unknown language'}): imports and calls are matched by name, not resolved`);
  const languages = new Set(modules.map((m) => languageOf(m.path)));
  const holes = readAnalysisCoverage(ctx.store.meta('mapped_analysis_coverage')).filter((c) => languages.has(c.language));
  gaps.push(...analysisGapLines(holes).map((l) => `analysis coverage: ${l.trim()}`));
  const lowest = confidences.sort((a, b) => CONFIDENCE.indexOf(a) - CONFIDENCE.indexOf(b))[0];
  return { gaps, strength: { ...(lowest && { confidence: lowest }), inferred, evidence } };
}

/** Why the evidence of a slice raises its risk (empty when it does not). */
export function weakEvidenceReasons(strength) {
  if (!strength) return [];
  const why = [];
  if (strength.confidence === 'low') why.push('source finding confidence is low');
  if (strength.evidence && strength.inferred * 2 > strength.evidence) why.push(`${strength.inferred} of ${strength.evidence} supporting evidence entries are inferred, not observed`);
  return why;
}

/** Whether the accepted config lets this slice's campaign be applied on weak evidence. */
const allowedWeak = (config, campaignId) => {
  const a = config.evidence?.allow_weak;
  return a === true || (Array.isArray(a) && campaignId != null && a.includes(campaignId));
};

/** Module paths in the graph, for judging what a scope glob reaches (empty without a store). */
export const modulePaths = (ctx) => (ctx?.store ? ctx.store.all("SELECT path FROM nodes WHERE type = 'module' AND path IS NOT NULL").map((r) => r.path) : []);

/**
 * The lexical share of a non-test slice's scope that makes apply refuse it, or null when its
 * evidence is enough or the accepted config allows weak evidence for its campaign.
 */
export function weakEvidence(ctx, slice, config) {
  if (allowedWeak(config, slice.campaign_id)) return null;
  const modules = scopeModules(ctx, slice.body.scope);
  // A slice that only reaches test code changes no behaviour. Judged by the modules the scope
  // matches, not by the glob text, which brace alternatives can dress up as a test path.
  if (modules.every((m) => isTestFile(m.path))) return null;
  const lex = lexicalShare(modules);
  return lex.lexical && lex.lexical * 2 > lex.modules ? lex : null;
}

/** One line for lane eligibility: why apply would refuse the slice on evidence, or ''. */
export function weakEvidenceLine(ctx, slice, config) {
  const lex = ctx ? weakEvidence(ctx, slice, config) : null;
  return lex ? `weak evidence: ${lex.lexical} of ${lex.modules} modules in scope were read lexically (${lex.languages.join(', ') || 'unknown language'}); evidence.allow_weak does not list ${slice.campaign_id ?? 'its campaign'}` : '';
}

/** Refuse to apply a non-test slice whose scope rests mostly on lexical reads. */
export function assertEvidence(ctx, slice, config) {
  const lex = weakEvidence(ctx, slice, config);
  if (!lex) return;
  const langs = lex.languages.join(', ') || 'its language';
  const ways = [
    `add semantic evidence: a SCIP index for ${langs} (adapters.scip in .unknot/config.yaml), then run unknot map again`,
    `or a person sets evidence.allow_weak: [${slice.campaign_id ?? '<campaign>'}] in .unknot/config.yaml and runs unknot config accept in a terminal`,
  ];
  throw new UnknotError('UK_INSUFFICIENT_EVIDENCE', `slice ${slice.id} rests on weak evidence: ${lex.lexical} of ${lex.modules} modules in its scope were read lexically (${langs}), so their imports and calls are matched by name, not resolved. To lift this, ${ways.join('; ')}`, {
    slice_id: slice.id,
    details: { policy: 'evidence.allow_weak', lexical: lex.lexical, modules: lex.modules, languages: lex.languages, ways_forward: ways },
  });
}

/** The refusal `assertEvidence` would throw for this slice, or null when apply would accept its evidence. */
export function evidenceRefusal(ctx, slice, config) {
  try {
    assertEvidence(ctx, slice, config);
    return null;
  } catch (e) {
    if (e.code === 'UK_INSUFFICIENT_EVIDENCE') return e;
    throw e;
  }
}
