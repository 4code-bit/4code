/**
 * Vista de piezas: el mismo grafo en forma de lista.
 *
 * El lienzo es bueno para entender cómo se conecta todo y malo para encontrar
 * algo concreto cuando ya sabes qué buscas. Esto es lo segundo.
 */
import { useMemo, useState } from 'react'
import { safeUrl, type DiagramNode, type NodeKind, type NodeStatus } from '../../shared/diagram.ts'
import { GLYPH, KIND_LABEL } from './nodes.tsx'
import { IconExternal, IconSearch } from './icons.tsx'

export function PiecesView({
  nodes,
  edges,
  onSelect,
}: {
  nodes: DiagramNode[]
  edges: { source: string; target: string }[]
  onSelect: (node: DiagramNode) => void
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<NodeKind | 'all'>('all')
  const [status, setStatus] = useState<NodeStatus | 'all'>('all')

  /** Cuántas conexiones tiene cada pieza: un indicio barato de qué es central. */
  const degree = useMemo(() => {
    const count = new Map<string, number>()
    for (const edge of edges) {
      count.set(edge.source, (count.get(edge.source) ?? 0) + 1)
      count.set(edge.target, (count.get(edge.target) ?? 0) + 1)
    }
    return count
  }, [edges])

  const kinds = useMemo(() => [...new Set(nodes.map((n) => n.kind))].sort(), [nodes])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return nodes
      .filter((n) => (kind === 'all' || n.kind === kind) && (status === 'all' || n.status === status))
      .filter(
        (n) =>
          !q ||
          n.label.toLowerCase().includes(q) ||
          n.path?.toLowerCase().includes(q) ||
          n.detail?.toLowerCase().includes(q) ||
          n.id.toLowerCase().includes(q),
      )
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label))
  }, [nodes, query, kind, status, degree])

  if (nodes.length === 0) {
    return (
      <div className="view-empty">
        <h2>Sin piezas</h2>
        <p>Cuando Claude mapee el proyecto, aquí tendrás la lista completa, buscable y filtrable.</p>
      </div>
    )
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Piezas</h1>
          <p className="view-sub">
            {filtered.length === nodes.length
              ? `${nodes.length} en el proyecto, ordenadas por cuántas conexiones tienen`
              : `${filtered.length} de ${nodes.length}`}
          </p>
        </div>
      </header>

      <div className="filters">
        <label className="search">
          <IconSearch />
          <input
            type="search"
            placeholder="Buscar por nombre, ruta o nota…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <select value={kind} onChange={(e) => setKind(e.target.value as NodeKind | 'all')}>
          <option value="all">Todos los tipos</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>

        <select value={status} onChange={(e) => setStatus(e.target.value as NodeStatus | 'all')}>
          <option value="all">Cualquier estado</option>
          <option value="problem">Bloqueado</option>
          <option value="building">En curso</option>
          <option value="planned">Planificado</option>
          <option value="done">Terminado</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="filters-empty">Nada coincide con ese filtro.</p>
      ) : (
        <ul className="pieces">
          {filtered.map((node) => {
            const href = safeUrl(node.url)
            const links = degree.get(node.id) ?? 0
            return (
              <li key={node.id}>
                <button className={`piece kind-${node.kind}`} onClick={() => onSelect(node)}>
                  <span className="piece-glyph">{GLYPH[node.kind]}</span>
                  <span className="piece-main">
                    <span className="piece-top">
                      <span className="piece-label">{node.label}</span>
                      {node.status && <span className={`chip status-${node.status}`}>{node.status}</span>}
                    </span>
                    {node.path && <span className="piece-path">{node.path}</span>}
                    {node.detail && <span className="piece-detail">{node.detail}</span>}
                  </span>
                  <span className="piece-meta">
                    {href && (
                      <span
                        className="piece-link"
                        role="link"
                        tabIndex={0}
                        title={href}
                        onClick={(e) => {
                          // El botón de la fila abre el panel; esto abre la app.
                          e.stopPropagation()
                          window.open(href, '_blank', 'noopener,noreferrer')
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.stopPropagation()
                          e.preventDefault()
                          window.open(href, '_blank', 'noopener,noreferrer')
                        }}
                      >
                        <IconExternal />
                      </span>
                    )}
                    {links > 0 && <span className="piece-degree">{links}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
