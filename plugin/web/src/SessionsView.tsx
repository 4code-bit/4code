/**
 * Vista de sesiones: qué ha hecho Claude en este proyecto, sesión a sesión.
 *
 * Todo sale de hooks. Coste en tokens: cero. Y nada de lo que se ve aquí ha
 * pasado por el modelo — son metadatos que Claude Code emite igualmente.
 */
import { useMemo } from 'react'
import { LAYER_LABEL, type WorkLayer } from '../../shared/layer.ts'
import type { SessionWithLayer } from '../../shared/session.ts'

const fecha = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
const hora = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' })

const SOURCE_LABEL: Record<string, string> = {
  startup: 'arranque',
  resume: 'retomada',
  clear: 'limpiada',
  compact: 'tras compactar',
  fork: 'bifurcada',
}

function duracion(desde: number, hasta: number): string {
  const s = Math.max(0, Math.round((hasta - desde) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

function LayerBadge({ layer }: { layer: WorkLayer }) {
  return <span className={`layer layer-${layer}`}>{LAYER_LABEL[layer]}</span>
}

export function SessionsView({ sessions }: { sessions: SessionWithLayer[] }) {
  const totales = useMemo(() => {
    const ficheros = new Set<string>()
    let llamadas = 0
    for (const s of sessions) {
      for (const f of s.files) ficheros.add(f)
      llamadas += Object.values(s.tools).reduce((a, b) => a + b, 0)
    }
    return { ficheros: ficheros.size, llamadas }
  }, [sessions])

  if (sessions.length === 0) {
    return (
      <div className="view-empty">
        <h2>Sin sesiones registradas</h2>
        <p>
          Los hooks escriben aquí cada sesión de Claude Code en este proyecto: qué herramientas
          usó, qué ficheros tocó y en qué capa estuvo trabajando. Sin gastar un token. Si acabas
          de instalarlos, reinicia Claude Code.
        </p>
      </div>
    )
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Sesiones</h1>
          <p className="view-sub">
            {sessions.length} sesión(es) · {totales.llamadas} llamadas a herramientas ·{' '}
            {totales.ficheros} ficheros tocados. Todo por hooks, cero tokens.
          </p>
        </div>
      </header>

      <ul className="sessions">
        {sessions.map((s) => {
          const herramientas = Object.entries(s.tools).sort((a, b) => b[1] - a[1])
          const subagentes = Object.entries(s.subagents).sort((a, b) => b[1] - a[1])
          const abierta = s.endedAt === undefined

          return (
            <li key={s.sessionId} className="session">
              <div className="session-head">
                <span className="session-when">
                  {fecha.format(new Date(s.startedAt))} · {hora.format(new Date(s.startedAt))}
                </span>
                <LayerBadge layer={s.layer} />
                {abierta ? (
                  <span className="session-open">abierta</span>
                ) : (
                  <span className="session-dur">{duracion(s.startedAt, s.endedAt!)}</span>
                )}
                {s.source && <span className="session-source">{SOURCE_LABEL[s.source] ?? s.source}</span>}
              </div>

              <div className="session-stats">
                <span>
                  <strong>{s.events}</strong> eventos
                </span>
                <span>
                  <strong>{s.files.length}</strong> ficheros
                </span>
                {s.compactions > 0 && (
                  <span title="Cada compactación es un punto donde Claude pudo perder el hilo">
                    <strong>{s.compactions}</strong> compactación(es)
                  </span>
                )}
              </div>

              {herramientas.length > 0 && (
                <div className="session-tools">
                  {herramientas.slice(0, 8).map(([tool, n]) => (
                    <span key={tool} className="tool-chip">
                      {tool}
                      <span className="tool-n">{n}</span>
                    </span>
                  ))}
                  {herramientas.length > 8 && (
                    <span className="tool-chip muted">+{herramientas.length - 8}</span>
                  )}
                </div>
              )}

              {subagentes.length > 0 && (
                <div className="session-tools">
                  {subagentes.map(([agent, n]) => (
                    <span key={agent} className="tool-chip agent">
                      {agent}
                      <span className="tool-n">{n}</span>
                    </span>
                  ))}
                </div>
              )}

              {s.files.length > 0 && (
                <ul className="session-files">
                  {s.files.slice(0, 6).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                  {s.files.length > 6 && <li className="muted">y {s.files.length - 6} más</li>}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
