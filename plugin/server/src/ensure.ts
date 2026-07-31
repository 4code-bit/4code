/**
 * Levantar el canvas-server, desde donde haga falta.
 *
 * Esto vivía dentro de `mcp-server.ts`, y por eso el tablero solo existía como
 * efecto secundario de que el modelo dibujara algo: abrías Claude Code, abrías
 * `127.0.0.1:41847` y no había nadie escuchando hasta que Claude tocaba una
 * herramienta. Arrancar un proceso es mecánico y determinista —mirar si un PID
 * está vivo y si no, `spawn`—, así que no tiene por qué pasar por el modelo
 * (§2.3). Sacado aquí, lo usan los dos: el servidor MCP y el hook de sesión.
 *
 * Quien tiene algo que enviar espera con `ensureCanvas()`. Quien solo quiere que
 * el tablero exista usa `startCanvas()` y se va: hacer esperar al arranque de una
 * sesión por un servidor que nadie está mirando todavía no compra nada.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeArgs } from '../../node-ts.mjs'
import { clearLock, isAlive, readLock, type CanvasLock } from './lockfile.ts'
import { HOME } from './paths.ts'

const log = (...args: unknown[]) => console.error('[ensure]', ...args)

const HERE = dirname(fileURLToPath(import.meta.url))
const CANVAS = resolve(HERE, 'canvas-server.ts')
const LOG_FILE = join(HOME, 'canvas.log')

/**
 * Los logs del canvas van a un fichero, no al stderr de quien lo lanzó.
 *
 * Heredar el stderr parece más cómodo hasta que quien lanza es un proceso corto:
 * el canvas sobrevive al padre y **mantiene su tubería abierta**, así que quien
 * leyera ese stderr no ve nunca el final. Con un hook de sesión eso significa un
 * hook que Claude Code cree que no ha terminado. Y además el canvas vive más que
 * el servidor MCP, así que la mitad de sus logs iban a una tubería muerta.
 *
 * Se trunca en cada arranque a propósito: lo que interesa es esta ejecución, y
 * así el fichero no crece sin límite en una máquina que lleva meses trabajando.
 */
function abrirLog(): number | 'ignore' {
  try {
    mkdirSync(HOME, { recursive: true })
    return openSync(LOG_FILE, 'w')
  } catch {
    return 'ignore'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function ping(lock: CanvasLock): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
      signal: AbortSignal.timeout(700),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Arranca uno nuevo y no espera.
 *
 * `env` es para `FOURCODE_OPEN`, que decide si el servidor abre el navegador al
 * quedar listo. Va por entorno y no por argumento porque es el propio servidor
 * quien lo decide —solo él sabe si alguien está ya mirando el tablero— y porque
 * así las verificaciones, que arrancan servidores a docenas, no abren nada.
 */
export function startCanvas(env: Record<string, string> = {}): void {
  log(`arrancando canvas-server… (sus logs, en ${LOG_FILE})`)
  // `nodeArgs`: un proceso que necesitó `--experimental-strip-types` para arrancar
  // NO se lo pasa a sus hijos. Sin esto, en Node 22 el canvas moría en silencio
  // aunque quien lo lanzaba hubiera arrancado bien.
  const child = spawn(process.execPath, nodeArgs(CANVAS), {
    detached: true,
    // stdout a 'ignore' NO es opcional: es lo que garantiza que nada del hijo
    // pueda alcanzar el stdout de quien lo lanzó. Para el servidor MCP eso es la
    // diferencia entre un protocolo válido y una conexión muerta al arrancar.
    stdio: ['ignore', 'ignore', abrirLog()],
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  child.unref()
}

/** Uno vivo, arrancándolo si hace falta. Para quien tiene algo que enviarle. */
export async function ensureCanvas(env: Record<string, string> = {}): Promise<CanvasLock> {
  let lock = readLock()
  if (lock && isAlive(lock) && (await ping(lock))) return lock

  // Un lockfile de un proceso que ya no existe se borra antes de seguir. Si se
  // deja, el bucle de abajo lo relee y hace ping a un puerto muerto en vez de
  // esperar al servidor nuevo. Pasa siempre que el canvas muere sin poder
  // limpiarlo: un apagón, cerrar la terminal, matar el proceso.
  if (lock && !isAlive(lock)) {
    log('lockfile huérfano de un proceso muerto; se descarta')
    clearLock()
  }

  startCanvas(env)
  // Quince segundos, no seis: en un arranque en frío Node tiene que transpilar
  // todos los .ts, y en Windows eso pasa de sobra del segundo y medio.
  for (let i = 0; i < 100; i++) {
    await sleep(150)
    lock = readLock()
    if (lock && (await ping(lock))) {
      log(`canvas-server listo en el puerto ${lock.port}`)
      return lock
    }
  }
  throw new Error('el canvas-server no arrancó a tiempo')
}

/**
 * El que ya está vivo, o `null`. No arranca nada.
 *
 * Es la mitad que necesita quien solo quiere hablar con un tablero que ya exista
 * —el hook, para pedirle que abra la pestaña— sin provocar un arranque.
 */
export async function liveCanvas(): Promise<CanvasLock | null> {
  const lock = readLock()
  if (!lock) return null
  if (!isAlive(lock)) {
    log('lockfile huérfano de un proceso muerto; se descarta')
    clearLock()
    return null
  }
  return (await ping(lock)) ? lock : null
}
