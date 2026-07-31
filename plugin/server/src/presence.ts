/**
 * Latido de presencia hacia la nube: en qué rama estás y en qué capa andas.
 *
 * Es la mitad de §4.2 que git NO puede dar, porque describe lo que estás
 * haciendo ahora y no lo que ya has publicado.
 *
 * Tres cosas que gobiernan el diseño:
 *
 *  1. **Solo se envía tu propia presencia.** Nunca la de otros.
 *  2. **Se apaga solo.** Sin token de sincronización no late; y aunque lo haya,
 *     `FOURCODE_PRESENCE=off` lo desactiva sin tocar nada más (§2.4: lo de
 *     equipo es aditivo y desactivable, o no es).
 *  3. **Metadatos, nunca contenido.** Rama y capa. Ni ficheros concretos, ni
 *     nombres de fichero: para saber que dos personas van a chocar basta con la
 *     rama, y el detalle ya lo da git en local sin salir de la máquina.
 */
import { deriveLayer, type WorkLayer } from '../../shared/layer.ts'
import type { ProjectRef } from '../../shared/project.ts'
import { readEvents } from './sessions.ts'
import { readConfig } from './sync.ts'

const log = (...args: unknown[]) => console.error('[presence]', ...args)

/** Lo bastante frecuente para ser útil, lo bastante espaciado para no molestar. */
const LATIDO_MS = 60_000
/** Sin actividad reciente no se late: nadie quiere aparecer activo mientras come. */
const INACTIVO_MS = 5 * 60 * 1000

const timers = new Map<string, ReturnType<typeof setInterval>>()

function activada(): boolean {
  return (process.env.FOURCODE_PRESENCE ?? '').toLowerCase() !== 'off' && readConfig() !== null
}

async function latir(project: ProjectRef): Promise<void> {
  const config = readConfig()
  if (!config || !project.remote?.startsWith('github.com/')) return

  const eventos = readEvents(project.id)
  const ultimo = eventos.at(-1)?.at ?? 0
  if (Date.now() - ultimo > INACTIVO_MS) return

  const layer: WorkLayer = deriveLayer(eventos, Date.now())

  try {
    await fetch(`${config.apiUrl}/api/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        boardId: project.id,
        remote: project.remote,
        branch: project.branch ?? null,
        layer,
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    // Un latido perdido no importa: el siguiente llega en un minuto y el
    // registro caduca solo.
  }
}

export function startPresence(project: ProjectRef): void {
  if (!activada() || timers.has(project.id)) return

  void latir(project)
  const t = setInterval(() => void latir(project), LATIDO_MS)
  t.unref?.()
  timers.set(project.id, t)
  log(`presencia activa para ${project.name}`)
}

export function stopPresence(): void {
  for (const t of timers.values()) clearInterval(t)
  timers.clear()
}
