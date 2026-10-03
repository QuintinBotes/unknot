// /unknot:security [scope | slice-id] — threat model and, for a slice, its security delta
// (spec §16). Read-only. Secret findings are reported as kind and location only, never the
// value, and the output is redacted again on the way out.

import { UnknotError } from '../../core/errors.mjs';
import { runDomainReport } from '../../artifacts/domain-report.mjs';
import { securityInventory, sliceSecurityDelta } from '../../artifacts/reports.mjs';
import { table } from '../util.mjs';

const SLICE_ID = /^UK(-[A-Z]+)?-\d+$/;

function render(inv) {
  const out = [];
  out.push('Threat checklist (spec 16.1):');
  out.push(table(inv.threats.map((t) => ({ threat: t.threat, evidence: t.evidenced ? 'yes' : 'none in graph', detail: t.evidence[0]?.summary ?? t.note ?? '' })), ['threat', 'evidence', 'detail']));
  out.push('', `Secret findings: ${inv.secret_findings.length} (kinds and locations only); secret references: ${inv.secret_references}`);
  for (const s of inv.secret_findings.slice(0, 20)) out.push(`  ${s.kind} at ${s.location}`);
  out.push('', `Privilege paths (service account -> role -> permissions): ${inv.privilege_paths.length}`);
  for (const p of inv.privilege_paths.slice(0, 15)) {
    out.push(`  ${p.service_account}${p.namespace ? `@${p.namespace}` : ''} -> ${p.role ?? '(no role)'} -> ${p.permissions.join(', ') || '(no permissions recorded)'}${p.risky.length ? `  [${p.risky.join('; ')}]` : ''}`);
  }
  const tb = inv.trust_boundaries;
  out.push('', `Trust boundaries: ${tb.public_entries.length} public entry point(s), ${tb.network_policies} network polic${tb.network_policies === 1 ? 'y' : 'ies'}, ${tb.namespaces} namespace(s)`);
  for (const e of tb.public_entries.slice(0, 15)) out.push(`  ${e.type} ${e.name}: ${e.why}`);
  if (tb.workloads_without_policy?.length) out.push(`  workloads with no network policy: ${tb.workloads_without_policy.slice(0, 10).join(', ')}`);
  return out.join('\n');
}

function renderDelta(d) {
  const out = ['', `Security delta of ${d.slice} (${d.state}, risk ${d.risk}): ${d.objective}`];
  out.push(`Changed paths touching security-relevant code: ${d.changed_paths.length} of ${d.changed_paths.length + d.unchanged_paths}`);
  for (const p of d.changed_paths) out.push(`  ${p.path}: ${p.reasons.join('; ')}`);
  out.push(`Security obligations: ${d.obligations.length} (${d.unsatisfied.length} not yet passed)`);
  out.push(d.obligations.length ? table(d.obligations.map((o) => ({ id: o.id, kind: o.kind, status: o.status, human: o.human ? 'yes' : 'no', description: o.description })), ['id', 'kind', 'status', 'human', 'description']) : '  (none)');
  return out.join('\n');
}

export async function run(args) {
  const first = args.positional[0];
  const sliceId = first && SLICE_ID.test(first) ? first : null;
  // A slice id is not a path scope: the report covers the whole graph and the delta covers the slice.
  const effective = sliceId ? { ...args, positional: args.positional.slice(1) } : args;
  return runDomainReport({
    command: 'security',
    domain: 'security',
    args: effective,
    build: ({ graph, ctx }) => {
      const stale = ctx.store.get('SELECT COUNT(*) AS n FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?', new Date().toISOString())?.n ?? 0;
      const inventory = securityInventory(graph, { staleFacts: stale });
      if (sliceId) {
        const delta = sliceSecurityDelta(ctx, graph, sliceId);
        if (!delta) throw new UnknotError('UK_NOT_FOUND', `no slice ${sliceId}`);
        inventory.slice_delta = delta;
      }
      return inventory;
    },
    render: (inv) => `${render(inv)}${inv.slice_delta ? renderDelta(inv.slice_delta) : ''}`,
  });
}
