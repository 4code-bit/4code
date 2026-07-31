/**
 * Dónde vive este tablero: aquí, o también en la nube.
 *
 * Es la respuesta a una pregunta que el tablero no contestaba en ningún sitio.
 * La terminal lo decía (`/4code:status`) y la web lo insinuaba, pero la pantalla
 * que se mira mientras se trabaja callaba — y un proyecto sin remoto de GitHub
 * nunca sube, así que el silencio se leía como «ya estará arriba».
 *
 * Tres estados, y cada uno con lo que hay que hacer para salir de él:
 *
 *   solo aquí     no hay remoto de GitHub del que sacar permisos, así que se
 *                 queda. Con dos motivos distintos que no se pueden confundir:
 *                 el repo no tiene remoto, o la carpeta no es un repo — y en ese
 *                 segundo caso lo normal es que los repos estén dentro.
 *   sin vincular  hay remoto, pero esta máquina no está vinculada a ninguna cuenta.
 *   en la nube    y el enlace para abrirlo.
 */
import { useEffect, useState } from 'react'
import type { ProjectSummary } from '../../shared/project.ts'

const HTTP = 'http://127.0.0.1:41847'

interface SyncStatus {
  enabled: boolean
  apiUrl?: string
}

/** Se pregunta de vez en cuando: vincular una máquina no pasa cada minuto. */
const REFRESH_MS = 30_000

function useSync(): SyncStatus | null {
  const [sync, setSync] = useState<SyncStatus | null>(null)

  useEffect(() => {
    let cancelado = false
    const load = async () => {
      try {
        const res = await fetch(`${HTTP}/health`)
        const data = (await res.json()) as { sync?: SyncStatus }
        if (!cancelado) setSync(data.sync ?? { enabled: false })
      } catch {
        /* el siguiente ciclo lo pillará */
      }
    }
    void load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      cancelado = true
      clearInterval(t)
    }
  }, [])

  return sync
}

type Estado = 'local' | 'sin-vincular' | 'en-la-nube'

const ETIQUETA: Record<Estado, string> = {
  local: 'solo aquí',
  'sin-vincular': 'sin vincular',
  'en-la-nube': 'en la nube',
}

export function CloudChip({ project }: { project: ProjectSummary | null }) {
  const sync = useSync()
  const [abierto, setAbierto] = useState(false)

  useEffect(() => {
    if (!abierto) return
    const cerrar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false)
    }
    window.addEventListener('keydown', cerrar)
    return () => window.removeEventListener('keydown', cerrar)
  }, [abierto])

  if (!project) return null

  const compartible = Boolean(project.remote?.startsWith('github.com/'))
  const estado: Estado = !compartible ? 'local' : sync?.enabled ? 'en-la-nube' : 'sin-vincular'
  const dentro = project.innerRepos ?? []
  const url = sync?.apiUrl ? `${sync.apiUrl}/app/${encodeURIComponent(project.id)}` : null

  return (
    <div className="cloud">
      <button
        className={`cloud-chip cloud-${estado}`}
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        title="¿Dónde vive este tablero?"
      >
        <span className="cloud-dot" />
        {ETIQUETA[estado]}
      </button>

      {abierto && (
        <div className="cloud-pop" role="dialog">
          {estado === 'local' && (
            <>
              <h3>Este tablero vive solo en esta máquina</h3>
              <p>
                {project.noRepo
                  ? 'Esta carpeta no es un repositorio de git.'
                  : project.remote
                    ? `El remoto del repositorio (${project.remote}) no es de GitHub.`
                    : 'El repositorio no tiene remoto.'}{' '}
                4Code decide quién puede ver un tablero preguntándole a GitHub por el repositorio: sin
                remoto no hay a quién preguntar, así que no se sube. No se pierde nada — sigue aquí,
                completo, y con su historial.
              </p>

              {/* Una carpeta que contiene repos no necesita un remoto: necesita
                  que abras el repo. Darle un remoto a ella envolvería dos
                  historiales en un tercero, que es un lío difícil de deshacer. */}
              {dentro.length > 0 ? (
                <>
                  <p className="cloud-how">
                    Esta carpeta es un contenedor: {dentro.length === 1 ? 'dentro está' : 'dentro están'}{' '}
                    <strong>{dentro.join(', ')}</strong>. Abre Claude Code{' '}
                    {dentro.length === 1 ? 'en esa carpeta' : 'en una de esas carpetas'} y ese tablero
                    sí sube, con los permisos de su repositorio.
                  </p>
                  <p className="cloud-warn">
                    No le pongas un remoto a esta carpeta para que suba: acabarías con un repositorio
                    envolviendo a los que ya tienes dentro, y dos historiales pisándose.
                  </p>
                </>
              ) : (
                <>
                  <p className="cloud-how">Para que suba, dale un remoto privado:</p>
                  {project.noRepo && <code>git init -b main</code>}
                  <code>gh repo create --private --source=. --push</code>
                  {!project.noRepo && (
                    <>
                      <p className="cloud-how">O si ya tienes el repositorio creado:</p>
                      <code>git remote add origin git@github.com:tu-cuenta/tu-repo.git</code>
                    </>
                  )}
                  <p className="cloud-warn">
                    Ojo: al ganar remoto, el proyecto cambia de identidad y el tablero nuevo empieza
                    vacío. El tablero de ahora no se borra, y el propio tablero te dirá cómo traerlo.
                  </p>
                </>
              )}
            </>
          )}

          {estado === 'sin-vincular' && (
            <>
              <h3>Listo para subir, falta vincular la máquina</h3>
              <p>
                El repositorio tiene remoto de GitHub ({project.remote}), así que este tablero se
                puede compartir con quien tenga acceso a él. Solo falta decirle a esta máquina con
                qué cuenta.
              </p>
              <code>/4code:login</code>
              <p className="cloud-how">
                Se abre el navegador, apruebas, y de ahí en adelante sube solo.
              </p>
            </>
          )}

          {estado === 'en-la-nube' && (
            <>
              <h3>En la nube</h3>
              <p>
                Se sube según trabajas. Lo ve quien tenga acceso a {project.remote} en GitHub, y
                nadie más.
              </p>
              {url && (
                <a href={url} target="_blank" rel="noopener noreferrer" className="cloud-link">
                  Abrir en {new URL(url).host} ↗
                </a>
              )}
              <p className="cloud-how">
                Solo viaja el diagrama: piezas, conexiones y notas. Nunca el contenido de tus
                ficheros, tus diffs ni tus prompts.
              </p>
            </>
          )}

          {/* El caso que ocurre justo cuando alguien hace lo que le pedimos. */}
          {project.orphan && (
            <div className="cloud-orphan">
              <strong>Hay un tablero anterior de esta misma carpeta</strong>
              <p>
                {project.orphan.nodes} piezas, de antes de que el repositorio tuviera remoto. Este
                empieza vacío porque el proyecto cambió de identidad. Para traerlo:
              </p>
              <code>
                node server/src/board.ts move {project.orphan.id} {project.id} --apply
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
