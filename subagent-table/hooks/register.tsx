import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnUsage } from 'claude-code'

import type { AgentRow, AgentStatus } from '../types'

const PANE = 'subagent-table'
const TITLE = 'Sub-agentes'
const MAX_ROWS = 30
// The dock width asked for on open: the card layout fits in it. A width the
// person dragged the dock to wins over it.
const DOCK_COLUMNS = 46
// From this many body columns the cards go in two columns.
const TWO_COLUMNS_FROM = 84
// A card's height: two border rows and five lines.
const CARD_ROWS = 7
// The ticker's step: fine enough to animate the load bar and the spinner.
const FRAME_MS = 250
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const agents = atom({ plugin: 'subagent-table', key: 'agents' } as const, [])
const now = atom({ plugin: 'subagent-table', key: 'now' } as const, 0)

// Working: the load bar slides and the spinner turns.
const isWorking = (row: AgentRow) => row.status === 'arrancando' || row.status === 'corriendo'
const isActive = (row: AgentRow) => isWorking(row) || row.status === 'esperando'

const shortModel = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

// "digitalizate-model-router:sonnet-implementer" -> "sonnet-implementer"
const shortType = (type: string) => type.slice(type.lastIndexOf(':') + 1)

// Rows kept by 0.1.0 carry no token counts.
const withUsage = (row: AgentRow): AgentRow => ({
  ...row,
  requests: row.requests ?? 0,
  tokensIn: row.tokensIn ?? 0,
  tokensOut: row.tokensOut ?? 0,
  tokensCached: row.tokensCached ?? 0,
})

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const spent = (row: AgentRow) => row.tokensIn + row.tokensOut

// Blue working, yellow waiting on a permission, green done, red failed.
const STATUS_COLOR: Record<AgentStatus, string> = {
  arrancando: 'suggestion',
  corriendo: 'suggestion',
  esperando: 'warning',
  listo: 'success',
  error: 'error',
  cancelado: 'inactive',
  rechazado: 'error',
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  arrancando: '◌ arrancando',
  corriendo: '● trabajando',
  esperando: '⏸ esperando permiso',
  listo: '✔ listo',
  error: '✖ falló',
  cancelado: '■ cancelado',
  rechazado: '✖ rechazado',
}

// A working agent's bar is a block a quarter wide bouncing across the track;
// a waiting one's stands still; a finished one's is full.
function loadBar(row: AgentRow, at: number, cells: number): string {
  const width = Math.max(1, cells)
  if (row.status === 'cancelado') return '░'.repeat(width)
  if (!isActive(row)) return '━'.repeat(width)
  const block = Math.max(1, Math.round(width / 4))
  const span = width - block
  const frame = Math.floor((row.status === 'esperando' ? row.startedAt : at) / FRAME_MS)
  const step = span === 0 ? 0 : frame % (2 * span)
  const offset = step <= span ? step : 2 * span - step
  return '░'.repeat(offset) + '━'.repeat(block) + '░'.repeat(span - offset)
}

// The ticker redraws the bars and the durations while some agent runs.
let ticker: Timer | undefined
// The second the status line was last written in: it changes once a second.
let lastSecond = 0

async function patch($: EngineInterface, match: (row: AgentRow) => boolean, fn: (row: AgentRow) => AgentRow) {
  await update($, agents, list => list.map(row => (match(row) ? fn(withUsage(row)) : row)))
}

function addUsage(row: AgentRow, usage: TurnUsage): AgentRow {
  return {
    ...row,
    requests: row.requests + 1,
    tokensIn: row.tokensIn + usage.input_tokens + usage.cache_creation_input_tokens,
    tokensOut: row.tokensOut + usage.output_tokens,
    tokensCached: row.tokensCached + usage.cache_read_input_tokens,
  }
}

// The status line under the prompt: the summary stays in view with the pane closed.
async function showStatus($: EngineInterface) {
  const list = (await read($, agents)).map(withUsage)
  if (list.length === 0) {
    $.ui.status(undefined)
    return
  }
  const at = Date.now()
  const active = list.filter(isActive).length
  const waiting = list.filter(row => row.status === 'esperando').length
  const time = list.reduce((sum, row) => sum + ((row.endedAt ?? at) - row.startedAt), 0)
  const total = list.reduce((sum, row) => sum + spent(row), 0)
  const counts = `${active - waiting} corriendo${waiting > 0 ? ` · ${waiting} esperando` : ''} · ${list.length - active} terminados`
  $.ui.status(`Sub-agentes: ${counts} · ${duration(time)} · ${tokens(total)} tok`)
}

async function tick($: EngineInterface) {
  const list = await read($, agents)
  const at = Date.now()
  await update($, now, () => at)
  const second = Math.floor(at / 1000)
  if (second !== lastSecond) {
    lastSecond = second
    await showStatus($)
  }
  if (!list.some(isActive)) {
    ticker?.cancel()
    ticker = undefined
  }
}

async function startTicker($: EngineInterface) {
  await update($, now, () => Date.now())
  if (ticker !== undefined) return
  ticker = $.clock.every(FRAME_MS, () => void tick($))
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS, rows: 12 })

export const register: Register = on => {
  ticker?.cancel()
  ticker = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagentes',
      description: 'Abre o cierra el panel de sub-agentes (consumo y tiempo)',
    })
    await showStatus($)

    return next(e)
  })

  // A toggle: the summary stays on the status line while the pane is closed.
  on('command.run', { command: 'subagentes' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Panel de sub-agentes cerrado; el resumen sigue en la línea de estado.' }
    }
    await openPane($)

    return { text: 'Panel de sub-agentes abierto.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const startedAt = Date.now()
    const row: AgentRow = {
      toolUseId: e.tool_use_id,
      name: e.name,
      type: e.subagentType,
      model: e.model ?? 'inherit',
      description: e.description || e.prompt.slice(0, 60),
      status: 'arrancando',
      toolCount: 0,
      startedAt,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
    }
    const isFirst = (await read($, agents)).length === 0
    await update($, agents, list => [...list, row].slice(-MAX_ROWS))
    await startTicker($)
    // The pane opens by itself with the session's first subagent only, never
    // empty at start; unasked it is placed on a wide enough terminal alone.
    if (isFirst) void openPane($)

    const isRow = (one: AgentRow) => one.toolUseId === row.toolUseId && one.startedAt === startedAt
    const started = await next(e)
    if (started.deny !== undefined) {
      await patch($, isRow, one => ({ ...one, status: 'rechazado', endedAt: Date.now() }))
      return started
    }
    await patch($, isRow, one => ({
      ...one,
      agentId: started.agentId,
      // A teammate's address is `<name>@<team>`: its name may carry a suffix (`scout-2`).
      name: started.teammateId?.split('@')[0] ?? one.name,
      model: shortModel(started.model),
      status: one.status === 'arrancando' ? 'corriendo' : one.status,
    }))

    return started
  })

  // A subagent woken again (SendMessage) starts a new turn: it runs again.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const list = await read($, agents)
      if (list.some(row => row.agentId === id && !isActive(row))) {
        await patch($, row => row.agentId === id, row => ({ ...row, status: 'corriendo', endedAt: undefined }))
        await startTicker($)
      }
    }

    return next(e)
  })

  // Each model request of a subagent: what it cost, counted as it lands.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined && result.usage !== null) {
      const id = e.agentId
      const usage = result.usage
      await patch($, row => row.agentId === id, row => addUsage(row, usage))
    }

    return result
  })

  // Only watches: the verdict goes up as core and the hooks beneath gave it.
  // An ask inside a subagent's loop stops it until someone answers.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.agentId !== undefined && e.tool_use_id !== undefined && verdict.decision === 'ask') {
      const id = e.agentId
      try {
        await patch($, row => row.agentId === id, row => ({ ...row, status: 'esperando', waitingTool: e.tool }))
        await showStatus($)
      } catch {
        // The panel missing a wait must never cost the call its verdict.
      }
    }

    return verdict
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const id = e.agentId
    await patch($, row => row.agentId === id, row => ({ ...row, lastTool: e.tool, toolCount: row.toolCount + 1 }))
    const result = await next(e)
    // The ask was answered and the tool ran (or was refused): it works again.
    // Matched inside the update, which sees the wait the check just wrote.
    await patch($, row => row.agentId === id && row.status === 'esperando', row => ({ ...row, status: 'corriendo', waitingTool: undefined }))
    await showStatus($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const usage = e.usage
      const status: AgentStatus = e.isAborted || e.reason === 'aborted' ? 'cancelado' : e.reason === 'answer' ? 'listo' : 'error'
      await patch($, row => row.agentId === id, row => {
        // The turn's own sum stands in where no step reported its usage.
        const counted = row.requests === 0 && usage !== undefined ? addUsage(row, usage) : row
        return { ...counted, status, lastTool: undefined, waitingTool: undefined, endedAt: Date.now() }
      })
      await showStatus($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = (await read($, agents)).map(withUsage)
    const at = (await read($, now)) || Date.now()
    const width = e.props.bodyColumns
    // The header's two lines and its margin, and the "+N más" line.
    const room = Math.max(1, e.props.scroll.bodyRows - 4)

    const waiting = all.filter(row => row.status === 'esperando')
    const working = all.filter(isWorking)
    const active = waiting.length + working.length
    // Waiting ones first, then the working ones, then the latest to finish.
    const list = [...waiting, ...working, ...all.filter(row => !isActive(row)).reverse()]
    const time = (row: AgentRow) => duration((row.endedAt ?? at) - row.startedAt)

    const totalTime = all.reduce((sum, row) => sum + ((row.endedAt ?? at) - row.startedAt), 0)
    const totalSpent = all.reduce((sum, row) => sum + spent(row), 0)
    const totalCached = all.reduce((sum, row) => sum + row.tokensCached, 0)

    const counts = `${working.length} corriendo${waiting.length > 0 ? ` · ${waiting.length} esperando` : ''} · ${all.length - active} terminados`
    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor wrap="truncate-end">{all.length === 0 ? 'Aún no hay sub-agentes en esta sesión.' : counts}</Text>
        {all.length > 0 && (
          <Text wrap="truncate-end">
            <Text bold>{duration(totalTime)}</Text>
            <Text dimColor> · </Text>
            <Text bold>{tokens(totalSpent)} tok</Text>
            <Text dimColor>{` (+${tokens(totalCached)} caché)`}</Text>
          </Text>
        )}
      </Box>
    )

    const columns = width >= TWO_COLUMNS_FROM ? 2 : 1
    const cardWidth = columns === 2 ? Math.floor((width - 1) / 2) : width
    // Inside the border and the padding on each side.
    const cells = cardWidth - 4
    const shown = list.slice(0, Math.max(1, Math.floor(room / CARD_ROWS)) * columns)

    const Card = (row: AgentRow) => {
      const isDone = !isActive(row)
      const color = STATUS_COLOR[row.status]
      // Unnamed, the task names the card and is not repeated under it.
      const title = row.name ?? row.description
      const activity = isDone ? 'terminado' : row.lastTool ?? 'pensando'
      const doing = row.name === undefined ? activity : isDone ? row.description : `${activity} · ${row.description}`
      const detail =
        row.status === 'esperando' ? ` · ${row.waitingTool ?? ''}` : row.status === 'corriendo' ? ` · ${row.lastTool ?? 'pensando'}` : ''
      return (
        <Box
          key={`${row.toolUseId}-${row.startedAt}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={color}
          paddingX={1}
          width={cardWidth}
          flexShrink={0}
        >
          <Box flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text bold dimColor={isDone} wrap="truncate-end">{title}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor={isDone}>
                {isWorking(row) ? `${SPINNER[Math.floor(at / FRAME_MS) % SPINNER.length]} ${time(row)}` : time(row)}
              </Text>
            </Box>
          </Box>
          <Text dimColor wrap="truncate-end">
            {`${shortType(row.type)} · ${row.model} · ${tokens(spent(row))} tok · ${row.requests} req · ${row.toolCount} tools`}
          </Text>
          <Text dimColor wrap="truncate-end">{doing}</Text>
          <Text color={color} wrap="truncate-end">{loadBar(row, at, cells)}</Text>
          <Box backgroundColor={color}>
            <Text color="inverseText" bold wrap="truncate-end">{` ${STATUS_LABEL[row.status]}${detail}`}</Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {columns === 2 ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {shown.map(Card)}
          </Box>
        ) : (
          shown.map(Card)
        )}
        {list.length > shown.length && <Text dimColor>{`+${list.length - shown.length} más`}</Text>}
      </Box>
    )
  })
}
