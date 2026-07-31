/**
 * Vista de tablero: el lienzo con el grafo.
 *
 * Estaba dentro de `App.tsx` cuando la web era una sola pantalla. Ahora que hay
 * varias vistas, cada una vive en su fichero y `App` solo decide cuál se ve.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { computeLayout, type Placement } from './layout.ts'
import { nodeTypes, type NodeData } from './nodes.tsx'
import type { DiagramEdge, DiagramNode, Lens, Operation } from '../../shared/diagram.ts'

const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  imports: { stroke: '#5b7cfa' },
  calls: { stroke: '#3fb59a' },
  reads: { stroke: '#8a8fa3', dash: '4 4' },
  writes: { stroke: '#d99a3c' },
  extends: { stroke: '#9b6bd6' },
  depends: { stroke: '#8a8fa3', dash: '2 5' },
  promotes: { stroke: '#f07a4a' },
  targets: { stroke: '#86cf6e', dash: '4 4' },
  drives: { stroke: '#f2d05b' },
  // La que cruza de la técnica al negocio va en claro y a trazo largo: no
  // pertenece a ninguna de las dos gamas porque no pertenece a ninguna lente.
  supports: { stroke: '#c9cee0', dash: '7 4' },
}

export function BoardView({
  nodes: rawNodes,
  edges: rawEdges,
  lens,
  lastTouched,
  pin,
  onSelect,
  projectId,
  focusId,
  onFocusHandled,
}: {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  /** Qué tablero es este. Decide de dónde salen las posiciones fijadas. */
  lens: Lens
  lastTouched: string | null
  pin: (lens: Lens, positions: { id: string; x: number; y: number }[]) => void
  onSelect: (node: DiagramNode | null) => void
  projectId: string | null
  /** Pieza a la que saltar cuando se llega desde otra vista. */
  focusId: string | null
  onFocusHandled: () => void
}) {
  const { fitView } = useReactFlow()
  const placement = useRef<Placement>(new Map())
  const previousCount = useRef(0)

  /**
   * Qué piezas y qué conexiones hay. Lo que dagre necesita saber: mover una caja
   * no cambia el grafo.
   */
  const topologia = useMemo(
    () =>
      `${rawNodes.map((n) => n.id).join('|')}::${rawEdges.map((e) => `${e.source}>${e.target}`).join('|')}`,
    [rawNodes, rawEdges],
  )

  /**
   * Solo se recalcula cuando cambia la topología.
   *
   * Recalcular también al fijar un nodo tenía un efecto feo: el primer layout
   * tras recargar sale sin `constraints` (el orden aún no se conoce) y el
   * segundo ya con ellas, así que el primer arrastre movía medio tablero de
   * golpe. Colocar una caja no es motivo para reordenar el grafo entero.
   */
  const auto = useMemo(() => {
    const result = computeLayout(rawNodes, rawEdges, placement.current, lens)
    placement.current = result.placement
    return new Map(result.placed.map((p) => [p.id, { x: p.x, y: p.y }]))
    // rawNodes/rawEdges se leen a propósito fuera de las dependencias: lo que
    // manda es la topología, no la identidad del array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologia])

  /** Quién tiene cable por arriba y quién por abajo. */
  const conectados = useMemo(() => {
    const entra = new Set<string>()
    const sale = new Set<string>()
    for (const e of rawEdges) {
      sale.add(e.source)
      entra.add(e.target)
    }
    return { entra, sale }
  }, [rawEdges])

  const nodes: Node<NodeData>[] = useMemo(() => {
    return rawNodes.map((n) => ({
      id: n.id,
      type: 'diagram',
      // Lo que coloca el humano manda sobre dagre, y se aplica aquí para que
      // fijar una posición no pase por el layout.
      position: n.pinned?.[lens] ?? auto.get(n.id) ?? { x: 0, y: 0 },
      data: {
        kind: n.kind,
        label: n.label,
        detail: n.detail,
        path: n.path,
        status: n.status,
        fresh: n.id === lastTouched,
        entra: conectados.entra.has(n.id),
        sale: conectados.sale.has(n.id),
      },
    }))
  }, [rawNodes, auto, lastTouched, conectados, lens])

  const edges: Edge[] = useMemo(
    () =>
      rawEdges.map((e) => {
        const style = EDGE_STYLE[e.kind] ?? EDGE_STYLE.depends
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label ?? e.kind,
          animated: e.kind === 'calls',
          // `color` no pinta nada por sí solo: existe para que el halo del
          // hover pueda salir del color del propio cable con `currentColor`,
          // sin repetir la tabla de colores en el CSS.
          style: {
            stroke: style.stroke,
            color: style.stroke,
            strokeWidth: 1.6,
            strokeDasharray: style.dash,
          },
          // El aspecto de la etiqueta vive en el CSS, que es donde puede
          // reaccionar al hover. Aquí solo la forma de la pastilla, que no es
          // estilo sino geometría del SVG.
          labelBgPadding: [7, 4] as [number, number],
          labelBgBorderRadius: 7,
        }
      }),
    [rawEdges],
  )

  // Encuadrar cuando aparecen nodos nuevos, no en cada actualización.
  useEffect(() => {
    if (rawNodes.length > previousCount.current) {
      const t = setTimeout(() => void fitView({ duration: 420, padding: 0.22 }), 60)
      previousCount.current = rawNodes.length
      return () => clearTimeout(t)
    }
    previousCount.current = rawNodes.length
  }, [rawNodes.length, fitView])

  // Cambiar de proyecto reencuadra: React puede agrupar el vaciado y el snapshot
  // nuevo en un mismo ciclo, así que el efecto de arriba no siempre lo pilla.
  useEffect(() => {
    if (!projectId) return
    const t = setTimeout(() => void fitView({ duration: 420, padding: 0.22 }), 260)
    return () => clearTimeout(t)
  }, [projectId, fitView])

  /** Llegada desde otra vista: centrar esa pieza en vez de dejar buscarla. */
  useEffect(() => {
    if (!focusId) return
    const t = setTimeout(() => {
      void fitView({ nodes: [{ id: focusId }], duration: 500, padding: 0.55, maxZoom: 1.3 })
      onFocusHandled()
    }, 120)
    return () => clearTimeout(t)
  }, [focusId, fitView, onFocusHandled])

  // El lienzo pinta de este estado, no del derivado: si solo se repintara al
  // soltar, el nodo se quedaría clavado bajo el cursor y saltaría al final.
  // React Flow emite un cambio de posición por frame y aquí se aplican todos.
  const [liveNodes, setLiveNodes] = useState<Node<NodeData>[]>(nodes)
  const dragging = useRef(false)
  // Solo existe para poner la clase en el lienzo. La transición de las aristas
  // es lo que da continuidad cuando dagre recoloca, pero mientras el humano
  // arrastra sobra: el cable iría 380 ms por detrás del nodo.
  const [dragActive, setDragActive] = useState(false)

  // Mientras se arrastra, el servidor no manda: pisar la posición a mitad de
  // gesto es exactamente el tirón que esto viene a quitar. Al soltar se retoma.
  useEffect(() => {
    if (!dragging.current) setLiveNodes(nodes)
  }, [nodes])

  const onNodesChange = useCallback((changes: NodeChange<Node<NodeData>>[]) => {
    setLiveNodes((current) => applyNodeChanges(changes, current))
  }, [])

  /**
   * Soltar fija la posición: lo que coloca el humano manda sobre dagre.
   * Con varios nodos seleccionados se mueven todos, así que se fijan todos.
   */
  const fijar = useCallback(
    (movidos: Node[]) => {
      dragging.current = false
      setDragActive(false)
      pin(
        lens,
        movidos.map((m) => ({ id: m.id, x: m.position.x, y: m.position.y })),
      )
    },
    [pin, lens],
  )

  const empezarArrastre = useCallback(() => {
    dragging.current = true
    setDragActive(true)
  }, [])

  return (
    <ReactFlow
      className={dragActive ? 'arrastrando' : undefined}
      nodes={liveNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={empezarArrastre}
      onNodeDragStop={(_, node, dragged) => fijar(dragged.length ? dragged : [node])}
      onSelectionDragStart={empezarArrastre}
      onSelectionDragStop={(_, dragged) => fijar(dragged)}
      onNodeClick={(_, node) => onSelect(rawNodes.find((n) => n.id === node.id) ?? null)}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
      minZoom={0.15}
      maxZoom={2}
      fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#252833" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor="#2f3444" maskColor="rgba(12,13,18,.72)" />
    </ReactFlow>
  )
}
