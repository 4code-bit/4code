/**
 * Lee el estado del equipo ejecutando git.
 *
 * Aquí SÍ se lanza el binario de git, al revés que en `git.ts`: esto corre como
 * mucho cada medio minuto y a petición de la web, no en cada llamada de
 * herramienta. Reimplementar `git log` a mano sería peor negocio.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

import { deriveLayer, layerOfPath, type WorkLayer } from '../../shared/layer.ts'
import type { BranchInfo, Collision, TeammateActivity, TeamView } from '../../shared/team.ts'
import { isRepo, readBranch, readRemote } from './git.ts'

const run = promisify(execFile)

const log = (...args: unknown[]) => console.error('[team]', ...args)

/** Ventana de actividad: lo de hace una semana ya no dice en qué anda nadie. */
const DIAS = 7
/** Cachear evita releer git en cada pintado de la vista. */
const CACHE_MS = 30_000
/**
 * Y mucho más para quien no está mirando.
 *
 * La vista se sondea siempre, no solo abierta, porque el aviso de colisión tiene que
 * poder aparecer desde cualquier sitio (§4.2). Pero el sondeo de fondo es de 120 s
 * contra una caché de 30, así que **fallaba siempre** y ejecutaba la batería entera de
 * git: medido, 12 procesos en 140 segundos sin que nadie mirara nada. Un aviso admite
 * cinco minutos de retraso; una vista abierta, no.
 */
const CACHE_FONDO_MS = 5 * 60 * 1000
/** `fetch` es lo único que sale a la red; se espacia mucho más. */
const FETCH_MS = 5 * 60 * 1000

const cache = new Map<string, { at: number; view: TeamView }>()
const ultimoFetch = new Map<string, number>()
const enVuelo = new Map<string, Promise<TeamView>>()

/**
 * `windowsHide` NO es cosmético, y es justo lo que alguien quitaría por parecerlo.
 *
 * Este proceso se arranca con `detached: true` (`ensure.ts`), que en Windows es
 * `DETACHED_PROCESS`: **el canvas-server no tiene consola**. Y cuando un proceso sin
 * consola lanza una aplicación de consola sin `CREATE_NO_WINDOW`, Windows le asigna
 * una **consola nueva y visible** a cada hijo. Sin esta línea, cada lectura del
 * equipo abría siete u ocho ventanas negras en la pantalla del usuario, cada dos
 * minutos, mientras hubiera un tablero abierto.
 */
async function git(root: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd: root,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

/**
 * Trae las novedades del remoto. Espaciado y silencioso: si falla —sin red, sin
 * credenciales, repo privado— se sigue con lo que ya está en el clon local, que
 * es mejor que no enseñar nada.
 */
async function maybeFetch(root: string, idle: boolean): Promise<void> {
  // Quien no está mirando la vista no tiene por qué provocar tráfico de red.
  if (idle) return
  const ultimo = ultimoFetch.get(root) ?? 0
  if (Date.now() - ultimo < FETCH_MS) return
  ultimoFetch.set(root, Date.now())

  try {
    await git(root, ['fetch', '--quiet', '--no-tags', '--prune', 'origin'], 30_000)
  } catch {
    log('fetch falló; se usa lo que ya hay en el clon')
  }
}

interface Commit {
  hash: string
  author: string
  at: number
  branch: string
  files: string[]
}

/** Commits recientes de una rama remota, con los ficheros que tocan. */
async function commitsOf(root: string, branch: string): Promise<Commit[]> {
  // El separador raro evita chocar con cualquier cosa que aparezca en un
  // nombre de autor.
  const salida = await git(root, [
    'log',
    branch,
    `--since=${DIAS} days ago`,
    '--no-merges',
    '--name-only',
    '--format=%x00%H%x1f%an%x1f%at',
  ]).catch(() => '')

  const commits: Commit[] = []
  for (const bloque of salida.split('\0')) {
    if (!bloque.trim()) continue
    const [cabecera, ...resto] = bloque.split('\n')
    const [hash, author, at] = (cabecera ?? '').split('\x1f')
    if (!hash || !author) continue
    commits.push({
      hash,
      author,
      at: Number(at) * 1000,
      branch,
      files: resto.map((l) => l.trim()).filter(Boolean),
    })
  }
  return commits
}

/** Ficheros que tienes a medias, con en qué estado. */
async function workingTree(root: string): Promise<Map<string, Collision['yours']>> {
  const out = new Map<string, Collision['yours']>()
  const salida = await git(root, ['status', '--porcelain=v1']).catch(() => '')

  for (const linea of salida.split('\n')) {
    if (!linea.trim()) continue
    const estado = linea.slice(0, 2)
    const file = linea.slice(3).trim().replace(/^"|"$/g, '')
    if (!file) continue
    if (estado === '??') out.set(file, 'untracked')
    else if (estado[0] !== ' ' && estado[0] !== '?') out.set(file, 'staged')
    else out.set(file, 'modified')
  }
  return out
}

/** Convierte los ficheros de una persona en su capa de trabajo (§4.3). */
function layerOfFiles(files: string[], at: number): WorkLayer {
  return deriveLayer(
    files.map((path) => ({ at, sessionId: 'git', kind: 'tool' as const, tool: 'Edit', path })),
    at,
  )
}

/**
 * Estado del equipo. `idle` significa «nadie está mirando la vista»: la caché aguanta
 * mucho más y no se sale a la red.
 *
 * Y una lectura en vuelo se comparte. Sin eso, tres pestañas del mismo proyecto que
 * fallan la caché a la vez lanzaban tres baterías de git completas, y el ahorro del
 * TTL se lo comía la estampida.
 */
export function readTeam(root: string, idle = false): Promise<TeamView> {
  const hit = cache.get(root)
  if (hit && Date.now() - hit.at < (idle ? CACHE_FONDO_MS : CACHE_MS)) return Promise.resolve(hit.view)

  const yaVa = enVuelo.get(root)
  if (yaVa) return yaVa

  const lectura = leerTeam(root, idle).finally(() => enVuelo.delete(root))
  enVuelo.set(root, lectura)
  return lectura
}

async function leerTeam(root: string, idle: boolean): Promise<TeamView> {
  const vacio: TeamView = {
    currentBranch: readBranch(root),
    branches: [],
    teammates: [],
    collisions: [],
    readAt: Date.now(),
    hasRemote: false,
    hasRoot: existsSync(root),
    // Sin repositorio tampoco hay remoto, pero el motivo que hay que enseñar no
    // es el mismo: una carpeta contenedora no necesita un remoto, necesita que
    // abras el repo que tiene dentro.
    hasRepo: isRepo(root),
  }

  if (!vacio.hasRoot || !vacio.hasRepo || !readRemote(root)) {
    cache.set(root, { at: Date.now(), view: vacio })
    return vacio
  }

  try {
    await maybeFetch(root, idle)

    const actual = readBranch(root)
    const refs = await git(root, [
      'for-each-ref',
      'refs/remotes/origin',
      '--format=%(refname:short)%1f%(authorname)%1f%(committerdate:unix)',
    ])

    const branches: BranchInfo[] = []
    const nombres: string[] = []

    for (const linea of refs.split('\n')) {
      if (!linea.trim()) continue
      const [refRaw, author, unix] = linea.split('\x1f')
      const ref = (refRaw ?? '').trim()
      // `origin/HEAD` es un puntero, no una rama en la que trabaje nadie.
      if (!ref || ref === 'origin' || ref.endsWith('/HEAD')) continue

      const name = ref.replace(/^origin\//, '')
      const lastCommitAt = Number(unix) * 1000
      // Solo interesan las ramas con actividad reciente: un repo veterano
      // acumula decenas de ramas muertas que solo estorban.
      if (Date.now() - lastCommitAt > DIAS * 24 * 60 * 60 * 1000) continue

      nombres.push(ref)
      let ahead = 0
      if (actual) {
        const cuenta = await git(root, ['rev-list', '--count', `HEAD..${ref}`]).catch(() => '0')
        ahead = Number(cuenta.trim()) || 0
      }
      branches.push({ name, lastAuthor: author ?? '?', lastCommitAt, ahead, current: name === actual })
    }

    branches.sort((a, b) => b.lastCommitAt - a.lastCommitAt)

    // Commits recientes de todas las ramas vivas.
    const todos: Commit[] = []
    for (const ref of nombres.slice(0, 20)) todos.push(...(await commitsOf(root, ref)))

    // Agrupados por persona.
    const porAutor = new Map<string, Commit[]>()
    for (const c of todos) {
      const lista = porAutor.get(c.author) ?? []
      lista.push(c)
      porAutor.set(c.author, lista)
    }

    const teammates: TeammateActivity[] = [...porAutor.entries()]
      .map(([author, cs]) => {
        const files = [...new Set(cs.flatMap((c) => c.files))]
        const lastCommitAt = Math.max(...cs.map((c) => c.at))
        return {
          author,
          branches: [...new Set(cs.map((c) => c.branch.replace(/^origin\//, '')))],
          commits: cs.length,
          files,
          lastCommitAt,
          layer: layerOfFiles(files, lastCommitAt),
        }
      })
      .sort((a, b) => b.lastCommitAt - a.lastCommitAt)

    // ── Colisiones ────────────────────────────────────────────────────────
    //
    // Lo que tú tienes a medias cruzado con lo que otros ya han commiteado en
    // otra rama. Enterarse ahora es accionable; enterarse en el merge, no.
    const mios = await workingTree(root)
    const yo = (await git(root, ['config', 'user.name']).catch(() => '')).trim()

    const collisions: Collision[] = []
    for (const [file, yours] of mios) {
      const theirs = todos
        .filter((c) => c.author !== yo && c.branch.replace(/^origin\//, '') !== actual && c.files.includes(file))
        .map((c) => ({ author: c.author, branch: c.branch.replace(/^origin\//, ''), at: c.at }))
      if (theirs.length > 0) collisions.push({ file, yours, theirs })
    }

    const view: TeamView = {
      currentBranch: actual,
      branches,
      teammates,
      collisions,
      readAt: Date.now(),
      hasRemote: true,
      hasRoot: true,
      hasRepo: true,
    }
    cache.set(root, { at: Date.now(), view })
    return view
  } catch (err) {
    log('no se pudo leer el equipo:', err)
    cache.set(root, { at: Date.now(), view: vacio })
    return { ...vacio, hasRemote: true }
  }
}

/** Para saber si merece la pena enseñar la vista sin abrirla. */
export function collisionCount(root: string): number {
  return cache.get(root)?.view.collisions.length ?? 0
}

export { layerOfPath }
