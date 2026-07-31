/**
 * canvas-server — proceso local que guarda el estado canónico de los tableros y
 * los difunde al navegador.
 *
 * REGLA INVIOLABLE: nada de este proceso, ni de sus dependencias, puede escribir
 * a stdout. Se arranca como hijo del servidor MCP, y aunque redirigimos su stdio
 * al lanzarlo, el margen de error aquí es cero. Todo log va a stderr.
 *
 *   node src/canvas-server.ts
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  applyOperation,
  toSnapshot,
  type Lens,
  type Operation,
  type ServerMessage,
} from '../../shared/diagram.ts'
import type { ProjectRef } from '../../shared/project.ts'
import { TOQUE_RECIENTE_MS, type PieceCollision } from '../../shared/team.ts'
import { clearLock, writeLock } from './lockfile.ts'
import { sessionsOf } from './sessions.ts'
import {
  listStoredProjects,
  openStore,
  readStoredProject,
  type Pinned,
  type Prioritized,
  type ProjectStore,
} from './store.ts'
import { startPresence, stopPresence } from './presence.ts'
import { start as startPull, stopAll as stopPull, type RemoteOperation } from './pull.ts'
import { enqueue, openBoardWanted, readConfig, resume, status as syncStatus } from './sync.ts'
import { readTeam } from './team.ts'

const log = (...args: unknown[]) => console.error('[canvas]', ...args)

const HERE = dirname(fileURLToPath(import.meta.url))
// Configurable por el mismo motivo que FOURCODE_HOME: para que la verificación
// pueda reproducir una instalación sin interfaz sin tocar la de verdad.
const WEB_DIST = resolve(HERE, process.env.FOURCODE_WEB_DIST ?? '../../web/dist')

/** Lo que ve quien abre el tablero en una copia del plugin sin `web/dist`. */
const SIN_INTERFAZ = `<!doctype html>
<meta charset="utf-8">
<title>4Code — falta la interfaz</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; color: #1e293b }
  code { background: #f1f5f9; padding: .15em .4em; border-radius: .25rem; font-size: .9em }
  p { margin: 1rem 0 }
</style>
<h1>Falta la interfaz del tablero</h1>
<p>El servidor está funcionando —el diagrama está a salvo y se sigue actualizando—,
   pero esta copia del plugin no trae la interfaz construida (<code>web/dist</code>).</p>
<p>Si lo instalaste desde el marketplace, actualízalo:<br><code>/plugin update 4code@4code</code></p>
<p>Si trabajas sobre el repositorio, constrúyela:<br><code>npm run web:build</code> dentro de <code>plugin/</code></p>
`

/**
 * Cabeceras de caché de los estáticos. NO es una optimización: sin ellas, el
 * navegador aplica caché heurística y se queda con el `index.html` de la visita
 * anterior — precisamente el fichero que dice qué bundle cargar. El resultado es
 * que actualizar el plugin no cambia nada de lo que ves hasta que aciertas con un
 * Ctrl+Shift+R, y desde fuera parece que la actualización no ha llegado.
 *
 * Los assets sí se cachean para siempre, y se puede porque Vite les pone el hash
 * del contenido en el nombre: si cambian, cambia la URL. El `index.html` es el
 * único que tiene que revalidarse en cada carga, y es barato — son 400 bytes.
 */
function cacheFor(file: string): Record<string, string> {
  return file.endsWith('.html')
    ? { 'cache-control': 'no-cache' }
    : { 'cache-control': 'public, max-age=31536000, immutable' }
}

const PORT = Number(process.env.FOURCODE_PORT ?? 41847)
const TOKEN = process.env.FOURCODE_TOKEN ?? randomBytes(16).toString('hex')

/**
 * Defensa contra DNS rebinding: un sitio cualquiera puede pedirle al navegador
 * que abra un WebSocket a 127.0.0.1. Solo aceptamos orígenes locales conocidos.
 * La spec de MCP lo advierte y ningún canvas MCP de la comunidad lo implementa.
 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true // clientes no-navegador (el propio MCP)
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && ALLOWED_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

// ── Tableros abiertos ───────────────────────────────────────────────────────

/**
 * Un store por proyecto, abierto en cuanto alguien lo toca. Antes había un
 * único estado global y dos proyectos a la vez se mezclaban en el mismo tablero.
 */
const stores = new Map<string, ProjectStore>()
/** Suscriptores por proyecto: un patch solo viaja a quien mira ese tablero. */
const clients = new Map<string, Set<WebSocket>>()

function storeFor(project: ProjectRef): ProjectStore {
  let store = stores.get(project.id)
  if (!store) {
    store = openStore(project)
    stores.set(project.id, store)
    log(`tablero abierto: ${project.name} (${project.id}, seq ${store.state.seq})`)
    // Lo que quedó sin subir en una sesión anterior sale ahora.
    resume(project, store.history)
    // Y lo que hayan dibujado otras máquinas empieza a entrar. Sin token no hace
    // nada, así que un tablero sin vincular sigue comportándose igual que siempre.
    startPull(project, { aplicar: ingestRemote, hayPublico: (id) => Boolean(clients.get(id)?.size) })
    startPresence(project)
  }
  return store
}

/** Para quien solo tiene el id: la web al reconectar, sin conocer la ruta. */
function storeById(id: string): ProjectStore | null {
  const open = stores.get(id)
  if (open) return open
  const known = readStoredProject(id)
  return known ? storeFor(known) : null
}

function broadcast(projectId: string, message: ServerMessage) {
  const subscribers = clients.get(projectId)
  if (!subscribers?.size) return
  const payload = JSON.stringify(message)
  for (const ws of subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(payload)
  }
}

function ingest(project: ProjectRef, operations: Operation[]): { applied: number; seq: number } {
  const store = storeFor(project)
  let applied = 0

  for (const operation of operations) {
    if (!applyOperation(store.state, operation)) continue
    store.state.seq++
    applied++
    const record = {
      seq: store.state.seq,
      at: Date.now(),
      operation,
      ...(project.branch && { branch: project.branch }),
    }
    store.record(record)
    // A la nube si está configurada; si no, no hace nada.
    enqueue(project, record)
    anotarToque(project.id, operation, record.at)
    broadcast(project.id, { type: 'patch', seq: store.state.seq, operation })
  }

  return { applied, seq: store.state.seq }
}

// ── Lo que llega de otras máquinas ──────────────────────────────────────────

/** Qué nodo toca una operación, o `null` si no toca ninguno (aristas, reset). */
function nodoDe(operation: Operation): string | null {
  switch (operation.op) {
    case 'add_node':
      return operation.node.id
    case 'update_node':
    case 'remove_node':
    case 'set_status':
    case 'annotate':
      return operation.id
    default:
      return null
  }
}

/**
 * Cuándo tocó ESTA máquina cada pieza, para poder detectar colisiones.
 *
 * En memoria y sin persistir a propósito: una colisión es un aviso de «ojo, ahora
 * mismo», no un hecho del proyecto. Sobrevivir a un reinicio la convertiría en un
 * registro permanente de quién es dueño de qué, que es justo lo que el tablero no
 * quiere ser.
 */
const toques = new Map<string, Map<string, number>>()
const colisiones = new Map<string, Map<string, PieceCollision>>()

function anotarToque(projectId: string, operation: Operation, at: number): void {
  const id = nodoDe(operation)
  if (!id) return
  let porNodo = toques.get(projectId)
  if (!porNodo) {
    porNodo = new Map()
    toques.set(projectId, porNodo)
  }
  porNodo.set(id, at)
}

/**
 * Aplica lo que bajó de la nube.
 *
 * Es `ingest()` menos una línea, y esa línea es la importante: **no llama a
 * `enqueue`**. Lo que viene de fuera no vuelve a salir, y además queda marcado con
 * `remote: true` para que ni el reenvío de arranque ni un `push` manual lo
 * devuelvan. Sin eso, dos máquinas se pasan la misma operación para siempre.
 *
 * El `at` que se guarda es el original, no el de ahora: la vista de Actividad
 * cuenta cuándo pasaron las cosas, no cuándo se enteró este disco.
 */
function ingestRemote(project: ProjectRef, operaciones: RemoteOperation[]): void {
  const store = storeFor(project)

  for (const remota of operaciones) {
    if (!applyOperation(store.state, remota.operation)) continue
    store.state.seq++

    const record = {
      seq: store.state.seq,
      at: remota.at,
      operation: remota.operation,
      ...(remota.branch && { branch: remota.branch }),
      remote: true as const,
      ...(remota.author && { author: remota.author }),
    }
    store.record(record)
    anotarColision(project.id, remota, store)
    broadcast(project.id, { type: 'patch', seq: store.state.seq, operation: remota.operation })
  }
}

/**
 * ¿Ha tocado alguien una pieza que yo también estaba tocando?
 *
 * Gana la última operación —el orden lo marca el `seq` del servidor, que es
 * global— pero callarse el choque sería mentir por omisión: quien mira vería su
 * cambio deshacerse sin explicación. Se avisa dentro de la misma ventana que usa
 * la atribución del lienzo, para no llamar colisión a algo de anteayer.
 */
function anotarColision(projectId: string, remota: RemoteOperation, store: ProjectStore): void {
  const id = nodoDe(remota.operation)
  if (!id || !remota.author) return

  const mio = toques.get(projectId)?.get(id)
  if (!mio || remota.at - mio > TOQUE_RECIENTE_MS) return

  let porNodo = colisiones.get(projectId)
  if (!porNodo) {
    porNodo = new Map()
    colisiones.set(projectId, porNodo)
  }

  const previa = porNodo.get(id)
  const theirs = previa?.theirs.filter((t) => t.author !== remota.author) ?? []
  theirs.push({ author: remota.author, at: remota.at })

  porNodo.set(id, {
    nodeId: id,
    label: store.state.nodes.get(id)?.label ?? id,
    yours: mio,
    theirs,
  })
}

/** Las colisiones vivas de un proyecto, ya caducadas las viejas. */
export function boardCollisions(projectId: string): PieceCollision[] {
  const porNodo = colisiones.get(projectId)
  if (!porNodo) return []

  const corte = Date.now() - TOQUE_RECIENTE_MS
  for (const [id, c] of porNodo) {
    if (c.yours < corte) porNodo.delete(id)
  }
  return [...porNodo.values()]
}

// ── ¿Existe ya arriba? ──────────────────────────────────────────────────────

export interface CloudBoardInfo {
  /** Hay tablero en la nube para el repositorio de este proyecto. */
  exists: boolean
  pieces?: number
  people?: number
  url?: string
  /** Por qué no se puede saber, cuando no se puede: se dice en vez de callar. */
  reason?: 'sin-vincular' | 'sin-remoto' | 'sin-acceso' | 'sin-red'
}

const nube = new Map<string, { at: number; info: CloudBoardInfo }>()
const NUBE_MS = 60_000

async function cloudBoard(projectId: string): Promise<CloudBoardInfo> {
  const hit = nube.get(projectId)
  if (hit && Date.now() - hit.at < NUBE_MS) return hit.info

  const guardar = (info: CloudBoardInfo) => {
    nube.set(projectId, { at: Date.now(), info })
    return info
  }

  const proyecto = stores.get(projectId)?.project ?? readStoredProject(projectId)
  if (!proyecto?.remote?.startsWith('github.com/')) return guardar({ exists: false, reason: 'sin-remoto' })

  const config = readConfig()
  if (!config) return guardar({ exists: false, reason: 'sin-vincular' })

  try {
    const res = await fetch(
      `${config.apiUrl}/api/access?remote=${encodeURIComponent(proyecto.remote)}`,
      { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return guardar({ exists: false, reason: 'sin-red' })

    const info = (await res.json()) as {
      access: boolean
      board?: { id: string; pieces: number; contributors: unknown[] }
    }
    if (!info.access) return guardar({ exists: false, reason: 'sin-acceso' })
    if (!info.board) return guardar({ exists: false })

    return guardar({
      exists: true,
      pieces: info.board.pieces,
      people: info.board.contributors.length,
      url: `${config.apiUrl}/app/${encodeURIComponent(info.board.id)}`,
    })
  } catch {
    return guardar({ exists: false, reason: 'sin-red' })
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 5_000_000) rej(new Error('body demasiado grande'))
    })
    req.on('end', () => res(data))
    req.on('error', rej)
  })
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin
  if (!originAllowed(origin)) {
    res.writeHead(403).end('origen no permitido')
    return
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-fourcode-token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const projectId = url.searchParams.get('project')

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, projects: stores.size, clients: countClients(), sync: syncStatus() })
    return
  }

  /** Lo que alimenta el selector de proyecto de la web. */
  if (url.pathname === '/projects') {
    const stored = listStoredProjects()
    // Los abiertos van con su estado en memoria, que es más fresco que el
    // snapshot en disco (que se escribe con retardo).
    const merged = stored.map((p) => {
      const open = stores.get(p.id)
      if (!open) return p
      return {
        ...p,
        nodes: open.state.nodes.size,
        edges: open.state.edges.size,
        seq: open.state.seq,
        updatedAt: open.history.at(-1)?.at ?? p.updatedAt,
      }
    })
    json(res, 200, merged)
    return
  }

  if (url.pathname === '/state') {
    if (!projectId) {
      json(res, 400, { error: 'falta ?project=' })
      return
    }
    const store = storeById(projectId)
    json(res, 200, store ? toSnapshot(store.state) : { type: 'snapshot', seq: 0, nodes: [], edges: [] })
    return
  }

  if (url.pathname === '/history') {
    if (!projectId) {
      json(res, 400, { error: 'falta ?project=' })
      return
    }
    json(res, 200, storeById(projectId)?.history ?? [])
    return
  }

  /**
   * Sesiones capturadas por los hooks. El fichero lo escribe otro proceso, así
   * que se lee del disco en cada petición (con caché por mtime en `sessions.ts`)
   * en vez de mantener estado aquí.
   */
  if (url.pathname === '/sessions') {
    if (!projectId) {
      json(res, 400, { error: 'falta ?project=' })
      return
    }
    json(res, 200, sessionsOf(projectId))
    return
  }

  /**
   * Estado del equipo, leído de git. No sale nada a ningún servidor nuestro:
   * el único tráfico es el `git fetch` contra el remoto que ya usas.
   */
  if (url.pathname === '/team') {
    if (!projectId) {
      json(res, 400, { error: 'falta ?project=' })
      return
    }
    const proyecto = readStoredProject(projectId)
    if (!proyecto) {
      json(res, 404, { error: 'proyecto desconocido' })
      return
    }
    // `idle=1`: el sondeo de fondo, el que solo alimenta el aviso de colisión. Se le
    // sirve de una caché mucho más larga y sin salir a la red.
    const equipo = await readTeam(proyecto.root, url.searchParams.get('idle') === '1')
    // Las de pieza salen de memoria, así que no pagan la caché de git ni la
    // merecen: son de este proceso y están al día por definición.
    json(res, 200, { ...equipo, pieces: boardCollisions(projectId) })
    return
  }

  /**
   * Dónde ha colocado el humano los nodos. Sin token, a diferencia de `/ops`:
   * el token existe para que nada de fuera invente contenido del tablero, y la
   * web no lo tiene por diseño. Esta superficie no crea ni describe nada — solo
   * mueve cajas que ya existen, y el `Origin` ya está validado más arriba.
   */
  if (url.pathname === '/layout' && req.method === 'POST') {
    if (!projectId) {
      json(res, 400, { error: 'falta ?project=' })
      return
    }
    const store = storeById(projectId)
    if (!store) {
      json(res, 404, { error: 'proyecto desconocido' })
      return
    }
    try {
      const parsed = JSON.parse(await readBody(req)) as {
        positions?: Pinned[]
        priority?: Prioritized[]
        lens?: string
      }
      // De qué tablero viene el arrastre. Sin esto, colocar la oferta en el
      // lienzo de negocio la movería también en el técnico: es la misma pieza
      // dibujada en los dos. Se cae a 'tech' porque es lo que mandaban los
      // clientes anteriores a que hubiera dos tableros.
      const lens: Lens = parsed.lens === 'business' ? 'business' : 'tech'
      const limpias = (parsed.positions ?? []).filter(
        (p) => typeof p?.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y),
      )
      // El orden de las tareas entra por aquí y no por `/ops` porque es de la
      // misma clase que arrastrar una caja: una decisión del humano, no un hecho
      // del proyecto. Comparte además la razón de no pedir token — solo reordena
      // nodos que ya existen, sin poder inventar contenido.
      const prioridades = (parsed.priority ?? []).filter(
        (p) => typeof p?.id === 'string' && Number.isFinite(p.priority),
      )
      if (!limpias.length && !prioridades.length) {
        json(res, 400, { error: 'se espera { positions: [{ id, x, y }] } o { priority: [{ id, priority }] }' })
        return
      }
      if (limpias.length) store.pin(lens, limpias)
      if (prioridades.length) store.prioritize(prioridades)
      json(res, 200, { fijados: limpias.length, priorizados: prioridades.length })
    } catch (err) {
      log('POST /layout falló:', err)
      res.writeHead(400).end(String(err))
    }
    return
  }

  /**
   * ¿Este proyecto ya tiene tablero en la nube?
   *
   * Lo pregunta el estado vacío del tablero local. Sin esto, a quien se acaba de unir a
   * un repositorio se le decía «pídele a Claude que mapee la estructura» — y ese es el
   * consejo equivocado: el tablero ya existe arriba, y redibujarlo produce piezas casi
   * duplicadas porque Claude elige ids distintos en cada máquina. Lo que toca es
   * `/4code:restore`, y para saberlo hay que preguntar.
   *
   * Se cachea un minuto por proyecto: es una llamada de red y la respuesta cambia como
   * mucho cuando alguien dibuja por primera vez.
   */
  if (url.pathname === '/cloud-board') {
    if (!projectId) {
      json(res, 400, { error: 'falta ?project=' })
      return
    }
    json(res, 200, await cloudBoard(projectId))
    return
  }

  /**
   * «Enséñame el tablero, si no lo estoy viendo ya.»
   *
   * Con token, como `/ops`: esto lanza un proceso, y aunque la URL sea constante
   * eso no lo puede pedir cualquiera que llegue al puerto. Sin cuerpo y sin
   * parámetros a propósito — no hay nada que un llamante pueda elegir.
   */
  if (url.pathname === '/open' && req.method === 'POST') {
    if (req.headers['x-fourcode-token'] !== TOKEN) {
      res.writeHead(401).end('token inválido')
      return
    }
    json(res, 200, abrirSiNadieMira())
    return
  }

  if (url.pathname === '/ops' && req.method === 'POST') {
    if (req.headers['x-fourcode-token'] !== TOKEN) {
      res.writeHead(401).end('token inválido')
      return
    }
    try {
      const parsed = JSON.parse(await readBody(req)) as {
        project?: ProjectRef
        operations?: Operation[]
      }
      if (!parsed.project?.id || !Array.isArray(parsed.operations)) {
        json(res, 400, { error: 'se espera { project, operations }' })
        return
      }
      json(res, 200, ingest(parsed.project, parsed.operations))
    } catch (err) {
      log('POST /ops falló:', err)
      res.writeHead(400).end(String(err))
    }
    return
  }

  /**
   * Sin interfaz construida, un GET de navegador merece una explicación.
   *
   * Quien abre esta URL no se la ha inventado: se la acaba de imprimir este mismo
   * proceso. Un «no encontrado» en texto plano no le dice si el servidor está
   * roto, si el tablero está vacío o si la culpa es suya. Y ninguna de las tres.
   */
  if (req.method === 'GET' && !existsSync(WEB_DIST)) {
    log('petición de navegador sin interfaz construida en', WEB_DIST)
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
    res.end(SIN_INTERFAZ)
    return
  }

  // Estáticos del build de la web, si existe. En desarrollo se usa Vite aparte.
  if (req.method === 'GET' && existsSync(WEB_DIST)) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = join(WEB_DIST, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    if (file.startsWith(WEB_DIST) && existsSync(file)) {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...cacheFor(file) })
      res.end(readFileSync(file))
      return
    }
    const index = join(WEB_DIST, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'content-type': MIME['.html'], ...cacheFor(index) })
      res.end(readFileSync(index))
      return
    }
  }

  res.writeHead(404).end('no encontrado')
})

// ── WebSocket ───────────────────────────────────────────────────────────────

function countClients(): number {
  let total = 0
  for (const set of clients.values()) total += set.size
  return total
}

// ── Abrir el tablero en el navegador ────────────────────────────────────────

/**
 * Abrir la pestaña, y solo si no hay nadie mirando.
 *
 * Lo decide este proceso y no quien lo llama, porque el dato que gobierna la
 * decisión —cuántos clientes hay conectados— solo lo tiene él. Y el criterio es
 * lo que separa ayudar de molestar: tres sesiones de Claude abiertas a la vez no
 * pueden convertirse en tres pestañas.
 *
 * LA URL ES UNA CONSTANTE DE ESTE FICHERO. No llega por la petición, no se
 * concatena con nada y no hay parámetros que elegir. Es lo que mantiene esto
 * lejos del modelo de amenaza del daemon de Fase 3 (§5): allí el riesgo es que
 * algo remoto decida qué se ejecuta; aquí no hay nada que decidir.
 */
const BOARD_URL = `http://127.0.0.1:${PORT}`
/** Dos sesiones que arrancan juntas no abren dos pestañas. */
const REABRIR_MS = 60_000
let ultimoOpen = 0

function lanzarNavegador(): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', BOARD_URL]]
      : process.platform === 'darwin'
        ? ['open', [BOARD_URL]]
        : ['xdg-open', [BOARD_URL]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (err) => log('no se pudo abrir el navegador:', err))
    child.unref()
  } catch (err) {
    log('no se pudo abrir el navegador:', err)
  }
}

function abrirSiNadieMira(): { opened: boolean; reason?: string } {
  if (countClients() > 0) return { opened: false, reason: 'ya hay alguien mirando el tablero' }
  if (Date.now() - ultimoOpen < REABRIR_MS) return { opened: false, reason: 'se acaba de abrir' }
  // El «no» del usuario, y el interruptor que mantiene las verificaciones sin
  // navegadores: arrancan canvas-servers a docenas y ninguna pasa FOURCODE_OPEN.
  if (process.env.FOURCODE_OPEN === '0') return { opened: false, reason: 'desactivado por entorno' }
  if (!openBoardWanted()) return { opened: false, reason: 'openBoard: false en config.json' }

  ultimoOpen = Date.now()
  lanzarNavegador()
  log(`tablero abierto en el navegador (${BOARD_URL})`)
  return { opened: true }
}

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, done) => {
    if (!originAllowed(origin)) {
      log('WebSocket rechazado, origen:', origin)
      done(false, 403, 'origen no permitido')
      return
    }
    done(true)
  },
})

wss.on('connection', (ws, req) => {
  // El proyecto va en la query para que reconectar no necesite negociación.
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const projectId = url.searchParams.get('project')

  if (!projectId) {
    ws.close(1008, 'falta ?project=')
    return
  }

  let subscribers = clients.get(projectId)
  if (!subscribers) {
    subscribers = new Set()
    clients.set(projectId, subscribers)
  }
  subscribers.add(ws)
  log(`cliente conectado a ${projectId} (${countClients()} en total)`)

  const store = storeById(projectId)
  ws.send(
    JSON.stringify(
      store ? toSnapshot(store.state) : { type: 'snapshot', seq: 0, nodes: [], edges: [] },
    ),
  )

  ws.on('close', () => {
    subscribers.delete(ws)
    if (subscribers.size === 0) clients.delete(projectId)
    log(`cliente desconectado de ${projectId} (${countClients()} restantes)`)
  })
  ws.on('error', (err) => log('error de WebSocket:', err))
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`el puerto ${PORT} está ocupado — ¿hay ya un canvas-server vivo?`)
    process.exit(3)
  }
  log('error del servidor:', err)
  process.exit(1)
})

// Solo loopback. Nunca 0.0.0.0.
server.listen(PORT, '127.0.0.1', () => {
  writeLock({ port: PORT, token: TOKEN, pid: process.pid, startedAt: Date.now() })
  const known = listStoredProjects()
  log(`escuchando en http://127.0.0.1:${PORT}`)
  log(`${known.length} proyecto(s) en disco`)

  /**
   * Arranque en frío: quien nos lanzó pidió que se viera el tablero.
   *
   * Se espera un momento antes de decidir, porque quien acaba de arrancar el
   * servidor puede tener ya una pestaña abierta reconectando: si preguntáramos
   * en este mismo tick, `countClients()` sería 0 y abriríamos una segunda.
   */
  if (process.env.FOURCODE_OPEN === '1') {
    setTimeout(abrirSiNadieMira, 2000).unref?.()
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearLock()
    stopPresence()
    stopPull()
    // Los snapshots pendientes se escriben antes de salir: el historial ya está
    // en disco, pero sin esto el próximo arranque tendría que reproducirlo entero.
    for (const store of stores.values()) store.flush()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500)
  })
}
