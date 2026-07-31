/**
 * Tiempo relativo, en corto.
 *
 * Vivía dentro de `TeamView` cuando era el único sitio que lo necesitaba. Las
 * tareas lo necesitan por el mismo motivo — «en curso desde hace nueve días» es
 * la única señal fiable de que algo se ha quedado atascado — y dos copias de
 * esto se separan a la primera que alguien afine un umbral.
 */
export function hace(at: number, ahora: number = Date.now()): string {
  const m = Math.round((ahora - at) / 60000)
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} d`
}

/**
 * Cuándo algo lleva parado lo suficiente como para preguntar por ello.
 *
 * Tres días es un umbral elegido, no medido: lo bastante largo para que un fin
 * de semana no dispare avisos, lo bastante corto para que una tarea olvidada
 * salte antes de que se olvide del todo.
 */
export const ESTANCADO_MS = 3 * 24 * 60 * 60 * 1000
