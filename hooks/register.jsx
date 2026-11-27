// Unknot's mod (Claude Code 2.1.287 and later; older versions ignore `modules` in hooks.json and
// keep only the settings hooks beside it).
//
// 1. A display-only campaign panel (#165), opened with /unknot-panel. It reads state only from
//    `unknot status --json` and never approves, attests, accepts config or signs a lane: it shows
//    the commands a person types in their own terminal, and runs none of them.
// 2. A guard that holds an Edit, Write or NotebookEdit outside the scope of a slice in PATCHING at
//    the call (#166), judged by `unknot slice patching`, the PDP's own scope rule. It only denies,
//    and fails closed. The PreToolUse hook in hooks.json stays the first line of defence.
//
// Plain JSX rather than TypeScript: `claude plugin validate` type-checks every .ts file under
// tests/ once the module is TypeScript, and tests/fixtures holds sample projects that never compile.
// The state the panel draws from is declared in types/index.d.ts.

import { atom, read, update } from 'claude-code'

const PANE = 'unknot-panel'
const panel = atom({ plugin: 'unknot', key: 'panel' }, { status: null, at: null, error: null, isUninitialised: false }, { shape: 'panel-1' })

// The only two commands the mod runs, both read-only. Nothing here may run approve, attest,
// config accept, lane approve or any other command that records a person's decision.
const STATUS = ['status']
const PATCHING = ['slice', 'patching']

const unknot = async ($, args, timeoutMs) =>
  $.process.run(['node', `${$.plugin.root}/bin/unknot`, ...args, '--json'], { cwd: await $.session.cwd(), timeoutMs })

async function refresh($) {
  try {
    const r = await unknot($, STATUS, 20_000)
    const out = JSON.parse(r.stdout)
    if (out.error?.code === 'UK_NOT_INITIALIZED') return update($, panel, () => ({ status: null, at: null, error: null, isUninitialised: true }))
    if (out.error || r.exitCode !== 0) throw new Error(out.error?.message ?? `exit ${r.exitCode}`)
    return update($, panel, () => ({ status: out, at: new Date().toISOString(), error: null, isUninitialised: false }))
  } catch (err) {
    // Keep the last good state; the pane marks it stale beside the error.
    return update($, panel, (p) => ({ ...p, error: String(err?.message ?? err).slice(0, 500) }))
  }
}

const isOpen = async ($) => (await $.ui.panes()).some((p) => p.id === PANE)
const refreshIfOpen = ($) => void isOpen($).then((open) => (open ? refresh($) : undefined))

const touchesUnknot = (e) => /^mcp__.*unknot/.test(String(e.tool)) || (e.tool === 'Bash' && /\bunknot\b/.test(String(e.command)))

/** Whether the session's directory holds Unknot state, so a failed check must hold the edit. */
async function isInitialised($) {
  try {
    await $.fs.stat(`${await $.session.cwd()}/.unknot`)
    return true
  } catch {
    return false
  }
}

function heldMessage(h, slices) {
  const s = slices.find((x) => x.id === h.slice)
  const scope = s ? `include ${s.scope.include.join(', ') || '—'}; exclude ${s.scope.exclude.join(', ') || '—'}` : 'unknown'
  const left = s?.budget?.files_left != null ? ` Change budget left: ${s.budget.files_left} file(s), ${s.budget.lines_left ?? '?'} diff line(s).` : ''
  return `Unknot held this edit: slice ${h.slice} is PATCHING with scope (${scope}), and ${h.path} is outside it: ${h.reason}.${left} Keep the change inside the slice scope, or stop and report; a person re-plans with \`unknot apply replan ${h.slice}\`.`
}

const failed = (why) => `Unknot held this edit: its scope check failed (${why}), so it cannot tell whether a slice in PATCHING allows it. Edits are held until \`unknot slice patching\` answers again; run /unknot:doctor.`

export const register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'unknot-panel', description: 'Show Unknot campaigns, slices and pending approvals in a pane (display only)', immediate: true })
    // A slow poll catches what changes outside this session, a person's approval above all.
    $.clock.every(30_000, () => refreshIfOpen($))
    return next(e)
  })

  on('command.run', { command: 'unknot-panel' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Unknot' })
    await refresh($)
    return { text: 'Unknot panel opened. It only shows state; approvals happen in your own terminal.' }
  })

  // Refresh after an Unknot tool call or CLI command, without holding up the call's result.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (touchesUnknot(e)) $.clock.after(0, () => refreshIfOpen($))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    let out
    try {
      const r = await unknot($, [...PATCHING, path, '--session', await $.session.id()], 10_000)
      out = JSON.parse(r.stdout)
      if (out.error?.code === 'UK_NOT_INITIALIZED') return next(e)
      if (out.error || r.exitCode !== 0) throw new Error(out.error?.message ?? `exit ${r.exitCode}`)
    } catch (err) {
      if (await isInitialised($)) return { deny: failed(String(err?.message ?? err).slice(0, 300)) }
      return next(e)
    }
    const held = out.held ?? []
    if (out.applies && held.length) return { deny: heldMessage(held[0], out.patching ?? []) }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: failed('the guard itself failed') }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, panel)
    if (p.isUninitialised) {
      return (
        <Box flexDirection="column">
          <Text>Unknot is not initialised in this repository.</Text>
          <Text dimColor>Run /unknot:init to propose a configuration.</Text>
        </Box>
      )
    }
    const rows = []
    if (p.error) rows.push(<Text color="warning">Refresh failed: {p.error}</Text>)
    const s = p.status
    if (!s) {
      rows.push(<Text dimColor>{p.error ? 'No state read yet.' : 'Reading unknot status...'}</Text>)
      return <Box flexDirection="column">{rows}</Box>
    }
    rows.push(<Text bold>{`Mode ${s.mode ?? '?'}${s.active_run ? ` · run ${s.active_run.id} (${s.active_run.command})` : ''}${p.error ? ' (STALE: last good state)' : ''}`}</Text>)
    const slices = s.slices ?? []
    const campaigns = s.campaigns ?? []
    const groups = campaigns.map((c) => [`${c.id} ${c.status}${c.objective ? `: ${c.objective}` : ''}`, slices.filter((x) => x.campaign_id === c.id)])
    const loose = slices.filter((x) => !campaigns.some((c) => c.id === x.campaign_id))
    if (loose.length) groups.push(['Slices outside a campaign', loose])
    if (!groups.length) rows.push(<Text dimColor>No campaigns yet.</Text>)
    for (const [title, list] of groups) {
      rows.push(<Text>{title}</Text>)
      for (const x of list) rows.push(<Text>{`  ${x.id}  ${x.state}${x.risk ? `  ${x.risk}` : ''}`}</Text>)
    }
    const blockers = s.blockers ?? []
    if (blockers.length) rows.push(<Text color="error">{`Blocked: ${blockers.map((b) => `${b.id} ${b.state}`).join(', ')}`}</Text>)
    const staleSlices = s.stale_evidence?.slices ?? []
    if (staleSlices.length) rows.push(<Text color="warning">{`Stale evidence: ${staleSlices.map((x) => x.slice_id).join(', ')} (re-plan or abandon)`}</Text>)
    if (s.stale_evidence?.expired_runtime_facts) rows.push(<Text color="warning">{`Stale evidence: ${s.stale_evidence.expired_runtime_facts} runtime fact(s) past their TTL`}</Text>)
    if (s.graph?.stale) rows.push(<Text color="warning">Graph is stale: HEAD moved since the last map</Text>)
    const steps = s.for_you?.steps ?? []
    if (steps.length) {
      rows.push(<Text bold>For you, in your own terminal:</Text>)
      for (const step of steps) {
        rows.push(<Text>{`  ${step.slice ? `${step.slice} ` : ''}${step.step.replace(/_/g, ' ')}${step.note ? ` (${step.note})` : ''}`}</Text>)
        for (const c of step.commands) rows.push(<Text color="suggestion">{`    ${c}`}</Text>)
      }
    }
    if (p.at) rows.push(<Text dimColor>{`Read ${p.at.slice(11, 19)} UTC from unknot status`}</Text>)
    return <Box flexDirection="column">{rows}</Box>
  })
}
