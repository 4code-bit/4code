/**
 * Envío de tableros a la nube.
 *
 * Sube el **log de operaciones**, no el grafo entero: cada una lleva su `seq` y
 * el servidor descarta las que ya vio. Eso lo hace idempotente, barato y
 * tolerante a cortes — se puede reenviar desde cualquier punto sin miedo.
 *
 * **Inactivo mientras no haya token configurado.** Sin él, 4Code sigue siendo
 * exactamente lo que era: local y nada más. Eso no es un detalle de comodidad,
 * es lo que hace que la nube sea aditiva (§2.4).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProjectRef } from '../../shared/project.ts'
import { HOME, PROJECTS_DIR } from './paths.ts'
import type { AppliedRecord } from './store.ts'

const log = (...args: unknown[]) => console.error('[sync]', ...args)

const CONFIG_FILE = join(HOME, 'config.json')

/** Agrupa los envíos: en un mapeo inicial llegan decenas de operaciones seguidas. */
const DEBOUNCE_MS = 2000
const MAX_LOTE = 200
const REINTENTOS = [5_000, 15_000, 60_000, 300_000]

export interface CloudConfig {
  apiUrl: string
  token: string
  /**
   * Con qué cuenta de GitHub quedó vinculada esta máquina.
   *
   * No se usa para nada funcional —el permiso lo decide el token— y existe solo para
   * poder **enseñarlo**. Vincular con una cuenta y tener el acceso del repositorio en
   * otra es el error que más tiempo cuesta, y hasta ahora la terminal solo podía
   * enseñar el prefijo del token, que no le dice nada a nadie.
   */
  login?: string
}

/** El fichero tal cual: la nube es lo principal, pero no lo único que guarda. */
interface RawConfig {
  apiUrl?: string
  token?: string
  /** Con qué cuenta de GitHub se vinculó. Solo para poder enseñarlo. */
  login?: string
  /** Abrir el tablero en el navegador al empezar una sesión. Por defecto, sí. */
  openBoard?: boolean
}

/**
 * La configuración se sigue consultando en cada operación —de eso depende que
 * vincular una máquina no obligue a reiniciar el canvas-server—, pero solo se
 * parsea cuando el fichero ha cambiado de verdad.
 *
 * `enqueue()` se llama una vez por operación aplicada, así que mapear un proyecto
 * de ochenta nodos suponía ciento sesenta lecturas del mismo fichero de 92 bytes.
 * El `statSync` se mantiene siempre: es lo que hace que un `login` surta efecto
 * en la siguiente operación, sin avisar a nadie.
 */
let cacheConfig: { mtimeMs: number; size: number; raw: RawConfig | null } | null = null

function readRaw(): RawConfig | null {
  try {
    const { mtimeMs, size } = statSync(CONFIG_FILE)
    if (cacheConfig && cacheConfig.mtimeMs === mtimeMs && cacheConfig.size === size) {
      return cacheConfig.raw
    }

    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as RawConfig
    cacheConfig = { mtimeMs, size, raw }
    return raw
  } catch {
    // Sin fichero (o ilegible) no hay nube. Se olvida lo cacheado: `logout` borra
    // el fichero, y seguir devolviendo la configuración anterior sería seguir
    // sincronizando después de haber desvinculado la máquina.
    cacheConfig = null
    return null
  }
}

export function readConfig(): CloudConfig | null {
  const raw = readRaw()
  return raw?.apiUrl && raw.token
    ? {
        apiUrl: raw.apiUrl.replace(/\/+$/, ''),
        token: raw.token,
        ...(raw.login && { login: raw.login }),
      }
    : null
}

/**
 * ¿Se puede abrir el tablero en el navegador? Por defecto sí, y esto es el «no».
 *
 * Se lee aparte de `readConfig()` porque una máquina sin vincular no tiene nube
 * pero sí tiene tablero: la preferencia no puede depender de haber hecho `login`.
 */
export function openBoardWanted(): boolean {
  return readRaw()?.openBoard !== false
}

export function writeConfig(config: CloudConfig): void {
  mkdirSync(HOME, { recursive: true })
  // Se fusiona con lo que ya hubiera: un `login` no puede borrar de paso una
  // preferencia que el usuario dejó puesta a mano en el mismo fichero.
  const previo = readRaw() ?? {}
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...previo, ...config }, null, 2), 'utf8')
  // Por si el fichero nuevo mide lo mismo y cae en el mismo milisegundo que la
  // última lectura: dentro de este proceso no hace falta adivinarlo por el mtime.
  cacheConfig = null
}

/** Último `seq` que la nube confirmó, por proyecto. */
function markerPath(projectId: string): string {
  return join(PROJECTS_DIR, projectId, 'sync.json')
}

export function readAcked(projectId: string): number {
  try {
    return (JSON.parse(readFileSync(markerPath(projectId), 'utf8')) as { acked?: number }).acked ?? 0
  } catch {
    return 0
  }
}

export function writeAcked(projectId: string, acked: number): void {
  try {
    writeFileSync(markerPath(projectId), JSON.stringify({ acked, at: Date.now() }), 'utf8')
  } catch (err) {
    log('no se pudo guardar la marca de sincronización:', err)
  }
}

interface Cola {
  project: ProjectRef
  pendientes: AppliedRecord[]
  temporizador: ReturnType<typeof setTimeout> | null
  intento: number
  enVuelo: boolean
}

const colas = new Map<string, Cola>()

/**
 * Encola una operación ya aplicada en local.
 *
 * No hace nada si no hay token, o si el proyecto no tiene remoto de GitHub: sin
 * remoto la nube no tendría de dónde sacar los permisos, así que ese tablero se
 * queda en casa.
 */
export function enqueue(project: ProjectRef, record: AppliedRecord): void {
  if (!readConfig() || !project.remote?.startsWith('github.com/')) return

  let cola = colas.get(project.id)
  if (!cola) {
    cola = { project, pendientes: [], temporizador: null, intento: 0, enVuelo: false }
    colas.set(project.id, cola)
  }
  cola.project = project
  cola.pendientes.push(record)
  programar(cola, DEBOUNCE_MS)
}

function programar(cola: Cola, ms: number): void {
  if (cola.temporizador) clearTimeout(cola.temporizador)
  cola.temporizador = setTimeout(() => void enviar(cola), ms)
  // Un envío pendiente no debe impedir que el proceso termine.
  cola.temporizador.unref?.()
}

async function enviar(cola: Cola): Promise<void> {
  const config = readConfig()
  if (!config || cola.enVuelo || cola.pendientes.length === 0) return

  cola.enVuelo = true
  const acked = readAcked(cola.project.id)
  const lote = cola.pendientes.filter((r) => r.seq > acked).slice(0, MAX_LOTE)

  if (lote.length === 0) {
    cola.pendientes = []
    cola.enVuelo = false
    return
  }

  try {
    const res = await fetch(`${config.apiUrl}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        project: { id: cola.project.id, remote: cola.project.remote, name: cola.project.name },
        operations: lote,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (res.status === 401) {
      // Token revocado desde la web. Dejar de intentarlo y no volver a encolar
      // hasta que haya uno nuevo; reintentar sería ruido infinito.
      log('token rechazado: la sincronización queda parada hasta reconfigurarla')
      cola.pendientes = []
      cola.enVuelo = false
      return
    }

    if (!res.ok) throw new Error(`la API respondió ${res.status}`)

    const { seq } = (await res.json()) as { seq: number }
    writeAcked(cola.project.id, seq)
    cola.pendientes = cola.pendientes.filter((r) => r.seq > seq)
    cola.intento = 0
    cola.enVuelo = false

    // Quedaba más de lo que cabía en un lote.
    if (cola.pendientes.length > 0) programar(cola, 200)
  } catch (err) {
    cola.enVuelo = false
    const espera = REINTENTOS[Math.min(cola.intento, REINTENTOS.length - 1)]!
    cola.intento++
    log(`envío fallido (${String(err)}); reintento en ${espera / 1000}s`)
    programar(cola, espera)
  }
}

/**
 * Al arrancar, reenvía lo que quedó sin confirmar.
 *
 * Es lo que hace que un corte de red o un cierre a media sincronización no
 * pierdan nada: la fuente de verdad es el `history.jsonl` local, y desde él se
 * puede reconstruir cualquier hueco.
 */
export function resume(project: ProjectRef, history: AppliedRecord[]): void {
  if (!readConfig() || !project.remote?.startsWith('github.com/')) return

  const acked = readAcked(project.id)
  const pendientes = history.filter((r) => r.seq > acked)
  if (pendientes.length === 0) return

  log(`${project.name}: ${pendientes.length} operación(es) sin sincronizar, reenviando`)
  for (const record of pendientes) enqueue(project, record)
}

/** ¿Está configurada la sincronización? Para informar en `/health`. */
export function status(): { enabled: boolean; apiUrl?: string } {
  const config = readConfig()
  return config ? { enabled: true, apiUrl: config.apiUrl } : { enabled: false }
}
