/**
 * Vincular esta máquina con tu cuenta de 4Code.
 *
 *   node server/src/cloud.ts login [--api https://…] [--relink]
 *   node server/src/cloud.ts status
 *   node server/src/cloud.ts push
 *   node server/src/cloud.ts logout
 *
 * No hay que copiar ni pegar ningún token. El proceso local no tiene navegador
 * ni puede leer la cookie de tu sesión —y no debería—, así que pide un código,
 * abre el navegador donde ya estás identificado, y espera a que lo apruebes.
 * Es el mismo patrón que `gh auth login` o `docker login`.
 *
 * Esta salida se lee en la terminal y se le enseña entera al usuario, así que es
 * parte de la interfaz: dice en qué punto está, qué va a pasar después, y termina
 * con el enlace a lo que acaba de conseguir. Sin colores a propósito — se lee
 * igual de bien en una terminal, en un log y dentro del chat de Claude Code.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { applyOperation, emptyState, toSnapshot } from '../../shared/diagram.ts'
import { HOME, PROJECTS_DIR } from './paths.ts'
import { detectProject } from './project.ts'
import { inspectRoot, listStoredProjects, type AppliedRecord } from './store.ts'
import { readAcked, readConfig, writeAcked, writeConfig } from './sync.ts'

const argv = process.argv.slice(2)
const comando = argv[0]
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Presentación ────────────────────────────────────────────────────────────

const li = (texto = '') => console.log(texto ? `  ${texto}` : '')

function titulo(texto: string): void {
  console.log(`\n  4Code · ${texto}`)
  console.log(`  ${'─'.repeat(texto.length + 8)}\n`)
}

/** Un dato con su etiqueta, alineado. Doce columnas caben en cualquier terminal. */
function campo(etiqueta: string, valor: string): void {
  li(`${etiqueta.padEnd(11)}${valor}`)
}

/** El código, imposible de confundir con el resto de la salida. */
function recuadro(texto: string): void {
  const ancho = texto.length + 6
  li(`┌${'─'.repeat(ancho)}┐`)
  li(`│   ${texto}   │`)
  li(`└${'─'.repeat(ancho)}┘`)
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const tableroUrl = (apiUrl: string, id: string) => `${apiUrl}/app/${encodeURIComponent(id)}`

/** Abre el navegador. Si falla, el usuario siempre tiene la URL impresa. */
function abrirNavegador(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    // `windowsHide`: en Windows esto es `cmd`, y sin el flag parpadea una consola
    // negra por encima de la terminal. Ver el comentario largo en `team.ts`.
    spawn(cmd!, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    /* la URL está impresa; se puede abrir a mano */
  }
}

/**
 * A dónde se vincula si nadie dice lo contrario: producción.
 *
 * Es lo que quiere el 99% de quien escribe `login`. Para desarrollo local se
 * pasa `--api http://localhost:3005`, que es el puerto de `npm run dev` en
 * `landing/` y no el 3000 por defecto de Next.
 */
const API_POR_DEFECTO = 'https://4code.vercel.app'

/**
 * ¿Sirve este token todavía?
 *
 * Sonda deliberadamente incompleta: con un token válido la API responde 400 por
 * el cuerpo, y con uno inválido 401 antes de mirarlo. Solo importa esa
 * diferencia, y así no se crea ningún tablero al comprobar.
 */
async function tokenVale(apiUrl: string, token: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${apiUrl}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ project: {}, operations: [] }),
      signal: AbortSignal.timeout(10_000),
    })
    return res.status !== 401
  } catch {
    // No se pudo preguntar. Ni válido ni inválido: hay que decirlo distinto.
    return null
  }
}

async function login(): Promise<void> {
  const apiUrl = (flag('api') ?? readConfig()?.apiUrl ?? API_POR_DEFECTO).replace(/\/+$/, '')
  const name = flag('name') ?? hostname()
  const relink = argv.includes('--relink')

  /**
   * Vincular una máquina que ya está vinculada crea un dispositivo duplicado en
   * la cuenta, y quien lo ve después no sabe cuál está vivo. Así que primero se
   * comprueba: si la credencial de aquí sigue valiendo, no hay nada que vincular
   * —lo único útil es subir lo que quedara pendiente, que es lo que se hace.
   */
  const actual = readConfig()
  if (actual && !relink && (flag('api') ?? actual.apiUrl) === actual.apiUrl) {
    const vale = await tokenVale(actual.apiUrl, actual.token)
    if (vale === true) {
      titulo('esta máquina ya está vinculada')
      campo('Nube', actual.apiUrl)
      campo('Cuenta', actual.login ?? '(desconocida — `login --relink` la averigua)')
      campo('Token', `${actual.token.slice(0, 10)}…`)
      li()
      li('No hace falta volver a vincularla. Se comprueba si queda algo por subir:')
      await push()
      li('Para vincularla a otra cuenta: `logout` y luego `login`.')
      li('Para forzar una credencial nueva: `login --relink`.')
      li()
      return
    }
    if (vale === false) {
      titulo('la credencial de esta máquina ya no vale')
      li('Se revocó desde la web, o la cuenta perdió la conexión con GitHub.')
      li('Se vincula otra vez ahora mismo.')
    }
  }

  const inicio = await fetch(`${apiUrl}/api/link/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).catch(() => null)

  if (!inicio?.ok) {
    titulo('no se pudo empezar')
    campo('Nube', apiUrl)
    li()
    li('No responde. Si es una instalación propia, comprueba que está levantada;')
    li('si es la nube pública, vuelve a intentarlo en un momento.')
    li()
    process.exit(1)
  }

  const { code, secret, verifyUrl, expiresInSeconds } = (await inicio.json()) as {
    code: string
    secret: string
    verifyUrl: string
    expiresInSeconds: number
  }

  titulo('vincular esta máquina')
  campo('Máquina', name)
  campo('Nube', apiUrl)
  li()
  recuadro(code)
  li()
  li('Se abre el navegador donde ya tienes sesión. Comprueba que enseña ESE')
  li('código —el mismo, carácter por carácter— y aprueba desde ahí.')
  li()
  li(`Si no se abre solo:  ${verifyUrl}`)
  li()

  abrirNavegador(verifyUrl)

  const limite = Date.now() + expiresInSeconds * 1000
  const tty = Boolean(process.stdout.isTTY)
  if (!tty) li('Esperando tu aprobación…')

  while (Date.now() < limite) {
    if (tty) {
      // Una línea que se reescribe: el tiempo que queda es la única información
      // nueva, y una fila de puntos no dice cuánto margen hay.
      process.stdout.write(`\r  Esperando tu aprobación…  ${mmss(limite - Date.now())} `)
    }
    await sleep(2000)

    const res = await fetch(`${apiUrl}/api/link/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    }).catch(() => null)

    if (!res) continue

    if (res.status === 410) {
      if (tty) process.stdout.write('\r')
      li()
      li('El código caducó (vive diez minutos). Vuelve a ejecutarlo y aprueba el nuevo.')
      li()
      process.exit(1)
    }
    if (!res.ok) continue

    const data = (await res.json()) as { status: string; token?: string; login?: string }
    if (data.status === 'approved' && data.token) {
      if (tty) process.stdout.write('\r                                            \r')
      // El `login` se guarda para poder enseñarlo después: es lo que convierte
      // «Token 4c_MUi…» en «Account elianpaludi», y con eso el cruce de cuentas
      // —vincular con una y tener el acceso en otra— se ve de un vistazo.
      writeConfig({ apiUrl, token: data.token, ...(data.login && { login: data.login }) })

      li(`✓ "${name}" vinculada${data.login ? ` a ${data.login}` : ''}.`)
      // Y se sube lo que ya hay. Vincular y no ver nada es la peor primera
      // impresión posible: parece que algo ha fallado cuando no ha fallado nada.
      await push()

      /**
       * Aquí ya no se pide reiniciar nada, y antes sí.
       *
       * Era un requisito falso: la configuración se lee del disco en cada
       * operación, así que el canvas-server que ya estuviera corriendo empieza a
       * sincronizar en cuanto Claude toque el tablero. Y lo anterior a este
       * momento acaba de subirlo el paso de arriba.
       */
      li('De aquí en adelante se sincroniza solo, mientras trabajas.')
      li()
      return
    }
  }

  if (tty) process.stdout.write('\r')
  li()
  li('Se agotó el tiempo sin aprobación. Vuelve a ejecutarlo cuando puedas aprobarlo.')
  li()
  process.exit(1)
}

/**
 * Sube lo que ya hay: todos los tableros con remoto de GitHub, desde la última
 * operación que la nube confirmó.
 *
 * Sin esto, vincular una máquina no producía absolutamente nada visible. La
 * sincronización solo arrancaba al abrir un proyecto —es decir, al volver a
 * trabajar en él— así que quien acababa de vincular veía su lista de tableros
 * vacía y no tenía forma de saber si había hecho algo mal.
 *
 * Va aquí y no en la cola de `sync.ts` porque este proceso termina enseguida y
 * una cola con retardo no llegaría a vaciarse.
 */
const LOTE = 200

function historialDe(id: string): AppliedRecord[] {
  const fichero = join(PROJECTS_DIR, id, 'history.jsonl')
  if (!existsSync(fichero)) return []
  const out: AppliedRecord[] = []
  for (const linea of readFileSync(fichero, 'utf8').split('\n')) {
    if (!linea.trim()) continue
    try {
      out.push(JSON.parse(linea) as AppliedRecord)
    } catch {
      // Una línea a medias solo puede ser la última, por un apagón durante el
      // append. El resto del historial sigue siendo válido.
    }
  }
  return out
}

/**
 * Qué significa cada fallo, dicho donde ocurre.
 *
 * Un `FALLÓ (404)` obliga a quien lo lee a adivinar, y el 404 es además el caso
 * más probable la primera vez: subir exige acceso real al repositorio, y la App
 * de GitHub se instala por cuenta, así que basta con no haberla instalado donde
 * vive ese repositorio.
 */
function explicarFallo(apiUrl: string, remoto: string | undefined, status: number | null): void {
  if (status === 404) {
    li(`      La cuenta vinculada no alcanza ${remoto ?? 'ese repositorio'}.`)
    li('      La App de GitHub se instala por cuenta u organización: si el')
    li('      repositorio vive en una donde no está, GitHub responde 404.')
    li(`      Revisa dónde tiene acceso:  ${apiUrl}/app/repos`)
    return
  }
  if (status === 401) {
    li('      La credencial de esta máquina ya no vale (revocada, o la cuenta')
    li('      perdió la conexión con GitHub). Ejecuta `login` otra vez.')
    return
  }
  if (status === null) {
    li('      No hubo respuesta. Se reintentará solo la próxima vez que trabajes.')
    return
  }
  li(`      La API respondió ${status}. Se reintentará solo la próxima vez que trabajes.`)
}

async function push(): Promise<void> {
  const config = readConfig()
  if (!config) {
    titulo('esta máquina no está vinculada')
    li('Los tableros existen solo aquí. Para vincularla:')
    li()
    li('  node server/src/cloud.ts login')
    li()
    process.exit(1)
  }

  const todos = listStoredProjects()
  const proyectos = todos.filter((p) => p.remote?.startsWith('github.com/'))
  const locales = todos.length - proyectos.length

  if (proyectos.length === 0) {
    li()
    li('Ningún tablero tiene remoto de GitHub, así que no hay nada que compartir.')
    li('Un tablero sin remoto no tiene de dónde sacar permisos y se queda aquí.')
    li()
    return
  }

  li()
  let total = 0

  for (const proyecto of proyectos) {
    /**
     * La marca se lee UNA vez, fuera del filtro.
     *
     * Dentro del predicado se leía del disco una vez por registro —169 veces en
     * el proyecto más grande— pero lo caro no era eso: `readAcked` devuelve 0 si
     * falla, así que un error transitorio a mitad del recorrido dejaba media
     * lista comparada contra la marca real y media contra cero, y eso son
     * reenvíos. `sync.ts` ya lo hacía bien; esto copia su forma.
     */
    const acked = readAcked(proyecto.id)
    // `!r.remote` por lo mismo que en `sync.ts`: el historial lleva mezcladas las
    // operaciones que bajaron de otras máquinas, y devolverlas sería un bucle.
    const pendientes = historialDe(proyecto.id).filter((r) => r.seq > acked && !r.remote)
    if (pendientes.length === 0) {
      li(`  ${proyecto.name.padEnd(24)} al día`)
      li(`  ${' '.repeat(24)} ${tableroUrl(config.apiUrl, proyecto.id)}`)
      continue
    }

    let enviadas = 0
    let fallo: number | null | undefined

    for (let i = 0; i < pendientes.length; i += LOTE) {
      const lote = pendientes.slice(i, i + LOTE)
      const res = await fetch(`${config.apiUrl}/api/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          project: { id: proyecto.id, remote: proyecto.remote, name: proyecto.name },
          operations: lote,
        }),
      }).catch(() => null)

      if (!res?.ok) {
        fallo = res?.status ?? null
        break
      }
      const data = (await res.json()) as { seq?: number }
      if (typeof data.seq === 'number') writeAcked(proyecto.id, data.seq)
      enviadas += lote.length
    }

    if (fallo !== undefined) {
      li(`  ${proyecto.name.padEnd(24)} no se pudo subir`)
      explicarFallo(config.apiUrl, proyecto.remote, fallo)
      continue
    }

    total += enviadas
    li(`  ${proyecto.name.padEnd(24)} ${enviadas} operación(es) subidas`)
    li(`  ${' '.repeat(24)} ${tableroUrl(config.apiUrl, proyecto.id)}`)
  }

  if (locales > 0) {
    li()
    li(`  ${locales} tablero(s) sin remoto de GitHub se quedan en esta máquina.`)
    li('  No se pierde nada: siguen aquí enteros. `status` explica cómo subirlos.')
  }

  li()
  if (total === 0) li('Todo estaba ya al día.')
  li()
}

/**
 * Traer de vuelta un tablero que está en la nube y no en esta máquina.
 *
 * El caso que lo justifica: formatear el PC, o cambiar de ordenador. Los tableros
 * viven en `~/.4code/`, así que el disco se los lleva; la nube tenía el historial
 * entero desde el principio —el historial manda, el snapshot es caché— pero no
 * había forma de devolverlo.
 *
 * Reconstruye el historial y el snapshot desde el log del servidor. La marca de
 * sincronización se deja al día para que esta máquina no vuelva a subir lo que ya
 * está arriba: sube solo lo que haga de aquí en adelante.
 */
async function restore(): Promise<void> {
  const config = readConfig()
  if (!config) {
    titulo('esta máquina no está vinculada')
    li('Para traer un tablero de la nube hay que vincularla primero:')
    li()
    li('  node server/src/cloud.ts login')
    li()
    process.exit(1)
  }

  const proyecto = detectProject(process.cwd())
  const forzar = argv.includes('--force')

  titulo('traer el tablero de la nube')
  campo('Proyecto', proyecto.name)
  campo('Carpeta', proyecto.root)
  campo('Remoto', proyecto.remote ?? '—')
  li()

  if (!proyecto.remote?.startsWith('github.com/')) {
    li('Esta carpeta no tiene remoto de GitHub, así que su tablero nunca subió a')
    li('la nube y no hay nada que traer. `status` explica cómo cambiarlo.')
    li()
    process.exit(1)
  }

  // Un tablero local con trabajo dentro no se pisa sin que lo pidan: reconstruir
  // desde la nube sustituye el historial, y el de aquí puede ser más reciente.
  const local = listStoredProjects().find((p) => p.id === proyecto.id)
  if (local && local.nodes > 0 && !forzar) {
    li(`Aquí ya hay un tablero con ${local.nodes} piezas y ${local.edges} enlaces.`)
    li('Traer el de la nube sustituiría su historial por el que hay allí.')
    li()
    li('Si es lo que quieres:  node server/src/cloud.ts restore --force')
    li('Antes, para guardarlo:  node server/src/board.ts export ' + proyecto.id)
    li()
    process.exit(1)
  }

  const registros: AppliedRecord[] = []
  let desde = 0
  let nombre = proyecto.name

  for (;;) {
    const res = await fetch(
      `${config.apiUrl}/api/boards/${encodeURIComponent(proyecto.id)}/ops?after=${desde}`,
      { headers: { authorization: `Bearer ${config.token}` } },
    ).catch(() => null)

    if (!res) {
      li(`No se pudo contactar con ${config.apiUrl}.`)
      li()
      process.exit(1)
    }

    if (res.status === 404) {
      li('En la nube no hay tablero de este repositorio, o esta cuenta no alcanza')
      li('el repositorio. Las dos cosas responden igual a propósito.')
      li()
      li(`Comprueba dónde tiene acceso 4Code:  ${config.apiUrl}/app/repos`)
      li()
      process.exit(1)
    }

    if (res.status === 401) {
      li('La credencial de esta máquina ya no vale. Ejecuta `login` otra vez.')
      li()
      process.exit(1)
    }

    if (!res.ok) {
      li(`La API respondió ${res.status}. Inténtalo de nuevo en un momento.`)
      li()
      process.exit(1)
    }

    const data = (await res.json()) as {
      name?: string
      operations: AppliedRecord[]
      more?: boolean
    }
    if (data.name) nombre = data.name
    registros.push(...data.operations)
    // Igual que en `login`: la línea que se reescribe solo tiene sentido en una
    // terminal. En un log, `\r` no borra nada y deja la salida pegada.
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  Descargando… ${registros.length} operación(es) `)
    }

    if (!data.more || data.operations.length === 0) break
    desde = data.operations.at(-1)?.seq ?? desde
  }

  if (process.stdout.isTTY) process.stdout.write('\r                                            \r')
  else li(`Descargadas ${registros.length} operación(es).`)

  if (registros.length === 0) {
    li('El tablero de la nube está vacío: no hay nada que traer.')
    li()
    return
  }

  // El estado se reconstruye aplicando el log, igual que hace el canvas-server al
  // abrir un proyecto. Así una operación que la nube guardó pero que ya no tiene
  // sentido (una arista a un nodo borrado) se descarta aquí y no ensucia nada.
  const estado = emptyState()
  let aplicadas = 0
  for (const r of registros) {
    if (applyOperation(estado, r.operation)) aplicadas++
  }
  const snapshot = toSnapshot(estado)

  const dir = join(PROJECTS_DIR, proyecto.id)
  mkdirSync(dir, { recursive: true })

  const ref = { ...proyecto, name: nombre }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(ref, null, 2), 'utf8')
  writeFileSync(
    join(dir, 'history.jsonl'),
    `${registros.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  )
  const ultimo = registros.at(-1)!.seq
  writeFileSync(
    join(dir, 'diagram.json'),
    JSON.stringify({
      version: 1,
      project: ref,
      seq: ultimo,
      savedAt: Date.now(),
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    }),
    'utf8',
  )
  // Al día: lo descargado ya está en la nube, y volver a subirlo solo duplicaría
  // el log. Desde aquí sube lo que se haga de ahora en adelante.
  writeAcked(proyecto.id, ultimo)

  li(`✓ ${snapshot.nodes.length} piezas y ${snapshot.edges.length} enlaces restaurados.`)
  li(`  ${registros.length} operación(es) de historial${aplicadas < registros.length ? ` (${registros.length - aplicadas} ya no aplicaban)` : ''}.`)
  li()
  li('Reinicia el canvas-server si estaba abierto, para que lo lea del disco:')
  li('  el servidor MCP lo arranca solo la próxima vez que trabajes aquí.')
  li()
  li(`  Tablero local:  http://127.0.0.1:41847/?project=${proyecto.id}`)
  li(`  En la nube:     ${tableroUrl(config.apiUrl, proyecto.id)}`)
  li()
}

/**
 * Vinculación con un token ya emitido, para máquinas donde no hay navegador que
 * abrir: un servidor por SSH, un contenedor, una VM sin escritorio.
 *
 * Es la vía secundaria a propósito. La principal no obliga a copiar nada, y un
 * token que viaja por el portapapeles acaba en el historial de la terminal.
 */
async function loginConToken(token: string): Promise<void> {
  const apiUrl = (flag('api') ?? readConfig()?.apiUrl ?? API_POR_DEFECTO).replace(/\/+$/, '')

  // Se comprueba antes de guardarlo. Escribir un token inválido deja la máquina
  // «vinculada» a algo que falla en silencio cada vez que intente sincronizar.
  const vale = await tokenVale(apiUrl, token)

  if (vale === null) {
    titulo('no se pudo comprobar el token')
    campo('Nube', apiUrl)
    li()
    li('No responde. No se guarda nada: un token sin comprobar deja la máquina')
    li('«vinculada» a algo que falla en silencio.')
    li()
    process.exit(1)
  }

  if (vale === false) {
    titulo('ese token no vale')
    li(`Genera otro en ${apiUrl}/app/settings, o usa \`login\` sin token: abre el`)
    li('navegador y no hay nada que copiar.')
    li()
    process.exit(1)
  }

  writeConfig({ apiUrl, token })
  titulo('máquina vinculada')
  campo('Nube', apiUrl)
  li()
  li('Los tableros con remoto de GitHub se sincronizan solos mientras trabajas.')
  await push()
}

function status(): void {
  const config = readConfig()
  titulo('estado')

  if (!config) {
    campo('Nube', 'sin vincular — los tableros existen solo en esta máquina')
    li()
    li('Para vincularla:  node server/src/cloud.ts login')
  } else {
    campo('Nube', config.apiUrl)
    campo('Cuenta', config.login ?? '(desconocida — `login --relink` la averigua)')
    campo('Token', `${config.token.slice(0, 10)}…`)
  }

  const proyectos = listStoredProjects()
  li()

  if (proyectos.length === 0) {
    li('Todavía no hay ningún tablero. Se crea solo la primera vez que Claude')
    li('diagrame algo en un proyecto.')
    li()
    return
  }

  li(`Tableros (${proyectos.length})`)
  li()

  let locales = 0
  let contenedores = 0

  for (const p of proyectos) {
    li(`  ${p.name}   ${p.nodes} piezas · ${p.edges} enlaces`)

    if (!p.remote?.startsWith('github.com/')) {
      locales++
      if (p.noRepo) contenedores++
      li(
        p.remote
          ? `    ${p.remote} — no es GitHub, así que se queda en esta máquina`
          : p.noRepo
            ? '    esta carpeta no es un repositorio de git — se queda en esta máquina'
            : '    sin remoto — se queda en esta máquina',
      )
      // Lo que hay dentro sí puede subir, y es lo único accionable de esta línea.
      if (p.innerRepos?.length) {
        li(`    dentro hay repositorios: ${p.innerRepos.join(', ')} — ábrelos por separado`)
      }
      li()
      continue
    }

    li(`    ${p.remote}`)

    // El caso que ocurre justo cuando alguien hace lo que le pedimos: subir el
    // repo cambia la identidad del proyecto y el tablero nuevo arranca vacío.
    if (p.orphan) {
      li(`    hay un tablero anterior de esta carpeta con ${p.orphan.nodes} piezas:`)
      li(`      node server/src/board.ts move ${p.orphan.id} ${p.id} --apply`)
    }

    if (!config) {
      li('    listo para subir en cuanto vincules esta máquina')
      li()
      continue
    }

    // La marca, una vez y fuera del filtro. Ver el comentario en `push()`.
    const acked = readAcked(p.id)
    const pendientes = historialDe(p.id).filter((r) => r.seq > acked).length
    li(
      pendientes === 0
        ? `    al día · ${tableroUrl(config.apiUrl, p.id)}`
        : `    ${pendientes} operación(es) pendientes de subir · se envían al trabajar`,
    )
    li()
  }

  /**
   * Y qué hacer con los que se quedan aquí.
   *
   * Decir «no se comparte» sin decir por qué ni cómo cambiarlo deja la impresión
   * de que el producto no funciona en la mitad de los proyectos. El motivo es que
   * los permisos los pone GitHub: sin remoto no hay a quién preguntarle quién
   * puede ver ese tablero.
   */
  if (locales > 0) {
    li(`${locales} tablero(s) se quedan en esta máquina, y no se pierde nada: siguen`)
    li('aquí completos, con su historial. Solo no suben, porque 4Code decide quién')
    li('ve un tablero preguntándole a GitHub por el repositorio, y sin remoto no')
    li('hay a quién preguntar.')
    li()
    li('Para que uno suba, dale un remoto privado desde su carpeta:')
    li()
    li('  gh repo create --private --source=. --push')
    li()
    li('Al ganar remoto el proyecto cambia de identidad y su tablero arranca vacío;')
    li('`status` te dirá entonces cómo traer el de ahora, que no se borra.')
    li()

    // Y la excepción, porque ahí el consejo de arriba es el equivocado.
    if (contenedores > 0) {
      li(`Con ${contenedores === 1 ? 'el que no es un repositorio' : 'los que no son repositorios'} eso no aplica: si es`)
      li('una carpeta que contiene repos, no le des un remoto a ella — envolverías')
      li('los historiales que ya tienes dentro. Abre Claude Code en cada repo y')
      li('cada uno tendrá su tablero.')
      li()
    }
  }
}

/**
 * ¿Se puede trabajar en equipo desde esta carpeta, y si no, qué falta?
 *
 * Compartir un tablero no falla en un sitio: falla en cinco (§4.13), y hasta ahora los
 * tres últimos daban exactamente la misma respuesta —un 404— porque decir cuál es
 * confirmaría la existencia de un repositorio privado ajeno. Esa ambigüedad hacia fuera
 * es correcta y se queda; lo que no tenía sentido es que también fuera ambigua **para
 * quien tiene el repositorio clonado en su disco**. Eso costó cuarenta minutos de
 * diagnóstico a mano el 30 jul, y esto es ese diagnóstico convertido en un comando.
 *
 * Enseña los cinco y explica **el primero que falla**: la lista da contexto, el detalle
 * da el siguiente paso.
 *
 * Devuelve si está todo, en vez de llamar a `process.exit()` por dentro: salir en el
 * mismo tick en que se cierran los sockets de un `fetch` revienta libuv en Windows con
 * un `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — el mismo que ya está
 * documentado en `verify/build.ts`. El código de salida lo pone quien llama.
 */
async function team(): Promise<boolean> {
  const proyecto = detectProject(process.cwd())
  const { noRepo, innerRepos } = inspectRoot(proyecto.root)
  const config = readConfig()

  titulo('sharing this board')
  campo('Folder', proyecto.root)
  campo('Project', proyecto.name)
  campo('Remote', proyecto.remote ?? '—')
  li()

  /** Una línea del chequeo. `null` = todavía no se ha podido comprobar. */
  const chequeo = (ok: boolean | null, texto: string, detalle = '') =>
    // 37 y no 34: «Your account reaches the repository» mide 35, y con un relleno
    // más corto que la etiqueta más larga el detalle se pega al texto.
    li(`${ok === null ? '·' : ok ? '✓' : '✗'}  ${detalle ? texto.padEnd(37) : texto}${detalle}`)

  const esRepo = !noRepo
  const enGitHub = Boolean(proyecto.remote?.startsWith('github.com/'))
  const vinculada = Boolean(config)

  chequeo(esRepo, 'This folder is a git repository')
  chequeo(enGitHub, 'It has a GitHub remote')
  chequeo(vinculada, 'This machine is linked', config?.apiUrl ?? '')

  // Las dos últimas hay que preguntárselas a la nube, y solo tienen sentido si las
  // tres primeras están.
  if (!esRepo || !enGitHub || !vinculada) {
    chequeo(null, 'Your account reaches the repository')
    chequeo(null, 'There is a board in the cloud')
    li()

    if (!esRepo) {
      li('This folder is not a git repository, so its board is identified by the')
      li('local path — and two people with different paths never converge.')
      if (innerRepos.length > 0) {
        li()
        li(`There are repositories inside it: ${innerRepos.join(', ')}.`)
        li('Open Claude Code inside one of them and run this again there.')
        li()
        li('Do NOT give this folder a remote: you would wrap the histories it')
        li('already holds inside a new repository.')
      }
    } else if (!enGitHub) {
      li(proyecto.remote
        ? `El remoto (${proyecto.remote}) no es de GitHub, y los permisos salen de ahí.`
        : 'El repositorio no tiene remoto, y sin remoto no hay a quién preguntarle')
      if (!proyecto.remote) li('who is allowed to see this board.')
      li()
      li('  gh repo create --private --source=. --push')
    } else {
      li('This machine is not linked to any account, so nothing uploads.')
      li()
      li('  /4code:login')
    }
    li()
    return false
  }

  const res = await fetch(
    `${config!.apiUrl}/api/access?remote=${encodeURIComponent(proyecto.remote!)}`,
    { headers: { authorization: `Bearer ${config!.token}` } },
  ).catch(() => null)

  if (!res || !res.ok) {
    chequeo(null, 'Your account reaches the repository')
    chequeo(null, 'There is a board in the cloud')
    li()
    if (res?.status === 401) {
      li('The credential of this machine is no longer valid. Link it again:')
      li()
      li('  /4code:login')
    } else if (res?.status === 404) {
      // Un despliegue viejo, sin este endpoint. Merece decirlo en vez de callar.
      li(`${config!.apiUrl} does not know this check: it is on an older version.`)
    } else {
      li(`Could not reach ${config!.apiUrl}.`)
    }
    li()
    return false
  }

  const info = (await res.json()) as {
    login: string
    access: boolean
    collaboratorsUrl?: string
    board?: { id: string; name: string; pieces: number; links: number; contributors: { login: string }[] }
  }

  const [owner, repo] = proyecto.remote!.replace(/^github\.com\//, '').split('/')

  chequeo(info.access, 'Your account reaches the repository', info.login || '?')

  if (!info.access) {
    chequeo(null, 'There is a board in the cloud')
    li()
    li(`The account **${info.login}** cannot reach ${owner}/${repo}. It is one of two`)
    li('things, and GitHub answers both identically on purpose:')
    li()
    li(`  · you are not a collaborator on the repository`)
    li(`      https://github.com/${owner}/${repo}/settings/access`)
    li(`  · or the 4Code App has not been granted access to it`)
    li(`      ${config!.apiUrl}/app/repos`)
    li()
    li('If your access lives on a DIFFERENT GitHub account, link this machine to it:')
    li()
    li('  /4code:logout    then    /4code:login')
    li()
    return false
  }

  const tablero = info.board
  const gente = tablero?.contributors.length ?? 0
  chequeo(
    tablero ? true : null,
    'There is a board in the cloud',
    tablero
      ? `${tablero.pieces} piezas · ${gente || 'sin'} ${gente === 1 ? 'persona' : 'personas'}`
      : 'todavía nadie ha dibujado nada',
  )
  li()

  if (tablero) {
    li('All set. Your shared board:')
    li()
    li(`  ${tableroUrl(config!.apiUrl, tablero.id)}`)
    if (gente > 0) {
      li()
      li(`  Already drawing here: ${tablero.contributors.map((c) => c.login).join(', ')}`)
    }
  } else {
    li('All set on your side. Ask Claude to map this project and the board will')
    li('appear up there on its own.')
  }

  li()
  li('For someone else to see this board they need, in this order:')
  li()
  li(`  1. Access to the repository on GitHub`)
  li(`     https://github.com/${owner}/${repo}/settings/access`)
  li(`  2. The plugin installed, and their machine linked with THAT account`)
  li(`     /plugin marketplace add https://github.com/4code-bit/4code.git`)
  li(`     /plugin install 4code@4code   then   /4code:login`)
  li(`  3. To open Claude Code inside the repository, not in the folder holding it`)
  li()
  li('Each local board only ever shows its own machine: the shared surface is the')
  li('website. Anyone who also wants it locally runs `/4code:restore`.')
  li()
  return true
}

switch (comando) {
  case 'login': {
    // Un token suelto detrás de `login`. Antes se ignoraba en silencio y se
    // arrancaba el flujo del navegador, que no es lo que pide quien lo escribe.
    const suelto = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined
    if (suelto) await loginConToken(suelto)
    else await login()
    break
  }

  case 'push':
    await push()
    break

  case 'restore':
    await restore()
    break

  case 'status':
    status()
    break

  case 'team':
    // `exitCode` y no `exit()`: ver el comentario de `team()`.
    if (!(await team())) process.exitCode = 1
    break

  case 'logout': {
    const file = join(HOME, 'config.json')
    if (existsSync(file)) rmSync(file)
    titulo('desvinculada')
    li('Esta máquina deja de subir nada. De la nube no se borra nada desde aquí:')
    li('para revocar el acceso del todo, hazlo en /app/settings.')
    li()
    break
  }

  default:
    console.log(`
Vincular esta máquina con 4Code.

  login [--api URL] [--name X]   Abre el navegador y espera tu aprobación
  login <token>                  Para máquinas sin navegador (SSH, contenedor)
  status                         Qué hay vinculado y qué queda por subir
  team                           Si se puede compartir este tablero, y qué falta
  push                           Sube ahora lo que esté pendiente
  restore [--force]              Trae de la nube el tablero de esta carpeta
  logout                         Desvincular esta máquina

Añade --relink a login para forzar una credencial nueva en una máquina que ya
está vinculada.

Solo se sincronizan los tableros con remoto de GitHub: sin remoto no hay forma de
saber quién puede verlos.
`)
}
