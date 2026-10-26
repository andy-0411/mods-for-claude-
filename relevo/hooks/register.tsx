import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff, HandoffKind, Role, Seat } from '../types'

const PANE = 'relevo'
const TITLE = 'Relevo'
const TOOL = 'mcp__relevo__entregar'
const PLAN_FILE = '.relevo/plan.md'
const MAX_ROUNDS = 3
const MAX_LOG = 50

const role = atom({ plugin: 'relevo', key: 'role' } as const, null)
const log = atom({ plugin: 'relevo', key: 'log' } as const, [])
const rounds = atom({ plugin: 'relevo', key: 'rounds' } as const, 0)

const ROLES: readonly Role[] = ['planifica', 'construye']
const partnerOf = (mine: Role): Role => (mine === 'planifica' ? 'construye' : 'planifica')
const seatKey = (of: Role) => `sesion:${of}`

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

async function record($: EngineInterface, entry: Handoff) {
  await update($, log, list => [...list, entry].slice(-MAX_LOG))
}

async function leave($: EngineInterface) {
  const mine = await read($, role)
  if (mine === null) return
  const seat = await seatOf($, mine)
  if (seat?.sessionId === (await $.session.id())) await $.store.delete(seatKey(mine))
  await update($, role, () => null)
}

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function status($: EngineInterface): Promise<string> {
  const mine = await read($, role)
  if (mine === null) return 'Esta sesión no tiene rol. Usa /relevo planifica o /relevo construye.'
  const partner = await seatOf($, partnerOf(mine))
  const cwd = await $.session.cwd()
  const lines = [`Esta sesión ${mine}.`]
  if (partner === undefined) {
    lines.push(`Falta la otra sesión: abre otra terminal en ${cwd} y corre /relevo ${partnerOf(mine)}.`)
  } else {
    lines.push(`Pareja: la sesión que ${partnerOf(mine)} (desde ${clock(partner.at)}).`)
    if (partner.cwd !== cwd) lines.push(`Ojo: la otra sesión corre en ${partner.cwd}, no en ${cwd}; el plan y el código no se van a ver.`)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relevo',
      description: 'Pareja de sesiones: /relevo planifica | construye | estado | salir',
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
    if ((await read($, role)) !== null) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await leave($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'relevo' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'salir') {
      await leave($)
      return { text: 'Esta sesión dejó la pareja de relevo.' }
    }

    if (ROLES.includes(arg as Role)) {
      const mine = arg as Role
      const before = await read($, role)
      if (before !== null && before !== mine) await leave($)
      await $.store.set(seatKey(mine), { sessionId: await $.session.id(), cwd: await $.session.cwd(), at: Date.now() })
      await update($, role, () => mine)
      await update($, rounds, () => 0)
      await $.ui.open({ id: PANE, title: TITLE })
      const tip = mine === 'planifica' ? 'Sugerido: Opus 5.5 (/model opus).' : 'Sugerido: Sonnet 5.5 (/model sonnet).'
      return { text: `${await status($)}\n${tip}` }
    }

    if (arg === '' || arg === 'estado') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: await status($) }
    }

    return { text: `No conozco «${arg}». Usa /relevo planifica | construye | estado | salir.` }
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
    if (mine === null) return { deny: 'Esta sesión no está en una pareja de relevo. La persona debe correr /relevo planifica o /relevo construye.' }

    const kind = input.tipo as HandoffKind
    if (!KINDS[mine].includes(kind)) return { deny: `La sesión que ${mine} solo entrega: ${KINDS[mine].join(', ')}.` }
    const summary = (input.resumen ?? '').trim()
    if (summary === '') return { deny: 'Falta el resumen.' }

    const done = await read($, rounds)
    if (kind === 'revision' && done >= MAX_ROUNDS) {
      return { deny: `Ya van ${MAX_ROUNDS} rondas de revisión sin aprobar. Detente y pregúntale a la persona cómo seguir.` }
    }

    const partner = await seatOf($, partnerOf(mine))
    if (partner === undefined) return { deny: `No hay sesión que ${partnerOf(mine)}. Pídele a la persona que abra otra y corra /relevo ${partnerOf(mine)}.` }

    const text = `[relevo] ${kind} de la sesión que ${mine}\n\n${summary}\n\n(Responde con la herramienta ${TOOL}.)`
    const sent = await $.session.send({ to: { sessionId: partner.sessionId }, text })
    if (!sent.isDelivered) return { deny: `No se entregó: ${sent.reason}. Puede que la otra sesión esté cerrada.` }

    if (kind === 'revision') await update($, rounds, n => n + 1)
    if (kind === 'plan' || kind === 'aprobado') await update($, rounds, () => 0)
    await record($, { at: Date.now(), kind, from: mine, direction: 'sale', summary })

    const after = kind === 'aprobado' ? 'Cuéntale a la persona el resultado.' : 'Termina tu turno; la respuesta llega sola.'
    return { result: { content: [{ type: 'text', text: `Entregado a la sesión que ${partnerOf(mine)}. ${after}` }], isError: false } }
  }).catch(() => ({ deny: 'relevo falló al entregar; reintenta o avísale a la persona.' }))

  on('session.receive', async ($, e, next) => {
    const found = /\[relevo\] (\w+) de la sesión que (planifica|construye)\n\n([\s\S]*?)\n\n\(Responde/.exec(e.text)
    if ((e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') && found !== null && e.agentId === undefined) {
      await record($, {
        at: Date.now(),
        kind: found[1] as HandoffKind,
        from: found[2] as Role,
        direction: 'entra',
        summary: found[3] ?? '',
      })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const mine = await read($, role)
    const list = await read($, log)
    const done = await read($, rounds)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 4) / 2))

    if (mine === null) {
      return <Text dimColor>Sin rol. Corre /relevo planifica o /relevo construye.</Text>
    }

    const partner = await seatOf($, partnerOf(mine))

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{mine === 'planifica' ? 'Planifica' : 'Construye'}</Text>
          <Text dimColor>
            {' · '}
            {partner === undefined ? `falta la sesión que ${partnerOf(mine)}` : `pareja conectada`}
            {mine === 'planifica' ? ` · revisiones ${done}/${MAX_ROUNDS}` : ''}
          </Text>
        </Text>
        {list.length === 0 && <Text dimColor>Aún no hay entregas.</Text>}
        {list.slice(-room).map(entry => (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>{clock(entry.at)} {entry.direction === 'sale' ? '→' : '←'} </Text>
              <Text bold color={KIND_COLOR[entry.kind]}>{entry.kind}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">  {entry.summary.split('\n')[0]}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
