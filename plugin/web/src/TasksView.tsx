/**
 * Vista de tareas.
 *
 * No hay ninguna herramienta nueva ni una llamada extra al modelo: el TODO ya
 * estaba en los datos. Cuando Claude marca un nodo como `planned`, `building`,
 * `problem` o `done` está diciendo exactamente en qué punto está esa pieza —
 * esto solo lo agrupa y lo ordena. Regla del canal (§2.3): si un script puede
 * derivarlo, no se le pide al modelo.
 *
 * SIGUE SIN SER EL KANBAN DEL BACKLOG (#12), y el matiz importa. Aquí se puede
 * arrastrar, pero solo DENTRO de un grupo: reordenar es declarar una intención
 * —«esto es lo siguiente»— y eso es del humano. Mover algo a «Terminado» sería
 * afirmar un hecho que solo Claude conoce, y por eso no se puede: la vista
 * mentiría hasta que Claude la pisara en la siguiente pasada.
 *
 * Dos columnas cuando hay de las dos lentes, porque el equipo de negocio y el
 * técnico miran cosas distintas y se sincronizan mirando la misma pantalla.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  homeLens,
  type DiagramEdge,
  type DiagramNode,
  type Lens,
  type NodeStatus,
} from '../../shared/diagram.ts'
import { dependencias, esAnotacion, estadoDesde, ordenar, type Vecino } from '../../shared/tareas.ts'
import { GLYPH, KIND_LABEL } from './nodes.tsx'
import type { HistoryEntry } from './useHistory.ts'
import { ESTANCADO_MS, hace } from './tiempo.ts'

/** El orden importa: lo bloqueado primero, porque es lo único accionable ya. */
const GROUPS: { status: NodeStatus; hint: string }[] = [
  { status: 'problem', hint: 'Claude encontró un problema aquí' },
  { status: 'building', hint: 'Se está construyendo ahora mismo' },
  { status: 'planned', hint: 'Declarado, todavía sin construir' },
  { status: 'done', hint: '' },
]

/** El título del grupo se dice en el idioma de la columna. */
const TITULO: Record<Lens, Record<NodeStatus, string>> = {
  tech: { problem: 'Bloqueado', building: 'En curso', planned: 'Planificado', done: 'Terminado' },
  business: { problem: 'Atascado', building: 'En marcha', planned: 'Ideas', done: 'Lanzado' },
}

/**
 * Técnica a la izquierda, negocio a la derecha. Y SIEMPRE las dos, aunque una
 * esté vacía: la columna vacía no es un hueco desperdiciado, es la pregunta de
 * «¿y esto para qué se vende?» ocupando sitio hasta que alguien la contesta.
 * Esconderla hacía que un proyecto sin negocio no supiera que le falta esa mitad.
 */
const COLUMNA: { lens: Lens; titulo: string; sub: string; vacia: string }[] = [
  {
    lens: 'tech',
    titulo: 'Técnica',
    sub: 'Cómo está hecho y qué falta',
    vacia: 'Todavía no hay piezas técnicas mapeadas. Pídele a Claude que mapee la estructura del proyecto.',
  },
  {
    lens: 'business',
    titulo: 'Negocio',
    sub: 'Qué se vende, a quién y por dónde',
    vacia:
      'Nada de negocio todavía. Cuéntale a Claude qué vendes, a quién y por qué canal, y lo irá poniendo aquí conforme lo habléis.',
  },
]

interface Tarea extends DiagramNode {
  /** Desde cuándo está en el estado en el que está. */
  desde?: number
  /** Quién tiene un problema que impide avanzar con esto. */
  bloqueadaPor: Vecino[]
  /** A quién está frenando esto, si el problema lo tiene ella. */
  frenaA: Vecino[]
}

export function TasksView({
  nodes,
  edges,
  history,
  lastTouched,
  onSelect,
  onReorder,
}: {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  history: HistoryEntry[]
  /** Lo que Claude acaba de tocar, igual que en el tablero. */
  lastTouched: string | null
  onSelect: (node: DiagramNode) => void
  onReorder: (entries: { id: string; priority: number }[]) => void
}) {
  /** Qué se está arrastrando y de qué grupo salió. */
  const [arrastrando, setArrastrando] = useState<{ id: string; grupo: string } | null>(null)

  const { columnas, progreso, bloqueadas } = useMemo(() => {
    const desde = estadoDesde(history)
    const { bloqueadaPor, frenaA } = dependencias(nodes, edges)
    const tareas: Tarea[] = nodes.map((n) => ({
      ...n,
      desde: desde.get(n.id),
      bloqueadaPor: bloqueadaPor.get(n.id) ?? [],
      frenaA: frenaA.get(n.id) ?? [],
    }))

    const porLente = new Map<Lens, Tarea[]>()
    for (const t of tareas) {
      // Las notas y las decisiones no entran: no son tareas. Se descartan aquí
      // y no al construir `tareas` porque sí cuentan para los bloqueos — una
      // decisión marcada como problema frena de verdad lo que depende de ella.
      if (esAnotacion(t.kind)) continue
      const clave = homeLens(t.kind)
      const lista = porLente.get(clave) ?? []
      lista.push(t)
      porLente.set(clave, lista)
    }

    const columnas = COLUMNA.map((c) => {
      const suyas = porLente.get(c.lens) ?? []
      return {
        ...c,
        total: suyas.length,
        grupos: GROUPS.map((g) => ({
          ...g,
          title: TITULO[c.lens][g.status],
          clave: `${c.lens}:${g.status}`,
          items: ordenar(suyas.filter((t) => t.status === g.status)),
        })).filter((g) => g.items.length > 0),
        sinEstado: ordenar(suyas.filter((t) => !t.status)),
      }
    })

    /**
     * El progreso cuenta solo lo que se ve en las columnas. Las notas y las
     * decisiones se quedan fuera de esta vista —una decisión ya tomada no es una
     * tarea accionable— y meterlas en el porcentaje sería medir sobre cosas que
     * no están en pantalla.
     */
    const enColumnas = tareas.filter((t) => !esAnotacion(t.kind))
    const conEstado = enColumnas.filter((t) => t.status).length
    const hechos = enColumnas.filter((t) => t.status === 'done').length

    return {
      columnas,
      progreso: conEstado === 0 ? 0 : Math.round((hechos / conEstado) * 100),
      /** Las que esperan a algo de la OTRA lente: el aviso que nadie ve hoy. */
      bloqueadas: tareas.filter(
        (t) => t.status !== 'done' && t.bloqueadaPor.some((v) => v.lens !== homeLens(t.kind)),
      ),
    }
  }, [nodes, edges, history])

  /**
   * Soltar reordena y reparte prioridades correlativas a todo el grupo.
   *
   * Se numera el grupo entero, no solo lo movido: si solo se tocara el arrastrado
   * habría que inventar fracciones entre dos vecinos y el orden acabaría
   * dependiendo de la precisión del coma flotante.
   */
  const soltar = useCallback(
    (grupo: string, items: Tarea[], destinoId: string) => {
      if (!arrastrando || arrastrando.grupo !== grupo || arrastrando.id === destinoId) {
        setArrastrando(null)
        return
      }
      const ids = items.map((t) => t.id)
      const origen = ids.indexOf(arrastrando.id)
      const destino = ids.indexOf(destinoId)
      if (origen < 0 || destino < 0) {
        setArrastrando(null)
        return
      }
      ids.splice(destino, 0, ...ids.splice(origen, 1))
      onReorder(ids.map((id, i) => ({ id, priority: i })))
      setArrastrando(null)
    },
    [arrastrando, onReorder],
  )

  if (nodes.length === 0) {
    return (
      <div className="view-empty">
        <h2>Nada que hacer todavía</h2>
        <p>Las tareas salen del estado de las piezas del tablero. En cuanto Claude marque algo como planificado o en curso, aparecerá aquí.</p>
      </div>
    )
  }

  /**
   * Una tarjeta. Arrastrable solo dentro de su grupo.
   *
   * Se lee con el MISMO lenguaje que un nodo del tablero, que es lo que permite
   * saltar de una vista a la otra sin recalibrar el ojo: el color dice el estado
   * y el glifo dice el tipo. La pastilla del glifo va del color del estado, no
   * del tipo — un nodo, un color; el tipo se comunica por la forma, que es el
   * canal que aguanta doce valores sin volverse ilegible.
   */
  const tarjeta = (node: Tarea, grupo: string, items: Tarea[]) => {
    const encallada = node.status === 'building' && node.desde !== undefined && Date.now() - node.desde > ESTANCADO_MS
    const propia = homeLens(node.kind)

    const clases = [
      'task',
      `status-${node.status ?? 'ninguno'}`,
      `kind-${node.kind}`,
      arrastrando?.id === node.id ? 'dragging' : '',
      // El mismo destello que en el tablero cuando Claude acaba de tocarlo.
      node.id === lastTouched ? 'fresh' : '',
      node.bloqueadaPor.length > 0 ? 'bloqueada' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <li key={node.id}>
        <button
          className={clases}
          onClick={() => onSelect(node)}
          draggable
          onDragStart={() => setArrastrando({ id: node.id, grupo })}
          onDragEnd={() => setArrastrando(null)}
          // Solo se admite soltar dentro del mismo grupo: mover algo entre
          // estados sería afirmar un hecho, y los hechos no son del humano.
          onDragOver={(e) => {
            if (arrastrando?.grupo === grupo) e.preventDefault()
          }}
          onDrop={(e) => {
            e.preventDefault()
            soltar(grupo, items, node.id)
          }}
        >
          <span className="task-tab" title={KIND_LABEL[node.kind]}>
            {GLYPH[node.kind]}
          </span>

          <span className="task-label">
            {node.label}
            {node.priority !== undefined && <span className="task-orden" title="Orden que le has dado tú">↕</span>}
          </span>
          {node.path && <span className="task-path">{node.path}</span>}
          {node.detail && <span className="task-detail">{node.detail}</span>}

          {/* Lo que está esperando a otra cosa. Cuando el culpable es de la otra
              lente, se dice de dónde viene: es justo la información que hoy no
              llega de un lado del equipo al otro. */}
          {node.bloqueadaPor.length > 0 && (
            <span className="task-bloqueo">
              ⛔ espera a {node.bloqueadaPor.map((v) => v.label).join(', ')}
              {node.bloqueadaPor.some((v) => v.lens !== propia) && (
                <em>{propia === 'business' ? ' — es cosa de la técnica' : ' — es cosa de negocio'}</em>
              )}
            </span>
          )}

          {/* Y al revés: lo que se está quedando parado por culpa de esto. Es lo
              que convierte una deuda técnica en una prioridad discutible con
              alguien que no programa. */}
          {node.frenaA.length > 0 && (
            <span className="task-frena">↯ frena a {node.frenaA.map((v) => v.label).join(', ')}</span>
          )}

          {node.desde !== undefined && (
            <span className={`task-desde ${encallada ? 'encallada' : ''}`}>
              {encallada ? '⚠ ' : ''}
              {hace(node.desde)}
            </span>
          )}
        </button>
      </li>
    )
  }

  return (
    <div className="view view-tasks">
      <header className="view-head">
        <div>
          <h1>Tareas</h1>
          <p className="view-sub">
            Derivadas del estado de cada pieza. El estado lo pone Claude; el orden, tú — arrastra dentro de un grupo.
          </p>
        </div>
        <div className="progress">
          <div className="progress-label">
            <span>{progreso}%</span> terminado
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progreso}%` }} />
          </div>
        </div>
      </header>

      {/* Lo más accionable de toda la pantalla: algo parado por culpa del otro
          lado del equipo. Es la única cosa que ninguna de las dos mitades puede
          ver por su cuenta, y por eso va antes que nada. */}
      {bloqueadas.length > 0 && (
        <div className="task-aviso">
          <strong>{bloqueadas.length}</strong>{' '}
          {bloqueadas.length === 1 ? 'tarea está esperando' : 'tareas están esperando'} a la otra parte del equipo:{' '}
          {bloqueadas.map((t) => t.label).join(', ')}
        </div>
      )}

      <div className="task-columns">
        {columnas.map((columna) => (
          <section key={columna.lens} className={`task-column lens-${columna.lens}`}>
            <header className="task-column-head">
              <h2>{columna.titulo}</h2>
              <span className="count">{columna.total}</span>
              <p>{columna.sub}</p>
            </header>

            {columna.total === 0 && <p className="task-column-vacia">{columna.vacia}</p>}

            {columna.grupos.map((group) => (
              <section key={group.clave} className="task-group">
                <div className="task-group-head">
                  <span className={`dot dot-${group.status}`} />
                  <h3>{group.title}</h3>
                  <span className="count">{group.items.length}</span>
                  {group.hint && <span className="task-group-hint">{group.hint}</span>}
                </div>
                <ul className="task-list">{group.items.map((n) => tarjeta(n, group.clave, group.items))}</ul>
              </section>
            ))}

            {columna.sinEstado.length > 0 && (
              <section className="task-group">
                <div className="task-group-head">
                  <span className="dot" />
                  <h3>Sin estado</h3>
                  <span className="count">{columna.sinEstado.length}</span>
                  <span className="task-group-hint">Claude no ha dicho en qué punto están</span>
                </div>
                <ul className="task-list">
                  {columna.sinEstado.map((n) => tarjeta(n, `${columna.lens}:sin`, columna.sinEstado))}
                </ul>
              </section>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
