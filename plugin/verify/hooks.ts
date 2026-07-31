/**
 * Verificación de los hooks.
 *
 * La primera sección es BLOQUEANTE: los hooks reciben el contenido literal de
 * cada edición, de cada fichero leído y de cada comando de shell, y el contrato
 * de datos (§2.2) promete que eso no sale de la máquina. Si una sola de esas
 * comprobaciones falla, el tramo no entra — da igual lo bien que funcione el
 * resto.
 *
 *   node verify/hooks.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeArgs } from '../node-ts.mjs'

import { toEvent } from '../hooks/capture.ts'
import { deriveLayer, layerOfPath } from '../shared/layer.ts'
import type { SessionEvent } from '../shared/session.ts'
import { detectProject } from '../server/src/project.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CANVAS = resolve(HERE, '../server/src/canvas-server.ts')
const CAPTURE = resolve(HERE, '../hooks/capture.ts')

const HOME = mkdtempSync(join(tmpdir(), '4code-hooks-'))
const PORT = 41998
const TOKEN = 'token-de-prueba'
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = process.platform === 'win32' ? 'F:/proyecto' : '/proyecto'

let fallos = 0
function check(nombre: string, ok: boolean, detalle: unknown = '') {
  if (!ok) fallos++
  console.log(`  ${ok ? 'OK   ' : 'FALLO'} ${nombre}${detalle !== '' ? `  → ${JSON.stringify(detalle)}` : ''}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── 1. Contrato de datos — BLOQUEANTE ───────────────────────────────────────

console.log('\n1. Contrato de datos: ningún contenido puede sobrevivir al filtro')

/** Centinelas: si alguna aparece en la salida, se está filtrando contenido. */
const SECRETO_EDIT = 'CONTENIDO-SECRETO-DE-UNA-EDICION-9f2a'
const SECRETO_WRITE = 'CONTENIDO-SECRETO-DE-UN-FICHERO-3c1b'
const SECRETO_BASH = 'curl https://interno.example.com/token?k=SECRETO-7d4e'
const SECRETO_PROMPT = 'PROMPT-PRIVADO-DEL-USUARIO-5a8c'

const casos = [
  {
    nombre: 'Edit (old_string / new_string)',
    payload: {
      session_id: 'ses-1',
      hook_event_name: 'PostToolUse',
      permission_mode: 'default',
      tool_name: 'Edit',
      tool_input: {
        file_path: `${ROOT}/src/auth/login.ts`,
        old_string: `viejo ${SECRETO_EDIT}`,
        new_string: `nuevo ${SECRETO_EDIT}`,
      },
      tool_output: `resultado con ${SECRETO_EDIT}`,
    },
    secreto: SECRETO_EDIT,
  },
  {
    nombre: 'Write (content)',
    payload: {
      session_id: 'ses-1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: `${ROOT}/src/config.ts`, content: SECRETO_WRITE },
    },
    secreto: SECRETO_WRITE,
  },
  {
    nombre: 'Bash (command)',
    payload: {
      session_id: 'ses-1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: SECRETO_BASH, description: 'algo' },
    },
    secreto: 'SECRETO-7d4e',
  },
  {
    nombre: 'Read (tool_output con el fichero entero)',
    payload: {
      session_id: 'ses-1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: `${ROOT}/.env` },
      tool_output: `DATABASE_URL=${SECRETO_WRITE}`,
    },
    secreto: SECRETO_WRITE,
  },
]

for (const caso of casos) {
  const evento = toEvent(caso.payload, ROOT, Date.now())
  const serializado = JSON.stringify(evento)
  check(`${caso.nombre}: el secreto NO aparece`, !serializado.includes(caso.secreto), serializado)
}

const promptEvento = toEvent(
  {
    session_id: 'ses-1',
    hook_event_name: 'UserPromptSubmit',
    user_input: SECRETO_PROMPT,
  } as never,
  ROOT,
  Date.now(),
)
check('UserPromptSubmit se ignora por completo', promptEvento === null, promptEvento)

console.log('\n2. Rutas')
const dentro = toEvent(
  {
    session_id: 'ses-1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: `${ROOT}/src/auth/login.ts` },
  },
  ROOT,
  Date.now(),
)
check('la ruta se guarda relativa', dentro?.path === 'src/auth/login.ts', dentro?.path)
check('no aparece la ruta absoluta', !JSON.stringify(dentro).includes(ROOT), dentro?.path)
check('se extrae la extensión', dentro?.ext === 'ts', dentro?.ext)

const fuera = toEvent(
  {
    session_id: 'ses-1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: process.platform === 'win32' ? 'C:/Clientes/AcmeCorp/x.ts' : '/clientes/acme/x.ts' },
  },
  ROOT,
  Date.now(),
)
check('una ruta de fuera del proyecto se descarta', fuera?.path === undefined, fuera?.path)

// ── 3. Capa de trabajo (§4.3) ───────────────────────────────────────────────

console.log('\n3. Capa de trabajo')
check('un .test.tsx es tests, no UI', layerOfPath('src/components/Button.test.tsx') === 'tests')
check('un workflow de CI es infra, no docs', layerOfPath('.github/workflows/ci.yml') === 'infra')
check('un .css es UI', layerOfPath('src/styles.css') === 'ui')
check('un .md es docs', layerOfPath('README.md') === 'docs')
check('un .ts suelto es código', layerOfPath('src/server.ts') === 'code')

const ahora = Date.now()
const ev = (over: Partial<SessionEvent>): SessionEvent => ({
  at: ahora,
  sessionId: 's',
  kind: 'tool',
  tool: 'Edit',
  ...over,
})

check(
  'plan mode manda: es planificación',
  deriveLayer([ev({ mode: 'plan' }), ev({ mode: 'plan' }), ev({ path: 'src/a.ts' })], ahora) === 'planning',
)
check(
  'mayoría de ficheros de UI → ui',
  deriveLayer([ev({ path: 'src/styles.css' }), ev({ path: 'src/components/A.tsx' }), ev({ path: 'src/x.ts' })], ahora) === 'ui',
)
check(
  'solo lecturas → explorando',
  deriveLayer([ev({ tool: 'Read', path: 'src/a.ts' }), ev({ tool: 'Grep', path: 'src/b.ts' })], ahora) === 'exploring',
)
check(
  'mezcla sin dominante → sin determinar',
  deriveLayer(
    [ev({ path: 'src/a.ts' }), ev({ path: 'src/styles.css' }), ev({ path: 'README.md' }), ev({ path: 'Dockerfile' })],
    ahora,
  ) === 'unknown',
)
check('sin eventos → sin determinar', deriveLayer([], ahora) === 'unknown')

// ── 4. De extremo a extremo: hook → disco → servidor ────────────────────────

console.log('\n4. Del hook al servidor')

function runHook(payload: unknown): void {
  spawnSync(process.execPath, nodeArgs(CAPTURE), {
    input: JSON.stringify(payload),
    env: { ...process.env, FOURCODE_HOME: HOME },
    encoding: 'utf8',
  })
}

// El mismo cálculo que hace el hook: sube a la raíz del repositorio, así que
// desde `plugin/` el proyecto sigue siendo el de la raíz.
const proyectoId = detectProject(process.cwd()).id

runHook({ session_id: 'e2e-1', hook_event_name: 'SessionStart', cwd: process.cwd(), source: 'startup', permission_mode: 'default' })
runHook({
  session_id: 'e2e-1',
  hook_event_name: 'PostToolUse',
  cwd: process.cwd(),
  tool_name: 'Write',
  tool_input: { file_path: join(process.cwd(), 'web/src/styles.css'), content: SECRETO_WRITE },
})
runHook({ session_id: 'e2e-1', hook_event_name: 'SubagentStart', cwd: process.cwd(), agent_type: 'Explore' })
runHook({ session_id: 'e2e-1', hook_event_name: 'SessionEnd', cwd: process.cwd(), reason: 'clear' })

const escrito = readFileSync(join(HOME, 'projects', proyectoId, 'sessions.jsonl'), 'utf8')
check('el hook escribió los 4 eventos', escrito.trim().split('\n').length === 4, escrito.trim().split('\n').length)
check('el fichero en disco NO contiene el contenido', !escrito.includes(SECRETO_WRITE))

const canvas: ChildProcess = spawn(process.execPath, nodeArgs(CANVAS), {
  env: { ...process.env, FOURCODE_HOME: HOME, FOURCODE_PORT: String(PORT), FOURCODE_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'ignore'],
})

let listo = false
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) })).ok) {
      listo = true
      break
    }
  } catch {
    /* todavía no */
  }
  await sleep(150)
}
check('el canvas-server arranca', listo)

if (listo) {
  const sesiones = (await (await fetch(`${BASE}/sessions?project=${proyectoId}`)).json()) as {
    sessionId: string
    layer: string
    files: string[]
    tools: Record<string, number>
    subagents: Record<string, number>
    endReason?: string
  }[]

  check('/sessions devuelve la sesión', sesiones.length === 1, sesiones.length)
  const s = sesiones[0]
  check('con su id', s?.sessionId === 'e2e-1', s?.sessionId)
  // Relativa a la RAÍZ del repositorio, que es el proyecto — no al cwd desde el
  // que se lanzó el hook. Se calcula igual que lo hace el hook en vez de
  // escribirla a mano, para que renombrar este directorio no rompa la prueba.
  const esperado = relative(detectProject(process.cwd()).root, join(process.cwd(), 'web/src/styles.css')).replace(
    /\\/g,
    '/',
  )
  check(`con el fichero tocado (${esperado})`, s?.files.includes(esperado), s?.files)
  check('con la herramienta contada', s?.tools.Write === 1, s?.tools)
  check('con el subagente', s?.subagents.Explore === 1, s?.subagents)
  check('con el motivo de cierre', s?.endReason === 'clear', s?.endReason)
  check('y la capa derivada del .css → ui', s?.layer === 'ui', s?.layer)
  check('la respuesta HTTP no filtra contenido', !JSON.stringify(sesiones).includes(SECRETO_WRITE))
}

canvas.kill('SIGTERM')
await sleep(500)
rmSync(HOME, { recursive: true, force: true })

console.log(`\n${fallos === 0 ? 'TODO CORRECTO' : `${fallos} COMPROBACIONES FALLIDAS`}\n`)
process.exit(fallos === 0 ? 0 : 1)
