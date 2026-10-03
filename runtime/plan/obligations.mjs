// Proof-obligation generation (spec §19.1, §19.2, §14.11). The runtime decides what must
// be proven for a slice from what it touches; a planner cannot remove an obligation, only
// add to it. Executed obligations name a configured command or a built-in runtime check;
// the rest require a human attestation and say so.

const ob = (kind, description, { command = null, builtin = null, requires_human = false } = {}) => ({ kind, description, command, builtin, requires_human });

/**
 * @param {object} slice slice body
 * @param {{config: object, risk: {risk: string, specialists: string[]}}} ctx
 * @returns {object[]} obligations without ids (the store assigns PO ids)
 */
export function generateObligations(slice, { config, risk }) {
  const c = config.commands ?? {};
  const out = [];
  const high = ['high', 'critical'].includes(risk.risk);
  out.push(ob('scope-check', 'Every changed path is inside the slice scope and outside protected, generated and vendored paths', { builtin: 'scope' }));
  out.push(ob('diff-budget', `Changed files and lines are within budget (${slice.budgets.max_changed_files} files, ${slice.budgets.max_diff_lines} lines)`, { builtin: 'diff-budget' }));
  out.push(ob('parse', 'Every changed source file still parses (re-mapped by the language adapters without extraction failures)', { builtin: 'parse' }));
  if (config.security.secrets_scan !== 'off') out.push(ob('secrets-scan', 'The diff introduces no credential-like values', { builtin: 'secrets' }));
  if (slice.kind !== 'documentation') {
    if (config.quality.forbid_new_cycles) out.push(ob('no-new-cycles', 'No dependency cycle exists after the change that did not exist before', { builtin: 'cycles' }));
    if (config.quality.public_api_compatibility === 'required') out.push(ob('api-compatibility', 'Exported symbols and endpoints of touched modules are unchanged or only added to', { builtin: 'api' }));
    out.push(ob('architecture-fitness', 'Complexity of touched functions does not increase beyond quality.max_complexity_increase', { builtin: 'complexity' }));
    if (c.lint) out.push(ob('lint', 'Project linter passes', { command: c.lint }));
    if (c.typecheck) out.push(ob('typecheck', 'Type check passes', { command: c.typecheck }));
    if (c.build) out.push(ob('parse', 'Project builds', { command: c.build }));
    if (c.test_unit) out.push(ob('unit', 'Unit tests pass on the changed worktree (and passed on the baseline)', { command: c.test_unit }));
    else out.push(ob('unit', 'No unit test command is configured: a human confirms behaviour is preserved', { requires_human: true }));
    if (c.test_integration && risk.risk !== 'low') out.push(ob('integration', 'Integration tests pass', { command: c.test_integration }));
    if (c.contract && ['T3', 'T5', 'T7', 'T9'].includes(slice.treatment)) out.push(ob('contract', 'Consumer contracts verify against the changed provider', { command: c.contract }));
    else if (['T3', 'T5', 'T7', 'T9'].includes(slice.treatment)) out.push(ob('contract', 'No contract test command is configured: a human confirms consumers are unaffected', { requires_human: true }));
  }
  if ((slice.sources ?? []).length && (slice.treatment === undefined || ['T1', 'T2', 'T4', 'T5', 'T8'].includes(slice.treatment))) {
    out.push(ob('characterization', 'Behaviour of the touched code is pinned by tests that pass before and after the change', { command: c.test_unit ?? null, requires_human: !c.test_unit }));
  }
  if (c.sast && (config.security.sast === 'required' || (config.security.sast === 'required_for_high_risk' && high))) {
    out.push(ob('security-scan', 'Static analysis reports no new issues', { command: c.sast }));
  } else if (config.security.sast === 'required' || (config.security.sast === 'required_for_high_risk' && high)) {
    out.push(ob('security-scan', 'SAST is required but no `sast` command is configured: a security owner reviews the delta', { requires_human: true }));
  }
  if (slice.kind === 'database') {
    out.push(ob('migration-rehearsal', 'The migration runs on an empty and a representative database; lock forecast matches observation', { command: c.migration_rehearsal ?? null, requires_human: !c.migration_rehearsal }));
    out.push(ob('reconciliation', 'Counts, checksums and domain invariants reconcile between old and new representations', { requires_human: true }));
    out.push(ob('rollback-rehearsal', 'The recovery path (revert, roll forward or restore) was exercised on a non-production copy', { requires_human: true }));
    if (high) out.push(ob('human-review', 'Data owner confirms a tested restore exists for the affected data (spec §14.11)', { requires_human: true }));
  }
  if (slice.kind === 'infrastructure') {
    out.push(ob('infra-plan', 'The saved plan contains no unapproved delete or replacement and matches the approved plan hash and state serial', { builtin: 'infra-plan' }));
    if (c.iac_validate) out.push(ob('lint', 'IaC validation passes', { command: c.iac_validate }));
    if (high) out.push(ob('human-review', 'Platform owner reviews blast radius, privilege and recovery deltas (spec §15.9)', { requires_human: true }));
  }
  if (['T3', 'T6', 'T7'].includes(slice.treatment)) {
    out.push(ob('rollback-rehearsal', 'Flipping the route/flag back was rehearsed outside production', { requires_human: true }));
    out.push(ob('performance', 'Latency and error budgets are unchanged within the agreed window', { command: c.performance ?? null, requires_human: !c.performance }));
  }
  if (risk.specialists.includes('security-owner')) out.push(ob('human-review', 'Security owner reviews the authorization and secrets delta', { requires_human: true }));
  if (slice.irreversible) out.push(ob('human-review', 'Irreversible step: two people confirm the restore plan and the observation window has passed', { requires_human: true }));
  // De-duplicate identical kinds with identical commands.
  const seen = new Set();
  return out.filter((o) => {
    const k = `${o.kind}|${JSON.stringify(o.command)}|${o.builtin}|${o.description}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
