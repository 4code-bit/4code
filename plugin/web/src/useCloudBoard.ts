import { useEffect, useState } from 'react'

/**
 * ¿El proyecto que estoy mirando ya tiene tablero en la nube?
 *
 * Solo importa cuando el tablero local está vacío, y ahí lo cambia todo: a quien acaba
 * de unirse a un repositorio se le decía «pídele a Claude que mapee la estructura», y
 * ese es el consejo equivocado. El tablero ya existe arriba; redibujarlo desde otra
 * máquina produce piezas casi duplicadas, porque Claude elige ids distintos cada vez.
 * Lo que toca es `/4code:restore`.
 *
 * Se pregunta una vez por proyecto y solo cuando hace falta: el canvas-server cachea la
 * respuesta un minuto, así que abrir y cerrar el estado vacío no dispara red.
 */

const HTTP = 'http://127.0.0.1:41847'

export interface CloudBoardInfo {
  exists: boolean
  pieces?: number
  people?: number
  url?: string
  reason?: 'sin-vincular' | 'sin-remoto' | 'sin-acceso' | 'sin-red'
}

export function useCloudBoard(projectId: string | null, enabled: boolean): CloudBoardInfo | null {
  const [info, setInfo] = useState<CloudBoardInfo | null>(null)

  useEffect(() => {
    if (!projectId || !enabled) {
      setInfo(null)
      return
    }
    let cancelado = false

    void (async () => {
      try {
        const res = await fetch(`${HTTP}/cloud-board?project=${encodeURIComponent(projectId)}`)
        if (!res.ok) return
        const data = (await res.json()) as CloudBoardInfo
        if (!cancelado) setInfo(data)
      } catch {
        /* sin respuesta, el estado vacío se queda como estaba */
      }
    })()

    return () => {
      cancelado = true
    }
  }, [projectId, enabled])

  return info
}
