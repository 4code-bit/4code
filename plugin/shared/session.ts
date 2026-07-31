/**
 * Eventos de sesión capturados por hooks.
 *
 * Este es el canal de coste cero de §2.3: sesiones, herramientas, ficheros y
 * subagentes salen de aquí sin gastar un token y sin depender de que Claude se
 * acuerde de contar nada.
 *
 * LO QUE NO ESTÁ EN ESTE TIPO ES TAN IMPORTANTE COMO LO QUE ESTÁ. Los hooks
 * reciben `tool_input` y `tool_output` completos — el texto de cada edición, el
 * contenido de cada fichero leído, el comando de cada Bash — y nada de eso puede
 * sobrevivir al filtro (§2.2). Si algún día hace falta un campo nuevo aquí, la
 * pregunta es si un script podría derivarlo de metadatos; si la respuesta es que
 * necesita contenido, la respuesta es que no va.
 */

/** Los modos de permiso de Claude Code. `plan` es el que delata la capa. */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

export type SessionEventKind =
  | 'session_start'
  | 'tool'
  | 'subagent_start'
  | 'subagent_stop'
  | 'compact'
  | 'session_end'

export interface SessionEvent {
  at: number
  sessionId: string
  kind: SessionEventKind
  mode?: PermissionMode
  /** Nombre de la herramienta. Nunca sus argumentos. */
  tool?: string
  /** Ruta RELATIVA a la raíz del proyecto. Una absoluta filtraría nombres de cliente. */
  path?: string
  ext?: string
  agentType?: string
  /** De SessionStart: startup | resume | clear | compact | fork */
  source?: string
  /** De SessionEnd, o el trigger de una compactación. */
  reason?: string
  /**
   * Branch en el momento del evento. Va aquí y no en la identidad del proyecto
   * porque cambia durante la sesión — y es la mitad de la correlación
   * *(repo, branch)* que §4.2 necesita para saber quién trabaja en lo mismo.
   */
  branch?: string
}

import type { WorkLayer } from './layer.ts'

/** Sesión reconstruida a partir de sus eventos. */
export interface SessionSummary {
  sessionId: string
  startedAt: number
  lastAt: number
  endedAt?: number
  source?: string
  endReason?: string
  /** Cuántas veces se usó cada herramienta. */
  tools: Record<string, number>
  files: string[]
  subagents: Record<string, number>
  compactions: number
  events: number
}

/** Lo que devuelve `/sessions`: el resumen más la capa derivada (§4.3). */
export interface SessionWithLayer extends SessionSummary {
  layer: WorkLayer
}
