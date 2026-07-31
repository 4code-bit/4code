/**
 * Lectura de git leyendo sus ficheros, sin lanzar el binario.
 *
 * El hook corre en CADA llamada de herramienta: un `spawn('git')` por evento
 * añadiría decenas de milisegundos y un proceso más, cientos de veces por
 * sesión. `.git/config` y `.git/HEAD` son ficheros de texto pequeños y estables
 * desde hace veinte años; leerlos cuesta microsegundos.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Directorio real de git. `.git` puede ser un fichero con `gitdir: …` cuando el
 * repo es un submódulo o un worktree, y entonces config y HEAD viven en otro sitio.
 */
function gitDir(root: string): string | null {
  const dot = join(root, '.git')
  if (!existsSync(dot)) return null

  try {
    if (statSync(dot).isDirectory()) return dot
    const contents = readFileSync(dot, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/m.exec(contents)
    if (!match) return null
    const target = match[1]!.trim()
    return isAbsolute(target) ? target : resolve(root, target)
  } catch {
    return null
  }
}

/**
 * Si la carpeta es un repositorio de git.
 *
 * No es lo mismo que «no tiene remoto», y confundir las dos cosas manda a la
 * gente a ejecutar `git remote -v` en una carpeta que no es un repo. Peor: la
 * salida habitual de una carpeta así es que **contiene** repos, y el consejo de
 * «dale un remoto desde aquí» acabaría envolviendo dos historiales en un tercero.
 */
export function isRepo(root: string): boolean {
  return gitDir(root) !== null
}

/**
 * URL del remoto `origin` tal cual está escrita en la configuración.
 *
 * Se parsea a mano en vez de con `git remote get-url` por lo dicho arriba. El
 * formato de `.git/config` es INI y la sección que interesa es una sola.
 */
export function readRemote(root: string): string | null {
  const dir = gitDir(root)
  if (!dir) return null

  try {
    const config = readFileSync(join(dir, 'config'), 'utf8')
    // Desde [remote "origin"] hasta la siguiente sección.
    const section = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config)
    if (!section) return null
    const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]!)
    return url ? url[1]!.trim() : null
  } catch {
    return null
  }
}

/** Branch actual, o null si el repo está en HEAD desacoplado. */
export function readBranch(root: string): string | null {
  const dir = gitDir(root)
  if (!dir) return null

  try {
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim()
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    // Sin `ref:` es un SHA suelto: HEAD desacoplado, y no hay branch que dar.
    return match ? match[1]!.trim() : null
  } catch {
    return null
  }
}

/**
 * Remoto en forma canónica: `github.com/viupik/viupikhub`.
 *
 * Es lo que hace que el id sea compartible. Dos personas con el mismo repo
 * clonado en rutas distintas, una por HTTPS y otra por SSH, tienen que llegar
 * a la MISMA cadena o sus tableros no convergen nunca.
 *
 * Y quita las credenciales embebidas: un `https://usuario:token@github.com/…`
 * es una forma habitual de clonar, y ese token no puede acabar dentro de un id
 * que viaja a la nube.
 */
export function normalizeRemote(url: string): string | null {
  let value = url.trim()
  if (!value) return null

  // git@host:ruta → host/ruta
  const scp = /^[\w.-]+@([^:]+):(.+)$/.exec(value)
  if (scp) {
    value = `${scp[1]}/${scp[2]}`
  } else {
    value = value
      .replace(/^[a-z+]+:\/\//i, '') // protocolo
      .replace(/^[^@/]*@/, '') // credenciales o usuario
  }

  value = value
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()

  // Un remoto que no distinga host de ruta no sirve para identificar nada.
  return value.includes('/') ? value : null
}

export interface GitInfo {
  remote: string | null
  branch: string | null
}

export function readGit(root: string): GitInfo {
  const raw = readRemote(root)
  return {
    remote: raw ? normalizeRemote(raw) : null,
    branch: readBranch(root),
  }
}
