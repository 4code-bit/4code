/**
 * Panel de detalle de una pieza.
 *
 * Vive aparte porque lo abren varias vistas: el tablero al clicar un nodo y la
 * lista de piezas al clicar una fila. Un panel por vista se habría desincronizado
 * a la tercera semana.
 */
import { safeUrl, type DiagramNode } from '../../shared/diagram.ts'
import { IconExternal } from './icons.tsx'

const KIND_LABEL: Record<string, string> = {
  module: 'módulo',
  service: 'servicio',
  file: 'fichero',
  datastore: 'datos',
  external: 'externo',
  note: 'nota',
  decision: 'decisión',
}

export function NodePanel({
  node,
  onClose,
  onLocate,
}: {
  node: DiagramNode
  onClose: () => void
  /** Saltar al tablero y enfocar esta pieza. Ausente si ya estás en el tablero. */
  onLocate?: () => void
}) {
  // Se revalida al pintar, no solo al guardar: el estado puede venir de un
  // fichero de disco que alguien editó a mano.
  const href = safeUrl(node.url)

  return (
    <aside className="panel">
      <button className="panel-close" onClick={onClose} aria-label="Cerrar">
        ×
      </button>
      <div className="panel-kind">{KIND_LABEL[node.kind] ?? node.kind}</div>
      <h2>{node.label}</h2>
      {node.path && <div className="panel-path">{node.path}</div>}
      {node.status && <div className={`panel-status status-${node.status}`}>{node.status}</div>}

      {href && (
        <a className="panel-link" href={href} target="_blank" rel="noopener noreferrer">
          <IconExternal />
          {href.replace(/^https?:\/\//, '')}
        </a>
      )}

      {node.detail ? (
        <p className="panel-detail">{node.detail}</p>
      ) : (
        <p className="panel-detail muted">Claude no ha anotado esta pieza todavía.</p>
      )}

      {onLocate && (
        <button className="panel-action" onClick={onLocate}>
          Ver en el tablero
        </button>
      )}

      <div className="panel-id">{node.id}</div>
    </aside>
  )
}
