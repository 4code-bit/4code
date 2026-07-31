/**
 * Iconos del rail, en SVG inline.
 *
 * Sin librería: son cinco trazos y meter un paquete de iconos por esto pesaría
 * más que todo el resto de la web junta. `currentColor` deja que el estado
 * activo/inactivo lo decida el CSS.
 */

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** Grafo: nodos conectados. */
export function IconBoard() {
  return (
    <svg {...base}>
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="5.5" cy="18" r="2.4" />
      <circle cx="18.5" cy="18" r="2.4" />
      <path d="M10.4 6.9 7 15.8M13.6 6.9 17 15.8" />
    </svg>
  )
}

/**
 * Negocio: una diana. Es el tablero gemelo del técnico, así que el icono tiene
 * que leerse como «lo mismo pero de otra cosa» — no como otra herramienta.
 */
export function IconBusiness() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Tareas: lista con una marcada. */
export function IconTasks() {
  return (
    <svg {...base}>
      <path d="m3 6.5 2 2 3.5-3.5" />
      <path d="M11.5 7h9.5" />
      <path d="m3 15.5 2 2 3.5-3.5" />
      <path d="M11.5 16h9.5" />
    </svg>
  )
}

/** Actividad: reloj. */
export function IconActivity() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.2V12l3.2 2" />
    </svg>
  )
}

/** Piezas: lista de líneas. */
export function IconPieces() {
  return (
    <svg {...base}>
      <path d="M4 6.5h16M4 12h16M4 17.5h11" />
    </svg>
  )
}

/** Sesiones: una terminal, que es de donde salen. */
export function IconSessions() {
  return (
    <svg {...base}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7.5 10 2.5 2.2-2.5 2.2" />
      <path d="M12.8 14.6h4" />
    </svg>
  )
}

/** Equipo: dos siluetas. */
export function IconTeam() {
  return (
    <svg {...base}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 5.5a3.2 3.2 0 0 1 0 6" />
      <path d="M17.5 14.8c2 .6 3.2 2.3 3.2 4.7" />
    </svg>
  )
}

export function IconSearch() {
  return (
    <svg {...base} width={14} height={14}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.1 4.1" />
    </svg>
  )
}

export function IconExternal() {
  return (
    <svg {...base} width={12} height={12}>
      <path d="M13 4h7v7" />
      <path d="M20 4 10.5 13.5" />
      <path d="M18 14.5V20H4V6h5.5" />
    </svg>
  )
}
