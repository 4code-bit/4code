/**
 * Verificación de la lectura de sesiones.
 *
 * El `sessions.jsonl` es append-only y se relee cada pocos segundos mientras se
 * mira la vista, así que solo se lee la cola nueva. Eso introduce **un** modo de
 * fallo que la relectura completa no podía tener: si una lectura pilla a un hook
 * a mitad de un append, los bytes que quedan tras el último salto de línea hay
 * que guardarlos para pegarles su continuación, o ese evento desaparece para
 * siempre del array cacheado.
 *
 * De ahí la forma de estas comprobaciones: la aserción central es de **igualdad**
 * —leer incremental tiene que dar exactamente lo mismo que releer de cero— y el
 * resto son los casos límite de esa costura.
 *
 * Va en un fichero propio porque necesita que `FOURCODE_HOME` apunte a un
 * directorio desechable ANTES de que `paths.ts` se evalúe, y ese módulo lee el
 * entorno al importarse.
 *
 *   node verify/sessions.ts
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeArgs } from '../node-ts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE = resolve(HERE, '../hooks/capture.ts')

const HOME = mkdtempSync(join(tmpdir(), '4code-sessions-'))
process.env.FOURCODE_HOME = HOME

// Después de fijar el entorno: `paths.ts` lo lee al cargarse, y de ahí sale el
// directorio del que estos módulos leen.
const { forgetCachedEvents, readEvents, summarize } = await import('../server/src/sessions.ts')
const { detectProject } = await import('../server/src/project.ts')

let fallos = 0
function check(nombre: string, ok: boolean, detalle: unknown = '') {
  if (!ok) fallos++
  console.log(`  ${ok ? 'OK   ' : 'FALLO'} ${nombre}${detalle !== '' ? `  → ${JSON.stringify(detalle)}` : ''}`)
}

const proyecto = detectProject(process.cwd())
const dir = join(HOME, 'projects', proyecto.id)
const file = join(dir, 'sessions.jsonl')
mkdirSync(dir, { recursive: true })

/** Una línea como la que escribe el hook, para no depender de lanzarlo siempre. */
const linea = (n: number, sessionId = 'ses-1') =>
  `${JSON.stringify({ at: 1_700_000_000_000 + n, sessionId, kind: 'tool', tool: 'Read', path: `src/f${n}.ts`, ext: 'ts' })}\n`

/** Lo mismo que hace `readEvents`, pero de cero: la referencia a batir. */
function releerDeCero(): ReturnType<typeof readEvents> {
  forgetCachedEvents(proyecto.id)
  return readEvents(proyecto.id)
}

// ── 1. Igualdad con la relectura completa — LO QUE IMPORTA ──────────────────

console.log('\n1. Leer la cola da lo mismo que releer el fichero')

writeFileSync(file, Array.from({ length: 500 }, (_, i) => linea(i)).join(''), 'utf8')

const base = readEvents(proyecto.id)
check('lee el fichero inicial', base.length === 500, base.length)

appendFileSync(file, linea(500), 'utf8')
const incremental = readEvents(proyecto.id)
check('el append entra sin releerlo todo', incremental.length === 501, incremental.length)
check(
  'y el resultado es idéntico a releer de cero',
  JSON.stringify(incremental) === JSON.stringify(releerDeCero()),
)

// Diez appends seguidos, que es el caso real: un evento cada pocos segundos.
for (let i = 0; i < 10; i++) appendFileSync(file, linea(600 + i), 'utf8')
const trasVarios = readEvents(proyecto.id)
check('diez appends seguidos', trasVarios.length === 511, trasVarios.length)
check('siguen coincidiendo', JSON.stringify(trasVarios) === JSON.stringify(releerDeCero()))

// ── 2. La costura: una línea partida ────────────────────────────────────────

console.log('\n2. Una escritura pillada a medias no pierde el evento')

readEvents(proyecto.id) // deja la caché al día antes de partir la línea

const entera = linea(700, 'partida')
const corte = Math.floor(entera.length / 2)
appendFileSync(file, entera.slice(0, corte), 'utf8')

const conParcial = readEvents(proyecto.id)
check('la línea sin terminar no se cuenta todavía', conParcial.length === 511, conParcial.length)

appendFileSync(file, entera.slice(corte), 'utf8')
const completada = readEvents(proyecto.id)
check('al completarse entra', completada.length === 512, completada.length)
check(
  'y entra UNA vez, no dos',
  completada.filter((e) => e.sessionId === 'partida').length === 1,
  completada.filter((e) => e.sessionId === 'partida').length,
)
check('sin perder ningún campo', completada.at(-1)?.path === 'src/f700.ts', completada.at(-1))
check('y coincide con releer de cero', JSON.stringify(completada) === JSON.stringify(releerDeCero()))

/**
 * El corte a mitad de un carácter multibyte.
 *
 * Un `path` con acentos ocupa más bytes que caracteres, así que partir por la
 * mitad puede dejar media secuencia UTF-8 en el fragmento. Si se decodificara
 * cada trozo por separado, aparecería un carácter de reemplazo y la ruta llegaría
 * corrupta: la reconstrucción tiene que juntar los BYTES, no los textos.
 */
readEvents(proyecto.id)
const conAcentos = `${JSON.stringify({ at: 1_700_000_009_999, sessionId: 'utf8', kind: 'tool', tool: 'Read', path: 'src/café/índice.ts', ext: 'ts' })}\n`
const bytes = Buffer.from(conAcentos, 'utf8')
const mitad = bytes.indexOf(Buffer.from('café', 'utf8')) + 4 // justo dentro de la é
appendFileSync(file, bytes.subarray(0, mitad))
readEvents(proyecto.id)
appendFileSync(file, bytes.subarray(mitad))

const utf8 = readEvents(proyecto.id)
const ruta = utf8.find((e) => e.sessionId === 'utf8')?.path
check('un corte dentro de un carácter multibyte no corrompe la ruta', ruta === 'src/café/índice.ts', ruta)
check('ni deja caracteres de reemplazo', !JSON.stringify(utf8).includes('�'))

// ── 3. Un fichero que encoge ────────────────────────────────────────────────

console.log('\n3. Un fichero truncado se relee de cero')

readEvents(proyecto.id)
writeFileSync(file, linea(1), 'utf8')
const trasTruncar = readEvents(proyecto.id)
check('la caché no intenta casar bytes que ya no están', trasTruncar.length === 1, trasTruncar.length)

// ── 4. Hooks reales en paralelo ─────────────────────────────────────────────

/**
 * Los hooks son procesos efímeros que hacen append sin cerrojo (§6, 28 jul), y
 * varios pueden estar vivos a la vez. Que la lectura incremental siga siendo
 * segura con ellos escribiendo es la propiedad que justifica no haber metido una
 * base de datos por medio.
 */
console.log('\n4. Doce hooks concurrentes, leyendo mientras escriben')

rmSync(file, { force: true })
forgetCachedEvents(proyecto.id)

const hooks = Array.from({ length: 12 }, (_, i) =>
  (async () => {
    spawnSync(process.execPath, nodeArgs(CAPTURE), {
      input: JSON.stringify({
        session_id: `rafaga-${i}`,
        hook_event_name: 'PostToolUse',
        cwd: process.cwd(),
        tool_name: 'Read',
        tool_input: { file_path: join(process.cwd(), `web/src/rafaga-${i}.ts`) },
      }),
      env: { ...process.env, FOURCODE_HOME: HOME },
      encoding: 'utf8',
    })
    // Leer mientras los demás escriben: es lo que hace la web cada tres segundos.
    readEvents(proyecto.id)
  })(),
)
await Promise.all(hooks)

const trasRafaga = readEvents(proyecto.id)
const enDisco = readFileSync(file, 'utf8').trim().split('\n').length
check('los doce eventos llegaron al disco', enDisco === 12, enDisco)
check('y la lectura incremental los ve todos', trasRafaga.length === 12, trasRafaga.length)
check('sin duplicar ninguno', new Set(trasRafaga.map((e) => e.sessionId)).size === 12)
check('igual que releyendo de cero', JSON.stringify(trasRafaga) === JSON.stringify(releerDeCero()))

// ── 5. Que la agregación siga viendo lo mismo ───────────────────────────────

console.log('\n5. El resumen por sesión no cambia')

writeFileSync(
  file,
  [linea(1, 'a'), linea(2, 'a'), linea(3, 'b')].join(''),
  'utf8',
)
forgetCachedEvents(proyecto.id)
const antes = summarize(readEvents(proyecto.id))
appendFileSync(file, linea(4, 'b'), 'utf8')
const despues = summarize(readEvents(proyecto.id))

check('dos sesiones antes y después', antes.length === 2 && despues.length === 2, {
  antes: antes.length,
  despues: despues.length,
})
check(
  'el resumen incremental es igual al recalculado',
  JSON.stringify(despues) === JSON.stringify(summarize(releerDeCero())),
)

rmSync(HOME, { recursive: true, force: true })

console.log(`\n${fallos === 0 ? 'TODO CORRECTO' : `${fallos} COMPROBACIONES FALLIDAS`}\n`)
process.exit(fallos === 0 ? 0 : 1)
