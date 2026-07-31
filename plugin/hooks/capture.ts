/**
 * Hook de captura. El canal de coste cero de §2.3.
 *
 * Claude Code lo ejecuta en cada evento y le pasa el payload por stdin. De ahí
 * salen sesiones, herramientas, ficheros tocados y subagentes sin gastar un solo
 * token.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ESTE FICHERO ES DONDE SE HACE CUMPLIR EL CONTRATO DE DATOS (§2.2).
 *
 *  El payload trae `tool_input` y `tool_output` ENTEROS: el `new_string` de
 *  cada edición, el contenido de cada `Write`, el `command` de cada `Bash`, el
 *  resultado de cada `Read`. Y `UserPromptSubmit` trae el prompt literal.
 *
 *  Nada de eso puede sobrevivir a este fichero. El filtro es una ALLOWLIST: se
 *  construye un objeto nuevo con los campos permitidos, en vez de copiar el
 *  payload y borrar lo que sobra. Copiar-y-borrar falla en silencio en cuanto
 *  Claude Code añade un campo; construir de cero, no.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nunca escribe a stdout (Claude Code interpretaría lo que salga) y nunca falla
 * de forma ruidosa: si algo va mal, se pierde un evento y la sesión sigue.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { PermissionMode, SessionEvent } from '../shared/session.ts'
import { detectProject } from '../server/src/project.ts'
import { PROJECTS_DIR } from '../server/src/paths.ts'

/** Campos de `tool_input` de los que puede salir una ruta. Nada más se mira. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const

const MODES = new Set<PermissionMode>([
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
])

interface HookPayload {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  permission_mode?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  agent_type?: string
  source?: string
  reason?: string
  trigger?: string
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      data += c
      // Un payload gigante solo puede ser contenido, que no queremos ni leer.
      if (data.length > 2_000_000) {
        process.stdin.pause()
        res(data.slice(0, 2_000_000))
      }
    })
    process.stdin.on('end', () => res(data))
    process.stdin.on('error', () => res(''))
  })
}

/**
 * Ruta relativa a la raíz del proyecto, o nada.
 *
 * Se descarta lo que caiga fuera del proyecto: una ruta absoluta de otro sitio
 * puede filtrar el nombre de un cliente, y eso es exactamente lo que el contrato
 * de datos promete que no pasa.
 */
function relativePath(raw: unknown, root: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400) return undefined
  const absolute = isAbsolute(raw) ? raw : resolve(root, raw)
  const rel = relative(root, absolute).replace(/\\/g, '/')

  // Tres condiciones, y la tercera no es paranoia: en Windows, `relative` entre
  // unidades distintas (F: → C:) no puede construir una ruta relativa y devuelve
  // la ABSOLUTA tal cual, que no empieza por '..' y colaría el filtro. Así es
  // como se escaparía la ruta de un cliente que viva en otro disco.
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel
}

function mode(raw: unknown): PermissionMode | undefined {
  return typeof raw === 'string' && MODES.has(raw as PermissionMode)
    ? (raw as PermissionMode)
    : undefined
}

/** Cadena corta de una lista cerrada. Nunca texto libre del usuario. */
function shortLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!value || value.length > 64) return undefined
  return /^[\w.:@/-]+$/.test(value) ? value : undefined
}

/**
 * El filtro. Construye el evento desde cero con los campos permitidos.
 *
 * Exportado para poder verificarlo sin lanzar procesos: la comprobación de que
 * ningún contenido sobrevive es la prueba bloqueante de este tramo.
 */
export function toEvent(
  payload: HookPayload,
  root: string,
  now: number,
  branch?: string | null,
): SessionEvent | null {
  const sessionId = shortLabel(payload.session_id)
  if (!sessionId) return null

  const base = {
    at: now,
    sessionId,
    ...(mode(payload.permission_mode) && { mode: mode(payload.permission_mode)! }),
    ...(branch && { branch }),
  }

  switch (payload.hook_event_name) {
    case 'SessionStart':
      return { ...base, kind: 'session_start', ...(shortLabel(payload.source) && { source: shortLabel(payload.source)! }) }

    case 'SessionEnd':
      return { ...base, kind: 'session_end', ...(shortLabel(payload.reason) && { reason: shortLabel(payload.reason)! }) }

    case 'SubagentStart':
    case 'SubagentStop':
      return {
        ...base,
        kind: payload.hook_event_name === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
        ...(shortLabel(payload.agent_type) && { agentType: shortLabel(payload.agent_type)! }),
      }

    case 'PreCompact':
      return { ...base, kind: 'compact', ...(shortLabel(payload.trigger) && { reason: shortLabel(payload.trigger)! }) }

    case 'PostToolUse': {
      const tool = shortLabel(payload.tool_name)
      if (!tool) return null

      // Del `tool_input` solo se miran los campos de ruta. `new_string`,
      // `content`, `command`, `old_string`, `prompt`… no se leen siquiera.
      let path: string | undefined
      for (const field of PATH_FIELDS) {
        path = relativePath(payload.tool_input?.[field], root)
        if (path) break
      }

      return {
        ...base,
        kind: 'tool',
        tool,
        ...(path && { path, ext: extname(path).slice(1) || undefined }),
      }
    }

    // Todo lo demás se ignora, incluido UserPromptSubmit: no hay forma segura de
    // registrar un prompt, así que no se registra.
    default:
      return null
  }
}

async function main(): Promise<void> {
  const raw = await readStdin()
  if (!raw.trim()) return

  const payload = JSON.parse(raw) as HookPayload
  const project = detectProject(payload.cwd || process.cwd())
  const event = toEvent(payload, project.root, Date.now(), project.branch)
  if (!event) return

  const dir = join(PROJECTS_DIR, project.id)
  mkdirSync(dir, { recursive: true })

  // A disco y no por HTTP: el canvas-server puede no estar vivo mientras Claude
  // trabaja, y perder la sesión entera por eso sería absurdo. Append de una
  // línea, sin red y sin lockfile de por medio.
  appendFileSync(join(dir, 'sessions.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')

  // El proyecto puede no tener `project.json` todavía si los hooks corren antes
  // de que Claude diagrame nada. Sin esto, la sesión no aparecería en la web.
  const metaPath = join(dir, 'project.json')
  try {
    const { existsSync, writeFileSync } = await import('node:fs')
    // Sin el branch: es dinámico y congelarlo aquí sería peor que no tenerlo.
    const { branch: _dinamico, ...estable } = project
    if (!existsSync(metaPath)) writeFileSync(metaPath, JSON.stringify(estable, null, 2), 'utf8')
  } catch {
    /* no es crítico */
  }
}

// Un hook que peta no debe estropearle la sesión a nadie: se pierde un evento y
// ya. Y nunca sale nada por stdout, que Claude Code interpretaría.
main().catch(() => {})
