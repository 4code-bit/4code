/**
 * Derivación de tareas a partir del grafo.
 *
 * Función pura a propósito, igual que `layer.ts`: así se puede verificar con
 * grafos sintéticos sin levantar nada ni abrir un navegador. Y hace falta,
 * porque lo de abajo es donde es fácil equivocarse — cada clase de arista apunta
 * al contrario, y confundir la dirección haría que el tablero acusara a la pieza
 * equivocada de estar bloqueando el trabajo.
 *
 * Coste en tokens: cero. Todo sale del grafo y del historial que ya existen.
 */
import { homeLens, type DiagramEdge, type DiagramNode, type Lens } from './diagram.ts'
import type { AppliedOperation } from './diagram.ts'

export interface Vecino {
  id: string
  label: string
  /** De qué tablero viene. Cuando no es el tuyo, es el aviso que importa. */
  lens: Lens
}

/**
 * Las anotaciones no son tareas.
 *
 * Viven en el tablero técnico como cualquier otra pieza, pero una decisión ya
 * tomada no es algo que nadie tenga que hacer, así que no aparece en las
 * columnas. Sí cuenta para los bloqueos: una decisión marcada como problema
 * frena de verdad lo que dependa de ella.
 */
export function esAnotacion(kind: DiagramNode['kind']): boolean {
  return kind === 'note' || kind === 'decision'
}

export interface Dependencias {
  /** Por id de nodo: quién tiene un problema que impide avanzar con él. */
  bloqueadaPor: Map<string, Vecino[]>
  /** Por id de nodo: a quién está frenando, si el problema lo tiene él. */
  frenaA: Map<string, Vecino[]>
}

/**
 * Qué está esperando a qué.
 *
 * Solo dos clases de arista significan «necesito aquello» sin ambigüedad, y cada
 * una apunta al contrario:
 *
 *   supports  el ORIGEN sostiene al destino → si el origen está roto, el que no
 *             puede avanzar es el DESTINO. Es la que cruza técnica ↔ negocio.
 *   depends   el ORIGEN necesita al destino → aquí el bloqueado es el ORIGEN.
 *
 * `imports` y `calls` quedan fuera a propósito: son estructurales, y con ellas
 * media base de código «dependería» de cualquier módulo roto. Un aviso que salta
 * siempre no es un aviso.
 */
export function dependencias(nodes: DiagramNode[], edges: DiagramEdge[]): Dependencias {
  const porId = new Map(nodes.map((n) => [n.id, n]))
  const bloqueadaPor = new Map<string, Vecino[]>()
  const frenaA = new Map<string, Vecino[]>()

  const anotar = (bloqueadoId: string, culpableId: string) => {
    const culpable = porId.get(culpableId)
    const bloqueado = porId.get(bloqueadoId)
    // Solo bloquea lo que está declarado como problema. Una pieza a medias no
    // frena a nadie: está en camino.
    if (!culpable || !bloqueado || culpable.status !== 'problem') return

    const lista = bloqueadaPor.get(bloqueadoId) ?? []
    lista.push({ id: culpable.id, label: culpable.label, lens: homeLens(culpable.kind) })
    bloqueadaPor.set(bloqueadoId, lista)

    const arrastra = frenaA.get(culpableId) ?? []
    arrastra.push({ id: bloqueado.id, label: bloqueado.label, lens: homeLens(bloqueado.kind) })
    frenaA.set(culpableId, arrastra)
  }

  for (const e of edges) {
    if (e.kind === 'supports') anotar(e.target, e.source)
    else if (e.kind === 'depends') anotar(e.source, e.target)
  }

  return { bloqueadaPor, frenaA }
}

/**
 * Desde cuándo cada pieza está como está, leído del historial.
 *
 * Se queda con la ÚLTIMA vez que el estado cambió, que es lo que convierte «en
 * curso» en «en curso desde hace nueve días» — la única señal fiable de que algo
 * se ha quedado encallado.
 */
export function estadoDesde(history: Pick<AppliedOperation, 'at' | 'operation'>[]): Map<string, number> {
  const cuando = new Map<string, number>()
  for (const { at, operation } of history) {
    if (operation.op === 'set_status') {
      cuando.set(operation.id, at)
    } else if (operation.op === 'add_node' && operation.node.status) {
      cuando.set(operation.node.id, at)
    } else if (operation.op === 'update_node' && operation.patch.status) {
      cuando.set(operation.id, at)
    }
  }
  return cuando
}

/**
 * Primero lo que el humano ha ordenado a mano; después, lo más viejo.
 *
 * Que lo no priorizado caiga por antigüedad no es un desempate cualquiera: sube
 * solo lo que lleva más tiempo parado, que es justo lo que hay que mirar.
 */
export function ordenar<T extends { priority?: number; desde?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return (a.desde ?? Number.MAX_SAFE_INTEGER) - (b.desde ?? Number.MAX_SAFE_INTEGER)
  })
}
