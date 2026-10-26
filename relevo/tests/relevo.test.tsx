import { expect, mock, test } from 'claude-code/testing'

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

// Nothing sits beneath the plugin: these hooks stand for the engine, the store
// a map in memory as the JSON file stands between two sessions.
function stubEngine(on: any, prompts: string[] = []) {
  const store = new Map<string, unknown>()
  on('store.keys', () => ({ value: [...store.keys()] }))
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
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.receive', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  return store
}

const relevo = ($: any, args: string) =>
  $.command.run({
    command: 'relevo',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  }) as Promise<{ text: string }>

const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

test('the planner hands the plan to the builder session', async ($, on) => {
  const store = stubEngine(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const set = await relevo($, 'planifica')
  expect(set.text).toContain('Falta la otra sesión')

  // No builder yet, and a builder's kind is not the planner's to send.
  const early = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'plan', resumen: 'Paso 1' })
  expect(early.deny).toContain('No hay sesión que construye')
  const wrong = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'entrega', resumen: 'x' })
  expect(wrong.deny).toContain('solo entrega')

  store.set('sesion:construye', { sessionId: 'sesion-b', cwd: '/repo', at: Date.now() })
  const ok = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'plan', resumen: 'Paso 1: test' })
  expect(ok.deny).toBeUndefined()
  // The plan waits in the builder's mailbox: no SendMessage, so auto mode never judges it.
  const letters = [...store.keys()].filter(k => k.startsWith('buzon:construye:'))
  expect(letters).toHaveLength(1)
  expect((store.get(letters[0]!) as any)?.summary).toBe('Paso 1: test')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Paso 1: test/ }))?.text).toContain('Paso 1: test')
  await ui.unmount()
})

test('revisions stop after three rounds', async ($, on) => {
  const store = stubEngine(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await relevo($, 'planifica')
  store.set('sesion:construye', { sessionId: 'sesion-b', cwd: '/repo', at: Date.now() })

  for (let i = 0; i < 3; i++) {
    const round = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'revision', resumen: `falta ${i}` })
    expect(round.deny).toBeUndefined()
  }
  const fourth = await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'revision', resumen: 'otra' })
  expect(fourth.deny).toContain('pregúntale a la persona')
})

test('english aliases pick roles, report and leave', async ($, on) => {
  const store = stubEngine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect((await relevo($, 'plan')).text).toContain('Planifica (esta sesión): listo')
  expect((store.get('sesion:planifica') as any)?.sessionId).toBe('sesion-a')

  expect((await relevo($, 'build')).text).toContain('Construye (esta sesión): esperando plan')
  expect(store.get('sesion:planifica')).toBeUndefined()
  expect((store.get('sesion:construye') as any)?.sessionId).toBe('sesion-a')

  expect((await relevo($, 'status')).text).toContain('Construye (esta sesión)')
  expect((await relevo($, 'STATUS ')).text).toContain('/relevo plan')
  expect((await relevo($, 'exit')).text).toContain('dejó la pareja')
  expect(store.get('sesion:construye')).toBeUndefined()
  expect((await relevo($, 'foo')).text).toContain('plan | build | status | exit')
})

test('each session writes its phase to the shared seat', async ($, on) => {
  const store = stubEngine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await relevo($, 'plan')

  await $.turn.start({ text: 'haz el plan', turnId: 't1' })
  expect((store.get('sesion:planifica') as any)?.phase).toBe('planificando')
  expect((store.get('sesion:planifica') as any)?.busy).toBe(true)

  store.set('sesion:construye', { sessionId: 'sesion-b', cwd: '/repo', at: Date.now() })
  await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'plan', resumen: 'Paso 1' })
  expect((store.get('sesion:planifica') as any)?.phase).toBe('plan creado')
  expect((await relevo($, 'status')).text).toContain('Planifica (esta sesión): plan creado')

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  expect((store.get('sesion:planifica') as any)?.busy).toBe(false)
})

test('the builder moves to building when a plan arrives', async ($, on) => {
  const store = stubEngine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await relevo($, 'build')

  await $.session.receive({
    origin: { kind: 'peer' },
    text: '[relevo] plan de la sesión que planifica\n\nPaso 1\n\n(Responde con la herramienta mcp__relevo__entregar.)',
  })
  expect((store.get('sesion:construye') as any)?.phase).toBe('construyendo plan')
})

test('the builder takes a waiting plan from its mailbox as a prompt', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const prompts: string[] = []
  const store = stubEngine(on, prompts)
  // Left by the planner while this session was closed.
  store.set('buzon:construye:1-0', { at: 1, kind: 'plan', from: 'planifica', summary: 'Paso 1' })
  store.set('buzon:planifica:2-0', { at: 2, kind: 'entrega', from: 'construye', summary: 'no es mía' })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await relevo($, 'build')
  await clock.advance(1000)
  await clock.advance(1000)

  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('[relevo] plan de la sesión que planifica\n\nPaso 1')
  expect(store.get('buzon:construye:1-0')).toBeUndefined()
  expect(store.get('buzon:planifica:2-0')).toBeDefined()
  expect((store.get('sesion:construye') as any)?.phase).toBe('construyendo plan')
})

test('the pane shows both sessions and spins for the busy one', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const store = stubEngine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await relevo($, 'plan')
  store.set('sesion:construye', { sessionId: 'sesion-b', cwd: '/repo', at: Date.now() })
  await $.tool.call({ tool: 'mcp__relevo__entregar', tipo: 'plan', resumen: 'Paso 1' })
  store.set('sesion:construye', {
    sessionId: 'sesion-b',
    cwd: '/repo',
    at: Date.now(),
    phase: 'construyendo plan',
    phaseAt: Date.now(),
    busy: true,
  })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Planifica/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Construye/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /esta sesión/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /plan creado/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /construyendo plan/ }))?.text).toMatch(BRAILLE)
  await ui.unmount()
})
