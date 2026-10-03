// /unknot:infrastructure [scope] — read-only: IaC, plans, drift, IAM, network and
// reliability analysis (spec §15). Never runs apply or destroy; drift is a finding.

import { runDomainReport, kv } from '../../artifacts/domain-report.mjs';
import { infrastructureInventory } from '../../artifacts/reports.mjs';
import { table } from '../util.mjs';

function render(inv) {
  const out = [];
  out.push(`Declared resources: ${inv.resources.declared}`, kv(inv.resources.by_type));
  out.push('', 'Infrastructure nodes by kind:', kv(inv.resources.by_kind));
  out.push('', `State backends: ${inv.state_backends.length}`);
  for (const b of inv.state_backends) out.push(`  ${b.name}${b.recorded ? ` (recorded, serial ${b.serial ?? '?'}, ${b.resource_count ?? '?'} resources)` : ` (${b.type ?? 'declared'}${b.bucket ? `, bucket ${b.bucket}` : ''})`}`);
  out.push('', `Plans imported: ${inv.plans.imported}`, 'Plan actions:', kv(inv.plans.actions));
  for (const p of inv.plans.summaries.slice(0, 5)) out.push(`  ${p.source ?? p.id}: ${typeof p.summary === 'object' ? JSON.stringify(p.summary) : p.summary}`);
  out.push('', `Drift items: ${inv.drift.total}`, kv(inv.drift.by_kind));
  for (const d of inv.drift.items.slice(0, 10)) out.push(`  ${d.kind}: ${d.address}`);
  out.push('', `Public exposure: ${inv.public_exposure.length}`);
  for (const e of inv.public_exposure.slice(0, 15)) out.push(`  ${e.type} ${e.name}: ${e.why}${e.path ? ` (${e.path})` : ''}`);
  out.push('', `IAM wildcards and privileged roles: ${inv.iam_wildcards.length}`);
  for (const i of inv.iam_wildcards.slice(0, 15)) out.push(`  ${i.type} ${i.name}: ${i.reasons.join('; ')}`);
  out.push('', 'State hierarchy (spec 15.4):', table(inv.state_hierarchy.map((l) => ({ layer: l.layer, present: l.present ? 'present' : 'absent', evidence: l.evidence, meaning: l.description })), ['layer', 'present', 'evidence', 'meaning']));
  if (inv.absent_layers.length) out.push(`Absent layers (${inv.absent_layers.join(', ')}) limit what can be concluded; drift against an absent layer is unknown, not zero.`);
  return out.join('\n');
}

export async function run(args) {
  return runDomainReport({
    command: 'infrastructure',
    domain: 'infrastructure',
    args,
    build: ({ graph, config }) => infrastructureInventory(graph, { config }),
    render,
  });
}
