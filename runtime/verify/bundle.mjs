// Proof bundles (spec §19.4): everything a reviewer needs to accept or reject one slice,
// with a manifest of digests so the bundle can be checked later. Only applicable
// artifacts are written.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJSON, sha256 } from '../core/canonical.mjs';
import { nowISO } from '../core/clock.mjs';
import { redact } from '../core/redact.mjs';
import { assertArtifact } from '../core/schema.mjs';
import { stringifyYAML } from '../core/yaml.mjs';
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
  revert: (s) => `Revert. Until merged: abandon the slice (\`unknot apply ${s.id} abandon\`), which deletes worktree and branch ${s.branch}. After merge: \`unknot rollback ${s.id}\` creates a revert commit on a new branch for review (rollback-stage approval required). Nothing is pushed.`,
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
