import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff, HandoffKind, Letter, Phase, Role, Seat } from '../types'

const PANE = 'relevo'
const TITLE = 'Relevo'
const TOOL = 'mcp__relevo__entregar'
const PLAN_FILE = '.relevo/plan.md'
const MAX_ROUNDS = 3
const MAX_LOG = 50
const POLL_MS = 1000
const FRAME_MS = 120

const role = atom({ plugin: 'relevo', key: 'role' } as const, null)
const log = atom({ plugin: 'relevo', key: 'log' } as const, [])
const rounds = atom({ plugin: 'relevo', key: 'rounds' } as const, 0)
// The seats as last read from the shared store: this session's and its partner's.
const self = atom({ plugin: 'relevo', key: 'self' } as const, null)
const peer = atom({ plugin: 'relevo', key: 'peer' } as const, null)
const frame = atom({ plugin: 'relevo', key: 'frame' } as const, 0)

const ROLES: readonly Role[] = ['planifica', 'construye']
const partnerOf = (mine: Role): Role => (mine === 'planifica' ? 'construye' : 'planifica')
const seatKey = (of: Role) => `sesion:${of}`
const cmdOf = (of: Role) => (of === 'planifica' ? 'plan' : 'build')
// A handoff waits in the shared store, one key per letter, for the session holding that role.
// It never goes through SendMessage, so no permission check or auto mode classifier is involved.
const boxOf = (of: Role) => `buzon:${of}:`
const LABEL: Record<Role, string> = { planifica: 'Planifica', construye: 'Construye' }

// What `/relevo <arg>` means; the Spanish words keep working.
const ALIASES: Record<string, string> = {
  plan: 'planifica', planifica: 'planifica',
  build: 'construye', construye: 'construye',
  status: 'estado', estado: 'estado', '': 'estado',
  exit: 'salir', leave: 'salir', salir: 'salir',
}

const KINDS: Record<Role, readonly HandoffKind[]> = {
  planifica: ['plan', 'revision', 'respuesta', 'aprobado'],
  construye: ['entrega', 'pregunta'],
}

const KIND_COLOR: Record<HandoffKind, string | undefined> = {
  plan: 'suggestion',
  entrega: 'warning',
  revision: 'error',
  pregunta: 'warning',
  respuesta: undefined,
  aprobado: 'success',
}

const FIRST_PHASE: Record<Role, Phase> = { planifica: 'listo', construye: 'esperando plan' }

// The phase a session moves to when it sends a handoff, and when it receives one.
const SENT_PHASE: Record<HandoffKind, Phase> = {
  plan: 'plan creado',
  revision: 'revision enviada',
  respuesta: 'respuesta enviada',
  aprobado: 'aprobado',
  entrega: 'entregado',
  pregunta: 'pregunta enviada',
}
const RECEIVED_PHASE: Record<HandoffKind, Phase> = {
  entrega: 'revisando',
  pregunta: 'revisando',
  plan: 'construyendo plan',
  revision: 'aplicando revision',
  respuesta: 'construyendo plan',
  aprobado: 'aprobado',
}

const PHASE_COLOR: Record<Phase, string | undefined> = {
  listo: undefined,
  'esperando plan': undefined,
  planificando: 'suggestion',
  'construyendo plan': 'suggestion',
  'aplicando revision': 'suggestion',
  revisando: 'suggestion',
  'plan creado': 'warning',
  entregado: 'warning',
  'revision enviada': 'warning',
  'respuesta enviada': 'warning',
  'pregunta enviada': 'warning',
  aprobado: 'success',
}

const REVIEW_PHASES: readonly Phase[] = ['revisando', 'revision enviada', 'aplicando revision']

// Set while poll delivers letters, so the next tick does not deliver them twice.
let picking = false
let sentCount = 0

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const INSTRUCTIONS: Record<Role, string> = {
  planifica: [
    '# Relevo: esta sesión PLANIFICA',
    'Trabajas en pareja con otra sesión de Claude que construye. Tú no implementas código del proyecto.',
    `1. Entiende el pedido, explora el código y escribe el plan en \`${PLAN_FILE}\`: pasos verificables, archivos a tocar, el comando que prueba cada paso y el criterio de terminado.`,
    `2. Cuando el plan esté listo, llama \`${TOOL}\` con tipo "plan" y un resumen. Luego termina tu turno: la respuesta del constructor te llega sola.`,
    '3. Al recibir una "entrega", revisa el trabajo contra el plan (git diff, corre los tests). Si cumple, entrega "aprobado" y avísale a la persona. Si no, entrega "revision" con lo que falta, concreto y con archivo:línea.',
    `4. A una "pregunta" contesta con "respuesta". Tras ${MAX_ROUNDS} rondas de revisión sin aprobar, detente y pregúntale a la persona.`,
  ].join('\n'),
  construye: [
    '# Relevo: esta sesión CONSTRUYE',
    'Trabajas en pareja con otra sesión de Claude que planifica y revisa.',
    `1. Espera el "plan". Al recibirlo, lee \`${PLAN_FILE}\` e impleméntalo paso a paso, verificando cada paso con el comando que indica.`,
    `2. Al terminar, llama \`${TOOL}\` con tipo "entrega": qué cambiaste (archivos), qué verificaste y el resultado. Luego termina tu turno.`,
    '3. Si el plan es ambiguo o choca con el código, entrega "pregunta" en vez de inventar, y espera la respuesta.',
    '4. Una "revision" trae correcciones: aplícalas y vuelve a entregar. No hagas commits salvo que el plan lo pida.',
  ].join('\n'),
}

async function seatOf($: EngineInterface, of: Role): Promise<Seat | undefined> {
  const seat = await $.store.get(seatKey(of)).catch(() => undefined)
  return typeof seat === 'object' && seat !== null && 'sessionId' in seat ? (seat as Seat) : undefined
}

const phaseOf = (of: Role, seat: Seat) => seat.phase ?? FIRST_PHASE[of]

// Merges a patch into this session's own seat, if the seat is still this session's.
async function mark($: EngineInterface, patch: Partial<Seat> | ((seat: Seat, of: Role) => Partial<Seat>)) {
  const mine = await read($, role)
  if (mine === null) return
  const seat = await seatOf($, mine)
  if (seat === undefined || seat.sessionId !== (await $.session.id())) return
  const changes = typeof patch === 'function' ? patch(seat, mine) : patch
  const next: Seat = { ...seat, ...changes }
  if (changes.phase !== undefined && changes.phase !== seat.phase) next.phaseAt = Date.now()
  await $.store.set(seatKey(mine), next)
  await refreshSelf($, next)
}

// Write the atoms only when the value changed, so a quiet poll redraws nothing.
const same = (a: Seat | null, b: Seat | null) => JSON.stringify(a) === JSON.stringify(b)

async function refreshSelf($: EngineInterface, value: Seat | null) {
  if (!same(await read($, self), value)) await update($, self, () => value)
}

async function refreshPeer($: EngineInterface, value: Seat | null) {
  if (!same(await read($, peer), value)) await update($, peer, () => value)
}

async function poll($: EngineInterface) {
  const mine = await read($, role)
  if (mine === null) {
    await refreshSelf($, null)
    await refreshPeer($, null)
    return
  }
  const own = await seatOf($, mine)
  const isMine = own !== undefined && own.sessionId === (await $.session.id())
  await refreshSelf($, isMine ? own : null)
  await refreshPeer($, (await seatOf($, partnerOf(mine))) ?? null)
  if (isMine) await pickUp($, mine)
}

async function record($: EngineInterface, entry: Handoff) {
  await update($, log, list => [...list, entry].slice(-MAX_LOG))
}

const letterText = (letter: Letter) =>
  `[relevo] ${letter.kind} de la sesión que ${letter.from}\n\n${letter.summary}\n\n(Responde con la herramienta ${TOOL}.)`

async function arrived($: EngineInterface, kind: HandoffKind, from: Role, summary: string) {
  await record($, { at: Date.now(), kind, from, direction: 'entra', summary })
  // The builder counts the rounds it receives, as the planner counts those it sends.
  if (kind === 'revision') await update($, rounds, n => n + 1)
  if (kind === 'plan' || kind === 'aprobado') await update($, rounds, () => 0)
  if (kind in RECEIVED_PHASE) await mark($, { phase: RECEIVED_PHASE[kind] })
}

// Takes the letters waiting for this session's role and hands each to the model as a prompt,
// which runs as a turn of its own once the session is idle.
async function pickUp($: EngineInterface, mine: Role) {
  if (picking) return
  picking = true
  try {
    for (const key of (await $.store.keys()).filter(k => k.startsWith(boxOf(mine)))) {
      const letter = (await $.store.get(key)) as Letter | undefined
      await $.store.delete(key)
      if (letter === undefined) continue
      await arrived($, letter.kind, letter.from, letter.summary)
      // Put it back if the prompt did not enter, so the next poll tries again.
      void $.prompt.submit({ text: letterText(letter) }).catch(() => $.store.set(key, letter))
    }
  } finally {
    picking = false
  }
}

async function leave($: EngineInterface) {
  const mine = await read($, role)
  if (mine === null) return
  const seat = await seatOf($, mine)
  if (seat?.sessionId === (await $.session.id())) await $.store.delete(seatKey(mine))
  await update($, role, () => null)
  await refreshSelf($, null)
  await refreshPeer($, null)
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function ago(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `hace ${minutes}m`
  return `hace ${Math.floor(minutes / 60)}h`
}

async function status($: EngineInterface): Promise<string> {
  const mine = await read($, role)
  if (mine === null) return 'Esta sesión no tiene rol. Usa /relevo plan o /relevo build.'
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const lines: string[] = []
  let partner: Seat | undefined
  for (const of of ROLES) {
    const seat = await seatOf($, of)
    const isMine = of === mine && seat?.sessionId === id
    if (of !== mine) partner = seat
    if (seat === undefined) {
      lines.push(`${LABEL[of]}: sin conectar`)
      continue
    }
    const busy = seat.busy === true ? ' ⠿ trabajando' : ''
    const since = isMine ? '' : ` · desde ${clock(seat.at)}`
    lines.push(`${LABEL[of]}${isMine ? ' (esta sesión)' : ''}: ${phaseOf(of, seat)}${busy} · ${ago(seat.phaseAt ?? seat.at)}${since}`)
  }
  if (partner === undefined) {
    lines.push(`Falta la otra sesión: abre otra terminal en ${cwd} y corre /relevo ${cmdOf(partnerOf(mine))}.`)
  } else if (partner.cwd !== cwd) {
    lines.push(`Ojo: la otra sesión corre en ${partner.cwd}, no en ${cwd}; el plan y el código no se van a ver.`)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relevo',
      description: 'Pareja de sesiones: /relevo plan | build | status | exit',
    })
    await $.tool.register({
      name: 'entregar',
      description:
        'Pasa el trabajo a la otra sesión de la pareja de relevo (la que planifica o la que construye). ' +
        'El planificador entrega plan, revision, respuesta o aprobado; el constructor entrega entrega o pregunta.',
      inputSchema: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['plan', 'entrega', 'revision', 'pregunta', 'respuesta', 'aprobado'] },
          resumen: { type: 'string', description: 'Lo que la otra sesión necesita saber para seguir, autocontenido.' },
        },
        required: ['tipo', 'resumen'],
      },
      isDeferred: false,
    })

    // The store has no change event: poll it for the partner's seat, and spin
    // the frame only while one of the two sessions has a turn running.
    $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
    $.clock.every(FRAME_MS, () =>
      void (async () => {
        const [own, other] = [await read($, self), await read($, peer)]
        if (own?.busy === true || other?.busy === true) await update($, frame, n => (n + 1) % SPINNER.length)
      })().catch(() => undefined),
    )

    if ((await read($, role)) !== null) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await leave($).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await mark($, (seat, of) => ({
        busy: true,
        ...(of === 'planifica' && phaseOf(of, seat) === 'listo' ? { phase: 'planificando' as const } : {}),
      })).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await mark($, { busy: false }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'relevo' }, async ($, e) => {
    const typed = e.args.trim().toLowerCase()
    const arg = ALIASES[typed]

    if (arg === 'salir') {
      await leave($)
      return { text: 'Esta sesión dejó la pareja de relevo.' }
    }

    if (ROLES.includes(arg as Role)) {
      const mine = arg as Role
      const before = await read($, role)
      if (before !== null && before !== mine) await leave($)
      const now = Date.now()
      const seat: Seat = {
        sessionId: await $.session.id(),
        cwd: await $.session.cwd(),
        at: now,
        phase: FIRST_PHASE[mine],
        phaseAt: now,
        busy: false,
      }
      await $.store.set(seatKey(mine), seat)
      await update($, role, () => mine)
      await update($, rounds, () => 0)
      await poll($)
      await $.ui.open({ id: PANE, title: TITLE })
      const tip = mine === 'planifica' ? 'Sugerido: Opus 5.5 (/model opus).' : 'Sugerido: Sonnet 5.5 (/model sonnet).'
      return { text: `${await status($)}\n${tip}` }
    }

    if (arg === 'estado') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: await status($) }
    }

    return { text: `No conozco «${typed}». Usa /relevo plan | build | status | exit.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const mine = await read($, role)
    if (mine === null || !e.tools.includes(TOOL)) return composed

    return { sections: [...composed.sections, { id: 'relevo:rol', text: INSTRUCTIONS[mine], scope: 'session' as const }] }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { tipo?: string; resumen?: string }
    const mine = await read($, role)
    if (mine === null) return { deny: 'Esta sesión no está en una pareja de relevo. La persona debe correr /relevo plan o /relevo build.' }

    const kind = input.tipo as HandoffKind
    if (!KINDS[mine].includes(kind)) return { deny: `La sesión que ${mine} solo entrega: ${KINDS[mine].join(', ')}.` }
    const summary = (input.resumen ?? '').trim()
    if (summary === '') return { deny: 'Falta el resumen.' }

    const done = await read($, rounds)
    if (kind === 'revision' && done >= MAX_ROUNDS) {
      return { deny: `Ya van ${MAX_ROUNDS} rondas de revisión sin aprobar. Detente y pregúntale a la persona cómo seguir.` }
    }

    const partner = await seatOf($, partnerOf(mine))
    if (partner === undefined) return { deny: `No hay sesión que ${partnerOf(mine)}. Pídele a la persona que abra otra y corra /relevo ${cmdOf(partnerOf(mine))}.` }

    const letter: Letter = { at: Date.now(), kind, from: mine, summary }
    const key = `${boxOf(partnerOf(mine))}${letter.at}-${sentCount++}`
    await $.store.set(key, letter)

    if (kind === 'revision') await update($, rounds, n => n + 1)
    if (kind === 'plan' || kind === 'aprobado') await update($, rounds, () => 0)
    await record($, { at: Date.now(), kind, from: mine, direction: 'sale', summary })
    await mark($, { phase: SENT_PHASE[kind] }).catch(() => undefined)

    // No waiting here for the pickup: a sleep counts against the hook's time budget.
    const after = kind === 'aprobado' ? 'Cuéntale a la persona el resultado.' : 'Termina tu turno; la respuesta llega sola.'
    return {
      result: `Entregado al buzón de la sesión que ${partnerOf(mine)}: la toma en un segundo, o al volver si está cerrada. No lo reenvíes. ${after}`,
    }
  }).catch(() => ({ deny: 'relevo falló al entregar; reintenta o avísale a la persona.' }))

  on('session.receive', async ($, e, next) => {
    const found = /\[relevo\] (\w+) de la sesión que (planifica|construye)\n\n([\s\S]*?)\n\n\(Responde/.exec(e.text)
    if ((e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') && found !== null && e.agentId === undefined) {
      // A handoff from a 0.2 partner, which still sent through SendMessage.
      await arrived($, found[1] as HandoffKind, found[2] as Role, found[3] ?? '')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const mine = await read($, role)
    const list = await read($, log)
    const done = await read($, rounds)
    const own = await read($, self)
    const other = await read($, peer)
    const tick = await read($, frame)

    if (mine === null) {
      return <Text dimColor>Sin rol. Corre /relevo plan o /relevo build.</Text>
    }

    const seats: Record<Role, Seat | null> = mine === 'planifica'
      ? { planifica: own, construye: other }
      : { planifica: other, construye: own }

    const card = (of: Role) => {
      const seat = seats[of]
      const isMine = of === mine
      const head = (
        <Text>
          <Text bold>{isMine ? '◆' : '◇'} {LABEL[of]}</Text>
          {isMine && <Text dimColor> · esta sesión</Text>}
        </Text>
      )
      if (seat === null) {
        return (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            {head}
            <Text dimColor>sin conectar — /relevo {cmdOf(of)}</Text>
          </Box>
        )
      }
      const phase = phaseOf(of, seat)
      const color = PHASE_COLOR[phase]
      const glyph = seat.busy === true
        ? SPINNER[tick % SPINNER.length]
        : phase === 'aprobado' ? '✓' : color === undefined ? '◌' : '●'
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={color === undefined} paddingX={1}>
          {head}
          <Box justifyContent="space-between">
            <Text color={color} dimColor={color === undefined}>{glyph} {phase}</Text>
            <Text dimColor>{ago(seat.phaseAt ?? seat.at)}</Text>
          </Box>
        </Box>
      )
    }

    const phases = [own, other].flatMap(seat => (seat?.phase === undefined ? [] : [seat.phase]))
    const showRounds = done > 0 || phases.some(phase => REVIEW_PHASES.includes(phase))
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const room = Math.max(1, rows - (8 + (showRounds ? 1 : 0) + 3))

    return (
      <Box flexDirection="column">
        {card('planifica')}
        {card('construye')}
        {showRounds && (
          <Text>
            <Text dimColor>  revisiones </Text>
            <Text color="warning">{'●'.repeat(Math.min(done, MAX_ROUNDS))}</Text>
            <Text dimColor>{'○'.repeat(Math.max(0, MAX_ROUNDS - done))}  {done}/{MAX_ROUNDS}</Text>
          </Text>
        )}
        <Text> </Text>
        {list.length === 0 && <Text dimColor>  Aún no hay entregas.</Text>}
        {list.slice(-room).map(entry => (
          <Text wrap="truncate-end">
            <Text dimColor>  {clock(entry.at)} {entry.direction === 'sale' ? '↗' : '↙'} </Text>
            <Text bold color={KIND_COLOR[entry.kind]}>{entry.kind.padEnd(9)}</Text>
            <Text dimColor> {entry.summary.split('\n')[0]}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
