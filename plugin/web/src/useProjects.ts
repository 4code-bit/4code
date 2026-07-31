/**
 * Lista de proyectos con tablero, y cuál se está mirando.
 *
 * La selección vive en la URL (`?project=…`) para que recargar no te devuelva a
 * otro proyecto y para poder dejar una pestaña fija por repositorio.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary } from '../../shared/project.ts'

const CANVAS_PORT = 41847
const HTTP = `http://127.0.0.1:${CANVAS_PORT}`

/** Basta con refrescar de vez en cuando: aparecer en la lista no es urgente. */
const REFRESH_MS = 4000

export interface ProjectsView {
  projects: ProjectSummary[]
  selected: string | null
  select: (id: string) => void
  current: ProjectSummary | null
}

function projectFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('project')
}

export function useProjects(): ProjectsView {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selected, setSelected] = useState<string | null>(projectFromUrl)

  const select = useCallback((id: string) => {
    setSelected(id)
    const url = new URL(window.location.href)
    url.searchParams.set('project', id)
    window.history.replaceState(null, '', url)
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch(`${HTTP}/projects`)
        const list = (await res.json()) as ProjectSummary[]
        if (cancelled) return
        setProjects(list)

        // Sin nada elegido, entra el más activo. Y si el de la URL ya no existe
        // (proyecto borrado), no dejamos la vista colgada mirando a la nada.
        setSelected((current) => {
          if (current && list.some((p) => p.id === current)) return current
          return list[0]?.id ?? null
        })
      } catch {
        /* el canvas-server no está vivo todavía; el siguiente intento lo pillará */
      }
    }

    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Mantiene la URL en hora cuando la selección la decide la carga, no un clic.
  useEffect(() => {
    if (!selected || projectFromUrl() === selected) return
    const url = new URL(window.location.href)
    url.searchParams.set('project', selected)
    window.history.replaceState(null, '', url)
  }, [selected])

  return {
    projects,
    selected,
    select,
    current: projects.find((p) => p.id === selected) ?? null,
  }
}
