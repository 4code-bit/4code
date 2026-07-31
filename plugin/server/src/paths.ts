/**
 * Dónde vive el estado local de 4Code.
 *
 * Configurable con `FOURCODE_HOME` por dos motivos: que las pruebas puedan
 * correr contra un directorio desechable sin pisar los tableros reales, y que
 * quien quiera moverlo de sitio pueda.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.FOURCODE_HOME || join(homedir(), '.4code')

/** Punto de encuentro entre el servidor MCP y el canvas-server. */
export const LOCK_FILE = join(HOME, 'canvas.json')

/** Un subdirectorio por proyecto. */
export const PROJECTS_DIR = join(HOME, 'projects')
