/**
 * Layout estable con @dagrejs/dagre.
 *
 * El problema real no es colocar bien un grafo una vez: es colocarlo bien
 * DOSCIENTAS veces seguidas sin que salte. Medido en verify/dagre-stability.ts:
 * 20 adiciones sucesivas producen 656 inversiones de orden sin constraints y
 * 13 con ellas. El agente añade nodos durante toda la sesión, así que es
 * exactamente el caso que importa.
 *
 * Protocolo: primer layout normal → persistir rank/order → en cada cambio
 * derivar constraints {left,right} del orden guardado → animar la transición.
 */
import { Graph, layout as dagreLayout } from '@dagrejs/dagre'
import type { EdgeLabel, GraphLabel, NodeLabel, OrderConstraint } from '@dagrejs/dagre'
import type { DiagramEdge, DiagramNode, Lens } from '../../shared/diagram.ts'

/**
 * Tamaño de la caja de un nodo. **Debe coincidir con `.node` en styles.css**:
 * dagre coloca las cajas según estos números, así que si el CSS dibuja otra
 * altura, las aristas dejan de tocar los bordes.
 */
export const NODE_W = 200
export const NODE_H = 74

export interface Placed {
  id: string
  x: number
  y: number
}

/** Orden visual persistido entre renders. Es el estado canónico del layout. */
export type Placement = Map<string, { rank: number; order: number; x: number }>

function constraintsFrom(previous: Placement, alive: Set<string>): OrderConstraint[] {
  const byRank = new Map<number, { id: string; x: number }[]>()
  for (const [id, p] of previous) {
    if (!alive.has(id)) continue
    if (!byRank.has(p.rank)) byRank.set(p.rank, [])
    byRank.get(p.rank)!.push({ id, x: p.x })
  }
  const constraints: OrderConstraint[] = []
  for (const items of byRank.values()) {
    const ordered = items.sort((a, b) => a.x - b.x)
    for (let i = 0; i < ordered.length - 1; i++) {
      constraints.push({ left: ordered[i].id, right: ordered[i + 1].id })
    }
  }
  return constraints
}

export function computeLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  previous: Placement,
  /** De qué tablero es este layout: las posiciones fijadas son por tablero. */
  lens: Lens,
): { placed: Placed[]; placement: Placement } {
  if (nodes.length === 0) return { placed: [], placement: new Map() }

  const g = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ directed: true })
  g.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 88, marginx: 40, marginy: 40 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })

  const ids = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    // Defensa: una arista huérfana rompe el layout entero.
    if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target)
  }

  const constraints = constraintsFrom(previous, ids)
  dagreLayout(g, constraints.length > 0 ? { constraints } : undefined)

  const placement: Placement = new Map()
  const placed: Placed[] = []

  for (const n of nodes) {
    const laid = g.node(n.id)
    if (!laid || laid.x === undefined || laid.y === undefined) continue

    placement.set(n.id, { rank: laid.rank ?? 0, order: laid.order ?? 0, x: laid.x })

    // Lo que el humano coloca a mano manda sobre el auto-layout, pero solo lo
    // que colocó EN ESTE tablero.
    const pos = n.pinned?.[lens] ?? { x: laid.x - NODE_W / 2, y: laid.y - NODE_H / 2 }
    placed.push({ id: n.id, x: pos.x, y: pos.y })
  }

  return { placed, placement }
}
