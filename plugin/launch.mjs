/**
 * Lanzador. Ejecuta el TypeScript del plugin en el Node que tenga el usuario.
 *
 *   node launch.mjs server/src/mcp-server.ts [args…]
 *
 * El plugin corre `.ts` sin compilar, y eso depende de la versión de Node: de serie
 * desde 22.18 y 23.6, con `--experimental-strip-types` desde 22.6, y no antes.
 *
 * Sin esto, en Node 22.16 —una LTS perfectamente normal— el plugin estaba **muerto y
 * callado**: el servidor MCP no arrancaba (así que Claude no tenía herramientas de
 * tablero), los hooks fallaban (ni sesiones ni tablero local) y los comandos también.
 * Lo único visible era «failed with exit code 1». Un plugin que no puede funcionar
 * tiene que decir por qué; y si puede, funcionar.
 *
 * **Siempre lanza un proceso hijo**, incluso en el Node que no necesita el flag. La
 * alternativa —importar el fichero aquí mismo y ahorrar el proceso— parece gratis y no
 * lo es: `cloud.ts`, `board.ts` y la batería de verificación terminan con
 * `process.exit()`, y al hacerlo desde dentro de un `await import()` la salida
 * pendiente hacia una tubería se descarta. Se veían seis de treinta y cinco líneas.
 * Un lanzador que se come la salida del comando es peor que no tener lanzador.
 *
 * La decisión de versión vive en `node-ts.mjs` para que los `.ts` puedan importarla
 * sin cerrar un círculo con este fichero.
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { exigeNode, nodeArgs } from './node-ts.mjs'

const AQUI = dirname(fileURLToPath(import.meta.url))

exigeNode()

const [relativa, ...extra] = process.argv.slice(2)
if (!relativa) {
  console.error('uso: node launch.mjs <fichero.ts> [args…]')
  process.exit(2)
}

// `inherit` mantiene los mismos descriptores, así que el protocolo del servidor MCP
// sigue viajando por stdio y la salida de los comandos llega entera.
const hijo = spawn(process.execPath, nodeArgs(resolve(AQUI, relativa), extra), {
  stdio: 'inherit',
  windowsHide: true,
})

hijo.on('error', (err) => {
  console.error('4Code: no se pudo lanzar Node:', err.message)
  process.exit(1)
})

// Reenviar la señal, para que Ctrl+C llegue al proceso de verdad y no se quede un
// canvas-server suelto.
for (const señal of ['SIGINT', 'SIGTERM']) {
  process.on(señal, () => {
    hijo.kill(señal)
  })
}

hijo.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
