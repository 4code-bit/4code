/**
 * Lectura y agregación de los eventos que escriben los hooks.
 *
 * El fichero lo escribe `hooks/capture.ts` desde otro proceso, así que aquí solo
 * se lee. Y se lee **de forma incremental**, porque es append-only: cuando crece,
 * los bytes anteriores son los mismos de antes y solo hay que leer la cola nueva.
 *
 * Esto importa más de lo que parece. La web sondea esta vista cada tres segundos
 * y cada llamada de herramienta de Claude añade una línea, así que la caché por
 * huella fallaba casi siempre justo mientras se está mirando — y cada fallo
 * costaba releer el fichero entero y parsear cada línea. En el proyecto más
 * grande de esta máquina eran 164 KB y 1.021 `JSON.parse` para enterarse de un
 * evento de 155 bytes.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { SessionEvent, SessionWithLayer } from '../../shared/session.ts'
import { deriveLayer } from '../../shared/layer.ts'
import { PROJECTS_DIR } from './paths.ts'

const log = (...args: unknown[]) => console.error('[sessions]', ...args)

interface Cached {
  mtimeMs: number
  size: number
  events: SessionEvent[]
  /**
   * Lo que quedó después del último salto de línea, **en bytes**.
   *
   * Dos motivos, y los dos se aprenden fallando:
   *
   * 1. Si una lectura pilla a un hook a mitad de un append, la última línea está
   *    incompleta. Sin guardarla para pegarle su continuación, ese evento se
   *    perdería para siempre del array cacheado.
   * 2. Y va en bytes y no en texto porque el corte puede caer **dentro** de un
   *    carácter multibyte: decodificar cada trozo por separado convierte una `é`
   *    partida en dos caracteres de reemplazo, y la ruta llega corrupta. Se juntan
   *    los bytes y se decodifica una sola vez, cuando la línea está entera.
   */
  tail: Buffer
}

/** `\n`. Nunca aparece dentro de una secuencia UTF-8, así que buscarlo es seguro. */
const NL = 0x0a

const cache = new Map<string, Cached>()

/**
 * Emite las líneas completas del fragmento y devuelve los bytes que sobran.
 *
 * Lo que no acaba en salto de línea **no se emite**. El hook escribe
 * `JSON.stringify(event) + '\n'` de una sola llamada (`hooks/capture.ts:189`), así
 * que un final sin salto solo puede ser una escritura pillada a medias: emitirla
 * sería adivinar, y guardarla es exactamente para qué existe `tail`.
 */
function procesar(chunk: Buffer, into: SessionEvent[]): Buffer {
  const corte = chunk.lastIndexOf(NL)
  // Ni una línea entera todavía: todo queda pendiente para la próxima vez.
  if (corte === -1) return Buffer.from(chunk)

  for (const linea of chunk.subarray(0, corte + 1).toString('utf8').split('\n')) {
    if (!linea.trim()) continue
    try {
      into.push(JSON.parse(linea) as SessionEvent)
    } catch {
      // Los hooks corren en paralelo y en procesos distintos; una línea a medias
      // es posible aunque raro. Se descarta esa, no el fichero.
    }
  }

  // Copia, no vista: el buffer de origen es grande y no hay que retenerlo entero
  // por guardar sus últimos bytes.
  return Buffer.from(chunk.subarray(corte + 1))
}

/** Lee `[desde, hasta)` del fichero, sin traerse el resto. */
function leerRango(file: string, desde: number, hasta: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(hasta - desde)
    const leidos = readSync(fd, buffer, 0, buffer.length, desde)
    return buffer.subarray(0, leidos)
  } finally {
    closeSync(fd)
  }
}

export function readEvents(projectId: string): SessionEvent[] {
  const file = join(PROJECTS_DIR, projectId, 'sessions.jsonl')
  if (!existsSync(file)) return []

  try {
    const { mtimeMs, size } = statSync(file)
    const hit = cache.get(projectId)
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.events

    /**
     * Si el fichero **creció**, se lee solo lo nuevo. Si encogió —truncado, o una
     * rotación futura— la caché ya no describe este fichero y se lee completo.
     */
    if (hit && size > hit.size) {
      const events = hit.events
      const tail = procesar(Buffer.concat([hit.tail, leerRango(file, hit.size, size)]), events)
      // El orden se rehace igual: los appends llegan casi ordenados, pero dos
      // hooks concurrentes pueden invertirse por milisegundos. Sobre un array casi
      // ordenado esto es lineal — no es lo que hay que optimizar aquí.
      events.sort((a, b) => a.at - b.at)
      cache.set(projectId, { mtimeMs, size, events, tail })
      return events
    }

    const events: SessionEvent[] = []
    const tail = procesar(readFileSync(file), events)
    events.sort((a, b) => a.at - b.at)
    cache.set(projectId, { mtimeMs, size, events, tail })
    return events
  } catch (err) {
    log(`no se pudo leer las sesiones de ${projectId}:`, err)
    return []
  }
}

/** Para las verificaciones: obliga a la siguiente lectura a partir de cero. */
export function forgetCachedEvents(projectId?: string): void {
  if (projectId) cache.delete(projectId)
  else cache.clear()
}

export function summarize(events: SessionEvent[]): SessionWithLayer[] {
  const byId = new Map<string, SessionEvent[]>()
  for (const event of events) {
    const list = byId.get(event.sessionId) ?? []
    list.push(event)
    byId.set(event.sessionId, list)
  }

  const out: SessionWithLayer[] = []

  for (const [sessionId, own] of byId) {
    const tools: Record<string, number> = {}
    const subagents: Record<string, number> = {}
    const files = new Set<string>()
    let compactions = 0
    let source: string | undefined
    let endReason: string | undefined
    let endedAt: number | undefined

    for (const e of own) {
      switch (e.kind) {
        case 'session_start':
          source = e.source
          break
        case 'session_end':
          endedAt = e.at
          endReason = e.reason
          break
        case 'tool':
          if (e.tool) tools[e.tool] = (tools[e.tool] ?? 0) + 1
          if (e.path) files.add(e.path)
          break
        case 'subagent_start':
          if (e.agentType) subagents[e.agentType] = (subagents[e.agentType] ?? 0) + 1
          break
        case 'compact':
          compactions++
          break
      }
    }

    // La capa se calcula sobre el final de la sesión, que es lo que responde
    // "¿en qué andaba?". `deriveLayer` ya aplica su propia ventana.
    const lastAt = own[own.length - 1]!.at

    out.push({
      sessionId,
      startedAt: own[0]!.at,
      lastAt,
      ...(endedAt !== undefined && { endedAt }),
      ...(source && { source }),
      ...(endReason && { endReason }),
      tools,
      files: [...files],
      subagents,
      compactions,
      events: own.length,
      layer: deriveLayer(own, lastAt),
    })
  }

  // Lo más reciente primero: al abrir la vista se quiere ver la sesión de ahora.
  return out.sort((a, b) => b.lastAt - a.lastAt)
}

export function sessionsOf(projectId: string): SessionWithLayer[] {
  return summarize(readEvents(projectId))
}
