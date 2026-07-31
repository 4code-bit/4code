/**
 * VERIFICACIÓN BLOQUEANTE #2 del plan.
 *
 * La spec de MCP (2025-11-25): "The server MUST NOT write anything to its stdout
 * that is not a valid MCP message". Nuestro servidor MCP lanza el canvas-server
 * como hijo, y ese hijo levanta HTTP y WebSocket — justo el patrón que mata la
 * conexión en firebase/genkit#2954, ruvnet/claude-flow#835 y otros.
 *
 * Este test habla JSON-RPC crudo por stdin/stdout, sin el SDK cliente, para poder
 * mirar CADA byte que sale por stdout y comprobar que no hay ni una línea que no
 * sea protocolo.
 *
 *   node verify/mcp-stdout.ts
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeArgs } from '../node-ts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MCP = resolve(HERE, '../server/src/mcp-server.ts')

/**
 * Contra un home y un puerto desechables.
 *
 * Antes corría contra los tableros de verdad: escribía nodos de prueba en el
 * proyecto abierto y, al limpiar, **mataba el canvas-server real** — el que la
 * persona tiene delante mientras trabaja. El lockfile de la prueba vive aquí, así
 * que la limpieza solo puede alcanzar a lo que la prueba levantó.
 */
const HOME = mkdtempSync(join(tmpdir(), '4code-mcp-'))
const PORT = 41995

/**
 * Se arranca **por el lanzador**, exactamente como lo hace `.mcp.json`.
 *
 * Es la diferencia entre probar el servidor y probar el producto: el lanzador mete un
 * proceso más en medio con `stdio: 'inherit'`, y si eso ensuciara stdout con una sola
 * línea, la conexión moriría en el arranque. Aquí se mira cada byte.
 */
const child = spawn(process.execPath, [resolve(HERE, '../launch.mjs'), 'server/src/mcp-server.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, FOURCODE_HOME: HOME, FOURCODE_PORT: String(PORT), FOURCODE_OPEN: '0' },
})
void MCP

const rawStdout: string[] = []
const rawStderr: string[] = []
const parsed: Record<string, unknown>[] = []
const garbage: string[] = []

let buffer = ''
child.stdout.on('data', (chunk: Buffer) => {
  const text = chunk.toString('utf8')
  rawStdout.push(text)
  buffer += text
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const msg = JSON.parse(line) as Record<string, unknown>
      if (msg.jsonrpc !== '2.0') {
        garbage.push(`JSON sin jsonrpc:2.0 → ${line.slice(0, 120)}`)
      } else {
        parsed.push(msg)
      }
    } catch {
      garbage.push(line.slice(0, 200))
    }
  }
})

child.stderr.on('data', (chunk: Buffer) => rawStderr.push(chunk.toString('utf8')))

const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (id: number, ms = 15000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = parsed.find((m) => m.id === id)
    if (hit) return hit
    await sleep(50)
  }
  return null
}

console.log('\n=== 1. handshake initialize ================================')
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-stdout', version: '0.0.0' },
  },
})
const init = await waitFor(1)
console.log(`  respuesta initialize: ${init ? 'recibida' : 'NO RECIBIDA'}`)
if (init) {
  const r = init.result as { serverInfo?: { name?: string }; protocolVersion?: string }
  console.log(`  servidor: ${r?.serverInfo?.name} · protocolo: ${r?.protocolVersion}`)
}

send({ jsonrpc: '2.0', method: 'notifications/initialized' })

console.log('\n=== 2. tools/list ==========================================')
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
const list = await waitFor(2)
const tools = ((list?.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name)
console.log(`  ${tools.length} herramientas: ${tools.join(', ')}`)

console.log('\n=== 3. tools/call — arranca el canvas-server como hijo ======')
console.log('  (este es el momento crítico: HTTP + WebSocket levantándose)')
send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'diagram_node',
    arguments: { kind: 'service', label: 'API', detail: 'Nodo de prueba', path: 'src/api.ts' },
  },
})
const call = await waitFor(3, 20000)
const callText = ((call?.result as { content?: { text?: string }[] })?.content ?? [])
  .map((c) => c.text)
  .join(' ')
console.log(`  respuesta: ${call ? callText : 'NO RECIBIDA'}`)

console.log('\n=== 4. segunda llamada, con el canvas ya vivo ===============')
send({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'diagram_get', arguments: {} },
})
const get = await waitFor(4)
const getText = ((get?.result as { content?: { text?: string }[] })?.content ?? [])
  .map((c) => c.text)
  .join(' ')
console.log(`  estado: ${getText.replace(/\n/g, ' | ') || 'NO RECIBIDO'}`)

/**
 * El canvas ya no es solo hijo nuestro: el hook de sesión también lo levanta
 * (§4.11), así que una sesión larga de Claude puede sobrevivir a varios canvas.
 * Cada arranque genera un token nuevo, y el `ping` no lo detecta —`/health` no pide
 * token—, así que la escritura fallaba con 401 hasta reiniciar Claude Code.
 */
console.log('\n=== 4b. el canvas se reinicia por su cuenta =================')
const antes = JSON.parse(readFileSync(join(HOME, 'canvas.json'), 'utf8')) as { pid: number; token: string }
process.kill(antes.pid, 'SIGKILL')
await sleep(500)
spawn(process.execPath, nodeArgs(resolve(HERE, '../hooks/board-up.ts')), {
  env: { ...process.env, FOURCODE_HOME: HOME, FOURCODE_PORT: String(PORT), FOURCODE_OPEN: '0' },
  stdio: 'ignore',
}).unref()
let despues = antes
for (let i = 0; i < 60; i++) {
  await sleep(200)
  try {
    const lock = JSON.parse(readFileSync(join(HOME, 'canvas.json'), 'utf8')) as { pid: number; token: string }
    if (lock.pid !== antes.pid) {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) {
        despues = lock
        break
      }
    }
  } catch {
    /* todavía no */
  }
}
console.log(`  canvas nuevo: ${despues.pid !== antes.pid ? 'sí' : 'NO'} · token distinto: ${despues.token !== antes.token ? 'sí' : 'NO'}`)

send({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'diagram_node', arguments: { kind: 'module', label: 'Tras el reinicio' } },
})
const tras = await waitFor(5, 20000)
const trasText = ((tras?.result as { content?: { text?: string }[]; isError?: boolean })?.content ?? [])
  .map((c) => c.text)
  .join(' ')
const reintento = Boolean(tras) && !(tras?.result as { isError?: boolean })?.isError
console.log(`  escribir sin reiniciar Claude Code: ${reintento ? 'FUNCIONA' : 'FALLA'} → ${trasText}`)

console.log('\n=== 5. Análisis de stdout ==================================')
const totalBytes = rawStdout.join('').length
console.log(`  bytes emitidos por stdout : ${totalBytes}`)
console.log(`  mensajes JSON-RPC válidos : ${parsed.length}`)
console.log(`  líneas NO protocolo       : ${garbage.length}`)
if (garbage.length > 0) {
  console.log('  ⚠ CONTAMINACIÓN DETECTADA:')
  for (const g of garbage.slice(0, 10)) console.log(`     ${g}`)
}

console.log('\n=== 6. stderr (debe tener los logs) ========================')
const stderrText = rawStderr.join('')
console.log(`  bytes por stderr: ${stderrText.length}`)
for (const line of stderrText.split('\n').filter(Boolean).slice(0, 8)) {
  console.log(`     ${line}`)
}

// Limpieza: matar el canvas-server que hemos dejado suelto. El lockfile se lee a
// mano del home de la prueba, no con `readLock()`: ese apunta al home real, y
// usarlo aquí es exactamente cómo esta prueba mataba el tablero de verdad.
child.stdin.end()
child.kill()
await sleep(300)
try {
  const lock = JSON.parse(readFileSync(join(HOME, 'canvas.json'), 'utf8')) as { pid: number }
  process.kill(lock.pid)
  console.log(`\n  canvas-server de la prueba (pid ${lock.pid}) detenido`)
} catch {
  console.log('\n  no había canvas-server de la prueba que detener')
}
rmSync(HOME, { recursive: true, force: true })

console.log('\n=== VEREDICTO ==============================================')
const clean = garbage.length === 0 && parsed.length > 0
const worked = Boolean(init && list && call && get)
console.log(`  stdout limpio        : ${clean ? 'SÍ' : 'NO'}`)
console.log(`  protocolo funcional  : ${worked ? 'SÍ' : 'NO'}`)
console.log(`  logs en stderr       : ${stderrText.length > 0 ? 'SÍ' : 'NO'}`)
console.log(`  sobrevive a que el canvas se reinicie : ${reintento ? 'SÍ' : 'NO'}`)
console.log()
process.exit(clean && worked && reintento ? 0 : 1)
