/**
 * Verificación del núcleo: aislamiento de proyectos, persistencia y `url`.
 *
 * Las tres cosas que el prototipo no hacía y que bloqueaban todo lo demás:
 *
 *   1. Dos proyectos abiertos a la vez compartían un único tablero global.
 *   2. Todo vivía en memoria: reiniciar borraba el diagrama y el historial.
 *   3. No había forma de abrir la pieza que Claude acababa de levantar (§4.5).
 *
 * Corre contra un FOURCODE_HOME desechable, así que no toca tus tableros.
 *
 *   node verify/core.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeArgs } from '../node-ts.mjs'
import { WebSocket } from 'ws'

import { homeLens, isBridge, safeUrl, statusLabel, visibleInLens } from '../shared/diagram.ts'
import { dependencias, esAnotacion, estadoDesde, ordenar } from '../shared/tareas.ts'
import type { ProjectSummary } from '../shared/project.ts'
import type { TeamView } from '../shared/team.ts'
import { makeProjectId, makeRemoteId } from '../server/src/project.ts'
import { normalizeRemote } from '../server/src/git.ts'
import { readTeam } from '../server/src/team.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CANVAS = resolve(HERE, '../server/src/canvas-server.ts')

const HOME = mkdtempSync(join(tmpdir(), '4code-verify-'))
const PORT = 41999
const TOKEN = 'token-de-prueba'
const BASE = `http://127.0.0.1:${PORT}`

let fallos = 0
function check(nombre: string, ok: boolean, detalle: unknown = '') {
  if (!ok) fallos++
  console.log(`  ${ok ? 'OK   ' : 'FALLO'} ${nombre}${detalle !== '' ? `  → ${JSON.stringify(detalle)}` : ''}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── 1. Piezas puras ─────────────────────────────────────────────────────────

console.log('\n1. Filtro de URLs (§4.5)')
check('acepta http', safeUrl('http://localhost:3001/landing') !== null)
check('acepta https', safeUrl('https://ejemplo.com') !== null)
check('rechaza javascript:', safeUrl('javascript:alert(1)') === null)
check('rechaza data:', safeUrl('data:text/html,<script>alert(1)</script>') === null)
check('rechaza file:', safeUrl('file:///C:/Windows/System32') === null)
check('rechaza vscode:', safeUrl('vscode://file/etc/passwd') === null)
check('rechaza basura', safeUrl('no es una url') === null)
check('rechaza vacío', safeUrl('') === null)
check('rechaza no-cadenas', safeUrl(42) === null)

console.log('\n1b. Los dos tableros, y la oferta como puente')
check('un módulo vive en técnica', homeLens('module') === 'tech')
check('una campaña vive en negocio', homeLens('campaign') === 'business')
check('una oferta vive en negocio', homeLens('offer') === 'business')
// Estuvieron en los dos tableros a la vez, y era un error: la misma caja
// dibujada dos veces comparte posición, así que moverla en uno la movía en el
// otro. Ahora cada pieza tiene una casa y solo una.
check('una decisión vive en técnica', homeLens('decision') === 'tech')
check('una nota vive en técnica', homeLens('note') === 'tech')

// La oferta es el punto de contacto: de ella cuelga el trabajo comercial a un
// lado y el técnico al otro, así que se dibuja en los dos lienzos.
check('la oferta se dibuja en los dos', visibleInLens('offer', 'tech') && visibleInLens('offer', 'business'))
check('y es la única que hace de puente', isBridge('offer') && !isBridge('campaign') && !isBridge('decision'))
check('el tablero de negocio no muestra servicios', !visibleInLens('service', 'business'))
check('el técnico no muestra campañas', !visibleInLens('campaign', 'tech'))
check('el técnico sí muestra sus decisiones', visibleInLens('decision', 'tech'))
check('el de negocio no las muestra', !visibleInLens('decision', 'business'))
check('«todo» no esconde nada', visibleInLens('offer', 'all') && visibleInLens('service', 'all'))
// El mismo estado, dicho en el idioma de cada lente. Si esto se rompe, la vista
// de negocio vuelve a hablar como un repositorio.
check('building es «en curso» en técnica', statusLabel('building', 'module') === 'en curso')
check('building es «en marcha» en negocio', statusLabel('building', 'campaign') === 'en marcha')
check('planned es «idea» en negocio', statusLabel('planned', 'offer') === 'idea')

console.log('\n1b bis. Las anotaciones no son tareas')
check('una decisión no aparece en las columnas', esAnotacion('decision'))
check('una nota tampoco', esAnotacion('note'))
check('una oferta sí es trabajo', !esAnotacion('offer'))
check('y un módulo también', !esAnotacion('module'))

console.log('\n1c. Qué está esperando a qué (bloqueo entre lentes)')
{
  // Facturación sostiene al Plan Pro y está rota; el Plan Team depende de una
  // decisión que está bien. Solo debe salir bloqueado el primero.
  const nodos = [
    { id: 'module:billing', kind: 'module' as const, label: 'Facturación', status: 'problem' as const },
    { id: 'offer:pro', kind: 'offer' as const, label: 'Plan Pro', status: 'planned' as const },
    { id: 'offer:team', kind: 'offer' as const, label: 'Plan Team', status: 'planned' as const },
    { id: 'decision:precio', kind: 'decision' as const, label: 'Precio', status: 'done' as const },
    { id: 'service:api', kind: 'service' as const, label: 'API', status: 'building' as const },
  ]
  const aristas = [
    { id: 'a', source: 'module:billing', target: 'offer:pro', kind: 'supports' as const },
    { id: 'b', source: 'offer:team', target: 'decision:precio', kind: 'depends' as const },
    // Estructural: NO debe generar bloqueo, o cualquier módulo roto acusaría a
    // media base de código y el aviso dejaría de significar nada.
    { id: 'c', source: 'service:api', target: 'module:billing', kind: 'imports' as const },
  ]
  const { bloqueadaPor, frenaA } = dependencias(nodos, aristas)

  check('`supports` bloquea al DESTINO', bloqueadaPor.get('offer:pro')?.[0]?.label === 'Facturación')
  check('y el origen sabe a quién frena', frenaA.get('module:billing')?.[0]?.label === 'Plan Pro')
  check('el bloqueo cruza de lente', bloqueadaPor.get('offer:pro')?.[0]?.lens === 'tech')
  check('`depends` hacia algo sano no bloquea', !bloqueadaPor.has('offer:team'))
  check('`imports` no genera bloqueo', !bloqueadaPor.has('service:api'))
  check('quien no espera a nadie queda limpio', bloqueadaPor.size === 1, [...bloqueadaPor.keys()])

  // La dirección de `depends` es la contraria a la de `supports`: confundirlas
  // haría que el tablero acusara a la pieza equivocada.
  const roto = dependencias(
    [
      { id: 'offer:x', kind: 'offer' as const, label: 'Oferta X', status: 'planned' as const },
      { id: 'decision:y', kind: 'decision' as const, label: 'Decisión Y', status: 'problem' as const },
    ],
    [{ id: 'd', source: 'offer:x', target: 'decision:y', kind: 'depends' as const }],
  )
  check('`depends` bloquea al ORIGEN', roto.bloqueadaPor.get('offer:x')?.[0]?.label === 'Decisión Y')
  check('y no al destino', !roto.bloqueadaPor.has('decision:y'))
}

console.log('\n1d. Orden de las tareas')
{
  const ordenadas = ordenar([
    { id: 'sin-nada' },
    { id: 'viejo', desde: 1000 },
    { id: 'nuevo', desde: 9000 },
    { id: 'a-mano', priority: 0, desde: 9999 },
  ] as { id: string; priority?: number; desde?: number }[])
  check('lo que el humano ordenó va primero', ordenadas[0]!.id === 'a-mano')
  check('luego lo más viejo', ordenadas[1]!.id === 'viejo', ordenadas.map((o) => o.id))
  check('lo que no tiene fecha, al final', ordenadas[3]!.id === 'sin-nada')
}

console.log('\n1e. Desde cuándo está cada pieza como está')
{
  const desde = estadoDesde([
    { at: 100, operation: { op: 'add_node', node: { id: 'a', kind: 'module', label: 'A', status: 'planned' } } },
    { at: 200, operation: { op: 'set_status', id: 'a', status: 'building' } },
    // Sin `status` en el parche: anotar algo no reinicia el reloj del estado.
    { at: 300, operation: { op: 'annotate', id: 'a', detail: 'una nota' } },
    { at: 400, operation: { op: 'add_node', node: { id: 'b', kind: 'module', label: 'B' } } },
  ])
  check('se queda con el ÚLTIMO cambio de estado', desde.get('a') === 200, desde.get('a'))
  check('anotar no cuenta como cambio de estado', desde.get('a') !== 300)
  check('un nodo sin estado no tiene reloj', !desde.has('b'))
}

console.log('\n2. Identidad de proyecto por ruta (repos sin remoto)')
const idA = makeProjectId('/home/ana/work/api')
const idB = makeProjectId('/home/ana/personal/api')
check('misma ruta → mismo id', makeProjectId('/home/ana/work/api') === idA)
check('carpetas homónimas en rutas distintas NO colisionan', idA !== idB, [idA, idB])
check('el id lleva parte legible', idA.startsWith('api-'), idA)

console.log('\n2b. Identidad compartible (por remoto de git)')

// Lo que hace que dos clones del mismo repo lleguen al MISMO tablero: da igual
// el protocolo, el usuario, el sufijo .git o las mayúsculas.
const canon = 'github.com/viupik/viupikhub'
const formas = [
  'https://github.com/Viupik/ViupikHub',
  'https://github.com/Viupik/ViupikHub.git',
  'git@github.com:Viupik/ViupikHub.git',
  'ssh://git@github.com/Viupik/ViupikHub.git',
  'https://github.com/Viupik/ViupikHub/',
]
for (const forma of formas) {
  check(`${forma} → ${canon}`, normalizeRemote(forma) === canon, normalizeRemote(forma))
}

// Un token en la URL de clonado es habitual, y no puede acabar dentro de un id
// que viaja a la nube.
const conToken = normalizeRemote('https://elian:ghp_TOKENSECRETO123@github.com/Viupik/ViupikHub.git')
check('las credenciales se descartan del remoto', conToken === canon, conToken)
check('el id no contiene el token', !makeRemoteId(conToken!).includes('ghp_'), makeRemoteId(conToken!))

check(
  'dos clones en rutas distintas comparten id',
  makeRemoteId(normalizeRemote('git@github.com:Viupik/ViupikHub.git')!) ===
    makeRemoteId(normalizeRemote('https://github.com/Viupik/ViupikHub')!),
)
check(
  'mismo nombre en organizaciones distintas NO comparte id',
  makeRemoteId('github.com/acme/api') !== makeRemoteId('github.com/otra/api'),
)
check('un remoto sin barra no vale como identidad', normalizeRemote('localhost') === null)

// ── 2. Servidor: aislamiento y persistencia ─────────────────────────────────

function startCanvas(): ChildProcess {
  const child = spawn(process.execPath, nodeArgs(CANVAS), {
    env: { ...process.env, FOURCODE_HOME: HOME, FOURCODE_PORT: String(PORT), FOURCODE_TOKEN: TOKEN },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  return child
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

async function stop(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM')
  // Dar margen a que se escriban los snapshots pendientes.
  for (let i = 0; i < 40 && child.exitCode === null && !child.killed; i++) await sleep(50)
  await sleep(400)
}

const proyectoA = { id: makeProjectId('/demo/alpha'), name: 'alpha', root: '/demo/alpha' }
const proyectoB = { id: makeProjectId('/demo/beta'), name: 'beta', root: '/demo/beta' }

async function push(project: typeof proyectoA, operations: unknown[]) {
  const res = await fetch(`${BASE}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fourcode-token': TOKEN },
    body: JSON.stringify({ project, operations }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

async function state(id: string) {
  const res = await fetch(`${BASE}/state?project=${encodeURIComponent(id)}`)
  return (await res.json()) as {
    seq: number
    nodes: { id: string; url?: string; priority?: number; pinned?: Partial<Record<string, { x: number; y: number }>> }[]
    edges: unknown[]
  }
}

console.log('\n3. Dos proyectos a la vez')
let canvas = startCanvas()
if (!(await waitReady())) {
  console.log('  FALLO  el canvas-server no arrancó')
  fallos++
} else {
  await push(proyectoA, [
    { op: 'add_node', node: { id: 'service:api', kind: 'service', label: 'API de alpha' } },
    { op: 'add_node', node: { id: 'module:auth', kind: 'module', label: 'Auth de alpha' } },
  ])
  await push(proyectoB, [
    { op: 'add_node', node: { id: 'service:web', kind: 'service', label: 'Web de beta' } },
  ])

  const a = await state(proyectoA.id)
  const b = await state(proyectoB.id)
  check('alpha tiene sus 2 nodos', a.nodes.length === 2, a.nodes.map((n) => n.id))
  check('beta tiene solo el suyo', b.nodes.length === 1, b.nodes.map((n) => n.id))
  check('beta no ve nodos de alpha', !b.nodes.some((n) => n.id === 'service:api'))
  check('alpha no ve nodos de beta', !a.nodes.some((n) => n.id === 'service:web'))

  const listado = (await (await fetch(`${BASE}/projects`)).json()) as { id: string; nodes: number }[]
  check('ambos aparecen en /projects', listado.length === 2, listado.map((p) => p.id))

  /**
   * `/projects` se sondea cada cuatro segundos y sus resúmenes están cacheados por
   * la huella de `project.json` y `diagram.json`. La caché no puede tapar un
   * cambio: el estado de los proyectos abiertos se superpone en memoria, y el
   * snapshot en disco cambia de huella cuando se guarda.
   */
  await push(proyectoA, [{ op: 'add_node', node: { id: 'module:cache', kind: 'module', label: 'Recién añadido' } }])
  const trasAñadir = (await (await fetch(`${BASE}/projects`)).json()) as { id: string; nodes: number }[]
  check(
    'un nodo nuevo se ve en /projects al momento, con caché o sin ella',
    trasAñadir.find((p) => p.id === proyectoA.id)?.nodes === 3,
    trasAñadir.find((p) => p.id === proyectoA.id)?.nodes,
  )

  console.log('\n4. URLs que llegan por la red')
  await push(proyectoA, [
    { op: 'add_node', node: { id: 'service:landing', kind: 'service', label: 'Landing', url: 'http://localhost:3001/landing' } },
    { op: 'add_node', node: { id: 'service:malo', kind: 'service', label: 'Malo', url: 'javascript:alert(document.cookie)' } },
  ])
  const conUrls = await state(proyectoA.id)
  const buena = conUrls.nodes.find((n) => n.id === 'service:landing')
  const malo = conUrls.nodes.find((n) => n.id === 'service:malo')
  check('la url legítima se guarda', buena?.url === 'http://localhost:3001/landing', buena?.url)
  check('el javascript: se descarta pero el nodo entra', malo !== undefined && malo.url === undefined, malo)

  /**
   * La regla que hace segura la edición desde la web: los hechos los declara
   * Claude, las intenciones el humano, y no comparten campo. Si el orden acabara
   * en el historial, la vista de Actividad se llenaría de ruido por cada gesto
   * del ratón y `status` dejaría de ser lo único que cuenta la verdad.
   */
  console.log('\n4b. El orden lo pone el humano, y no es un hecho del proyecto')
  const historialAntes = ((await (await fetch(`${BASE}/history?project=${proyectoA.id}`)).json()) as unknown[]).length
  const guardado = await fetch(`${BASE}/layout?project=${proyectoA.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      priority: [
        { id: 'module:auth', priority: 0 },
        { id: 'service:api', priority: 1 },
      ],
    }),
  })
  check('el canvas acepta la prioridad sin token', guardado.ok)
  const priorizado = await state(proyectoA.id)
  check('module:auth queda el primero', priorizado.nodes.find((n) => n.id === 'module:auth')?.priority === 0)
  check('service:api queda el segundo', priorizado.nodes.find((n) => n.id === 'service:api')?.priority === 1)
  const historialDespues = ((await (await fetch(`${BASE}/history?project=${proyectoA.id}`)).json()) as unknown[]).length
  check('reordenar NO escribe en el historial', historialDespues === historialAntes, {
    antes: historialAntes,
    despues: historialDespues,
  })
  check('reordenar NO toca el estado que declara Claude', priorizado.nodes.find((n) => n.id === 'module:auth')?.status === undefined)

  /**
   * La oferta se dibuja en los dos tableros, así que necesita una posición en
   * cada uno. Con una sola, arrastrarla en el lienzo de negocio la movía también
   * en el técnico — era literalmente la misma caja en dos sitios.
   */
  console.log('\n4c. Cada tablero recuerda su propia colocación')
  await push(proyectoA, [{ op: 'add_node', node: { id: 'offer:pro', kind: 'offer', label: 'Plan Pro' } }])
  await fetch(`${BASE}/layout?project=${proyectoA.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lens: 'tech', positions: [{ id: 'offer:pro', x: 100, y: 100 }] }),
  })
  await fetch(`${BASE}/layout?project=${proyectoA.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lens: 'business', positions: [{ id: 'offer:pro', x: 900, y: 900 }] }),
  })
  const dosSitios = (await state(proyectoA.id)).nodes.find((n) => n.id === 'offer:pro')
  check('la posición en técnica es la suya', dosSitios?.pinned?.tech?.x === 100, dosSitios?.pinned)
  check('la de negocio no la ha pisado', dosSitios?.pinned?.business?.x === 900, dosSitios?.pinned)

  console.log('\n5. Persistencia: sobrevivir a un reinicio')
  const antes = await state(proyectoA.id)
  await stop(canvas)

  canvas = startCanvas()
  const revivio = await waitReady()
  check('el canvas-server vuelve a arrancar', revivio)

  if (revivio) {
    const despues = await state(proyectoA.id)
    check('los nodos siguen ahí', despues.nodes.length === antes.nodes.length, {
      antes: antes.nodes.length,
      despues: despues.nodes.length,
    })
    check('el seq no retrocede', despues.seq === antes.seq, { antes: antes.seq, despues: despues.seq })
    check(
      'la url sobrevivió al viaje por disco',
      despues.nodes.find((n) => n.id === 'service:landing')?.url === 'http://localhost:3001/landing',
    )
    check('el otro proyecto también sobrevive', (await state(proyectoB.id)).nodes.length === 1)
    check(
      'el orden del humano sobrevivió al viaje por disco',
      despues.nodes.find((n) => n.id === 'module:auth')?.priority === 0,
    )

    const historial = (await (await fetch(`${BASE}/history?project=${proyectoA.id}`)).json()) as unknown[]
    check('el historial se conserva', historial.length >= 4, historial.length)
  }

  /**
   * Un tablero que no sube tiene que decir POR QUÉ, y había dos motivos metidos en
   * uno: «este repositorio no tiene remoto» se enseñaba también cuando la carpeta
   * no era un repositorio. Es el caso más frecuente —abrir Claude Code en la
   * carpeta que contiene los repos— y el único donde el consejo de darle un remoto
   * es activamente malo: envolvería los historiales que ya hay dentro.
   */
  console.log('\n6. Sin repositorio no es lo mismo que sin remoto')

  const contenedor = join(HOME, 'contenedor')
  mkdirSync(join(contenedor, 'hija', '.git'), { recursive: true })
  mkdirSync(join(contenedor, 'sin-git'), { recursive: true })

  const soloLocal = join(HOME, 'repo-sin-remoto')
  mkdirSync(join(soloLocal, '.git'), { recursive: true })
  writeFileSync(join(soloLocal, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8')

  const pContenedor = { id: makeProjectId(contenedor), name: 'contenedor', root: contenedor }
  const pSinRemoto = { id: makeProjectId(soloLocal), name: 'repo-sin-remoto', root: soloLocal }
  await push(pContenedor, [{ op: 'add_node', node: { id: 'module:x', kind: 'module', label: 'X' } }])
  await push(pSinRemoto, [{ op: 'add_node', node: { id: 'module:y', kind: 'module', label: 'Y' } }])

  const conMotivo = (await (await fetch(`${BASE}/projects`)).json()) as ProjectSummary[]
  const cont = conMotivo.find((p) => p.id === pContenedor.id)
  const sinRem = conMotivo.find((p) => p.id === pSinRemoto.id)

  check('la carpeta contenedora se marca como no-repositorio', cont?.noRepo === true, cont?.noRepo)
  check('y nombra los repositorios que tiene dentro', cont?.innerRepos?.join(',') === 'hija', cont?.innerRepos)
  check('un repo sin remoto NO se marca como no-repositorio', sinRem?.noRepo === undefined, sinRem?.noRepo)
  check('y no se le inventan repositorios dentro', sinRem?.innerRepos === undefined, sinRem?.innerRepos)
  // Una raíz que no existe —disco desconectado, tablero de prueba— no afirma nada.
  check(
    'una raíz que no está en el disco no se marca',
    conMotivo.find((p) => p.id === proyectoA.id)?.noRepo === undefined,
  )

  const equipoCont = (await (await fetch(`${BASE}/team?project=${pContenedor.id}`)).json()) as TeamView
  const equipoRepo = (await (await fetch(`${BASE}/team?project=${pSinRemoto.id}`)).json()) as TeamView
  check('la vista de equipo ve que no hay repositorio', equipoCont.hasRepo === false, equipoCont.hasRepo)
  check('y que un repo sin remoto sí es un repositorio', equipoRepo.hasRepo === true, equipoRepo.hasRepo)
  check(
    'ninguno de los dos tiene equipo que enseñar',
    equipoCont.hasRemote === false && equipoRepo.hasRemote === false,
  )

  // Y el tercer motivo, que se contaba como el segundo: la carpeta ya no está.
  const equipoFantasma = (await (await fetch(`${BASE}/team?project=${proyectoA.id}`)).json()) as TeamView
  check('una carpeta que ya no está no se cuenta como no-repositorio', equipoFantasma.hasRoot === false, {
    hasRoot: equipoFantasma.hasRoot,
  })
  check('y la que sí está se distingue de ella', equipoCont.hasRoot === true, equipoCont.hasRoot)

  await stop(canvas)
}

/**
 * 7. El tablero existe sin que Claude haya tocado nada.
 *
 * Antes el canvas-server solo nacía cuando el modelo usaba una herramienta del
 * tablero, así que abrir Claude Code y abrir el tablero no era lo mismo. Lo que
 * se comprueba aquí es el hook de `SessionStart`, incluido lo que no debe hacer:
 * escribir en stdout (se inyectaría en el contexto de la sesión) y abrir
 * navegadores durante las pruebas.
 */
console.log('\n7. El tablero se levanta solo, sin pasar por el modelo')

const HOOK = resolve(HERE, '../hooks/board-up.ts')
const HOOK_HOME = mkdtempSync(join(tmpdir(), '4code-hook-'))
const HOOK_PORT = 41998
const LOCK = join(HOOK_HOME, 'canvas.json')
// FOURCODE_OPEN=0 es el «no» duro: ninguna prueba puede abrir un navegador.
const HOOK_ENV = {
  ...process.env,
  FOURCODE_HOME: HOOK_HOME,
  FOURCODE_PORT: String(HOOK_PORT),
  FOURCODE_OPEN: '0',
}

interface Lock {
  port: number
  token: string
  pid: number
}

function runHook(source = 'startup'): { stdout: string; status: number | null } {
  const res = spawnSync(process.execPath, nodeArgs(HOOK), {
    env: HOOK_ENV,
    input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
    encoding: 'utf8',
  })
  return { stdout: res.stdout ?? '', status: res.status }
}

async function esperarCanvas(): Promise<Lock | null> {
  for (let i = 0; i < 100; i++) {
    try {
      const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as Lock
      const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (res.ok) return lock
    } catch {
      /* todavía no */
    }
    await sleep(150)
  }
  return null
}

const primera = runHook()
// La aserción que protege el contexto de la sesión: un hook de SessionStart que
// escribe en stdout le mete texto en la conversación a quien acaba de abrirla.
check('el hook no escribe nada en stdout', primera.stdout === '', primera.stdout.slice(0, 120))
check('y sale sin error', primera.status === 0, primera.status)

const lock1 = await esperarCanvas()
check('levanta el canvas-server sin que nadie diagrame nada', lock1 !== null)

if (lock1) {
  // Segunda sesión: no puede haber un segundo servidor.
  runHook()
  await sleep(600)
  const lock2 = JSON.parse(readFileSync(LOCK, 'utf8')) as Lock
  check('una segunda sesión reutiliza el que ya está', lock2.pid === lock1.pid, {
    antes: lock1.pid,
    despues: lock2.pid,
  })

  // Dos a la vez con el puerto libre: el perdedor sale con 3 sin pisar el
  // lockfile, así que lo que quede apuntado tiene que ser el que escucha.
  process.kill(lock1.pid)
  await sleep(700)
  await Promise.all([
    new Promise<void>((r) => {
      spawn(process.execPath, nodeArgs(HOOK), { env: HOOK_ENV, stdio: 'ignore' }).on('exit', () => r())
    }),
    new Promise<void>((r) => {
      spawn(process.execPath, nodeArgs(HOOK), { env: HOOK_ENV, stdio: 'ignore' }).on('exit', () => r())
    }),
  ])
  const lock3 = await esperarCanvas()
  check('dos sesiones a la vez dejan uno solo, y es el que escucha', lock3 !== null, lock3?.pid)

  if (lock3) {
    // Un lockfile huérfano: el proceso muerto a lo bruto, sin limpiar detrás.
    process.kill(lock3.pid, 'SIGKILL')
    await sleep(500)
    writeFileSync(LOCK, JSON.stringify({ ...lock3, pid: lock3.pid }), 'utf8')
    runHook()
    const lock4 = await esperarCanvas()
    check('un lockfile huérfano no impide arrancar', lock4 !== null && lock4.pid !== lock3.pid, {
      muerto: lock3.pid,
      vivo: lock4?.pid,
    })

    if (lock4) {
      // ── /open: quién puede pedirlo, y cuándo dice que no ──────────────────
      const sinToken = await fetch(`http://127.0.0.1:${lock4.port}/open`, { method: 'POST' })
      check('/open sin token responde 401', sinToken.status === 401, sinToken.status)

      const abrir = async () =>
        (await (
          await fetch(`http://127.0.0.1:${lock4.port}/open`, {
            method: 'POST',
            headers: { 'x-fourcode-token': lock4.token },
          })
        ).json()) as { opened: boolean; reason?: string }

      // Con el interruptor a 0 nunca se abre nada, ni con token.
      const apagado = await abrir()
      check('con FOURCODE_OPEN=0 no abre ni con token', apagado.opened === false, apagado)

      // Y el criterio que de verdad importa: si hay alguien mirando, no se abre.
      const ws = new WebSocket(`ws://127.0.0.1:${lock4.port}/?project=${proyectoA.id}`)
      const conectado = await new Promise<boolean>((r) => {
        ws.on('open', () => r(true))
        ws.on('error', () => r(false))
        setTimeout(() => r(false), 3000)
      })
      check('un cliente del tablero se puede conectar', conectado)
      if (conectado) {
        const mirando = await abrir()
        check(
          'con alguien mirando, la razón es esa y no otra',
          mirando.opened === false && /mirando/.test(mirando.reason ?? ''),
          mirando,
        )
        ws.close()
      }

      process.kill(lock4.pid)
      await sleep(400)
    }
  }
}

rmSync(HOOK_HOME, { recursive: true, force: true })

/**
 * 8. La vista de equipo no lanza git más veces de las necesarias.
 *
 * Medido antes de arreglarlo: 12 procesos `git` en 140 segundos sin que nadie mirara
 * la vista, porque el sondeo de fondo (120 s) fallaba una caché de 30 s y ninguna
 * lectura se compartía con las demás. Se ejecuta contra este mismo repositorio, que
 * tiene remoto y ramas de verdad; con `idle` no sale a la red.
 */
console.log('\n8. La vista de equipo no lanza git de más')

const REPO = resolve(HERE, '../..')
const [uno, dos] = await Promise.all([readTeam(REPO, true), readTeam(REPO, true)])
check('dos lecturas simultáneas comparten una sola pasada de git', uno.readAt === dos.readAt, {
  uno: uno.readAt,
  dos: dos.readAt,
})
check('y la lectura trae datos de git de verdad', uno.hasRepo && uno.hasRemote && uno.branches.length > 0, {
  hasRepo: uno.hasRepo,
  hasRemote: uno.hasRemote,
  ramas: uno.branches.length,
})
const tres = await readTeam(REPO, true)
check('la siguiente sale de la caché, sin tocar git', tres.readAt === uno.readAt)

/**
 * 9. El chequeo de equipo señala el requisito que falla, no uno cualquiera.
 *
 * Compartir un tablero falla en cinco sitios (§4.13) y hasta ahora los tres últimos
 * respondían igual —un 404—, así que el diagnóstico era a mano. Aquí se comprueba el
 * primero de los cinco, que es el único que no necesita red: una carpeta que no es un
 * repositorio tiene que decir eso y nombrar los que tiene dentro, no hablar de permisos.
 */
console.log('\n9. El chequeo de equipo dice cuál de los cinco falta')

const CLOUD = resolve(HERE, '../server/src/cloud.ts')
const contenedorTeam = mkdtempSync(join(tmpdir(), '4code-team-'))
mkdirSync(join(contenedorTeam, 'hija', '.git'), { recursive: true })

const salidaTeam = spawnSync(process.execPath, nodeArgs(CLOUD, ['team']), {
  cwd: contenedorTeam,
  env: { ...process.env, FOURCODE_HOME: mkdtempSync(join(tmpdir(), '4code-team-home-')) },
  encoding: 'utf8',
})
const textoTeam = salidaTeam.stdout ?? ''

check('sale con error cuando falta un requisito', salidaTeam.status === 1, salidaTeam.status)
check('dice que no es un repositorio', /not a git repository/.test(textoTeam))
check('y nombra los que tiene dentro', /hija/.test(textoTeam), textoTeam.match(/repositories inside.*/)?.[0])
/**
 * Y lo que NO debe hacer: explicar el requisito equivocado.
 *
 * Los cinco aparecen siempre en la lista —ahí `·` significa «no se ha podido
 * comprobar»—, pero el párrafo de debajo es el que da el siguiente paso, y mandar a
 * alguien a revisar permisos cuando lo que pasa es que está en la carpeta de al lado
 * es peor que no decir nada.
 */
check(
  'no manda a arreglar un requisito que no es',
  !/settings\/access|collaborator|4code:login/.test(textoTeam),
  textoTeam.match(/(settings\/access|collaborator|4code:login)/)?.[0],
)
rmSync(contenedorTeam, { recursive: true, force: true })

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${fallos === 0 ? 'TODO CORRECTO' : `${fallos} COMPROBACIONES FALLIDAS`}\n`)
process.exit(fallos === 0 ? 0 : 1)
