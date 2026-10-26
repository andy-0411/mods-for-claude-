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
    expect((await ui.find({ type: 'Text', text: /^sonnet-implementer$/ }))?.text).toBe('sonnet-implementer')
    expect((await ui.find({ type: 'Text', text: /^sonnet-5-5$/ }))?.text).toBe('sonnet-5-5')
    expect((await ui.find({ type: 'Text', text: /^corriendo$/ }))?.text).toBe('corriendo')
    expect((await ui.find({ type: 'Text', text: /^Tokens$/ }))?.text).toBe('Tokens')
    expect((await ui.find({ type: 'Text', text: /Buscar config/ }))?.text).toBe('Buscar config')
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
    expect((await ui.find({ type: 'Text', text: /tok · 2 req$/ }))?.text).toBe('sonnet-5-5 · 0s · 5.0k tok · 2 req')
    expect((await ui.find({ type: 'Text', text: /caché/ }))?.text).toBe('0s · 5.0k tok (+60k caché)')
    await ui.unmount()
  }
})
