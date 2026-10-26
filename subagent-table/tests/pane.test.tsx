import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-table',
  component: 'Pane',
  requestId: 'subagent-table',
  props: {
    title: 'Sub-agentes',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// What the engine stamps on every spawn it raises.
const SPAWN = {
  tool_use_id: 'tu1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const

const USAGE = {
  model: 'claude-sonnet-5-5',
  input_tokens: 1200,
  output_tokens: 800,
  cache_read_input_tokens: 30000,
  cache_creation_input_tokens: 500,
}

test('a spawned subagent shows as a running row in a wide pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    ...SPAWN,
    prompt: 'Busca los archivos de config',
    description: 'Buscar config',
    subagentType: 'digitalizate-model-router:sonnet-implementer',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Unnamed, the task is the card's title and the line under it says what it does.
    expect((await ui.find({ type: 'Text', text: /Buscar config/ }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^sonnet-implementer · / }))?.text).toBe('sonnet-implementer · sonnet-5-5 · 0 tok · 0 req · 0 tools')
    expect((await ui.find({ type: 'Text', text: /^pensando$/ }))?.text).toBe('pensando')
    expect((await ui.find({ type: 'Text', text: /● trabajando/ }))?.text).toBe(' ● trabajando · pensando')
    await ui.unmount()
  }
})

test('a narrow pane draws cards with the tokens each request cost', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'Audita el tracking', description: 'Auditar tracking', subagentType: 'Explore' })
  for (const index of [0, 1]) {
    for await (const _ of $.turn.step({ turnId: 't1', index, model: 'claude-sonnet-5-5', messageCount: 3, agentId: 'a1' })) {
      // drain the stream
    }
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 40 } })
    // Two requests of 1200 + 500 fresh in and 800 out: 5000 tokens, 60k cached.
    expect((await ui.find({ type: 'Text', text: /tok · 2 req/ }))?.text).toBe('Explore · sonnet-5-5 · 5.0k tok · 2 req · 0 tools')
    expect((await ui.find({ type: 'Text', text: /caché/ }))?.text).toBe('0s · 5.0k tok (+60k caché)')
    await ui.unmount()
  }
})

// The border color of each card, in the order drawn.
const borders = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round').map(box => box.props.borderColor)

test('each card is colored by its status', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let id = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++id}` }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const [n, description] of [[1, 'Bien'], [2, 'Mal'], [3, 'Sigue']] as const) {
    await $.agent.spawn({ ...SPAWN, tool_use_id: `tu${n}`, prompt: description, description, subagentType: 'Explore' })
  }
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', answer: '', durationMs: 0, isAborted: false })
  await $.turn.complete({ turnId: 't2', agentId: 'a2', reason: 'error', answer: '', durationMs: 0, isAborted: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The running one first, then the latest to finish.
    expect(await borders(ui)).toEqual(['suggestion', 'error', 'success'])
    expect((await ui.find({ type: 'Text', text: /✔ listo/ }))?.text).toBe(' ✔ listo')
    expect((await ui.find({ type: 'Text', text: /✖ falló/ }))?.text).toBe(' ✖ falló')
    expect((await ui.find({ type: 'Text', text: /● trabajando/ }))?.text).toBe(' ● trabajando · pensando')
    await ui.unmount()
  }
})

test('a finished card has a full load bar', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'Listo', description: 'Listo', subagentType: 'Explore' })
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', answer: '', durationMs: 0, isAborted: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 40 } })
    // 40 columns less the border and the padding.
    expect((await ui.find({ type: 'Text', text: /^[━░]+$/ }))?.text).toBe('━'.repeat(36))
    await ui.unmount()
  }
})

test('a subagent waiting on a permission turns yellow, then works again', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => ({ result: {} }))

  const seen: { label?: string; borders: unknown[] }[] = []
  // Who answers the ask: while it is open, the card shows the wait.
  on('classic.PermissionRequest', async () => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      seen.push({ label: (await ui.find({ type: 'Text', text: /esperando permiso/ }))?.text, borders: await borders(ui) })
      await ui.unmount()
    }
    return { decision: { behavior: 'allow' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'Corre ls', description: 'Correr ls', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })

  expect(seen).toEqual([
    { label: ' ⏸ esperando permiso · Bash', borders: ['warning'] },
    { label: ' ⏸ esperando permiso · Bash', borders: ['warning'] },
  ])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /● trabajando/ }))?.text).toBe(' ● trabajando · Bash')
    expect(await borders(ui)).toEqual(['suggestion'])
    await ui.unmount()
  }
})

test('the permission verdict goes up untouched', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'ask', reason: 'Bash pide permiso' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).toEqual({ decision: 'ask', reason: 'Bash pide permiso' })
})

test('a named subagent shows its name as the title, the task under it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let id = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++id}` }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'Explora el repo', description: 'Explorar repo', name: 'scout', subagentType: 'Explore' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2', prompt: 'Lee el README', description: 'Leer README', subagentType: 'Explore' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^scout$/ }))?.props.bold).toBe(true)
    // Unnamed, its task is the title.
    expect((await ui.find({ type: 'Text', text: /^Leer README$/ }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Explorar repo/ }))?.text).toBe('pensando · Explorar repo')
    await ui.unmount()
  }
})

test('a tool that throws after the wait leaves the card working, the error going up', async ($, on) => {
  on('command.register', () => ({ value: { command: 'subagentes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.check', () => ({ decision: 'ask' }))
  let waited: string | undefined
  on('classic.PermissionRequest', async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    waited = (await ui.find({ type: 'Text', text: /esperando permiso/ }))?.text
    await ui.unmount()
    return { decision: { behavior: 'allow' } }
  })
  on('tool.call', () => {
    throw new Error('x')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'Corre ls', description: 'Correr ls', subagentType: 'Explore' })
  // The engine skips the throwing hook: nothing is left to run the tool, and the call rejects.
  const failure = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' }).then(
    () => undefined,
    (error: unknown) => String(error),
  )
  expect(waited).toBe(' ⏸ esperando permiso · Bash')
  expect(failure).toMatch(/tool\.call/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /● trabajando/ }))?.text).toBe(' ● trabajando · Bash')
    await ui.unmount()
  }
})
