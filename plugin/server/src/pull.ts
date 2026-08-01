/**
 * Bajada de tableros desde la nube.
 *
 * El reverso de `sync.ts`, y la pieza que faltaba para que dos personas vean el
 * mismo tablero. Hasta ahora los datos subían y no bajaban: cada tablero local se
 * alimentaba solo de su propia máquina, así que dos compañeros trabajando en el
 * mismo repositorio veían dos diagramas que no convergían nunca. `/4code:team`
 * funcionaba porque lee git, un canal que ya compartían; el tablero no tenía
 * ninguno.
 *
 * **No hace falta inventar el transporte**: `GET /api/boards/<id>/ops?after=<seq>`
 * ya existía con cursor incremental y paginación, y el `seq` que devuelve ya es el
 * del servidor precisamente porque se pensó para varias máquinas alimentando el
 * mismo tablero. Lo único que faltaba era alguien que lo consumiera en bucle en
 * vez de una vez a mano, que es lo que hacía `restore`.
 *
 * **Y no rompe §2.1.** Lo que ese principio protege es que la web no meta
 * instrucciones en el Claude de nadie. Aquí lo que baja son nodos: un canal de
 * datos, no de control. Nada de lo que entra por aquí se ejecuta.
 *
 * **Inactivo sin token**, igual que `sync.ts`. Sin vincular, 4Code sigue siendo
 * local y nada más — es lo que mantiene la nube aditiva (§2.4).
 */
import type { Operation } from '../../shared/diagram.ts'
import type { ProjectRef } from '../../shared/project.ts'
import { readConfig, readRemoteAcked, writeRemoteAcked } from './sync.ts'

const log = (...args: unknown[]) => console.error('[pull]', ...args)

/**
 * Se sondea despacio, y más despacio todavía si nadie mira.
 *
 * Es la misma lección que costó doce procesos de git en 140 segundos (§4.11): un
 * tablero que nadie tiene abierto no necesita estar al día al segundo, solo
 * necesita estarlo cuando alguien lo abra. La diferencia se paga en peticiones
 * contra la nube, que sí cuestan dinero.
 */
const ACTIVO_MS = 20_000
const FONDO_MS = 180_000
const REINTENTOS = [10_000, 30_000, 120_000, 600_000]

/** Una operación tal y como la devuelve la nube. El `seq` es del servidor. */
export interface RemoteOperation {
  seq: number
  at: number
  operation: Operation
  branch?: string
  author?: string
}

export interface PullHooks {
  /** Aplica lo bajado al tablero local. Solo se llama si hay algo que aplicar. */
  aplicar: (project: ProjectRef, operaciones: RemoteOperation[]) => void
  /** ¿Hay alguien con este tablero abierto? Decide el ritmo, nada más. */
  hayPublico: (projectId: string) => boolean
}

interface Ciclo {
  project: ProjectRef
  temporizador: ReturnType<typeof setTimeout> | null
  intento: number
  enVuelo: boolean
  /** Un 401 para el ciclo del todo: reintentar sería ruido infinito. */
  detenido: boolean
}

const ciclos = new Map<string, Ciclo>()

/**
 * Empieza a escuchar el tablero de un proyecto.
 *
 * Se llama al abrir el store, junto a `resume()`: el mismo momento en que se
 * decide que este proyecto habla con la nube.
 */
export function start(project: ProjectRef, hooks: PullHooks): void {
  if (!readConfig() || !project.remote?.startsWith('github.com/')) return
  if (ciclos.has(project.id)) return

  const ciclo: Ciclo = {
    project,
    temporizador: null,
    intento: 0,
    enVuelo: false,
    detenido: false,
  }
  ciclos.set(project.id, ciclo)
  // La primera pasada va enseguida: si un compañero ya dibujó, no tiene sentido
  // enseñar un tablero vacío durante veinte segundos.
  programar(ciclo, hooks, 1_000)
}

export function stopAll(): void {
  for (const ciclo of ciclos.values()) {
    if (ciclo.temporizador) clearTimeout(ciclo.temporizador)
  }
  ciclos.clear()
}

function programar(ciclo: Ciclo, hooks: PullHooks, ms: number): void {
  if (ciclo.temporizador) clearTimeout(ciclo.temporizador)
  ciclo.temporizador = setTimeout(() => void tirar(ciclo, hooks), ms)
  // Un sondeo pendiente no debe impedir que el proceso termine.
  ciclo.temporizador.unref?.()
}

async function tirar(ciclo: Ciclo, hooks: PullHooks): Promise<void> {
  const config = readConfig()
  if (!config || ciclo.enVuelo || ciclo.detenido) return

  ciclo.enVuelo = true
  const { project } = ciclo

  try {
    let cursor = readRemoteAcked(project.id)
    let quedaMas = true
    let bajadas = 0

    /**
     * Se pagina hasta agotar. El cursor se guarda DESPUÉS de aplicar cada
     * página, no antes: si el proceso muere a mitad, la siguiente vuelta repite
     * esa página. Repetir es inofensivo —los ids son estables y re-aplicar una
     * operación es idempotente— mientras que saltársela perdería piezas.
     */
    while (quedaMas) {
      const url =
        `${config.apiUrl}/api/boards/${encodeURIComponent(project.id)}/ops` +
        `?after=${cursor}&others=1`

      const res = await fetch(url, {
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(15_000),
      })

      if (res.status === 401) {
        log('token rechazado: la bajada queda parada hasta reconfigurarla')
        ciclo.detenido = true
        return
      }

      /**
       * 402: el tablero no tiene plan de equipo.
       *
       * No es un fallo, así que no entra en el backoff: reintentarlo cada diez
       * segundos sería pedirle a la nube que repita un «no» que no va a cambiar
       * hasta que alguien pague. Se para y ya está.
       *
       * Y no rompe nada: el tablero local sigue funcionando entero, con lo que
       * dibuja esta máquina. Lo que no llega es lo de los demás — que es
       * exactamente lo que se paga.
       */
      if (res.status === 402) {
        log('este tablero no incluye trabajo en equipo: la bajada queda parada')
        ciclo.detenido = true
        return
      }

      /**
       * 404 no es un error que merezca reintentos rápidos. Significa una de dos:
       * este repositorio todavía no tiene tablero arriba, o esta cuenta no lo
       * alcanza. Las dos responden igual a propósito (§4.13), y en ninguna hay
       * nada que esperar en diez segundos.
       */
      if (res.status === 404) {
        quedaMas = false
        break
      }

      if (!res.ok) throw new Error(`la API respondió ${res.status}`)

      const datos = (await res.json()) as { operations?: RemoteOperation[]; more?: boolean }
      const operaciones = datos.operations ?? []

      if (operaciones.length > 0) {
        hooks.aplicar(project, operaciones)
        cursor = operaciones[operaciones.length - 1]!.seq
        writeRemoteAcked(project.id, cursor)
        bajadas += operaciones.length
      }

      quedaMas = Boolean(datos.more) && operaciones.length > 0
    }

    if (bajadas > 0) log(`${project.name}: ${bajadas} operación(es) de otras máquinas`)
    ciclo.intento = 0
    programar(ciclo, hooks, hooks.hayPublico(project.id) ? ACTIVO_MS : FONDO_MS)
  } catch (err) {
    const espera = REINTENTOS[Math.min(ciclo.intento, REINTENTOS.length - 1)]!
    ciclo.intento++
    log(`bajada fallida (${String(err)}); reintento en ${espera / 1000}s`)
    programar(ciclo, hooks, espera)
  } finally {
    ciclo.enVuelo = false
  }
}
