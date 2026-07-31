/**
 * Estado del equipo, leído de git en el servidor local.
 *
 * Coste en tokens: cero. Coste en infraestructura: cero — el único tráfico es
 * el `git fetch` contra el remoto que ya usas.
 */
import { useEffect, useState } from 'react'
import type { TeamView } from '../../shared/team.ts'

const CANVAS_PORT = 41847
const HTTP = `http://127.0.0.1:${CANVAS_PORT}`

/**
 * Se carga SIEMPRE, no solo con la vista abierta: el aviso de colisión tiene que
 * poder verse desde cualquier sitio, que para eso es un aviso. Mirando la vista
 * se refresca más a menudo, nada más.
 *
 * Pero «sondear de más no cuesta nada» era falso: el sondeo de fondo es de 120 s
 * contra una caché de 30, así que fallaba siempre y cada vez ejecutaba una batería
 * de siete u ocho comandos de git. Ahora se dice para qué se pregunta —`idle=1`
 * cuando nadie mira— y el servidor decide cuánto puede aguantar la respuesta.
 */
const ACTIVA_MS = 30_000
const FONDO_MS = 120_000

export function useTeam(projectId: string | null, active: boolean): TeamView | null {
  const [team, setTeam] = useState<TeamView | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false

    const load = async () => {
      try {
        const url = `${HTTP}/team?project=${encodeURIComponent(projectId)}${active ? '' : '&idle=1'}`
        const res = await fetch(url)
        if (!res.ok) return
        const data = (await res.json()) as TeamView
        if (!cancelled) setTeam(data)
      } catch {
        /* el canvas-server no está vivo; el siguiente intento lo pillará */
      }
    }

    void load()
    const timer = setInterval(load, active ? ACTIVA_MS : FONDO_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [projectId, active])

  return team
}
