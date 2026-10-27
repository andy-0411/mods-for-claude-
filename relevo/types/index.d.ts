export type Role = 'planifica' | 'construye'

export type HandoffKind = 'plan' | 'entrega' | 'fallo' | 'pregunta' | 'respuesta' | 'aprobado'

export type Handoff = {
  at: number
  kind: HandoffKind
  from: Role
  direction: 'sale' | 'entra'
  summary: string
}

// A handoff waiting in the shared store under `buzon:<role>:<id>` for the session holding that role.
export type Letter = { at: number; kind: HandoffKind; from: Role; summary: string }

export type Phase =
  | 'listo' // planifica: rol tomado, sin plan aún
  | 'planificando' // planifica: turno corriendo sin haber enviado plan
  | 'plan creado' // planifica: envió plan, espera entrega
  | 'revisando' // planifica: recibió entrega/pregunta
  | 'fallo enviado'
  | 'respuesta enviada'
  | 'aprobado'
  | 'esperando plan' // construye: rol tomado, nada recibido
  | 'construyendo plan' // construye: recibió plan
  | 'corrigiendo fallo'
  | 'entregado' // construye: envió entrega, espera las pruebas del plan
  | 'pregunta enviada'

// What each session writes to the shared store under `sesion:<role>`.
// `phase`, `phaseAt` and `busy` are absent on a seat written by v0.1.
export type Seat = { sessionId: string; cwd: string; at: number; phase?: Phase; phaseAt?: number; busy?: boolean }

declare module 'claude-code' {
  interface PluginState {
    relevo: {
      role: Role | null
      log: Handoff[]
      rounds: number
      self: Seat | null
      peer: Seat | null
      frame: number
    }
  }
}
