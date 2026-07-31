/**
 * Tipos de nodo propios. Esta es la razón de haber descartado un whiteboard:
 * cada clase de pieza se dibuja como lo que es, no como un rectángulo genérico
 * con texto dentro.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeKind, NodeStatus } from '../../shared/diagram.ts'

export interface NodeData extends Record<string, unknown> {
  kind: NodeKind
  label: string
  detail?: string
  path?: string
  status?: NodeStatus
  fresh: boolean
  /** Si tiene algo enganchado por arriba y por abajo. Un conector sin cable no
      es información: es un punto suelto que el ojo intenta seguir a ninguna
      parte. */
  entra: boolean
  sale: boolean
}

/**
 * Exportados porque la vista de Piezas pinta los mismos tipos en forma de lista.
 * Tenerlos por duplicado aguantaba con siete kinds; con doce, la segunda copia
 * se queda atrás a la primera que se añada uno.
 */
export const GLYPH: Record<NodeKind, string> = {
  module: '▣',
  service: '⬢',
  file: '⌗',
  datastore: '⛁',
  external: '↗',
  // Los de negocio tiran de símbolos con carga propia — un megáfono para la
  // campaña, una diana para el objetivo — para que la lente se reconozca de un
  // vistazo sin leer una sola etiqueta.
  offer: '✦',
  campaign: '►',
  channel: '⇄',
  segment: '☗',
  goal: '◎',
  note: '✎',
  decision: '◈',
}

export const KIND_LABEL: Record<NodeKind, string> = {
  module: 'módulo',
  service: 'servicio',
  file: 'fichero',
  datastore: 'datos',
  external: 'externo',
  offer: 'oferta',
  campaign: 'campaña',
  channel: 'canal',
  segment: 'público',
  goal: 'objetivo',
  note: 'nota',
  decision: 'decisión',
}

function DiagramNodeView({ data, selected }: NodeProps & { data: NodeData }) {
  const classes = [
    'node',
    `kind-${data.kind}`,
    data.status ? `status-${data.status}` : '',
    data.fresh ? 'fresh' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} title={data.detail ?? data.path ?? data.label}>
      {data.entra && <Handle type="target" position={Position.Top} />}
      {/* La esquina lleva el glifo y es lo que dice el tipo de un vistazo. El
          nombre de la clase se queda en el `title`: escrito ocupaba una línea
          entera de las tres que caben. */}
      <span className="node-tab" title={KIND_LABEL[data.kind]}>
        {GLYPH[data.kind]}
      </span>
      {data.status && <span className={`node-dot dot-${data.status}`} />}
      <div className="node-label">{data.label}</div>
      {data.path && <div className="node-path">{data.path}</div>}
      {data.sale && <Handle type="source" position={Position.Bottom} />}
    </div>
  )
}

export const nodeTypes = { diagram: DiagramNodeView }
