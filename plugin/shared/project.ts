/**
 * Identidad de proyecto.
 *
 * El prototipo tenía un único lienzo global: dos proyectos abiertos a la vez se
 * mezclaban en el mismo tablero. Todo lo que viene después — persistencia,
 * historial, la nube, la colaboración — necesita saber a qué proyecto pertenece
 * cada operación, así que esto es la pieza que va primero.
 *
 * Este fichero lo comparten servidor y web: nada de imports de Node aquí. La
 * detección, que sí toca el disco, vive en `server/src/project.ts`.
 */

export interface ProjectRef {
  /**
   * Estable entre sesiones Y ENTRE MÁQUINAS. Deriva del remoto de git cuando lo
   * hay, no de la ruta local: dos personas con el mismo repo clonado en sitios
   * distintos tienen que llegar al mismo tablero o no se ven nunca.
   */
  id: string
  /** Para enseñar. El nombre del repo, o el de la carpeta raíz si no hay. */
  name: string
  /** Ruta absoluta de la raíz. NO sale de la máquina sin consentimiento. */
  root: string
  /**
   * Remoto normalizado (`github.com/viupik/viupikhub`), si el repo tiene.
   * Sin él, el id cae a la ruta local y el tablero deja de ser compartible.
   */
  remote?: string
  /** Branch actual. Cambia durante la sesión, así que viaja con cada operación. */
  branch?: string
}

export interface ProjectSummary extends ProjectRef {
  nodes: number
  edges: number
  seq: number
  /** Última operación aplicada, para ordenar por actividad reciente. */
  updatedAt: number
  /**
   * El tablero que esta misma carpeta tenía antes de tener remoto.
   *
   * Ponerle remoto a un repo cambia el id del proyecto —pasa de derivarse de la
   * ruta a derivarse del remoto—, así que el tablero nuevo arranca vacío y el
   * anterior se queda a un lado con todo dentro. Ocurre justo cuando alguien
   * hace lo que le pedimos (subir el repo a GitHub), y sin decirlo parece que el
   * trabajo de Claude se ha perdido.
   *
   * No se mueve nada por iniciativa propia: se enseña, y traerlo es un comando.
   */
  orphan?: { id: string; nodes: number }
  /**
   * La carpeta raíz no es un repositorio de git.
   *
   * Distinto de «el repositorio no tiene remoto», y la diferencia cambia por
   * completo qué hay que hacer. Un repo sin remoto necesita un `git remote add`;
   * una carpeta que no es repo casi siempre es una carpeta contenedora, y lo que
   * hay que abrir es lo que tiene dentro.
   *
   * Solo local: no viaja a la nube. Es una propiedad del disco de esta máquina,
   * no del proyecto.
   */
  noRepo?: true
  /**
   * Nombres de los repositorios que viven dentro de la carpeta, cuando la
   * carpeta no es uno. Es lo que convierte el aviso en accionable: sin esto se
   * dice «esto no sube» y con esto se dice «lo que sube es esto de aquí dentro».
   */
  innerRepos?: string[]
}
