// `claude plugin test hooks` — the mod's tests: the panel (#165) and the edit guard (#166).
// Each `on` hook here stands for the engine beneath the mod; `process.run` stands for the CLI.

import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'
const PANE = {
  plugin: 'unknot',
  component: 'Pane',
  requestId: 'unknot-panel',
  props: { title: 'Unknot', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const STATUS = {
  mode: 'assist',
  active_run: null,
  graph: { stale: false },
  campaigns: [{ id: 'CMP-1', status: 'active', objective: 'Tidy the ledger' }],
  slices: [
    { id: 'UK-1', campaign_id: 'CMP-1', state: 'AWAITING_APPROVAL', risk: 'low' },
    { id: 'UK-2', campaign_id: 'CMP-1', state: 'PATCHING', risk: 'low' },
  ],
  blockers: [],
  awaiting_approval: ['UK-1'],
  stale_evidence: { expired_runtime_facts: 0, slices: [] },
  for_you: { steps: [{ step: 'approve_slice', slice: 'UK-1', commands: ['unknot approve UK-1 --role code-owner --as alice'] }] },
}

const PATCHING = {
  patching: [{ id: 'UK-2', scope: { include: ['src/a/**'], exclude: [] }, budget: { files_left: 4, lines_left: 120 } }],
  applies: true,
}

// A `cli` that throws stands for a command that did not run or timed out: $.process.run rejects.
type Run = (argv: readonly string[]) => { exitCode: number; stdout: string }

/** The engine beneath the mod: the CLI answered by `cli`, every argv it was asked recorded. */
function engine(on: any, cli: Run, { initialised = true, panes = ['unknot-panel'] } = {}) {
  const asked: string[][] = []
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    asked.push([...e.argv])
    const r = cli(e.argv)
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'session-a' }))
  on('fs.stat', (_: unknown, e: unknown) => {
    if (initialised) return { value: { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 } }
    throw new Error(`ENOENT ${JSON.stringify(e)}`)
  })
  on('ui.panes', () => ({ value: panes.map(id => ({ id, title: 'Unknot', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'unknot-panel' } }))
  on('tool.call', () => ({ result: {} }))
  return asked
}

const json = (v: unknown) => ({ exitCode: 0, stdout: JSON.stringify(v) })
const fail = (code: string, message: string) => ({ exitCode: 1, stdout: JSON.stringify({ error: { code, message } }) })
const rejects = (why: string): never => {
  throw new Error(why)
}
const isStatus = (argv: readonly string[]) => argv.includes('status')

// Every command the mod may run: read-only status and the read-only scope query.
const ONLY_READ = (argv: readonly string[]) =>
  argv[0] === 'node' && argv[1].endsWith('/bin/unknot') && argv.at(-1) === '--json' && (argv[2] === 'status' || (argv[2] === 'slice' && argv[3] === 'patching'))

test('an Edit outside the PATCHING slice scope is denied, naming the slice, its scope and the path', async ($, on) => {
  const asked = engine(on, argv => json({ ...PATCHING, held: [{ path: `${ROOT}/src/b/x.js`, slice: 'UK-2', rule: 'scope.slice', reason: 'src/b/x.js is outside slice UK-2 scope (include: src/a/**; exclude: —)' }] }))
  const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/b/x.js`, old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeDefined()
  expect(r.deny).toContain('slice UK-2 is PATCHING')
  expect(r.deny).toContain('include src/a/**')
  expect(r.deny).toContain(`${ROOT}/src/b/x.js`)
  expect(r.deny).toContain('Change budget left: 4 file(s), 120 diff line(s)')
  expect(asked[0].slice(2)).toEqual(['slice', 'patching', `${ROOT}/src/b/x.js`, '--session', 'session-a', '--json'])
})

test('an Edit inside the scope proceeds to what lies beneath, unchanged', async ($, on) => {
  const seen: unknown[] = []
  on('tool.call', { tool: 'Edit' }, (_: unknown, e: unknown) => (seen.push(e), { result: { ran: true } }))
  engine(on, () => json({ ...PATCHING, held: [] }))
  const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a/y.js`, old_string: 'a', new_string: 'b' })
  expect(r.deny).toBe(undefined)
  expect(r.result).toEqual({ ran: true })
  expect(seen[0]).toEqual(expect.objectContaining({ file_path: `${ROOT}/src/a/y.js`, old_string: 'a', new_string: 'b' }))
})

test('with no slice in PATCHING, or another session owning the run, the mod does nothing', async ($, on) => {
  let answer: unknown = { patching: [], applies: false, held: [] }
  engine(on, () => json(answer))
  expect((await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/b/x.js`, content: 'x' })).deny).toBe(undefined)
  answer = { ...PATCHING, applies: false, held: [] }
  expect((await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/b/x.js`, content: 'x' })).deny).toBe(undefined)
})

test('a check that fails or times out in an initialised repository denies (fail closed)', async ($, on) => {
  let mode = 'timeout'
  engine(on, () => (mode === 'timeout' ? rejects('timed out after 10000 ms') : mode === 'garbage' ? { exitCode: 0, stdout: 'not json' } : fail('UK_INTERNAL', 'store locked')))
  for (mode of ['timeout', 'garbage', 'error']) {
    const r = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a/y.js`, old_string: 'a', new_string: 'b' })
    expect(r.deny).toBeDefined()
    expect(r.deny).toContain('its scope check failed')
  }
})

test('outside an Unknot project the guard stays out of the way, failing or not', async ($, on) => {
  let notInit = true
  engine(on, () => (notInit ? fail('UK_NOT_INITIALIZED', 'no .unknot directory') : rejects('node not found')), { initialised: false })
  expect((await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/a.js', old_string: 'a', new_string: 'b' })).deny).toBe(undefined)
  notInit = false
  expect((await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/a.js', old_string: 'a', new_string: 'b' })).deny).toBe(undefined)
})

test('/unknot-panel lists the campaign, both slices and the approval with the command a person types', async ($, on) => {
  mock.clock(on)
  const asked = engine(on, () => json(STATUS))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'unknot-panel' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /CMP-1/ }))?.text).toBe('CMP-1 active: Tidy the ledger')
    expect((await ui.find({ type: 'Text', text: /UK-1  AWAITING_APPROVAL/ }))?.text).toBe('  UK-1  AWAITING_APPROVAL  low')
    expect((await ui.find({ type: 'Text', text: /UK-2  PATCHING/ }))?.text).toBe('  UK-2  PATCHING  low')
    expect((await ui.find({ type: 'Text', text: /unknot approve/ }))?.text).toBe('    unknot approve UK-1 --role code-owner --as alice')
    await ui.unmount()
  }
  expect(asked.every(ONLY_READ)).toBe(true)
})

test('the panel refreshes after an Unknot CLI command or MCP tool call while it is open', async ($, on) => {
  const clock = mock.clock(on)
  const asked = engine(on, () => json(STATUS))
  await $.tool.call({ tool: 'Bash', command: 'unknot status' })
  await clock.settle()
  expect(asked.filter(isStatus).length).toBe(1)
  await $.tool.call({ tool: 'mcp__plugin_unknot_unknot__status' } as any)
  await clock.settle()
  expect(asked.filter(isStatus).length).toBe(2)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(asked.filter(isStatus).length).toBe(2)
})

test('a closed panel runs nothing after Unknot calls', async ($, on) => {
  const clock = mock.clock(on)
  const asked = engine(on, () => json(STATUS), { panes: [] })
  await $.tool.call({ tool: 'Bash', command: 'unknot status' })
  await clock.settle()
  expect(asked.length).toBe(0)
})

test('without a .unknot directory the pane says so and suggests /unknot:init', async ($, on) => {
  engine(on, () => fail('UK_NOT_INITIALIZED', 'no .unknot directory'))
  await $.command.run({ command: 'unknot-panel' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /not initialised/ }))?.text).toBe('Unknot is not initialised in this repository.')
  expect((await ui.find({ type: 'Text', text: /unknot:init/ }))?.text).toContain('/unknot:init')
  await ui.unmount()
})

test('a failed refresh shows the error and the last good state, marked stale', async ($, on) => {
  let broken = false
  engine(on, () => (broken ? rejects('timed out after 20000 ms') : json(STATUS)))
  await $.command.run({ command: 'unknot-panel' })
  broken = true
  await $.command.run({ command: 'unknot-panel' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Refresh failed/ }))?.text).toContain('Refresh failed: ')
  expect((await ui.find({ type: 'Text', text: /STALE/ }))?.text).toContain('Mode assist')
  expect((await ui.find({ type: 'Text', text: /UK-2  PATCHING/ }))?.text).toBe('  UK-2  PATCHING  low')
  await ui.unmount()
})
