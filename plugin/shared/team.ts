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

/**
 * Cuánto tiempo se considera que sigues «en» una pieza.
 *
 * Una hora, la misma que usa la atribución del lienzo. Lo bastante larga para
 * cubrir «me fui a comer y vuelvo», y lo bastante corta para que el tablero no se
 * convierta en un registro permanente de quién es dueño de qué.
 */
export const TOQUE_RECIENTE_MS = 60 * 60_000

/**
 * Dos personas han tocado la misma pieza del tablero casi a la vez.
 *
 * El hermano de `Collision`, pero sobre nodos en vez de ficheros, y por eso vive
 * aquí: es la misma pregunta —«¿voy a chocar con alguien?»— resuelta por el otro
 * canal. Aquella la contesta git; esta, el log de operaciones de la nube.
 *
 * Gana la última operación, siempre: el orden lo marca el `seq` del servidor, que
 * es global y no se repite. Esto no cambia quién gana, solo impide que el cambio
 * de alguien desaparezca sin que se entere.
 */
export interface PieceCollision {
  nodeId: string
  /** El nombre visible, para no obligar a la interfaz a buscarlo. */
  label: string
  /** Cuándo la tocaste tú. */
  yours: number
  theirs: { author: string; at: number }[]
}

export interface TeamView {
  /** Rama actual de quien mira. */
  currentBranch: string | null
  branches: BranchInfo[]
  teammates: TeammateActivity[]
  collisions: Collision[]
  /**
   * Colisiones sobre piezas del tablero, no sobre ficheros.
   *
   * Viajan con el resto del equipo en vez de por un canal propio porque son la
   * misma pregunta y se miran en el mismo sitio: quien abre esta vista quiere
   * saber con quién va a chocar, y le da igual si lo ha averiguado git o la nube.
   * De paso heredan el sondeo que ya existe, incluido el de fondo que alimenta el
   * aviso del rail.
   *
   * Opcional: las deriva el canvas-server, no `readTeam()`, que solo sabe de git.
   */
  pieces?: PieceCollision[]
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
