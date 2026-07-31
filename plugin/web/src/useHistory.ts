/**
 * Historial de operaciones del proyecto.
 *
 * El canvas-server ya lo guarda en `history.jsonl` desde que hay persistencia, y
 * el plan dice que ese log **es** la línea temporal del proyecto. Estaba en
 * disco sin que nadie lo mirase; esto lo saca a la vista de Actividad.
 *
 * Coste en tokens: cero. Son datos que ya existen.
 */
import { useEffect, useState } from 'react'
import type { Operation } from '../../shared/diagram.ts'

const CANVAS_PORT = 41847
const HTTP = `http://127.0.0.1:${CANVAS_PORT}`

export interface HistoryEntry {
  seq: number
  at: number
  operation: Operation
}

/**
 * `seq` entra como dependencia para recargar cuando el tablero cambia: así la
 * actividad se actualiza sola mientras Claude trabaja, sin sondear a ciegas.
 */
export function useHistory(projectId: string | null, seq: number): HistoryEntry[] {
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  useEffect(() => {
    if (!projectId) {
      setEntries([])
      return
    }
    let cancelled = false

    void (async () => {
      try {
        const res = await fetch(`${HTTP}/history?project=${encodeURIComponent(projectId)}`)
        const list = (await res.json()) as HistoryEntry[]
        if (!cancelled) setEntries(list)
      } catch {
        if (!cancelled) setEntries([])
      }
    })()

    return () => {
      cancelled = true
    }
  }, [projectId, seq])

  return entries
}
