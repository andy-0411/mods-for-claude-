export type AgentStatus = 'arrancando' | 'corriendo' | 'esperando' | 'listo' | 'error' | 'cancelado' | 'rechazado'

export type AgentRow = {
  toolUseId: string
  agentId?: string
  /** The name the call gave it (`Agent({ name })`), with the team's suffix if it got one. */
  name?: string
  type: string
  model: string
  description: string
  status: AgentStatus
  lastTool?: string
  /** The tool whose permission the agent waits on, while `esperando`. */
  waitingTool?: string
  toolCount: number
  startedAt: number
  endedAt?: number
  /** Model requests the agent made (one per `turn.step` with usage). */
  requests: number
  /** Fresh input tokens: uncached input plus what was written to the cache. */
  tokensIn: number
  tokensOut: number
  /** Input tokens served from the prompt cache (cheap, counted apart). */
  tokensCached: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-table': { agents: AgentRow[]; now: number }
  }
}
