/**
 * Sesiones capturadas por los hooks.
 *
 * Sondea en vez de escuchar el WebSocket a propósito: el canal WS transporta el
 * reducer del diagrama, con su `seq` y su detección de deriva, y meter ahí otro
 * tipo de mensaje obligaría a tocar esa lógica para nada. Un fetch local cada
 * pocos segundos, solo mientras la vista está abierta, no le cuesta nada a nadie.
 */
import { useEffect, useState } from 'react'
import type { SessionWithLayer } from '../../shared/session.ts'

const CANVAS_PORT = 41847
const HTTP = `http://127.0.0.1:${CANVAS_PORT}`

const REFRESH_MS = 3000

export function useSessions(projectId: string | null, active: boolean): SessionWithLayer[] {
  const [sessions, setSessions] = useState<SessionWithLayer[]>([])

  useEffect(() => {
    if (!projectId || !active) return
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch(`${HTTP}/sessions?project=${encodeURIComponent(projectId)}`)
        const list = (await res.json()) as SessionWithLayer[]
        if (!cancelled) setSessions(list)
      } catch {
        /* el canvas-server no está vivo; el siguiente intento lo pillará */
      }
    }

    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [projectId, active])

  return sessions
}
