export type Role = 'planifica' | 'construye'

export type HandoffKind = 'plan' | 'entrega' | 'revision' | 'pregunta' | 'respuesta' | 'aprobado'

export type Handoff = {
  at: number
  kind: HandoffKind
  from: Role
  direction: 'sale' | 'entra'
  summary: string
}

// What each session writes to the shared store under `sesion:<role>`.
export type Seat = { sessionId: string; cwd: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    relevo: { role: Role | null; log: Handoff[]; rounds: number }
  }
}
