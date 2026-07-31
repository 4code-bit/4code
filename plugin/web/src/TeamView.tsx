/**
 * Vista de equipo.
 *
 * Todo sale de git y de tu propio clon: quién está en qué rama, qué toca y en
 * qué capa anda. **Tus colaboradores no necesitan tener 4Code instalado.**
 *
 * Lo primero que se enseña son las colisiones, porque es lo único accionable
 * ahora mismo: enterarte de que alguien está tocando lo que tú tienes a medias
 * sirve hoy; enterarte en el merge, no (§4.2).
 */
import { LAYER_LABEL } from '../../shared/layer.ts'
import { hace } from './tiempo.ts'
import type { ProjectSummary } from '../../shared/project.ts'
import type { TeamView as Team } from '../../shared/team.ts'

const hora = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const ESTADO_MIO: Record<string, string> = {
  modified: 'lo tienes modificado',
  staged: 'lo tienes en el índice',
  untracked: 'lo tienes sin seguir',
}

export function TeamView({ team, project }: { team: Team | null; project: ProjectSummary | null }) {
  if (!team) {
    return (
      <div className="view-empty">
        <h2>Leyendo git…</h2>
      </div>
    )
  }

  /**
   * La carpeta ya no está: disco desconectado, o el proyecto movido de sitio.
   *
   * El tablero no se ha perdido —vive en `~/.4code`, no en la carpeta—, pero git
   * no se puede leer. Va antes que todo lo demás porque, sin decirlo, la ausencia
   * se leía como «esto no es un repositorio».
   */
  if (!team.hasRoot) {
    return (
      <div className="view-empty">
        <h2>La carpeta de este proyecto ya no está aquí</h2>
        <p>
          El tablero está entero —no vive en la carpeta, vive en 4Code—, pero la vista de equipo se
          lee de git y para eso hace falta el clon.
          {project?.root && (
            <>
              {' '}
              La ruta que tiene guardada es <code>{project.root}</code>: ¿un disco sin conectar, o la
              moviste de sitio?
            </>
          )}
        </p>
      </div>
    )
  }

  /**
   * Sin repositorio y sin remoto se veían igual, y no son lo mismo.
   *
   * El caso frecuente es abrir Claude Code en la carpeta que **contiene** los
   * repos: ahí «este repositorio no tiene remoto» es falso —no hay repositorio— y
   * manda a buscar un remoto que no arreglaría nada.
   */
  if (!team.hasRepo) {
    const dentro = project?.innerRepos ?? []
    return (
      <div className="view-empty">
        <h2>Esta carpeta no es un repositorio de git</h2>
        <p>
          La vista de equipo sale de git: de las ramas y los commits que otras personas publican en
          el remoto, no de un servidor nuestro. Sin repositorio no hay de dónde leerlo.
        </p>
        {dentro.length > 0 && (
          <p>
            Dentro sí {dentro.length === 1 ? 'hay uno' : 'hay repositorios'}:{' '}
            <strong>{dentro.join(', ')}</strong>. Abre Claude Code{' '}
            {dentro.length === 1 ? 'en esa carpeta' : 'en una de esas carpetas'} y tendrá su propio
            tablero, su equipo y su sitio en la nube.
          </p>
        )}
      </div>
    )
  }

  if (!team.hasRemote) {
    return (
      <div className="view-empty">
        <h2>Este repositorio no tiene remoto</h2>
        <p>
          Sin remoto no hay con quién compararse: la vista de equipo sale de las ramas que otras
          personas publican, no de un servidor nuestro.
        </p>
      </div>
    )
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Equipo</h1>
          <p className="view-sub">
            Todo derivado de git, sin servidor y sin que nadie más instale nada. Actualizado{' '}
            {hace(team.readAt)}.
          </p>
        </div>
        {team.currentBranch && (
          <div className="progress">
            <div className="progress-label">
              estás en <span>{team.currentBranch}</span>
            </div>
          </div>
        )}
      </header>

      {team.collisions.length > 0 && (
        <section className="collisions">
          <div className="task-group-head">
            <span className="dot dot-problem" />
            <h2>Posibles colisiones</h2>
            <span className="count">{team.collisions.length}</span>
            <span className="task-group-hint">Otra persona ya tocó esto en otra rama</span>
          </div>
          <ul className="task-list">
            {team.collisions.map((c) => (
              <li key={c.file} className="task status-problem">
                <span className="task-path">{c.file}</span>
                <span className="task-detail">
                  {ESTADO_MIO[c.yours] ?? c.yours} ·{' '}
                  {c.theirs.map((t) => `${t.author} en ${t.branch} ${hace(t.at)}`).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        Colisiones sobre el tablero, no sobre ficheros. Van justo debajo de las de
        git porque son la misma pregunta por el otro canal, y separadas porque lo
        que se hace con ellas es distinto: aquí el cambio ya se aplicó y lo único
        accionable es mirar si sigue diciendo lo que querías.
      */}
      {(team.pieces?.length ?? 0) > 0 && (
        <section className="collisions">
          <div className="task-group-head">
            <span className="dot dot-problem" />
            <h2>Piezas tocadas a la vez</h2>
            <span className="count">{team.pieces!.length}</span>
            <span className="task-group-hint">Gana el último cambio, pero conviene mirarlo</span>
          </div>
          <ul className="task-list">
            {team.pieces!.map((c) => (
              <li key={c.nodeId} className="task status-problem">
                <span className="task-path">{c.label}</span>
                <span className="task-detail">
                  tú {hace(c.yours)} ·{' '}
                  {c.theirs.map((t) => `${t.author} ${hace(t.at)}`).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="task-group">
        <div className="task-group-head">
          <span className="dot dot-building" />
          <h2>Quién hace qué</h2>
          <span className="count">{team.teammates.length}</span>
          <span className="task-group-hint">Última semana</span>
        </div>
        {team.teammates.length === 0 ? (
          <p className="filters-empty">Nadie ha publicado commits esta semana.</p>
        ) : (
          <ul className="sessions">
            {team.teammates.map((m) => (
              <li key={m.author} className="session">
                <div className="session-head">
                  <span className="session-when">{m.author}</span>
                  <span className={`layer layer-${m.layer}`}>{LAYER_LABEL[m.layer]}</span>
                  <span className="session-dur">{hace(m.lastCommitAt)}</span>
                </div>
                <div className="session-stats">
                  <span>
                    <strong>{m.commits}</strong> commits
                  </span>
                  <span>
                    <strong>{m.files.length}</strong> ficheros
                  </span>
                </div>
                <div className="session-tools">
                  {m.branches.map((b) => (
                    <span key={b} className="tool-chip">
                      {b}
                    </span>
                  ))}
                </div>
                <ul className="session-files">
                  {m.files.slice(0, 5).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                  {m.files.length > 5 && <li className="muted">y {m.files.length - 5} más</li>}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="task-group">
        <div className="task-group-head">
          <span className="dot" />
          <h2>Ramas activas</h2>
          <span className="count">{team.branches.length}</span>
        </div>
        <ul className="task-list">
          {team.branches.map((b) => (
            <li key={b.name}>
              <div className={`task ${b.current ? 'status-building' : ''}`}>
                <span className="task-label">
                  {b.name}
                  {b.current && <span className="branch-you"> · estás aquí</span>}
                </span>
                <span className="task-detail">
                  {b.lastAuthor} · {hora.format(new Date(b.lastCommitAt))}
                  {b.ahead > 0 && ` · ${b.ahead} commit(s) que tú no tienes`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
