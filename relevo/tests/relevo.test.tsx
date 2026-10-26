import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'relevo',
  component: 'Pane',
  requestId: 'relevo',
  props: {
    title: 'Relevo',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

type Sent = { to: unknown; text: string }

// Nothing sits beneath the plugin: these hooks stand for the engine, the store
// a map in memory as the JSON file stands between two sessions.
function stubEngine(on: any, sent: Sent[] = []) {
  const store = new Map<string, unknown>()
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: { key: string }) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'relevo' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__relevo__entregar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sesion-a' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.send', (_: unknown, e: Sent) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })

  return store
}

test('the planner hands the plan to the builder session', async ($, on) => {
  const sent: Sent[] = []
  const store = stubEngine(on, sent)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const set = await $.command.run({ command: 'relevo', args: 'planifica' })
  expect(set.text).toContain('Falta la otra sesión')

  // No builder yet, and a builder's kind is not the planner's to send.
  const early = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'plan', resumen: 'Paso 1' })
  expect(early.deny).toContain('No hay sesión que construye')
  const wrong = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'entrega', resumen: 'x' })
  expect(wrong.deny).toContain('solo entrega')

  store.set('sesion:construye', { sessionId: 'sesion-b', cwd: '/repo', at: Date.now() })
  const ok = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'plan', resumen: 'Paso 1: test' })
  expect(ok.deny).toBeUndefined()
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).toContain('[relevo] plan de la sesión que planifica')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Paso 1: test/ }))?.text).toContain('Paso 1: test')
  await ui.unmount()
})

test('revisions stop after three rounds', async ($, on) => {
  const store = stubEngine(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'relevo', args: 'planifica' })
  store.set('sesion:construye', { sessionId: 'sesion-b', cwd: '/repo', at: Date.now() })

  for (let i = 0; i < 3; i++) {
    const round = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'revision', resumen: `falta ${i}` })
    expect(round.deny).toBeUndefined()
  }
  const fourth = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'revision', resumen: 'otra' })
  expect(fourth.deny).toContain('pregúntale a la persona')
})
