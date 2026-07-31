/**
 * Detección de a qué proyecto pertenece una sesión de Claude.
 *
 * Claude Code lanza el servidor MCP con el directorio del proyecto como cwd, así
 * que de ahí sale todo. Subimos hasta la raíz del repositorio para que trabajar
 * en `src/auth/` y en la raíz cuenten como el mismo proyecto — si no, cada
 * subdirectorio abriría un tablero distinto.
 *
 * EL ID SALE DEL REMOTO, NO DE LA RUTA. Esa es la diferencia entre un tablero
 * personal y uno que se puede compartir: si el id dependiera de dónde está el
 * repo en tu disco, cada colaborador crearía el suyo y no convergerían jamás.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

import type { ProjectRef } from '../../shared/project.ts'
import { readGit } from './git.ts'

/** Marcadores de raíz, en orden de confianza. */
const ROOT_MARKERS = ['.git', '.hg', '.svn']

export function findRoot(start: string): string {
  let current = resolve(start)
  // `dirname` de una raíz devuelve la propia raíz: ahí es donde paramos.
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(start)
    current = parent
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  )
}

function digest(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

/**
 * Id a partir del remoto: `viupikhub-3f9c1a2b`.
 *
 * La parte legible sirve para depurar mirando el directorio de datos; el hash
 * garantiza que dos repos con el mismo nombre en organizaciones distintas
 * (`acme/api` y `otra/api`) no compartan tablero.
 */
export function makeRemoteId(remote: string): string {
  const last = remote.split('/').filter(Boolean).pop() ?? 'project'
  return `${slugify(last)}-${digest(remote)}`
}

/**
 * Id de respaldo, por ruta local. Solo para repos sin remoto.
 *
 * Un tablero identificado así NO es compartible, y es correcto que así sea: sin
 * remoto no hay forma de saber que el repo de otra persona es "el mismo".
 */
export function makeProjectId(root: string): string {
  // En Windows la misma carpeta se escribe de varias formas; normalizamos para
  // que el id no dependa de cómo se tecleó la ruta.
  const normalized = resolve(root).split(sep).join('/').replace(/\/+$/, '').toLowerCase()
  return `${slugify(basename(resolve(root)))}-${digest(normalized)}`
}

export function detectProject(cwd: string = process.cwd()): ProjectRef {
  const root = findRoot(cwd)
  const { remote, branch } = readGit(root)

  const name = remote ? (remote.split('/').filter(Boolean).pop() ?? basename(root)) : basename(root) || root

  return {
    id: remote ? makeRemoteId(remote) : makeProjectId(root),
    name,
    root,
    ...(remote && { remote }),
    ...(branch && { branch }),
  }
}
