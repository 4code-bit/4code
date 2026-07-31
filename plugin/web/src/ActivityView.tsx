/**
 * Vista de actividad: la línea temporal del proyecto.
 *
 * El plan lo dice desde el principio — el log de operaciones **es** la línea
 * temporal. Ya se escribía en `history.jsonl`, ya sobrevive a los reinicios, y
 * hasta ahora nadie lo miraba. Esto no genera ni un dato nuevo: solo traduce
 * operaciones a frases y las ordena.
 */
import { useMemo } from 'react'
import type { DiagramNode, NodeStatus, Operation } from '../../shared/diagram.ts'
import type { HistoryEntry } from './useHistory.ts'

const STATUS_TEXT: Record<NodeStatus, string> = {
  planned: 'planificado',
  building: 'en curso',
  done: 'terminado',
  problem: 'con problemas',
}

interface Line {
  seq: number
  at: number
  verb: string
  subject: string
  extra?: string
  tone: 'add' | 'link' | 'status' | 'note' | 'remove'
  status?: NodeStatus
}

function describe(operation: Operation, labelOf: (id: string) => string): Line | null {
  switch (operation.op) {
    case 'add_node':
      return { seq: 0, at: 0, verb: 'Añadió', subject: operation.node.label, tone: 'add' }
    case 'update_node':
      return { seq: 0, at: 0, verb: 'Actualizó', subject: labelOf(operation.id), tone: 'note' }
    case 'remove_node':
      return { seq: 0, at: 0, verb: 'Eliminó', subject: labelOf(operation.id), tone: 'remove' }
    case 'add_edge':
      return {
        seq: 0,
        at: 0,
        verb: 'Conectó',
        subject: labelOf(operation.edge.source),
        extra: `→ ${labelOf(operation.edge.target)} (${operation.edge.kind})`,
        tone: 'link',
      }
    case 'remove_edge':
      return { seq: 0, at: 0, verb: 'Desconectó', subject: '', tone: 'remove' }
    case 'set_status':
      return {
        seq: 0,
        at: 0,
        verb: 'Marcó',
        subject: labelOf(operation.id),
        extra: `como ${STATUS_TEXT[operation.status]}`,
        tone: 'status',
        status: operation.status,
      }
    case 'annotate':
      return { seq: 0, at: 0, verb: 'Anotó', subject: labelOf(operation.id), extra: operation.detail, tone: 'note' }
    case 'reset':
      return { seq: 0, at: 0, verb: 'Vació el tablero', subject: '', tone: 'remove' }
    default:
      return null
  }
}

const fecha = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
const hora = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' })

export function ActivityView({ history, nodes }: { history: HistoryEntry[]; nodes: DiagramNode[] }) {
  const days = useMemo(() => {
    // Los nodos borrados ya no están en el estado, así que el historial también
    // aporta nombres: sin esto, la línea temporal enseñaría ids crudos.
    const labels = new Map<string, string>()
    for (const entry of history) {
      if (entry.operation.op === 'add_node') labels.set(entry.operation.node.id, entry.operation.node.label)
    }
    for (const node of nodes) labels.set(node.id, node.label)
    const labelOf = (id: string) => labels.get(id) ?? id

    const lines: Line[] = []
    for (const entry of history) {
      const line = describe(entry.operation, labelOf)
      if (line) lines.push({ ...line, seq: entry.seq, at: entry.at })
    }

    // Lo más reciente arriba: al volver al tablero lo que se quiere saber es
    // qué acaba de pasar, no cómo empezó todo.
    lines.reverse()

    const grouped = new Map<string, Line[]>()
    for (const line of lines) {
      const key = new Date(line.at).toDateString()
      const list = grouped.get(key) ?? []
      list.push(line)
      grouped.set(key, list)
    }
    return [...grouped.entries()]
  }, [history, nodes])

  if (history.length === 0) {
    return (
      <div className="view-empty">
        <h2>Todavía no ha pasado nada</h2>
        <p>Cada operación sobre el tablero queda registrada aquí, con su hora. Es la línea temporal del proyecto.</p>
      </div>
    )
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Actividad</h1>
          <p className="view-sub">
            {history.length} operaciones registradas. Sale del log del tablero, no de preguntarle nada a Claude.
          </p>
        </div>
      </header>

      <div className="timeline">
        {days.map(([day, lines]) => (
          <section key={day} className="timeline-day">
            <h2 className="timeline-date">{fecha.format(new Date(day))}</h2>
            <ul>
              {lines.map((line) => (
                <li key={line.seq} className={`event tone-${line.tone}`}>
                  <span className="event-time">{hora.format(new Date(line.at))}</span>
                  <span className="event-marker" />
                  <span className="event-text">
                    <span className="event-verb">{line.verb}</span>{' '}
                    {line.subject && <strong>{line.subject}</strong>}{' '}
                    {line.extra && (
                      <span className={line.status ? `event-status status-${line.status}` : 'event-extra'}>
                        {line.extra}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
