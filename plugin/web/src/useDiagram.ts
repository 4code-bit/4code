/**
 * Conexión con el canvas-server.
 *
 * Snapshot al conectar, patches después. El `seq` que asigna el servidor detecta
 * deriva: si llega un patch con un seq que no encaja, pedimos snapshot en vez de
 * seguir aplicando sobre un estado que ya no coincide. Esa es la vía de escape
 * del plan, no el camino habitual.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyOperation,
  emptyState,
  type DiagramEdge,
  type DiagramNode,
  type Lens,
  type Operation,
  type ServerMessage,
} from '../../shared/diagram.ts'

const CANVAS_PORT = 41847
const HTTP = `http://127.0.0.1:${CANVAS_PORT}`
const WS = `ws://127.0.0.1:${CANVAS_PORT}`

export type Status = 'connecting' | 'live' | 'offline'

export interface DiagramView {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  status: Status
  seq: number
  /** Última operación aplicada — sirve para resaltar lo que acaba de cambiar. */
  lastTouched: string | null
  applyLocal: (operation: Operation) => void
  /** Dónde ha colocado el humano unos nodos, en un tablero. Se pinta ya y se
      guarda aparte. */
  pin: (lens: Lens, positions: { id: string; x: number; y: number }[]) => void
  /** En qué orden quiere atacarlos. Igual que `pin`: intención suya, no un hecho. */
  prioritize: (entries: { id: string; priority: number }[]) => void
}

function touchedId(operation: Operation): string | null {
  switch (operation.op) {
    case 'add_node':
      return operation.node.id
    case 'update_node':
    case 'set_status':
    case 'annotate':
      return operation.id
    case 'add_edge':
      return operation.edge.target
    default:
      return null
  }
}

export function useDiagram(projectId: string | null): DiagramView {
  const state = useRef(emptyState())
  const [nodes, setNodes] = useState<DiagramNode[]>([])
  const [edges, setEdges] = useState<DiagramEdge[]>([])
  const [status, setStatus] = useState<Status>('connecting')
  const [seq, setSeq] = useState(0)
  const [lastTouched, setLastTouched] = useState<string | null>(null)

  const publish = useCallback(() => {
    setNodes([...state.current.nodes.values()])
    setEdges([...state.current.edges.values()])
    setSeq(state.current.seq)
  }, [])

  /** Ediciones locales del humano. Se pintan sin esperar al servidor. */
  const applyLocal = useCallback(
    (operation: Operation) => {
      if (applyOperation(state.current, operation)) publish()
    },
    [publish],
  )

  /**
   * Colocar un nodo sí se guarda: si no, cada F5 deshacía el orden que el humano
   * acaba de darle al tablero. Va por `/layout` y no por el historial — arrastrar
   * una caja no es un hecho del proyecto y no debe salir en Actividad.
   *
   * Se pinta primero y se guarda después: el gesto ya ha ocurrido en la pantalla
   * y esperar a la respuesta solo añadiría un tirón.
   */
  const pin = useCallback(
    (lens: Lens, positions: { id: string; x: number; y: number }[]) => {
      if (!positions.length) return
      for (const { id, x, y } of positions) {
        const actual = state.current.nodes.get(id)
        applyOperation(state.current, {
          op: 'update_node',
          id,
          // Se conserva la posición del OTRO tablero: la oferta se dibuja en los
          // dos y colocarla aquí no dice nada de dónde debe estar allí.
          patch: { pinned: { ...actual?.pinned, [lens]: { x, y } } },
        })
      }
      publish()

      if (!projectId) return
      void fetch(`${HTTP}/layout?project=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ positions, lens }),
      }).catch(() => {
        /* sin servidor el tablero sigue usable; se pierde al recargar */
      })
    },
    [projectId, publish],
  )

  /**
   * El orden que el humano da a sus tareas. Mismo canal que `pin` y por el mismo
   * motivo: es una intención suya, y `status` —que es un hecho— sigue siendo de
   * Claude en exclusiva. Los dos escriben en el tablero sin poder pisarse.
   */
  const prioritize = useCallback(
    (entries: { id: string; priority: number }[]) => {
      if (!entries.length) return
      for (const { id, priority } of entries) {
        applyOperation(state.current, { op: 'update_node', id, patch: { priority } })
      }
      publish()

      if (!projectId) return
      void fetch(`${HTTP}/layout?project=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ priority: entries }),
      }).catch(() => {
        /* igual que el layout: se pierde al recargar, pero la vista sigue viva */
      })
    },
    [projectId, publish],
  )

  useEffect(() => {
    // Cambiar de proyecto es empezar de cero: el estado del anterior no puede
    // quedarse ni un frame, o se verían nodos del proyecto que acabas de dejar.
    state.current = emptyState()
    setNodes([])
    setEdges([])
    setSeq(0)
    setLastTouched(null)

    if (!projectId) {
      setStatus('connecting')
      return
    }

    const query = `project=${encodeURIComponent(projectId)}`
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const resync = async () => {
      try {
        const res = await fetch(`${HTTP}/state?${query}`)
        const snap = (await res.json()) as { seq: number; nodes: DiagramNode[]; edges: DiagramEdge[] }
        state.current = emptyState()
        state.current.seq = snap.seq
        for (const n of snap.nodes) state.current.nodes.set(n.id, n)
        for (const e of snap.edges) state.current.edges.set(e.id, e)
        publish()
      } catch {
        /* el socket reintentará */
      }
    }

    const connect = () => {
      if (closed) return
      socket = new WebSocket(`${WS}/?${query}`)

      socket.onopen = () => setStatus('live')

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as ServerMessage

        if (message.type === 'snapshot') {
          state.current = emptyState()
          state.current.seq = message.seq
          for (const n of message.nodes) state.current.nodes.set(n.id, n)
          for (const e of message.edges) state.current.edges.set(e.id, e)
          setLastTouched(null)
          publish()
          return
        }

        // Deriva: nos hemos perdido operaciones. Resincronizar en vez de adivinar.
        if (message.seq !== state.current.seq + 1) {
          void resync()
          return
        }

        if (applyOperation(state.current, message.operation)) {
          state.current.seq = message.seq
          setLastTouched(touchedId(message.operation))
          publish()
        }
      }

      socket.onclose = () => {
        if (closed) return
        setStatus('offline')
        retry = setTimeout(connect, 1200)
      }

      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      socket?.close()
    }
  }, [projectId, publish])

  return { nodes, edges, status, seq, lastTouched, applyLocal, pin, prioritize }
}
