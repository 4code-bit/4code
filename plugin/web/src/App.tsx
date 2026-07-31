/**
 * Armazón de la aplicación: rail de vistas, cabecera de proyecto y la vista
 * activa. Todo lo que se enseña sale de datos que ya existen — el grafo, el
 * estado de cada pieza y el log de operaciones — sin pedirle nada más al modelo.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'

import { useDiagram } from './useDiagram.ts'
import { useProjects } from './useProjects.ts'
import { useHistory } from './useHistory.ts'
import { useSessions } from './useSessions.ts'
import { useTeam } from './useTeam.ts'
import { useCloudBoard } from './useCloudBoard.ts'
import { BoardView } from './BoardView.tsx'
import { CloudChip } from './CloudChip.tsx'
import { TasksView } from './TasksView.tsx'
import { ActivityView } from './ActivityView.tsx'
import { PiecesView } from './PiecesView.tsx'
import { SessionsView } from './SessionsView.tsx'
import { TeamView } from './TeamView.tsx'
import { NodePanel } from './NodePanel.tsx'
import {
  IconActivity,
  IconBoard,
  IconBusiness,
  IconPieces,
  IconSessions,
  IconTasks,
  IconTeam,
} from './icons.tsx'
import { LAYER_LABEL } from '../../shared/layer.ts'
import { homeLens, STATUS_LABEL, visibleInLens, type Lens } from '../../shared/diagram.ts'
import type { DiagramNode, NodeStatus } from '../../shared/diagram.ts'

type View = 'board' | 'business' | 'tasks' | 'activity' | 'pieces' | 'sessions' | 'team'

/**
 * La lente ya no es un control aparte: la dice la vista en la que estás.
 *
 * Hubo un conmutador de tres posiciones con un modo «Todo», y se quitó porque
 * mezclar las dos lentes en un lienzo salía revuelto: los nodos de negocio
 * apenas tienen aristas con los técnicos, y dagre coloca componentes
 * desconectados sin criterio, así que una campaña acababa dibujada entre dos
 * módulos de código.
 *
 * El precio, asumido a conciencia: una arista `supports` tiene ahora un extremo
 * en cada tablero y no se puede dibujar. La relación no se pierde —sigue en el
 * modelo y la vista de Tareas la usa para avisar de qué espera a qué— pero deja
 * de verse como cable.
 *
 * Las vistas de lista van con 'all': Tareas ya separa en dos columnas por sí
 * sola y necesita el grafo completo para cruzar los bloqueos.
 */
function lensOfView(view: View): Lens | 'all' {
  if (view === 'board') return 'tech'
  if (view === 'business') return 'business'
  return 'all'
}

const VIEWS: { id: View; label: string; icon: () => React.ReactElement }[] = [
  { id: 'board', label: 'Tablero', icon: IconBoard },
  { id: 'business', label: 'Negocio', icon: IconBusiness },
  { id: 'tasks', label: 'Tareas', icon: IconTasks },
  { id: 'activity', label: 'Actividad', icon: IconActivity },
  { id: 'pieces', label: 'Piezas', icon: IconPieces },
  { id: 'sessions', label: 'Sesiones', icon: IconSessions },
  { id: 'team', label: 'Equipo', icon: IconTeam },
]

function viewFromUrl(): View {
  const v = new URLSearchParams(window.location.search).get('view')
  return VIEWS.some((x) => x.id === v) ? (v as View) : 'board'
}

function Shell() {
  const { projects, selected: projectId, select, current } = useProjects()
  const { nodes: allNodes, edges: allEdges, status, seq, lastTouched, pin, prioritize } = useDiagram(projectId)
  const history = useHistory(projectId, seq)
  const [view, setView] = useState<View>(viewFromUrl)
  const lens = lensOfView(view)
  // Solo sondean mientras su vista está abierta.
  const sessions = useSessions(projectId, view === 'sessions')
  const team = useTeam(projectId, view === 'team')
  // Solo se pregunta cuando el proyecto está vacío del todo —no cuando lo está la
  // lente— que es cuando cambia el consejo que hay que dar.
  const enLaNube = useCloudBoard(projectId, allNodes.length === 0)

  const [selectedNode, setSelectedNode] = useState<DiagramNode | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  /**
   * El filtro se aplica una vez aquí y no en cada vista. Tareas, Piezas y el
   * tablero beben del mismo array ya filtrado, así que la lente no puede
   * significar una cosa en una pantalla y otra en la de al lado.
   */
  const nodes = useMemo(() => allNodes.filter((n) => visibleInLens(n.kind, lens)), [allNodes, lens])

  /**
   * Una arista solo sobrevive si sus dos extremos siguen en pie. Es lo que hace
   * que `supports` — la que cruza — desaparezca al aislar una lente: con un
   * extremo fuera de la vista sería un cable hacia la nada.
   */
  const edges = useMemo(() => {
    if (lens === 'all') return allEdges
    const vivos = new Set(nodes.map((n) => n.id))
    return allEdges.filter((e) => vivos.has(e.source) && vivos.has(e.target))
  }, [allEdges, nodes, lens])

  /**
   * Cuántas piezas de este tablero están enganchadas al otro por un `supports`.
   *
   * Separar los tableros dejó esas aristas sin poder dibujarse —cada extremo
   * está en una vista distinta—, así que la relación se cuenta aquí para que al
   * menos se sepa que existe y se pueda saltar al otro lado.
   */
  const cruces = useMemo(() => {
    if (lens === 'all') return 0
    const visibles = new Set(nodes.map((n) => n.id))
    const conCruce = new Set<string>()
    for (const e of allEdges) {
      if (e.kind !== 'supports') continue
      if (visibles.has(e.source) !== visibles.has(e.target)) {
        conCruce.add(visibles.has(e.source) ? e.source : e.target)
      }
    }
    return conCruce.size
  }, [allEdges, nodes, lens])

  const esLienzo = view === 'board' || view === 'business'

  // La vista también vive en la URL: recargar no debe devolverte al tablero si
  // estabas mirando la actividad.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get('view') === view) return
    url.searchParams.set('view', view)
    window.history.replaceState(null, '', url)
  }, [view])

  // Cambiar de vista suelta el nodo si se lo ha llevado el filtro: el panel de
  // detalle de una pieza que ya no está en pantalla no tiene a qué referirse.
  // La lente ya viaja en la URL a través de `view`, así que no hace falta más.
  useEffect(() => {
    setSelectedNode((actual) => (actual && !visibleInLens(actual.kind, lens) ? null : actual))
  }, [lens])

  // Cambiar de proyecto suelta el nodo enfocado: si no, el panel se queda
  // enseñando una pieza del proyecto anterior.
  useEffect(() => {
    setSelectedNode(null)
  }, [projectId])

  /** El nodo del panel se re-lee del estado vivo para que no se quede rancio. */
  const panelNode = useMemo(
    () => (selectedNode ? (nodes.find((n) => n.id === selectedNode.id) ?? selectedNode) : null),
    [selectedNode, nodes],
  )

  /** Saltar a la pieza en su tablero, que ahora depende de lo que sea. */
  const locate = useCallback((node: DiagramNode) => {
    setView(homeLens(node.kind) === 'business' ? 'business' : 'board')
    setFocusId(node.id)
  }, [])

  /**
   * La leyenda cuenta por estado, pero lo nombra en el idioma de la lente: en
   * negocio no hay nada «en construcción», hay cosas en marcha. La clave sigue
   * siendo el estado crudo porque es lo que da el color.
   */
  const counts = useMemo(() => {
    const byStatus = new Map<string, number>()
    for (const n of nodes) byStatus.set(n.status ?? 'sin estado', (byStatus.get(n.status ?? 'sin estado') ?? 0) + 1)
    const vocabulario = STATUS_LABEL[lens === 'business' ? 'business' : 'tech']
    return [...byStatus.entries()].map(([clave, n]) => ({
      clave,
      label: clave === 'sin estado' ? 'sin estado' : vocabulario[clave as NodeStatus],
      n,
    }))
  }, [nodes, lens])

  /**
   * El aviso del rail cuenta sobre TODO el proyecto, no sobre la vista abierta:
   * un número que baja al cambiar de tablero no es un aviso, es un despiste.
   */
  const pendientes = useMemo(
    () => allNodes.filter((n) => n.status === 'planned' || n.status === 'building' || n.status === 'problem').length,
    [allNodes],
  )

  return (
    <div className="app">
      {/* ── Rail ─────────────────────────────────────────────────────────── */}
      <nav className="rail" aria-label="Vistas">
        <div className="rail-brand" title="4Code">
          4<span>C</span>
        </div>
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`rail-btn rail-${id} ${view === id ? 'active' : ''}`}
            onClick={() => setView(id)}
            title={label}
            aria-current={view === id}
          >
            <Icon />
            <span className="rail-tip">{label}</span>
            {id === 'tasks' && pendientes > 0 && <span className="rail-badge">{pendientes}</span>}
            {/* Una colisión es lo más urgente que puede enseñar el tablero. */}
            {id === 'team' && team && team.collisions.length > 0 && (
              <span className="rail-badge badge-alerta">{team.collisions.length}</span>
            )}
          </button>
        ))}
        <div className={`rail-conn conn-${status}`} title={status === 'live' ? 'En vivo' : 'Sin conexión'}>
          <span className="conn-dot" />
        </div>
      </nav>

      <div className="main">
        {/* ── Cabecera ───────────────────────────────────────────────────── */}
        <header className="bar">
          <div className="bar-project">
            {projects.length > 0 ? (
              <select
                className="project-picker"
                value={projectId ?? ''}
                onChange={(e) => select(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="brand">4Code</span>
            )}
            {current?.root && <span className="bar-root" title={current.root}>{current.root}</span>}
            {/* Dónde vive este tablero. Va junto al proyecto porque es una
                propiedad suya, no del estado de la conexión local. */}
            <CloudChip project={current} />
          </div>

          <div className="stats">
            <span>{nodes.length} piezas</span>
            <span>{edges.length} conexiones</span>
            <span className="muted">op {seq}</span>
            {/* La capa de la sesión más reciente (§4.3), derivada de los hooks. */}
            {sessions[0] && <span className={`layer layer-${sessions[0].layer}`}>{LAYER_LABEL[sessions[0].layer]}</span>}
          </div>

          <div className={`conn conn-${status}`}>
            <span className="conn-dot" />
            {status === 'live' ? 'en vivo' : status === 'connecting' ? 'conectando…' : 'sin conexión'}
          </div>
        </header>

        {/* ── Vista activa ───────────────────────────────────────────────── */}
        <div className={`stage ${esLienzo ? 'stage-canvas' : 'stage-scroll'}`}>
          {/* El mismo lienzo para los dos tableros: lo único que cambia es qué
              nodos le llegan. Dos componentes gemelos habrían divergido a la
              primera mejora que se le hiciera a uno. La `key` fuerza un montaje
              nuevo al cambiar de tablero, para que el layout no arrastre las
              posiciones del otro. */}
          {esLienzo && (
            <BoardView
              key={view}
              nodes={nodes}
              edges={edges}
              lens={view === 'business' ? 'business' : 'tech'}
              lastTouched={lastTouched}
              pin={pin}
              onSelect={setSelectedNode}
              projectId={projectId}
              focusId={focusId}
              onFocusHandled={() => setFocusId(null)}
            />
          )}
          {view === 'tasks' && (
            <TasksView
              nodes={nodes}
              edges={edges}
              history={history}
              lastTouched={lastTouched}
              onSelect={setSelectedNode}
              onReorder={prioritize}
            />
          )}
          {view === 'activity' && <ActivityView history={history} nodes={nodes} />}
          {view === 'pieces' && <PiecesView nodes={nodes} edges={edges} onSelect={setSelectedNode} />}
          {view === 'sessions' && <SessionsView sessions={sessions} />}
          {view === 'team' && <TeamView team={team} project={current} />}

          {esLienzo && nodes.length === 0 && (
            <div className="empty">
              {view === 'business' ? (
                <>
                  <h1>Nada de negocio todavía</h1>
                  <p>
                    Este tablero no sale del código: sale de lo que le cuentes. Háblale a Claude de qué vendes, a
                    quién, por qué canal y con qué objetivo, y lo irá dibujando aquí conforme lo habléis.
                  </p>
                </>
              ) : enLaNube?.exists ? (
                /*
                 * Vacío aquí, pero lleno arriba: alguien de tu equipo ya lo dibujó.
                 * Decirle a esta persona que le pida a Claude que mapee sería el
                 * consejo equivocado — redibujarlo desde otra máquina genera piezas
                 * casi duplicadas, porque los ids los elige Claude cada vez.
                 */
                <>
                  <h1>Este tablero ya existe, pero no en esta máquina</h1>
                  <p>
                    En la nube hay {enLaNube.pieces} piezas
                    {enLaNube.people ? ` de ${enLaNube.people} persona${enLaNube.people === 1 ? '' : 's'}` : ''}. El
                    tablero local solo enseña lo que ha dibujado esta máquina, y los datos suben pero no bajan
                    solos. Para traértelo:
                  </p>
                  <code>/4code:restore</code>
                  <p>
                    No le pidas a Claude que lo mapee otra vez: elegiría ids distintos y acabarías con piezas
                    casi duplicadas.{' '}
                    {enLaNube.url && (
                      <a href={enLaNube.url} target="_blank" rel="noopener noreferrer">
                        Verlo en la nube
                      </a>
                    )}
                  </p>
                </>
              ) : (
                <>
                  <h1>
                    {projects.length === 0 ? 'Esperando a Claude' : `${current?.name ?? 'Proyecto'} sin mapear`}
                  </h1>
                  <p>
                    {projects.length === 0
                      ? 'Instala el servidor MCP en tu sesión y ponte a trabajar. El diagrama se irá dibujando solo conforme Claude entienda y construya tu proyecto.'
                      : 'Este proyecto todavía no tiene nada dibujado. Pídele a Claude que mapee la estructura desde una sesión abierta en esa carpeta.'}
                  </p>
                  {projects.length === 0 && <code>/plugin marketplace add https://github.com/4code-bit/4code.git</code>}
                </>
              )}
            </div>
          )}

          {panelNode && (
            <NodePanel
              node={panelNode}
              onClose={() => setSelectedNode(null)}
              onLocate={esLienzo ? undefined : () => locate(panelNode)}
            />
          )}
        </div>

        {esLienzo && counts.length > 0 && (
          <footer className="legend">
            {counts.map(({ clave, label, n }) => (
              <span key={clave} className={`chip status-${clave}`}>
                {label}: {n}
              </span>
            ))}
            {/* Lo que sostiene algo del otro tablero. Es el hueco que dejó
                separar las vistas: el cable no se puede dibujar, así que al
                menos se dice cuántos hay y se puede saltar allí. */}
            {cruces > 0 && (
              <button
                className="chip chip-oculto"
                onClick={() => setView(view === 'board' ? 'business' : 'board')}
                title="Estas piezas están conectadas con el otro tablero"
              >
                {cruces} {cruces === 1 ? 'conexión' : 'conexiones'} con {view === 'board' ? 'Negocio' : 'Técnica'} ↗
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  )
}
