/**
 * Qué sabe hacer con TypeScript el Node que hay delante.
 *
 * Sin efectos secundarios y sin `await` de primer nivel **a propósito**: lo importan
 * tanto el lanzador (`launch.mjs`) como los ficheros que el lanzador ejecuta. Si esto
 * viviera dentro de `launch.mjs`, la importación sería circular: el lanzador estaría
 * esperando a que el `.ts` cargue mientras el `.ts` espera a que el lanzador termine
 * de evaluarse. Node lo resuelve saliendo con código 13 y la salida a medias, que es
 * exactamente lo que pasó la primera vez que se escribió.
 */

const [mayor, menor] = process.versions.node.split('.').map(Number)

const nativoPorVersion = mayor > 23 || (mayor === 23 && menor >= 6) || (mayor === 22 && menor >= 18)

/**
 * `FOURCODE_NODE_TS` fuerza una de las tres vías en cualquier Node: `nativo`, `flag`
 * (la de Node 22.6-22.17) o cualquier otra cosa —`viejo`— para la de «no puedo».
 *
 * No es una comodidad: sin esto, el soporte a Node 22 y el mensaje de Node demasiado
 * viejo son ramas que en la máquina de quien las escribió **nunca se ejecutan**, y una
 * vía de compatibilidad sin probar es una vía que no funciona. El flag sigue aceptado
 * en Node 24, así que la verificación las recorre de verdad y no de mentira.
 */
const forzado = process.env.FOURCODE_NODE_TS

/** Ejecuta `.ts` sin pedir permiso: 22.18+ y 23.6+. */
export const NATIVO = forzado ? forzado === 'nativo' : nativoPorVersion
/** Lo ejecuta, pero hay que pedírselo: 22.6 – 22.17. */
export const CON_FLAG = !NATIVO && (forzado ? forzado === 'flag' : mayor === 22 && menor >= 6)
export const FLAG = '--experimental-strip-types'

/**
 * Los argumentos con los que lanzar un `.ts` en ESTE Node.
 *
 * Lo usa `server/src/ensure.ts` para arrancar el canvas-server: un proceso que
 * necesitó el flag para arrancar NO se lo pasa a sus hijos, así que sin esto el
 * canvas moría en silencio en Node 22 aunque quien lo lanzaba estuviera vivo.
 */
export function nodeArgs(entrada, extra = []) {
  return NATIVO ? [entrada, ...extra] : [FLAG, entrada, ...extra]
}

const DEMASIADO_VIEJO = `
4Code no puede arrancar: necesita Node 22.6 o superior.

Esta máquina tiene Node ${process.versions.node}, que no sabe ejecutar TypeScript sin
compilarlo, y el plugin va sin compilar a propósito.

Instala Node 24 (la versión con soporte a largo plazo) desde https://nodejs.org,
cierra Claude Code y vuelve a abrirlo.
`

/** Corta con un motivo legible en vez de con un error de sintaxis. */
export function exigeNode() {
  if (NATIVO || CON_FLAG) return
  // A stderr: por aquí pasa también el arranque del servidor MCP, y su stdout solo
  // puede llevar mensajes de protocolo.
  console.error(DEMASIADO_VIEJO)
  process.exit(1)
}
