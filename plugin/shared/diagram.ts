/**
 * Modelo del diagrama. Fuente de verdad compartida por el servidor MCP y la web.
 *
 * No es un dibujo: es un grafo tipado. Claude no pinta formas, declara arquitectura.
 * Consecuencia práctica: el agente envía deltas (decenas de tokens), no el grafo
 * entero (miles), y el log de operaciones ES la línea temporal del proyecto.
 */

export type NodeKind =
  // ── Lente técnica ─────────────────────────────────────────────────────────
  | 'module' // agrupación lógica de código
  | 'service' // proceso o servidor
  | 'file' // fichero concreto
  | 'datastore' // BD, cache, cola, fichero de estado
  | 'external' // API o dependencia de terceros
  // ── Lente de negocio ──────────────────────────────────────────────────────
  | 'offer' // producto o servicio que se vende
  | 'campaign' // acción de marketing con principio y fin
  | 'channel' // vía de captación: SEO, ads, email, partners
  | 'segment' // a quién va dirigido
  | 'goal' // objetivo o métrica que se persigue
  // ── Neutros ───────────────────────────────────────────────────────────────
  | 'note' // anotación libre de Claude
  | 'decision' // decisión tomada, técnica o de negocio

export type EdgeKind =
  // Técnicas
  | 'imports'
  | 'calls'
  | 'reads'
  | 'writes'
  | 'extends'
  | 'depends'
  // De negocio
  | 'promotes' // campaña → oferta
  | 'targets' // campaña o canal → segmento
  | 'drives' // canal o campaña → objetivo
  /**
   * La arista que cruza las dos lentes: una pieza técnica sostiene algo que se
   * vende. Es la razón de que esto sea un grafo con dos lentes y no dos
   * tableros — sin ella, nadie sabe qué se rompe en el negocio si cae un módulo.
   */
  | 'supports'

export type NodeStatus = 'planned' | 'building' | 'done' | 'problem'

/**
 * Los dos tableros. No son dos formas de mirar las mismas piezas: son dos
 * conjuntos de piezas distintos que hablan del mismo proyecto.
 *
 * La diferencia importa. «Planes de suscripción» en negocio es decidir precios,
 * nombres y qué entra en cada plan; en técnica es la cuenta de Stripe, construir
 * los planes y bloquear features. No es una caja pintada de otro color en cada
 * vista: son dos trabajos distintos que se tocan en un punto.
 *
 * Ese punto es la OFERTA, y es la única pieza que sale en los dos tableros: de
 * ella cuelga el trabajo comercial a un lado y el técnico al otro.
 */
export type Lens = 'tech' | 'business'

/**
 * En qué tablero VIVE una pieza. Es su casa: donde se cuenta, donde se prioriza
 * y en qué columna de tareas aparece.
 *
 * Se deriva del kind y no se guarda: un campo aparte podría contradecir al tipo
 * (`kind: 'campaign', lens: 'tech'`) y habría que migrar los tableros que ya
 * existen. Una función pura no puede desincronizarse de nada.
 */
export function homeLens(kind: NodeKind): Lens {
  switch (kind) {
    case 'offer':
    case 'campaign':
    case 'channel':
    case 'segment':
    case 'goal':
      return 'business'
    default:
      // `note` y `decision` incluidas: son anotaciones sobre cómo está hecho
      // algo, que es su definición. Estuvieron en los dos tableros a la vez y
      // fue un error — la misma caja dibujada dos veces comparte posición, así
      // que moverla en un tablero la movía en el otro.
      return 'tech'
  }
}

/**
 * Piezas que se DIBUJAN en los dos tableros aunque vivan en uno.
 *
 * Solo la oferta. Es el ancla que permite ver, desde el lienzo técnico, para qué
 * se está construyendo algo, y desde el de negocio, que eso que se vende tiene
 * una máquina debajo.
 */
const PUENTES = new Set<NodeKind>(['offer'])

/** Si esa clase de pieza se dibuja en ese tablero. */
export function visibleInLens(kind: NodeKind, lens: Lens | 'all'): boolean {
  if (lens === 'all') return true
  return PUENTES.has(kind) || homeLens(kind) === lens
}

/** Si una pieza aparece en los dos lienzos y necesita posición propia en cada uno. */
export function isBridge(kind: NodeKind): boolean {
  return PUENTES.has(kind)
}

/**
 * Los cuatro estados son los mismos en las dos lentes; lo que cambia es cómo se
 * dicen. Una campaña no está «en construcción», está en marcha; una idea que no
 * ha arrancado no está «planificada», es una idea.
 *
 * Traducir en vez de duplicar el enum mantiene un solo eje de estado en el
 * reducer, en el store y en la nube: el tablero sigue pudiendo contar cuánto
 * hay hecho sin preguntarse de qué lente es cada cosa.
 */
export const STATUS_LABEL: Record<Lens, Record<NodeStatus, string>> = {
  tech: { planned: 'planeado', building: 'en curso', done: 'hecho', problem: 'con problema' },
  business: { planned: 'idea', building: 'en marcha', done: 'lanzado', problem: 'atascado' },
}

export function statusLabel(status: NodeStatus, kind: NodeKind): string {
  return STATUS_LABEL[homeLens(kind)][status]
}

export interface DiagramNode {
  /** Estable entre sesiones. Derivado de ruta+símbolo, NUNCA de un contador. */
  id: string
  kind: NodeKind
  label: string
  /** Explicación de Claude. Se muestra al enfocar el nodo. */
  detail?: string
  /** Ruta relativa al proyecto. Sujeta al contrato de datos: nunca contenido. */
  path?: string
  status?: NodeStatus
  /**
   * Dirección donde se ve esa pieza funcionando (§4.5). Convierte el tablero en
   * operable: clicas el nodo `landing` y se abre `localhost:3001/landing`.
   * Pasa SIEMPRE por `safeUrl` antes de guardarse y antes de pintarse.
   */
  url?: string
  /** Layout persistido — la clave de la estabilidad visual. */
  rank?: number
  order?: number
  /**
   * Posición fijada por el humano al arrastrar. Manda sobre el auto-layout.
   *
   * Una por tablero. La oferta se dibuja en los dos, y con una sola posición
   * arrastrarla en el de negocio la movía también en el técnico: era la misma
   * caja en dos lienzos. Dos lienzos, dos sitios donde puede estar.
   */
  pinned?: Partial<Record<Lens, { x: number; y: number }>>
  /**
   * En qué orden quiere el humano atacar esto. Menor es antes.
   *
   * LA REGLA QUE HACE QUE ESTE CAMPO SEA SEGURO: los hechos los declara Claude,
   * las intenciones el humano, y no escriben nunca en el mismo campo. `status`
   * es un hecho —algo está hecho porque el código está escrito— y por eso la web
   * no lo toca: si lo hiciera, la vista mentiría hasta que Claude la pisara en
   * la siguiente pasada. `priority` es lo contrario: Claude no puede deducirla
   * de ningún sitio, así que no la escribe nunca y no hay colisión posible.
   *
   * Viaja de vuelta en `diagram_get`, que es lo que convierte el tablero en un
   * sitio donde los dos se dejan recados en vez de un espejo de solo lectura.
   */
  priority?: number
}

/**
 * Filtro de esquemas para `url`. Devuelve la URL normalizada o null.
 *
 * Es una defensa de seguridad, no una comodidad: el tablero guarda una cadena
 * que el navegador va a convertir en un enlace, y un `javascript:` ahí es XSS
 * almacenado que además viaja a la nube y se le sirve a otra gente. Se valida
 * al escribir Y al pintar, porque el estado puede venir de un fichero de disco
 * que alguien editó a mano.
 */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

export interface DiagramEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
  label?: string
}

// ── Operaciones ─────────────────────────────────────────────────────────────

export type Operation =
  | { op: 'add_node'; node: DiagramNode }
  | { op: 'update_node'; id: string; patch: Partial<Omit<DiagramNode, 'id'>> }
  | { op: 'remove_node'; id: string }
  | { op: 'add_edge'; edge: DiagramEdge }
  | { op: 'remove_edge'; id: string }
  | { op: 'set_status'; id: string; status: NodeStatus }
  | { op: 'annotate'; id: string; detail: string }
  | { op: 'reset' }

export interface AppliedOperation {
  /** Asignado por el servidor, monotónico. Detecta deriva en el cliente. */
  seq: number
  at: number
  operation: Operation
  /** Branch desde el que se hizo. Permite leer el tablero por rama. */
  branch?: string
}

export interface DiagramState {
  nodes: Map<string, DiagramNode>
  edges: Map<string, DiagramEdge>
  seq: number
}

export function emptyState(): DiagramState {
  return { nodes: new Map(), edges: new Map(), seq: 0 }
}

/**
 * Filtra la `url` de cualquier cosa que entre al estado. Va en el reducer y no
 * en quien llama para que no haya forma de saltárselo: el estado no puede
 * contener una URL que no se pueda pintar sin riesgo.
 */
function withSafeUrl<T extends { url?: string }>(input: T): T {
  if (input.url === undefined) return input
  const url = safeUrl(input.url)
  if (url) return { ...input, url }
  const { url: _descartada, ...resto } = input
  return resto as T
}

/**
 * Reducer puro. Corre igual en el servidor (estado canónico) y en la web
 * (réplica). Si divergen, el cliente pide snapshot.
 *
 * Devuelve false si la operación no cambió nada — así el servidor no difunde
 * ruido ni incrementa `seq` sin motivo.
 */
export function applyOperation(state: DiagramState, operation: Operation): boolean {
  switch (operation.op) {
    case 'add_node': {
      const incoming = withSafeUrl(operation.node)
      const existing = state.nodes.get(incoming.id)
      if (existing) {
        // Ids estables: re-declarar un nodo es actualizarlo, no duplicarlo.
        // Es la defensa contra que el modelo reinvente ids para el mismo concepto.
        state.nodes.set(incoming.id, { ...existing, ...incoming })
      } else {
        state.nodes.set(incoming.id, incoming)
      }
      return true
    }
    case 'update_node': {
      const node = state.nodes.get(operation.id)
      if (!node) return false
      state.nodes.set(operation.id, { ...node, ...withSafeUrl(operation.patch) })
      return true
    }
    case 'remove_node': {
      if (!state.nodes.delete(operation.id)) return false
      // Las aristas colgantes se van con el nodo.
      for (const [id, e] of state.edges) {
        if (e.source === operation.id || e.target === operation.id) state.edges.delete(id)
      }
      return true
    }
    case 'add_edge': {
      const { edge } = operation
      // Una arista hacia un nodo inexistente rompería el layout.
      if (!state.nodes.has(edge.source) || !state.nodes.has(edge.target)) return false
      state.edges.set(edge.id, edge)
      return true
    }
    case 'remove_edge':
      return state.edges.delete(operation.id)
    case 'set_status': {
      const node = state.nodes.get(operation.id)
      if (!node) return false
      state.nodes.set(operation.id, { ...node, status: operation.status })
      return true
    }
    case 'annotate': {
      const node = state.nodes.get(operation.id)
      if (!node) return false
      state.nodes.set(operation.id, { ...node, detail: operation.detail })
      return true
    }
    case 'reset': {
      state.nodes.clear()
      state.edges.clear()
      return true
    }
  }
}

export interface Snapshot {
  type: 'snapshot'
  seq: number
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

export interface Patch {
  type: 'patch'
  seq: number
  operation: Operation
}

export type ServerMessage = Snapshot | Patch

export function toSnapshot(state: DiagramState): Snapshot {
  return {
    type: 'snapshot',
    seq: state.seq,
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
  }
}

/**
 * Id determinista. Que Claude reutilice ids entre sesiones es una apuesta sobre
 * el comportamiento del modelo, no una garantía — por eso normalizamos aquí y
 * `add_node` hace upsert. Verificación #9 del plan.
 */
export function makeNodeId(kind: NodeKind, key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${kind}:${slug}`
}

export function makeEdgeId(source: string, target: string, kind: EdgeKind): string {
  return `${source}->${target}:${kind}`
}
