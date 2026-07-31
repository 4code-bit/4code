/**
 * Persistencia por proyecto.
 *
 * Sin esto el tablero muere en cada reinicio, y eso hace imposible responder a
 * la pregunta que decide el producto: si Claude mantiene el diagrama al día
 * durante sesiones largas. No se puede evaluar algo que se borra solo.
 *
 * Dos ficheros por proyecto, con papeles distintos:
 *
 *   history.jsonl  Append-only. Es la fuente de verdad y ES la línea temporal
 *                  del proyecto. Se escribe en cada operación porque añadir una
 *                  línea es barato y perder historial no lo es.
 *   diagram.json   Snapshot para arrancar rápido. Se reescribe con retardo: es
 *                  un caché reconstruible, no un dato que temamos perder.
 *   layout.json    Dónde ha colocado el humano cada nodo. Fichero aparte y NO
 *                  en el historial a propósito: el historial es la línea
 *                  temporal del proyecto y arrastrar una caja no es un hecho
 *                  del proyecto. Mezclarlos llenaría la vista de Actividad de
 *                  ruido por cada gesto del ratón.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  applyOperation,
  emptyState,
  toSnapshot,
  type DiagramState,
  type Lens,
  type Operation,
} from '../../shared/diagram.ts'
import type { ProjectRef, ProjectSummary } from '../../shared/project.ts'
import { isRepo } from './git.ts'
import { PROJECTS_DIR } from './paths.ts'

const log = (...args: unknown[]) => console.error('[store]', ...args)

export const DATA_DIR = PROJECTS_DIR

export interface AppliedRecord {
  seq: number
  at: number
  operation: Operation
  branch?: string
  /**
   * Bajó de la nube: la escribió otra máquina.
   *
   * **Es lo que corta el bucle.** El `seq` de este registro es local, así que sin
   * la marca el envío lo vería como pendiente —`seq > acked`— y lo devolvería a
   * la nube, que se lo reenviaría a la otra máquina, que volvería a subirlo. Los
   * filtros de `sync.ts` y `cloud.ts` la miran; no se quita sin quitar eso.
   */
  remote?: true
  /** Quién la hizo, cuando vino de fuera. El login de GitHub. */
  author?: string
}

interface SnapshotFile {
  version: 1
  project: ProjectRef
  seq: number
  savedAt: number
  nodes: unknown[]
  edges: unknown[]
}

export interface Pinned {
  id: string
  x: number
  y: number
}

export interface Prioritized {
  id: string
  /** Menor es antes. */
  priority: number
}

interface LayoutFile {
  version: 1
  /**
   * Posiciones del formato anterior, cuando había un solo lienzo. Se siguen
   * leyendo —y se interpretan como las del tablero técnico, que es el único que
   * existía— para no tirar la colocación de nadie al actualizar. No se escriben.
   */
  positions?: Record<string, { x: number; y: number }>
  /** Posiciones por tablero: la oferta se dibuja en los dos y puede estar en un
      sitio distinto en cada uno. */
  byLens?: Partial<Record<Lens, Record<string, { x: number; y: number }>>>
  /**
   * El orden en que el humano quiere atacar las tareas. Comparte fichero con las
   * posiciones porque es la misma clase de dato: lo que ha decidido la persona,
   * no lo que ha averiguado Claude. Y comparte por tanto la misma exclusión del
   * historial — reordenar una lista no es un hecho del proyecto.
   */
  priority?: Record<string, number>
}

export interface ProjectStore {
  readonly project: ProjectRef
  readonly state: DiagramState
  readonly history: AppliedRecord[]
  /** Registra una operación ya aplicada al estado. */
  record(record: AppliedRecord): void
  /** Fija dónde ha colocado el humano unos nodos, en un tablero concreto. */
  pin(lens: Lens, positions: Pinned[]): void
  /** Fija en qué orden quiere el humano atacarlos. Tampoco toca el historial. */
  prioritize(entries: Prioritized[]): void
  flush(): void
}

function projectDir(id: string): string {
  return join(DATA_DIR, id)
}

/**
 * El resumen de un proyecto, cacheado por la huella de los dos ficheros de los
 * que depende.
 *
 * La web sondea `/projects` cada cuatro segundos, y cada sondeo parseaba el
 * `diagram.json` **entero** de cada proyecto —decenas de miles de nodos
 * serializados— para quedarse con cuatro números. Con la huella `(mtimeMs, size)`
 * de `project.json` y `diagram.json` basta: el snapshot se reescribe con retardo y
 * de forma atómica, así que si no ha cambiado, los cuatro números tampoco.
 *
 * Sin TTL a propósito. Por mtime es exacto; un TTL reintroduciría el fallo de
 * «¿por qué me sigue enseñando el número viejo?» a cambio de nada.
 */
interface ResumenCacheado {
  huella: string
  resumen: ProjectSummary
}

const resumenes = new Map<string, ResumenCacheado>()

/** `null` cuando el fichero no existe: forma parte de la huella. */
function huellaDe(file: string): string {
  try {
    const { mtimeMs, size } = statSync(file)
    return `${mtimeMs}:${size}`
  } catch {
    return '-'
  }
}

/**
 * ¿Es la raíz un repositorio? Y si no lo es, ¿hay repositorios dentro?
 *
 * Va aparte de la caché de resúmenes a propósito: esto no depende de
 * `project.json` ni del snapshot, sino de la carpeta de trabajo. Se cachea por el
 * mtime del **directorio raíz**, que cambia en cuanto se crea un `.git` dentro,
 * así que un `git init` se nota en el sondeo siguiente y sigue sin haber TTL.
 *
 * Existe porque un tablero que no sube tiene que decir por qué, y «sin remoto»
 * era la respuesta equivocada en el caso más común de todos: la carpeta que
 * contiene varios repos y no es ninguno.
 */
interface Sondeo {
  mtimeMs: number
  noRepo: boolean
  innerRepos: string[]
}

const sondeos = new Map<string, Sondeo>()

/**
 * Topes: esto corre en cada sondeo de `/projects`, y una raíz puede ser la
 * carpeta personal entera. Con los primeros basta para decir «mira dentro».
 */
const MAX_HIJOS = 80
const MAX_INNER = 6

/**
 * Lo mismo, para quien pregunta por una carpeta suelta y no por la lista entera.
 *
 * Lo usa el chequeo de equipo (`cloud.ts team`): la primera pregunta de las cinco es
 * «¿esto es un repositorio, o la carpeta que los contiene?», y la respuesta útil
 * incluye los nombres de los que tiene dentro.
 */
export function inspectRoot(root: string): { noRepo: boolean; innerRepos: string[] } {
  const { noRepo, innerRepos } = sondearRaiz(root)
  return { noRepo, innerRepos }
}

function sondearRaiz(root: string): Sondeo {
  let mtimeMs: number
  try {
    mtimeMs = statSync(root).mtimeMs
  } catch {
    // La carpeta no está: disco desconectado, proyecto borrado, o un tablero de
    // prueba con una raíz inventada. No se afirma nada sobre ella.
    return { mtimeMs: 0, noRepo: false, innerRepos: [] }
  }

  const hit = sondeos.get(root)
  if (hit && hit.mtimeMs === mtimeMs) return hit

  const sondeo: Sondeo = { mtimeMs, noRepo: !isRepo(root), innerRepos: [] }

  if (sondeo.noRepo) {
    try {
      let mirados = 0
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (++mirados > MAX_HIJOS || sondeo.innerRepos.length >= MAX_INNER) break
        if (existsSync(join(root, entry.name, '.git'))) sondeo.innerRepos.push(entry.name)
      }
    } catch {
      // Sin permisos de lectura: se queda la lista vacía y el aviso, más flojo.
    }
  }

  sondeos.set(root, sondeo)
  return sondeo
}

/**
 * Proyectos que existen en disco, leyendo solo metadatos y snapshot.
 *
 * A propósito NO abre los stores: cargar el historial completo de cada proyecto
 * para pintar un desplegable sería pagar por lo que no se mira. Quien tiene diez
 * repos mapeados lo notaría en cada arranque.
 */
export function listStoredProjects(): ProjectSummary[] {
  if (!existsSync(DATA_DIR)) return []
  const out: ProjectSummary[] = []
  const vistos = new Set<string>()

  for (const entry of readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // Lo apartado por una migración o un traslado no es un proyecto vivo: se
    // conserva por si hiciera falta, pero no debe aparecer en los listados ni
    // contarse entre lo que hay que sincronizar.
    if (/\.(migrado|movido-|vaciado-)/.test(entry.name)) continue
    const dir = join(DATA_DIR, entry.name)
    const metaPath = join(dir, 'project.json')
    const snapshotPath = join(dir, 'diagram.json')

    vistos.add(entry.name)
    const huella = `${huellaDe(metaPath)}|${huellaDe(snapshotPath)}`
    const hit = resumenes.get(entry.name)
    if (hit && hit.huella === huella) {
      // Copia superficial: lo que sale de aquí lo tocan otros (`marcarHuerfanos`,
      // la superposición del estado en memoria del canvas-server), y el objeto
      // cacheado no puede quedar contaminado por eso.
      out.push({ ...hit.resumen })
      continue
    }

    try {
      const project = JSON.parse(readFileSync(metaPath, 'utf8')) as ProjectRef
      const saved = existsSync(snapshotPath)
        ? (JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotFile)
        : null

      const resumen: ProjectSummary = {
        ...project,
        nodes: saved?.nodes?.length ?? 0,
        edges: saved?.edges?.length ?? 0,
        seq: saved?.seq ?? 0,
        updatedAt: saved?.savedAt ?? 0,
      }

      resumenes.set(entry.name, { huella, resumen })
      out.push({ ...resumen })
    } catch {
      // Un directorio ilegible no puede tumbar el listado de los demás. Y no se
      // cachea: la próxima vez se vuelve a intentar, que es lo que arregla un
      // fichero pillado a medio escribir.
      resumenes.delete(entry.name)
      log(`proyecto ilegible en disco, omitido: ${entry.name}`)
    }
  }

  // Un proyecto que desaparece del disco no debe quedarse ocupando memoria.
  for (const id of resumenes.keys()) if (!vistos.has(id)) resumenes.delete(id)

  // Por qué NO sube este tablero, distinguiendo los dos casos que se confundían.
  // Fuera de la caché de resúmenes porque depende de la carpeta de trabajo, no de
  // los ficheros del tablero.
  const raices = new Set<string>()
  for (const p of out) {
    if (p.remote || !p.root) continue
    raices.add(p.root)
    const { noRepo, innerRepos } = sondearRaiz(p.root)
    if (!noRepo) continue
    p.noRepo = true
    if (innerRepos.length > 0) p.innerRepos = innerRepos
  }
  for (const root of sondeos.keys()) if (!raices.has(root)) sondeos.delete(root)

  return marcarHuerfanos(out).sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Empareja cada tablero con el que la misma carpeta tenía antes del remoto.
 *
 * Subir un repo a GitHub cambia el id del proyecto —de la ruta al remoto—, así
 * que el tablero nuevo arranca vacío y el viejo se queda con todo. Pasa justo
 * cuando el usuario hace lo que le pedimos, y visto desde el tablero parece que
 * el trabajo de Claude se ha perdido.
 *
 * Se marca, no se mueve: mover tableros es del `board.ts move`, que simula por
 * defecto porque estos datos no están respaldados en ningún sitio.
 */
function marcarHuerfanos(lista: ProjectSummary[]): ProjectSummary[] {
  const sinRemotoPorRaiz = new Map<string, ProjectSummary>()
  for (const p of lista) {
    if (!p.remote && p.root && p.nodes > 0) sinRemotoPorRaiz.set(p.root.toLowerCase(), p)
  }
  if (sinRemotoPorRaiz.size === 0) return lista

  return lista.map((p) => {
    if (!p.remote || !p.root) return p
    const previo = sinRemotoPorRaiz.get(p.root.toLowerCase())
    // Solo si el de ahora está vacío: con tablero propio ya en marcha, el aviso
    // sería ruido sobre algo que el usuario ya resolvió trabajando.
    if (!previo || previo.id === p.id || p.nodes > 0) return p
    return { ...p, orphan: { id: previo.id, nodes: previo.nodes } }
  })
}

export function readStoredProject(id: string): ProjectRef | null {
  try {
    return JSON.parse(readFileSync(join(projectDir(id), 'project.json'), 'utf8')) as ProjectRef
  } catch {
    return null
  }
}

/**
 * Escritura atómica. Un corte de luz a mitad de un `writeFileSync` deja el
 * fichero truncado, y un snapshot truncado es un tablero perdido al arrancar.
 * Con temporal + rename, o está el viejo entero o está el nuevo entero.
 */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, contents, 'utf8')
  renameSync(tmp, path)
}

export function openStore(project: ProjectRef): ProjectStore {
  const dir = projectDir(project.id)
  mkdirSync(dir, { recursive: true })

  const snapshotPath = join(dir, 'diagram.json')
  const historyPath = join(dir, 'history.jsonl')
  const metaPath = join(dir, 'project.json')
  const layoutPath = join(dir, 'layout.json')

  const state = emptyState()
  const history: AppliedRecord[] = []

  // 1. Snapshot: arranque rápido al estado conocido.
  if (existsSync(snapshotPath)) {
    try {
      const saved = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotFile
      for (const node of saved.nodes ?? []) applyOperation(state, { op: 'add_node', node: node as never })
      for (const edge of saved.edges ?? []) applyOperation(state, { op: 'add_edge', edge: edge as never })
      state.seq = saved.seq ?? 0
    } catch (err) {
      log(`snapshot de ${project.id} ilegible, se reconstruye del historial:`, err)
    }
  }

  // 2. Historial: se cargan las operaciones y se reproducen las posteriores al
  //    snapshot. Si el snapshot se perdió, esto reconstruye el tablero entero.
  if (existsSync(historyPath)) {
    const desde = state.seq
    for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as AppliedRecord
        history.push(record)
        if (record.seq > desde && applyOperation(state, record.operation)) {
          state.seq = record.seq
        }
      } catch {
        // Una línea a medias solo puede ser la última, por un apagón durante el
        // append. Se descarta esa y se sigue: el resto del historial es válido.
        log(`línea corrupta en el historial de ${project.id}, descartada`)
      }
    }
  }

  // 3. Colocación del humano, encima de lo reproducido. Va después del historial
  //    porque manda sobre dagre: si alguien movió una caja, ahí se queda.
  const guardado: LayoutFile = (() => {
    if (!existsSync(layoutPath)) return { version: 1, positions: {} }
    try {
      return JSON.parse(readFileSync(layoutPath, 'utf8')) as LayoutFile
    } catch (err) {
      log(`layout de ${project.id} ilegible, se usa el de dagre:`, err)
      return { version: 1, positions: {} }
    }
  })()

  /**
   * Migración del formato de un solo lienzo: lo que había colocado se queda como
   * posición del tablero técnico, que es el único que existía cuando se guardó.
   * Se hace al leer y no con un script aparte para que nadie tenga que ejecutar
   * nada — el fichero viejo simplemente se entiende.
   */
  const byLens: Partial<Record<Lens, Record<string, { x: number; y: number }>>> = {
    tech: { ...(guardado.positions ?? {}), ...(guardado.byLens?.tech ?? {}) },
    business: { ...(guardado.byLens?.business ?? {}) },
  }
  const priority = guardado.priority ?? {}

  for (const lens of ['tech', 'business'] as const) {
    for (const [id, pos] of Object.entries(byLens[lens] ?? {})) {
      const node = state.nodes.get(id)
      if (node) node.pinned = { ...node.pinned, [lens]: pos }
    }
  }

  for (const [id, valor] of Object.entries(priority)) {
    const node = state.nodes.get(id)
    if (node) node.priority = valor
  }

  // El branch se excluye a propósito: cambia durante la sesión y guardarlo aquí
  // dejaría congelado el de la primera vez, que es peor que no tenerlo. Vive en
  // cada operación y en cada evento.
  const { branch: _dinamico, ...estable } = project
  // Se reescribe también cuando cambia, no solo la primera vez. Un repositorio
  // que se traslada de dueño mantendría si no el remoto viejo en disco para
  // siempre, y de ese fichero salen el estado del equipo y la sincronización.
  const serializado = JSON.stringify(estable, null, 2)
  if (!existsSync(metaPath) || readFileSync(metaPath, 'utf8') !== serializado) {
    writeAtomic(metaPath, serializado)
  }

  let pending: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let layoutPending: ReturnType<typeof setTimeout> | null = null
  let layoutDirty = false

  function saveLayout(): void {
    if (!layoutDirty) return
    // Se escribe solo `byLens`: `positions` era el formato de un lienzo y ya se
    // ha absorbido al leer. Mantenerlo también al escribir dejaría dos sitios
    // con la misma verdad.
    const file: LayoutFile = { version: 1, byLens, priority }
    try {
      writeAtomic(layoutPath, JSON.stringify(file, null, 2))
      layoutDirty = false
    } catch (err) {
      log(`no se pudo guardar el layout de ${project.id}:`, err)
    }
  }

  function saveSnapshot(): void {
    if (!dirty) return
    const snap = toSnapshot(state)
    const file: SnapshotFile = {
      version: 1,
      project,
      seq: snap.seq,
      savedAt: Date.now(),
      nodes: snap.nodes,
      edges: snap.edges,
    }
    try {
      writeAtomic(snapshotPath, JSON.stringify(file))
      dirty = false
    } catch (err) {
      log(`no se pudo guardar el snapshot de ${project.id}:`, err)
    }
  }

  return {
    project,
    state,
    history,

    record(record: AppliedRecord) {
      history.push(record)
      try {
        appendFileSync(historyPath, `${JSON.stringify(record)}\n`, 'utf8')
      } catch (err) {
        log(`no se pudo escribir el historial de ${project.id}:`, err)
      }

      // El snapshot se agrupa: durante un mapeo inicial llegan decenas de
      // operaciones seguidas y no tiene sentido reescribir el fichero entero
      // en cada una.
      dirty = true
      if (pending) clearTimeout(pending)
      pending = setTimeout(saveSnapshot, 600)
      pending.unref?.()
    },

    pin(lens: Lens, entradas: Pinned[]) {
      const delTablero = (byLens[lens] ??= {})
      for (const { id, x, y } of entradas) {
        delTablero[id] = { x, y }
        const node = state.nodes.get(id)
        if (node) node.pinned = { ...node.pinned, [lens]: { x, y } }
      }
      // Soltar el ratón es un gesto suelto, pero arrastrar cinco cajas seguidas
      // son cinco escrituras. Se agrupan igual que el snapshot.
      layoutDirty = true
      if (layoutPending) clearTimeout(layoutPending)
      layoutPending = setTimeout(saveLayout, 400)
      layoutPending.unref?.()
    },

    /**
     * El orden que el humano le da a sus tareas. Mismo camino que `pin` y por el
     * mismo motivo: es una decisión suya, no un hecho del proyecto.
     */
    prioritize(entradas: Prioritized[]) {
      for (const { id, priority: valor } of entradas) {
        priority[id] = valor
        const node = state.nodes.get(id)
        if (node) node.priority = valor
      }
      // A diferencia de `pin`, esto se guarda YA. Arrastrar una caja emite un
      // evento por frame y agrupar es obligado; soltar una tarjeta ocurre una
      // vez y trae el grupo entero renumerado en una sola llamada, así que el
      // retardo no ahorraría nada y sí abre una ventana para perder el gesto:
      // en Windows, matar el proceso no ejecuta el manejador de SIGTERM y lo
      // que estuviera pendiente no llega a escribirse.
      layoutDirty = true
      saveLayout()
    },

    flush() {
      if (pending) clearTimeout(pending)
      pending = null
      saveSnapshot()
      if (layoutPending) clearTimeout(layoutPending)
      layoutPending = null
      saveLayout()
    },
  }
}
