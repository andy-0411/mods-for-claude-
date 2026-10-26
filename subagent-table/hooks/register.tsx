import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnUsage } from 'claude-code'

import type { AgentRow, AgentStatus } from '../types'

const PANE = 'subagent-table'
const TITLE = 'Sub-agentes'
const MAX_ROWS = 30
// The dock width asked for on open: the card layout fits in it. A width the
// person dragged the dock to wins over it.
const DOCK_COLUMNS = 44
// From this many body columns the pane draws a table instead of cards.
const TABLE_FROM = 84

const agents = atom({ plugin: 'subagent-table', key: 'agents' } as const, [])
const now = atom({ plugin: 'subagent-table', key: 'now' } as const, 0)

const isActive = (row: AgentRow) => row.status === 'arrancando' || row.status === 'corriendo'

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

const STATUS_COLOR: Record<AgentStatus, string | undefined> = {
  arrancando: 'warning',
  corriendo: 'warning',
  listo: 'success',
  error: 'error',
  cancelado: undefined,
  rechazado: 'error',
}

// The ticker redraws the durations once a second while some agent runs.
let ticker: Timer | undefined

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
  const running = list.filter(isActive).length
  const time = list.reduce((sum, row) => sum + ((row.endedAt ?? at) - row.startedAt), 0)
  const total = list.reduce((sum, row) => sum + spent(row), 0)
  $.ui.status(`Sub-agentes: ${running} corriendo · ${list.length - running} terminados · ${duration(time)} · ${tokens(total)} tok`)
}

async function tick($: EngineInterface) {
  const list = await read($, agents)
  await update($, now, () => Date.now())
  await showStatus($)
  if (!list.some(isActive)) {
    ticker?.cancel()
    ticker = undefined
  }
}

async function startTicker($: EngineInterface) {
  await update($, now, () => Date.now())
  if (ticker !== undefined) return
  ticker = $.clock.every(1000, () => void tick($))
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

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      await patch($, row => row.agentId === id, row => ({ ...row, lastTool: e.tool, toolCount: row.toolCount + 1 }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const usage = e.usage
      const status: AgentStatus = e.isAborted || e.reason === 'aborted' ? 'cancelado' : e.reason === 'answer' ? 'listo' : 'error'
      await patch($, row => row.agentId === id, row => {
        // The turn's own sum stands in where no step reported its usage.
        const counted = row.requests === 0 && usage !== undefined ? addUsage(row, usage) : row
        return { ...counted, status, lastTool: undefined, endedAt: Date.now() }
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
    const room = Math.max(1, e.props.scroll.bodyRows - 2)

    const running = all.filter(isActive)
    // Running ones first, then the latest to finish.
    const list = [...running, ...all.filter(row => !isActive(row)).reverse()]
    const time = (row: AgentRow) => duration((row.endedAt ?? at) - row.startedAt)
    const doing = (row: AgentRow) => (isActive(row) ? row.lastTool ?? 'pensando' : `${row.toolCount} tools`)

    const totalTime = all.reduce((sum, row) => sum + ((row.endedAt ?? at) - row.startedAt), 0)
    const totalSpent = all.reduce((sum, row) => sum + spent(row), 0)
    const totalCached = all.reduce((sum, row) => sum + row.tokensCached, 0)

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor wrap="truncate-end">
          {all.length === 0 ? 'Aún no hay sub-agentes en esta sesión.' : `${running.length} corriendo · ${all.length - running.length} terminados`}
        </Text>
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

    if (width < TABLE_FROM) {
      // Cards: three lines each, so a narrow dock loses nothing to truncation.
      const shown = list.slice(0, Math.max(1, Math.floor(room / 4)))
      return (
        <Box flexDirection="column">
          {header}
          {shown.map(row => {
            const isDone = !isActive(row)
            return (
              <Box key={`${row.toolUseId}-${row.startedAt}`} flexDirection="column" marginBottom={1}>
                <Box flexDirection="row">
                  <Box flexGrow={1} flexShrink={1}>
                    <Text bold dimColor={isDone} wrap="truncate-end">{shortType(row.type)}</Text>
                  </Box>
                  <Box flexShrink={0} marginLeft={1}>
                    <Text color={STATUS_COLOR[row.status]}>{row.status}</Text>
                  </Box>
                </Box>
                <Text dimColor={isDone} wrap="truncate-end">
                  {`${row.model} · ${time(row)} · ${tokens(spent(row))} tok · ${row.requests} req`}
                </Text>
                <Text dimColor wrap="truncate-end">{`${doing(row)} · ${row.description}`}</Text>
              </Box>
            )
          })}
          {list.length > shown.length && <Text dimColor>{`+${list.length - shown.length} más`}</Text>}
        </Box>
      )
    }

    const Row = (
      cells: { type: string; model: string; status: string; time: string; spent: string; cached: string; doing: string; task: string },
      color?: string,
      isBold?: boolean,
      isDim?: boolean,
    ) => (
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={12}><Text bold={isBold} dimColor={isDim} wrap="truncate-end">{cells.type}</Text></Box>
        <Box width={11} flexShrink={0}><Text bold={isBold} dimColor={isDim} wrap="truncate-end">{cells.model}</Text></Box>
        <Box width={10} flexShrink={0}><Text bold={isBold} color={color} wrap="truncate-end">{cells.status}</Text></Box>
        <Box width={7} flexShrink={0}><Text bold={isBold} dimColor={isDim} wrap="truncate-end">{cells.time}</Text></Box>
        <Box width={7} flexShrink={0}><Text bold={isBold} dimColor={isDim} wrap="truncate-end">{cells.spent}</Text></Box>
        <Box width={7} flexShrink={0}><Text bold={isBold} dimColor wrap="truncate-end">{cells.cached}</Text></Box>
        <Box width={12} flexShrink={0}><Text bold={isBold} dimColor={isDim} wrap="truncate-end">{cells.doing}</Text></Box>
        <Box flexGrow={2} flexShrink={1}><Text bold={isBold} dimColor={isDim} wrap="truncate-end">{cells.task}</Text></Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {all.length > 0 &&
          Row({ type: 'Agente', model: 'Modelo', status: 'Estado', time: 'Tiempo', spent: 'Tokens', cached: 'Caché', doing: 'Haciendo', task: 'Tarea' }, undefined, true)}
        {list.slice(0, room - 1).map(row =>
          Row(
            {
              type: shortType(row.type),
              model: row.model,
              status: row.status,
              time: time(row),
              spent: tokens(spent(row)),
              cached: tokens(row.tokensCached),
              doing: doing(row),
              task: row.description,
            },
            STATUS_COLOR[row.status],
            false,
            !isActive(row),
          ),
        )}
      </Box>
    )
  })
}
