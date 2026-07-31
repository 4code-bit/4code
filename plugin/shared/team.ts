/**
 * Estado del equipo, derivado de git.
 *
 * Nada de esto necesita servidor ni que tus colaboradores instalen 4Code: el
 * remoto del repositorio ya es un canal compartido al que todos tenéis acceso,
 * con los permisos resueltos. Es la regla del canal (§2.3) llevada a la
 * colaboración — si git ya lo sabe, no hace falta inventar un protocolo.
 *
 * Lo que NO se puede saber así, y es correcto que no se pueda: lo que alguien
 * tiene sin commitear. Eso vive solo en su disco, es tentativo, y anunciarlo
 * sería ruido y presión.
 */
import type { WorkLayer } from './layer.ts'

export interface BranchInfo {
  name: string
  lastAuthor: string
  lastCommitAt: number
  /** Cuántos commits tiene esta rama que no estén en la tuya. */
  ahead: number
  /** Si es la rama en la que estás tú ahora mismo. */
  current: boolean
}

export interface TeammateActivity {
  author: string
  branches: string[]
  commits: number
  files: string[]
  lastCommitAt: number
  /** Derivada de las rutas que toca, igual que la tuya (§4.3). */
  layer: WorkLayer
}

/**
 * Un fichero que tú tienes a medias y alguien más ha tocado en otra rama.
 *
 * Esto es lo que el plan señala como el valor real de la colaboración (§4.2):
 * «Ana lleva 20 minutos en PlayerCharacter.cpp» es accionable ahora; enterarse
 * en el merge, no.
 */
export interface Collision {
  file: string
  /** Cómo lo tienes tú: modificado en el working tree o ya en el índice. */
  yours: 'modified' | 'staged' | 'untracked'
  theirs: { author: string; branch: string; at: number }[]
}

export interface TeamView {
  /** Rama actual de quien mira. */
  currentBranch: string | null
  branches: BranchInfo[]
  teammates: TeammateActivity[]
  collisions: Collision[]
  /** Cuándo se leyó git por última vez. */
  readAt: number
  /** Si el repositorio no tiene remoto, aquí no hay equipo que ver. */
  hasRemote: boolean
  /**
   * Si la carpeta raíz sigue existiendo en esta máquina.
   *
   * Un tablero sobrevive a que su carpeta se mueva o a que el disco se
   * desconecte — vive en `~/.4code`, no ahí —, pero git ya no se puede leer. Sin
   * esto, la ausencia se contaba como «no es un repositorio», que manda a buscar
   * el problema en el sitio equivocado.
   */
  hasRoot: boolean
  /**
   * Si la carpeta es siquiera un repositorio.
   *
   * Va separado de `hasRemote` porque el motivo que se enseña y el arreglo son
   * distintos: sin repo no falta un remoto, falta el repositorio — y lo normal es
   * que esté una carpeta más abajo.
   */
  hasRepo: boolean
}
