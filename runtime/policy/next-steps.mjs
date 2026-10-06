// What to do instead, per policy rule, so every refusal ends with a way forward (roadmap
// item 5). Keys are the policy ids the PDP returns; the first rule of a decision that has an
// entry here supplies the step.

export const NEXT_STEPS = Object.freeze({
  'state.protected': 'change Unknot state only through the unknot CLI (configuration: a person runs unknot config accept); reading it with cat, Read or unknot status is fine',
  'keys.protected': 'key material is handled only by a person, with unknot keys in their own terminal',
  'approval.human_only': "give the person the block headed 'For you, in your own terminal:' from unknot status (or the status tool) to copy into a separate terminal window",
  'secrets.read': 'refer to the value as [REDACTED]; ask the person if the task needs a credential',
  'secrets.write': 'do not write credential files; ask the person',
  'scope.read_outside': 'during a run, read only inside the project; finish the Unknot command first',
  'scope.write_outside': 'write inside the project only',
  'write.git': 'leave git internals alone; the person commits, or Unknot does after approval',
  'write.no_path': 'name the file to write',
  'capability.read': 'this agent may not read files; report back to the agent that started it',
  'capability.write': 'this command does not change source: finish it, then apply an approved slice with /unknot:apply',
  'mode.write': 'a person sets mode: assist (or higher) in .unknot/config.yaml and accepts it',
  'slice.not_patching': 'start an approved slice with unknot apply <slice> and edit inside its worktree',
  'scope.worktree': 'edit the file inside the slice worktree that unknot apply printed',
  'scope.slice': 'stay within the slice scope, or run unknot apply <slice> replan --reason "..."',
  'scope.protected': 'a protected path needs a slice planned for it and approved at high risk',
  'scope.generated': 'change the generator or its input, not the generated file',
  'scope.excluded': 'the slice excludes this path; replan if it has to change',
  'network.domain': 'a person adds the domain to network.allowed_domains, or the work is done offline',
  'network.disabled': 'network access is off in this run (limits.max_network_requests is 0)',
  'mcp.server': 'during a run only the MCP servers in mcp.allowed_servers are available; finish the Unknot command first',
  'exec.shell': 'use a read-only command or the Read, Grep and Glob tools; checks and builds run through unknot verify or unknot exec',
  'exec.background': 'run the command in the foreground',
  'tool.unknown': 'this tool is not used during an Unknot run; finish the Unknot command first',
  'budget.delegation_depth': 'do the work in this agent instead of delegating further',
});

/** The step for a decision's rules, or null. */
export const nextStep = (policyIds = []) => policyIds.map((id) => NEXT_STEPS[id]).find(Boolean) ?? null;

/** `<reasons> [rule a, b]. Next: <step>` for a refusal message. */
export function explainDenial(d) {
  const ids = d.policy_ids ?? [];
  const next = nextStep(ids);
  return `${d.reasons.join('; ')}${ids.length ? ` [rule ${ids.join(', ')}]` : ''}${next ? `. Next: ${next}` : ''}`;
}
