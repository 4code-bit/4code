/**
 * Hook de arranque: que el tablero exista antes de que hagas nada.
 *
 * Antes, el canvas-server solo nacía cuando Claude tocaba una herramienta del
 * tablero, así que el tablero era un efecto secundario de que el modelo hubiera
 * dibujado algo: abrías Claude Code, abrías `127.0.0.1:41847` y no había nadie
 * escuchando. La salida documentada era «pídeme que mapee cualquier cosa», es
 * decir, provocar trabajo del modelo para arrancar un proceso.
 *
 * Mirar si un PID está vivo y, si no, hacer un `spawn` es mecánico y
 * determinista: el canal de coste cero de §2.3, no una tarea para un agente.
 *
 * Dos reglas, las mismas que en `capture.ts`:
 *
 *   1. NUNCA escribe a stdout. El stdout de un hook de SessionStart se inyecta en
 *      el contexto de la sesión, y esto no tiene nada que contarle a Claude.
 *   2. Nunca falla de forma ruidosa. Que el tablero no arranque no puede
 *      estropear una sesión de trabajo.
 */
import { liveCanvas, startCanvas } from '../server/src/ensure.ts'

/**
 * Solo cuando la sesión empieza de verdad.
 *
 * `SessionStart` también dispara al compactar o al limpiar, y ahí el servidor ya
 * está vivo: lo único que quedaría por hacer es abrir una pestaña en mitad del
 * trabajo, que es exactamente lo que nadie ha pedido.
 */
const EMPIEZA = new Set(['startup', 'resume'])

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      data += c
      if (data.length > 100_000) {
        process.stdin.pause()
        res(data)
      }
    })
    process.stdin.on('end', () => res(data))
    process.stdin.on('error', () => res(''))
  })
}

async function main(): Promise<void> {
  let source = 'startup'
  try {
    const raw = await readStdin()
    // Sin payload legible se asume que la sesión empieza: equivocarse hacia
    // «levanta el tablero» es el lado bueno del error.
    source = (JSON.parse(raw) as { source?: string }).source ?? 'startup'
  } catch {
    /* se queda 'startup' */
  }

  // `FOURCODE_OPEN=0` es un «no» duro que gana a todo, y es lo que mantiene la
  // batería de verificación sin abrir navegadores.
  const abrir = EMPIEZA.has(source) && process.env.FOURCODE_OPEN !== '0'

  const vivo = await liveCanvas()

  if (!vivo) {
    // Y no se espera: no hay nada que enviarle. Hacer esperar al arranque de la
    // sesión por un servidor que nadie está mirando todavía no compra nada.
    startCanvas(abrir ? { FOURCODE_OPEN: '1' } : {})
    return
  }

  if (!abrir) return

  // Ya estaba en pie: la decisión de abrir o no es suya, que es quien sabe si
  // hay alguien mirando.
  await fetch(`http://127.0.0.1:${vivo.port}/open`, {
    method: 'POST',
    headers: { 'x-fourcode-token': vivo.token },
    signal: AbortSignal.timeout(3000),
  }).catch(() => {})
}

main().catch(() => {})
