/**
 * Verificación de la bajada: converger sin entrar en bucle.
 *
 * Que dos tableros converjan es fácil de hacer y fácil de hacer mal, y el modo de
 * fallar es silencioso y caro: una operación que baja de otra máquina entra en el
 * historial local con un `seq` LOCAL nuevo, así que el envío la ve como pendiente
 * —`seq > acked`— y la devuelve a la nube, que se la reenvía a la otra máquina,
 * que vuelve a subirla. Dos personas trabajando se convierten en dos procesos
 * hablando entre ellos para siempre, y el síntoma es una factura, no un error.
 *
 * Por eso esto no comprueba solo que lo bajado aparezca: comprueba sobre todo lo
 * que NO tiene que pasar.
 *
 * Corre contra un FOURCODE_HOME desechable y una nube de mentira, así que no toca
 * tus tableros ni la red.
 *
 *   node verify/pull.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeArgs } from '../node-ts.mjs'
import { makeProjectId } from '../server/src/project.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CANVAS = resolve(HERE, '../server/src/canvas-server.ts')

const HOME = mkdtempSync(join(tmpdir(), '4code-pull-'))
const PORT = 41997
const NUBE_PORT = 41996
const TOKEN = 'token-de-prueba'
const BASE = `http://127.0.0.1:${PORT}`

let fallos = 0
function check(nombre: string, ok: boolean, detalle: unknown = '') {
  if (!ok) fallos++
  console.log(`  ${ok ? 'OK   ' : 'FALLO'} ${nombre}${detalle !== '' ? `  → ${JSON.stringify(detalle)}` : ''}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── La nube de mentira ──────────────────────────────────────────────────────

/** Todo lo que el plugin ha intentado SUBIR. Es la mitad importante del test. */
const subidas: { operation: { op: string; node?: { id: string }; id?: string } }[] = []

/** Lo que la nube tiene para ofrecer, como si lo hubiera escrito otra persona. */
const ajenas = [
  {
    seq: 7,
    at: Date.now(),
    operation: { op: 'add_node', node: { id: 'module:de-otro', kind: 'module', label: 'Pieza ajena' } },
    author: 'compañera',
  },
]

let sirvioAjenas = 0
/** Cualquier petición, del tipo que sea. Lo que mide la aditividad de §2.4. */
let peticiones = 0

const nube = createServer((req, res) => {
  peticiones++
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${NUBE_PORT}`)

  if (req.method === 'POST' && url.pathname === '/api/sync') {
    let cuerpo = ''
    req.on('data', (c) => (cuerpo += c))
    req.on('end', () => {
      try {
        const { operations } = JSON.parse(cuerpo) as { operations: { operation: never }[] }
        subidas.push(...operations)
      } catch {
        /* cuerpo ilegible: que lo cuente el test como no-subida */
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ seq: 999 }))
    })
    return
  }

  if (req.method === 'GET' && url.pathname.endsWith('/ops')) {
    const after = Number(url.searchParams.get('after') ?? 0)
    // Solo la primera vez: después, el cursor del cliente ya va por delante. Si
    // las sirviera siempre, el test pasaría aunque el cursor no se guardase.
    const pendientes = ajenas.filter((o) => o.seq > after)
    if (pendientes.length > 0) sirvioAjenas++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'x',
        name: 'demo',
        remote: 'github.com/demo/repo',
        version: 7,
        operations: pendientes,
        more: false,
      }),
    )
    return
  }

  res.writeHead(404)
  res.end('{}')
})

await new Promise<void>((r) => nube.listen(NUBE_PORT, '127.0.0.1', r))

// Vincular la máquina de mentira contra la nube de mentira.
mkdirSync(HOME, { recursive: true })
writeFileSync(
  join(HOME, 'config.json'),
  JSON.stringify({ apiUrl: `http://127.0.0.1:${NUBE_PORT}`, token: 'tok', openBoard: false }),
  'utf8',
)

// ── El canvas-server ────────────────────────────────────────────────────────

function startCanvas(): ChildProcess {
  return spawn(process.execPath, nodeArgs(CANVAS), {
    env: {
      ...process.env,
      FOURCODE_HOME: HOME,
      FOURCODE_PORT: String(PORT),
      FOURCODE_TOKEN: TOKEN,
      FOURCODE_OPEN: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

async function waitReady(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return true
    } catch {
      /* todavía no */
    }
    await sleep(150)
  }
  return false
}

const proyecto = {
  id: makeProjectId('/demo/converge'),
  name: 'converge',
  root: '/demo/converge',
  remote: 'github.com/demo/repo',
}

async function push(operations: unknown[]) {
  const res = await fetch(`${BASE}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fourcode-token': TOKEN },
    body: JSON.stringify({ project: proyecto, operations }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

async function state() {
  const res = await fetch(`${BASE}/state?project=${encodeURIComponent(proyecto.id)}`)
  return (await res.json()) as { seq: number; nodes: { id: string }[] }
}

console.log('\nConvergencia entre máquinas, sin bucle')

const canvas = startCanvas()
const listo = await waitReady()

if (!listo) {
  console.log('  FALLO  el canvas-server no arrancó')
  fallos++
} else {
  // Una pieza propia: abre el store, que es lo que arranca la bajada y el envío.
  await push([{ op: 'add_node', node: { id: 'service:mia', kind: 'service', label: 'Mía' } }])

  // La primera pasada de `pull` va al segundo; se le da margen de sobra.
  await sleep(4_000)

  const estado = await state()
  const ids = estado.nodes.map((n) => n.id)

  check('lo que dibujó la otra máquina aparece aquí', ids.includes('module:de-otro'), ids)
  check('y lo propio sigue estando', ids.includes('service:mia'), ids)
  check('la nube se consultó de verdad', sirvioAjenas > 0, { sirvioAjenas })

  /**
   * El corazón del asunto: la pieza ajena NO puede volver a subir.
   *
   * Si esto falla, las dos máquinas se reenvían la misma operación en bucle.
   */
  const devueltas = subidas.filter(
    (r) => r.operation?.node?.id === 'module:de-otro' || r.operation?.id === 'module:de-otro',
  )
  check('lo que bajó de fuera NO se devuelve a la nube', devueltas.length === 0, {
    devueltas: devueltas.length,
  })

  const propias = subidas.filter((r) => r.operation?.node?.id === 'service:mia')
  check('lo propio sí sube, una sola vez', propias.length === 1, { veces: propias.length })

  /**
   * Las dos marcas conviven en el mismo fichero. Si una pisara a la otra se
   * rompería un sentido entero: o se deja de subir lo que nunca subió, o se
   * vuelve a bajar lo ya aplicado.
   */
  let marca: { acked?: number; remoteAcked?: number } = {}
  try {
    marca = JSON.parse(readFileSync(join(HOME, 'projects', proyecto.id, 'sync.json'), 'utf8'))
  } catch {
    /* se comprueba abajo */
  }
  check('la marca de subida se guardó', (marca.acked ?? 0) > 0, marca)
  check('la de bajada también, y no se pisan', (marca.remoteAcked ?? 0) === 7, marca)

  // Y al reiniciar, el historial mixto no puede reenviar lo ajeno.
  const antes = subidas.length
  canvas.kill('SIGTERM')
  await sleep(800)
  const otra = startCanvas()
  if (await waitReady()) {
    await push([{ op: 'set_status', id: 'service:mia', status: 'done' }])
    await sleep(1_500)
    const reenviadas = subidas
      .slice(antes)
      .filter((r) => r.operation?.node?.id === 'module:de-otro' || r.operation?.id === 'module:de-otro')
    check('tras reiniciar tampoco se reenvía lo ajeno', reenviadas.length === 0, {
      reenviadas: reenviadas.length,
    })
  } else {
    check('el canvas-server vuelve a arrancar', false)
  }
  otra.kill('SIGTERM')
  await sleep(400)
}

canvas.kill('SIGTERM')
await sleep(300)

/**
 * Aditividad (§2.4): sin vincular, la nube no existe.
 *
 * No basta con que «no sincronice»: no puede haber ni una petición. Una máquina
 * sin `login` tiene que comportarse exactamente igual que antes de que esto se
 * escribiera, y eso incluye no hablar con nadie.
 */
console.log('\nSin vincular, la nube no existe')

const HOME_SOLO = mkdtempSync(join(tmpdir(), '4code-pull-solo-'))
const PORT_SOLO = 41995
const BASE_SOLO = `http://127.0.0.1:${PORT_SOLO}`
const antesDeSolo = peticiones

const solo = spawn(process.execPath, nodeArgs(CANVAS), {
  env: {
    ...process.env,
    FOURCODE_HOME: HOME_SOLO,
    FOURCODE_PORT: String(PORT_SOLO),
    FOURCODE_TOKEN: TOKEN,
    FOURCODE_OPEN: '0',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
})

let listoSolo = false
for (let i = 0; i < 60 && !listoSolo; i++) {
  try {
    const res = await fetch(`${BASE_SOLO}/health`, { signal: AbortSignal.timeout(500) })
    listoSolo = res.ok
  } catch {
    /* todavía no */
  }
  if (!listoSolo) await sleep(150)
}

if (listoSolo) {
  await fetch(`${BASE_SOLO}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fourcode-token': TOKEN },
    body: JSON.stringify({
      project: proyecto,
      operations: [{ op: 'add_node', node: { id: 'service:sola', kind: 'service', label: 'Sola' } }],
    }),
  })
  await sleep(3_000)
  check('una máquina sin vincular no hace ni una petición', peticiones === antesDeSolo, {
    antes: antesDeSolo,
    ahora: peticiones,
  })
} else {
  check('el canvas-server sin vincular arranca', false)
}

solo.kill('SIGTERM')
await sleep(400)
try {
  rmSync(HOME_SOLO, { recursive: true, force: true })
} catch {
  /* Windows a veces retiene el directorio un instante */
}

await new Promise<void>((r) => nube.close(() => r()))
try {
  rmSync(HOME, { recursive: true, force: true })
} catch {
  /* Windows a veces retiene el directorio un instante */
}

console.log(fallos === 0 ? '\nTODO CORRECTO' : `\n${fallos} FALLO(S)`)
process.exit(fallos === 0 ? 0 : 1)
