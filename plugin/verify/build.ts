/**
 * Verificación del empaquetado: lo que se publica tiene que poder abrirse.
 *
 * El plugin se instala clonando el repositorio, así que **lo que no esté
 * versionado no llega a la máquina de quien lo instala**. `web/dist` cayó bajo la
 * regla `dist/` del .gitignore y durante un tiempo el plugin publicado arrancaba
 * el servidor, servía el diagrama por API, imprimía la URL del tablero… y
 * respondía «no encontrado» a quien la abría. Ni el arranque ni los verificadores
 * lo notaron, porque en el repositorio de desarrollo el `dist` sí existe.
 *
 * Versionar un artefacto tiene un precio conocido: se queda viejo. De eso se
 * ocupa la comprobación 3.
 *
 *   node verify/build.ts
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeArgs } from '../node-ts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RAIZ = resolve(HERE, '..')
const WEB = join(RAIZ, 'web')
const DIST = join(WEB, 'dist')

let fallos = 0
function check(nombre: string, ok: boolean, detalle: unknown = '') {
  if (!ok) fallos++
  console.log(`  ${ok ? 'OK   ' : 'FALLO'} ${nombre}${detalle !== '' ? `  → ${JSON.stringify(detalle)}` : ''}`)
}

/** El fichero modificado más recientemente bajo `dir`, saltando node_modules. */
function masReciente(dir: string): { ruta: string; at: number } {
  let mejor = { ruta: dir, at: 0 }
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name === 'node_modules' || entrada.name === 'dist') continue
    const ruta = join(dir, entrada.name)
    const candidato = entrada.isDirectory() ? masReciente(ruta) : { ruta, at: statSync(ruta).mtimeMs }
    if (candidato.at > mejor.at) mejor = candidato
  }
  return mejor
}

console.log('\n1. La interfaz construida existe')

check('web/dist/index.html', existsSync(join(DIST, 'index.html')))

const html = existsSync(join(DIST, 'index.html')) ? readFileSync(join(DIST, 'index.html'), 'utf8') : ''
const referencias = [...html.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map((m) => m[1]!)
check('el index referencia sus assets', referencias.length >= 2, referencias)
for (const ref of referencias) {
  check(`existe ${ref}`, existsSync(join(DIST, ref)))
}

console.log('\n2. Y viaja con el plugin')

/**
 * La comprobación que de verdad importa: no basta con que el fichero exista en
 * disco, tiene que estar *versionado*. Es exactamente la diferencia que dejó el
 * plugin publicado sin interfaz.
 */
function versionado(ruta: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', ruta], { cwd: RAIZ, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

check('git tiene el index.html', versionado('web/dist/index.html'))
for (const ref of referencias) check(`git tiene ${ref}`, versionado(`web/dist/${ref}`))

console.log('\n3. Y está al día')

/**
 * Comparación de fechas, con su límite declarado: en un clon recién hecho todos
 * los ficheros comparten el mtime del checkout, así que aquí no significa nada.
 * Donde sí significa —y es donde importa— es en la máquina desde la que se
 * publica, que es la única que puede subir un `dist` viejo.
 */
const fuente = masReciente(join(WEB, 'src'))
const construido = masReciente(DIST)
const alDia = construido.at >= fuente.at

check(
  'el build no es más viejo que web/src',
  alDia,
  alDia ? '' : `${fuente.ruta.slice(RAIZ.length + 1)} es más nuevo — corre: npm run web:build`,
)

console.log('\n4. Y si aun así faltara, se dice')

/**
 * La red de seguridad. Si el `dist` vuelve a no llegar —otra regla del
 * .gitignore, un empaquetado distinto—, quien abra la URL tiene que enterarse de
 * qué pasa. Un «no encontrado» a secas costó una mañana.
 */
const PORT = 41998
const HOME_TMP = mkdtempSync(join(tmpdir(), '4code-verify-build-'))
const servidor = spawn(process.execPath, nodeArgs(join(RAIZ, 'server/src/canvas-server.ts')), {
  env: {
    ...process.env,
    FOURCODE_HOME: HOME_TMP,
    FOURCODE_PORT: String(PORT),
    FOURCODE_WEB_DIST: join(HOME_TMP, 'no-existe'),
  },
  stdio: ['ignore', 'ignore', 'ignore'],
})

try {
  let vivo = false
  for (let i = 0; i < 60 && !vivo; i++) {
    try {
      vivo = (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) })).ok
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  check('el servidor arranca sin interfaz', vivo)

  if (vivo) {
    const res = await fetch(`http://127.0.0.1:${PORT}/`)
    const cuerpo = await res.text()
    check('no responde «no encontrado»', cuerpo.trim() !== 'no encontrado', cuerpo.slice(0, 40))
    check('explica que falta la interfaz', cuerpo.includes('Falta la interfaz'))
    check('dice cómo arreglarlo', cuerpo.includes('/plugin update') && cuerpo.includes('web:build'))
    check('y el diagrama sigue sirviéndose', (await fetch(`http://127.0.0.1:${PORT}/projects`)).ok)
  }
} finally {
  // Esperar al hijo, y después un margen, igual que `core.ts`. En Windows,
  // matarlo y llamar a `process.exit` en el mismo tick revienta libuv con un
  // assert (`UV_HANDLE_CLOSING`): el verificador acaba en 127 con todas las
  // comprobaciones en verde, que es lo peor de los dos mundos porque parece un
  // fallo real del producto.
  servidor.kill()
  await new Promise<void>((listo) => {
    servidor.once('exit', () => listo())
    setTimeout(listo, 3000).unref()
  })
  await new Promise((r) => setTimeout(r, 400))
  rmSync(HOME_TMP, { recursive: true, force: true })
}

/**
 * 5. Ningún punto de entrada se salta el lanzador.
 *
 * El plugin va sin compilar, y qué Nodes saben ejecutar `.ts` depende de la versión.
 * Un `node algo.ts` suelto funciona perfectamente en la máquina de quien lo escribe y
 * **mata el plugin entero, en silencio**, en un Node 22.16 — que es una LTS normal.
 * Pasó: el servidor MCP no arrancaba, los hooks tampoco, y lo único visible era
 * «failed with exit code 1». Esta comprobación existe para que no vuelva a colarse.
 */
console.log('\n5. Todos los puntos de entrada pasan por el lanzador')

// Los dos, y versionados: un lanzador que no viaja con el plugin no lanza nada.
for (const f of ['launch.mjs', 'node-ts.mjs']) {
  check(`${f} existe`, existsSync(join(RAIZ, f)))
  check(`y git tiene ${f}`, versionado(f))
}

/**
 * Los comandos se descubren, no se enumeran: una lista fija deja fuera al comando
 * nuevo, que es justo el que puede traer el fallo de vuelta.
 */
const ENTRADAS = [
  '.mcp.json',
  'hooks/hooks.json',
  ...readdirSync(join(RAIZ, 'commands'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `commands/${f}`),
]

for (const rel of ENTRADAS) {
  const ruta = join(RAIZ, rel)
  if (!existsSync(ruta)) {
    check(`existe ${rel}`, false)
    continue
  }
  const texto = readFileSync(ruta, 'utf8')
  // Toda invocación de `node` que acabe en un `.ts` tiene que llevar el lanzador.
  const invocaciones = [...texto.matchAll(/node[^\n]*?\.ts/g)].map((m) => m[0])
  const malas = invocaciones.filter((i) => !i.includes('launch.mjs'))
  check(`${rel} no lanza .ts a pelo`, malas.length === 0, malas)
}

/**
 * Y que el lanzador ejecute un `.ts` de verdad — por las DOS vías.
 *
 * La segunda es la que importa: `FOURCODE_NODE_TS=flag` recorre la rama de Node 22 en
 * este Node moderno. Sin ella, el soporte a la LTS anterior sería una rama de código
 * que nadie ejecuta nunca hasta que un usuario la estrena, que es exactamente cómo se
 * llegó aquí.
 */
function lanza(nombre: string, env: Record<string, string>) {
  const sonda = mkdtempSync(join(tmpdir(), '4code-launch-'))
  const res = spawnSync(process.execPath, [join(RAIZ, 'launch.mjs'), 'server/src/board.ts', 'list'], {
    env: { ...process.env, FOURCODE_HOME: sonda, ...env },
    encoding: 'utf8',
  })
  rmSync(sonda, { recursive: true, force: true })
  const roto = /Unknown file extension|SyntaxError|ERR_UNKNOWN_FILE_EXTENSION/.test(res.stderr ?? '')
  check(nombre, res.status === 0 && !roto && (res.stdout ?? '').length > 0, {
    status: res.status,
    bytes: (res.stdout ?? '').length,
    stderr: (res.stderr ?? '').slice(0, 120),
  })
  return res.stdout ?? ''
}

const salidaNativa = lanza(`ejecuta TypeScript en este Node (${process.versions.node})`, {})
const salidaConFlag = lanza('y por la vía de Node 22, con --experimental-strip-types', {
  FOURCODE_NODE_TS: 'flag',
})
// La misma salida por las dos vías: si el flag cambiara el comportamiento del
// producto, la compatibilidad sería aparente y no real.
check('las dos vías dan la misma salida', salidaNativa === salidaConFlag, {
  nativa: salidaNativa.length,
  conFlag: salidaConFlag.length,
})

/**
 * Y la tercera vía: el Node que no puede. Es la única que ve un usuario nuevo con una
 * máquina vieja, así que tiene que decir qué pasa y por dónde salir — y decirlo por
 * **stderr**, porque por aquí arranca también el servidor MCP y su stdout solo admite
 * mensajes de protocolo.
 */
const viejo = spawnSync(process.execPath, [join(RAIZ, 'launch.mjs'), 'server/src/board.ts', 'list'], {
  env: { ...process.env, FOURCODE_NODE_TS: 'viejo' },
  encoding: 'utf8',
})
check('con un Node demasiado viejo, no arranca', viejo.status === 1, viejo.status)
check('dice la versión que hace falta', /22\.6/.test(viejo.stderr ?? ''))
check('y de dónde sacarla', /nodejs\.org/.test(viejo.stderr ?? ''))
check('sin ensuciar stdout', (viejo.stdout ?? '') === '', (viejo.stdout ?? '').slice(0, 80))

console.log(`\n${fallos === 0 ? 'TODO CORRECTO' : `${fallos} COMPROBACIONES FALLIDAS`}\n`)
process.exit(fallos === 0 ? 0 : 1)
