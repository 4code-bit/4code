/**
 * Capa de trabajo (§4.3 del plan): en qué está trabajando alguien ahora mismo.
 *
 * Se **deriva**, no se pregunta. Preguntárselo a Claude costaría tokens y habría
 * que repetirlo en cada cambio; el modo de permiso, las herramientas usadas y las
 * rutas tocadas lo dicen gratis. Es la regla del canal (§2.3) aplicada al pie de
 * la letra.
 *
 * Función pura a propósito: así se puede verificar con secuencias sintéticas sin
 * levantar nada.
 */
import type { SessionEvent } from './session.ts'

export type WorkLayer =
  | 'planning'
  | 'ui'
  | 'code'
  | 'tests'
  | 'infra'
  | 'docs'
  | 'exploring'
  | 'unknown'

export const LAYER_LABEL: Record<WorkLayer, string> = {
  planning: 'Planificando',
  ui: 'UI / UX',
  code: 'Código',
  tests: 'Tests',
  infra: 'Infraestructura',
  docs: 'Documentación',
  exploring: 'Explorando',
  unknown: 'Sin determinar',
}

/** Ventana deslizante: una capa se decide por tendencia, no por un evento suelto. */
export const WINDOW_EVENTS = 40
export const WINDOW_MS = 5 * 60 * 1000

/** Herramientas que solo leen. Si únicamente hay de estas, no se está construyendo. */
const READ_ONLY = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookRead',
  'TaskList',
  'TaskGet',
])

/**
 * Capa de un fichero por su ruta.
 *
 * El orden de las comprobaciones ES la precedencia y está elegido: un test de un
 * componente es un test, no UI; un `.yml` de CI es infraestructura, no
 * documentación. Cambiar el orden cambia el resultado.
 */
export function layerOfPath(rawPath: string): WorkLayer | null {
  const path = rawPath.replace(/\\/g, '/').toLowerCase()
  const file = path.split('/').pop() ?? path

  // Tests primero: `Button.test.tsx` es test aunque viva en components/.
  if (/\.(test|spec)\.[a-z0-9]+$/.test(file) || /(^|\/)(__tests__|__mocks__|tests?|e2e)\//.test(path)) {
    return 'tests'
  }

  // Infra antes que docs: un workflow de CI en YAML no es documentación.
  if (
    /(^|\/)(dockerfile|docker-compose\.ya?ml|\.dockerignore)$/.test(file) ||
    /(^|\/)\.github\/workflows\//.test(path) ||
    /(^|\/)(terraform|k8s|kubernetes|helm|infra|deploy)\//.test(path) ||
    /\.(tf|tfvars)$/.test(file)
  ) {
    return 'infra'
  }

  if (/\.(md|mdx|rst|adoc|txt)$/.test(file) || /(^|\/)docs?\//.test(path)) return 'docs'

  if (
    /\.(css|scss|sass|less|styl)$/.test(file) ||
    /(^|\/)(components?|ui|styles?|views?|pages?|layouts?)\//.test(path) ||
    /\.(vue|svelte)$/.test(file)
  ) {
    return 'ui'
  }

  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|swift|sql)$/.test(file)) {
    return 'code'
  }

  return null
}

/** Los eventos que entran en la decisión: los recientes, por número y por tiempo. */
export function windowOf(events: SessionEvent[], now: number): SessionEvent[] {
  const recientes = events.filter((e) => now - e.at <= WINDOW_MS)
  const base = recientes.length > 0 ? recientes : events
  return base.slice(-WINDOW_EVENTS)
}

/**
 * Regla 4 del plan: si nada domina con claridad, la capa es «sin determinar».
 * Un valor honesto y vacío vale más que uno inventado — una capa equivocada rompe
 * la confianza en todo lo demás que enseña el tablero (§8).
 */
const DOMINANCE = 0.5

export function deriveLayer(events: SessionEvent[], now: number = Date.now()): WorkLayer {
  const window = windowOf(events, now)
  if (window.length === 0) return 'unknown'

  // Plan mode es una declaración explícita del propio Claude Code, no una
  // heurística: si está activo en la ventana reciente, se está planificando.
  const enPlan = window.filter((e) => e.mode === 'plan').length
  if (enPlan > 0 && enPlan / window.length >= 0.3) return 'planning'

  const conRuta = window.filter((e) => e.kind === 'tool' && e.path)
  const porCapa = new Map<WorkLayer, number>()
  for (const evento of conRuta) {
    const capa = layerOfPath(evento.path!)
    if (capa) porCapa.set(capa, (porCapa.get(capa) ?? 0) + 1)
  }

  const total = [...porCapa.values()].reduce((a, b) => a + b, 0)
  if (total > 0) {
    const [capa, n] = [...porCapa.entries()].sort((a, b) => b[1] - a[1])[0]
    if (n / total >= DOMINANCE) {
      // Tocar ficheros solo para leerlos es explorar, no construir en esa capa.
      const escrituras = conRuta.filter((e) => e.tool && !READ_ONLY.has(e.tool)).length
      return escrituras === 0 ? 'exploring' : capa
    }
    return 'unknown'
  }

  // Sin rutas: si solo hubo herramientas de lectura, está explorando.
  const herramientas = window.filter((e) => e.kind === 'tool' && e.tool)
  if (herramientas.length > 0 && herramientas.every((e) => READ_ONLY.has(e.tool!))) {
    return 'exploring'
  }

  return 'unknown'
}
