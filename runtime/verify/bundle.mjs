// Proof bundles (spec §19.4): everything a reviewer needs to accept or reject one slice,
// with a manifest of digests so the bundle can be checked later. Only applicable
// artifacts are written.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJSON, sha256 } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { redact } from '../core/redact.mjs';
import { assertArtifact } from '../core/schema.mjs';
import { parseYAML, stringifyYAML } from '../core/yaml.mjs';
import { stagePatch } from '../apply/worktree.mjs';
import { appendEvent } from '../state/ledger.mjs';
import { upgradeDecomposition } from '../state/upgrade.mjs';

const MEDIA = { json: 'application/json', yaml: 'application/yaml', md: 'text/markdown', patch: 'text/x-diff', jsonl: 'application/x-ndjson' };

function importsTable(graph, paths) {
  const rows = [];
  for (const p of paths) {
    const id = `module:${p}`;
    if (!graph?.node(id)) continue;
    const out = graph.out(id, 'IMPORTS').map((e) => e.to.replace(/^module:/, '')).sort();
    const inn = graph.in(id, 'IMPORTS').map((e) => e.from.replace(/^module:/, '')).sort();
    rows.push(`### ${p}\n- imports (${out.length}): ${out.slice(0, 25).join(', ') || '—'}\n- imported by (${inn.length}): ${inn.slice(0, 25).join(', ') || '—'}`);
  }
  return rows.join('\n\n') || '_No module-level structure for the changed files._';
}

const RECOVERY_TEXT = {
  revert: (s) => `Revert. Until merged: abandon the slice (\`unknot apply ${s.id} abandon\`), which deletes worktree and branch ${s.branch}. After merge: \`unknot rollback ${s.id}\` creates a revert commit on a new branch for review (rollback-stage approval required). If \`unknot pr\` opened a pull request for it, close the pull request and delete the remote branch ${s.branch}; Unknot pushes nothing else.`,
  roll_forward: (s) => `Roll forward. Reverting is not the safe path for this change; the corrective step is a new slice in the same campaign. Keep the expand state until the contract step's observation window passes. Trigger: any abort condition in the slice invariants.`,
  restore: () => 'Restore from a tested backup. A restore test must be on record before this slice is accepted.',
  fail_over: () => 'Fail over to prepared capacity, as declared in the slice.',
  recreate: () => 'Recreate the resource and restore its data, as declared in the slice.',
  compensate: () => 'Apply the explicit domain or infrastructure compensation declared in the slice.',
};

/**
 * @param {object} ctx
 * @param {{cfg, run, slice, all, pair, notes}} p `all` is the slice's obligations
 */
export async function emitProofBundle(ctx, { cfg, run, slice, all, pair = null, notes = [] }) {
  const dir = join(ctx.paths.runs, run.id);
  mkdirSync(dir, { recursive: true });
  const written = [];
  const put = (name, content) => {
    const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(join(dir, name), redact(text).text);
    written.push(name);
  };
  const sources = (slice.body.sources ?? []).map((s) => {
    if (s.startsWith('F-')) return JSON.parse(ctx.store.get('SELECT body FROM findings WHERE id = ?', s)?.body ?? 'null');
    if (s.startsWith('DEC-')) {
      try {
        return upgradeDecomposition(JSON.parse(readFileSync(join(ctx.paths.base, 'decompositions', `${s}.json`), 'utf8')));
      } catch {
        return { id: s, missing: true };
      }
    }
    return { id: s };
  });
  if (sources.length) put('finding.json', sources);
  put('slice.yaml', stringifyYAML({ ...slice.body, status: slice.state }));
  put('approvals.json', ctx.store.all('SELECT id, stage, role, approver, key_fingerprint, binding, signature, created_at, revoked_at, revoked_reason FROM approvals WHERE slice_id = ?', slice.id).map((a) => ({ ...a, binding: JSON.parse(a.binding) })));
  const { patch, files } = stagePatch(slice.worktree, slice.baseline_commit);
  put('diff.patch', patch);
  put('architecture-before.md', `# Architecture before ${slice.id}\n\nBaseline ${slice.baseline_commit}. Module neighbourhood of the changed files:\n\n${importsTable(pair?.before, files)}\n`);
  put('architecture-after.md', `# Architecture after ${slice.id}\n\nDiff ${slice.diff_hash}. Module neighbourhood of the changed files:\n\n${importsTable(pair?.after, files)}\n`);
  const sec = all.filter((o) => ['secrets-scan', 'security-scan'].includes(o.kind) || /security/i.test(o.body.description));
  put('security-delta.md', `# Security delta for ${slice.id}\n\nRisk: **${slice.risk}**.\n\n${sec.map((o) => `- ${o.id} ${o.kind}: ${o.status}`).join('\n') || '- no security obligations'}\n\nSecurity-relevant paths touched: ${files.filter((f) => /auth|crypto|secur|permission|rbac|iam|policy/i.test(f)).join(', ') || 'none'}.\n\nControls removed by this change: none may be; the scope and secrets checks above are the executed evidence.\n`);
  if (slice.body.kind === 'database') {
    put('database-migration-plan.yaml', stringifyYAML({
      version: 1,
      slice: slice.id,
      engine: cfg.config.database.engines?.[0]?.engine ?? 'unknown',
      objects: slice.body.scope.include,
      phases: ['expand', 'backfill', 'validate', 'switch_reads', 'switch_writes', 'contract'],
      rollback: { mode: slice.body.recovery.type, procedure: `.unknot/runs/${run.id}/recovery.md` },
      approvals: slice.body.approvals,
      note: 'Unknot never executes migrations against a live database; this plan is for the delivery system and the data owner.',
    }));
  }
  if (slice.body.kind === 'infrastructure' && slice.body.infra?.plan_path) {
    try {
      const { normalizePlan, planSummary } = await import('../../adapters/infrastructure/iac/plan.mjs');
      put('infrastructure-plan-summary.json', planSummary(normalizePlan(JSON.parse(readFileSync(join(ctx.root, slice.body.infra.plan_path), 'utf8')), slice.body.infra)));
    } catch (err) {
      put('infrastructure-plan-summary.json', { error: `plan could not be summarised: ${err.message}` });
    }
  }
  const evidence = ctx.store.all('SELECT record FROM evidence WHERE slice_id = ? ORDER BY at', slice.id).map((r) => JSON.parse(r.record));
  put('verification.json', { slice: slice.id, diff_hash: slice.diff_hash, obligations: all.map((o) => ({ id: o.id, kind: o.kind, status: o.status, evidence: o.evidence_id, human: Boolean(o.requires_human), description: o.body.description })) });
  put('command-log.jsonl', `${evidence.map(canonicalJSON).join('\n')}\n`);
  const uncertainties = [...notes, ...sources.flatMap((s) => s?.uncertainties ?? []), ...sources.flatMap((s) => s?.evidence_gaps ?? [])];
  put('uncertainties.md', `# Residual uncertainty for ${slice.id}\n\n${uncertainties.map((u) => `- ${u}`).join('\n') || '- none recorded beyond the evidence above'}\n\nPassing tests do not prove semantic equivalence (spec §2.2); they prove the obligations listed in verification.json.\n`);
  put('recovery.md', `# Recovery for ${slice.id}\n\n${(RECOVERY_TEXT[slice.body.recovery.type] ?? RECOVERY_TEXT.revert)(slice)}\n${slice.body.recovery.procedure ? `\nDeclared procedure: ${slice.body.recovery.procedure}\n` : ''}`);
  const manifest = {
    schema_version: '1.0',
    run_id: run.id,
    slice_id: slice.id,
    created_at: nowISO(),
    files: written.map((name) => {
      const buf = readFileSync(join(dir, name));
      return { path: name, digest: `sha256:${sha256(buf)}`, media_type: MEDIA[name.split('.').pop()] ?? 'application/octet-stream', size: statSync(join(dir, name)).size };
    }),
    applicable: written,
  };
  assertArtifact('proof-bundle-manifest', manifest);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  appendEvent(ctx, { type: 'artifact.stored', run_id: run.id, slice_id: slice.id, actor: 'runtime:verifier', payload: { bundle: `.unknot/runs/${run.id}`, files: written.length } });
  return `.unknot/runs/${run.id}`;
}

const QUOTE_MAX_LINES = 200;
const COLLAPSE_LINES = 15;

/** Repository text as data: a fenced block GitHub renders literally (no links, mentions or HTML). */
function quote(text) {
  const lines = String(text).trimEnd().split('\n');
  const shown = lines.length > QUOTE_MAX_LINES ? [...lines.slice(0, QUOTE_MAX_LINES), `… ${lines.length - QUOTE_MAX_LINES} more lines in the proof bundle`] : lines;
  const body = shown.join('\n');
  const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((r) => r.length + 1)));
  return `${fence}text\n${body}\n${fence}`;
}

/** One body section; a long one is collapsed. */
function section(title, text, empty = '_none recorded_') {
  const t = String(text ?? '').trim();
  if (!t) return `## ${title}\n\n${empty}`;
  const n = t.split('\n').length;
  return n > COLLAPSE_LINES ? `## ${title}\n\n<details><summary>${n} lines</summary>\n\n${quote(t)}\n\n</details>` : `## ${title}\n\n${quote(t)}`;
}

const NOT_RUN_WHY = (o) => (o.human && o.status === 'pending' ? 'waits for a person to attest it' : o.status === 'inconclusive' ? 'ran without a verdict' : `not run (${o.status})`);

/**
 * The pull request body for a slice (#151), rendered only from its stored proof bundle. `stale`
 * is the current diff hash when the slice was patched again after this bundle was made.
 */
export function renderPullRequestBody(dir, { stale = null } = {}) {
  const read = (name) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  // Bundle markdown starts with its own `# ...` heading; the section supplies one.
  const md = (name) => read(name)?.replace(/^# .*\n+/, '') ?? '';
  const manifest = JSON.parse(read('manifest.json'));
  const verification = JSON.parse(read('verification.json'));
  const sources = JSON.parse(read('finding.json') ?? '[]');
  const slice = parseYAML(read('slice.yaml') ?? '{}') ?? {};
  const why = sources.filter(Boolean).map((f) => [
    `${f.id}${f.kind ? ` (${f.kind})` : ''}: ${f.title ?? ''}`,
    ...(f.why_accidental ? [`why: ${f.why_accidental}`] : []),
    ...(f.evidence ?? []).map((e) => `- ${e.ref} [${e.label}] ${e.summary}`),
  ].join('\n')).join('\n\n');
  const list = (rows, why = () => '') => rows.map((o) => `${o.id} ${o.kind}: ${o.description}${why(o)}`).join('\n');
  // shortcut: `verifySlice` overwrites the bundle's verification.json with its run summary (#183),
  // which lists only this run's results; read that shape until the bundle keeps its own.
  const obligations = verification.obligations ?? [
    ...(verification.results ?? []).map((r) => ({ id: r.id, kind: r.kind, status: r.verdict, description: r.detail })),
    ...(verification.waiting_for_human ?? []).map((o) => ({ ...o, status: 'pending', human: true })),
  ];
  const body = [
    ...(stale ? [`> [!WARNING]\n> This slice was patched again after its verification (diff \`${stale}\`, verified \`${verification.diff_hash}\`). The results below are stale until \`unknot verify ${manifest.slice_id}\` runs again.`] : []),
    `Unknot slice \`${manifest.slice_id}\`, proof bundle \`.unknot/runs/${manifest.run_id}\`, verified diff \`${verification.diff_hash}\`. Text from the bundle is quoted as data.`,
    section('Objective', slice.objective),
    section('Why this change belongs', why, '_no finding recorded_'),
    // The slice's convention report (#155), nearest scope first; a slice planned before it has none.
    section('Conventions that apply', (slice.conventions ?? []).map((c) => `[${c.status}] ${c.rule} (${c.source?.file}${c.source?.line ? `:${c.source.line}` : ''}, scope ${c.scope})${c.verification ? `: ${c.verification}` : ''}`).join('\n'), '_no convention report recorded for this slice_'),
    section('Ran and passed', list(obligations.filter((o) => o.status === 'pass'))),
    section('Ran and failed', list(obligations.filter((o) => o.status === 'fail'))),
    section('Not run, and why', list(obligations.filter((o) => o.status !== 'pass' && o.status !== 'fail'), (o) => ` (${NOT_RUN_WHY(o)})`)),
    section('Evidence gaps and uncertainties', md('uncertainties.md')),
    section('Security delta', md('security-delta.md')),
    section('How to revert', md('recovery.md')),
    '_Opened as a draft by `unknot pr`. Unknot never merges, marks ready, approves or force-pushes._',
  ].join('\n\n');
  return `${redact(body).text}\n`;
}
