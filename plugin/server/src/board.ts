/**
 * Gestión de tableros desde la terminal.
 *
 *   node server/src/board.ts list
 *   node server/src/board.ts export <id> [salida.json]
 *   node server/src/board.ts import <fichero.json> --into <id> --apply
 *   node server/src/board.ts reset  <id> --apply
 *   node server/src/board.ts move   <origen> <destino> --apply
 *   node server/src/board.ts split  <id> --apply
 *
 * Todo lo que destruye o mueve **simula por defecto**: son datos que no están
 * respaldados en ningún sitio (la nube es Fase 1), así que un `--apply` de más
 * no puede costarte un tablero.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { DiagramEdge, DiagramNode } from '../../shared/diagram.ts'
import type { ProjectRef } from '../../shared/project.ts'
import { PROJECTS_DIR } from './paths.ts'
import { detectProject } from './project.ts'

const argv = process.argv.slice(2)
const comando = argv[0]
const aplicar = argv.includes('--apply')
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const posicionales = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))

interface BoardFile {
  version: 1
  project: ProjectRef
  seq: number
  savedAt: number
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

const dirOf = (id: string) => join(PROJECTS_DIR, id)
const snapshotOf = (id: string) => join(dirOf(id), 'diagram.json')

function leerTablero(id: string): BoardFile | null {
  try {
    return JSON.parse(readFileSync(snapshotOf(id), 'utf8')) as BoardFile
  } catch {
    return null
  }
}

function leerProyecto(id: string): ProjectRef | null {
  try {
    return JSON.parse(readFileSync(join(dirOf(id), 'project.json'), 'utf8')) as ProjectRef
  } catch {
    return null
  }
}

function escribirTablero(id: string, project: ProjectRef, nodes: DiagramNode[], edges: DiagramEdge[]): void {
  const dir = dirOf(id)
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2), 'utf8')
  writeFileSync(
    snapshotOf(id),
    JSON.stringify({ version: 1, project, seq: nodes.length + edges.length, savedAt: Date.now(), nodes, edges }),
    'utf8',
  )

  // El historial se rehace como una secuencia de altas. La cronología original
  // no se puede repartir con sentido — una operación pertenece al tablero donde
  // ocurrió — así que el tablero de origen se queda con ella y no se toca.
  const at = Date.now()
  const historial = [
    ...nodes.map((node, i) => ({ seq: i + 1, at, operation: { op: 'add_node', node } })),
    ...edges.map((edge, i) => ({ seq: nodes.length + i + 1, at, operation: { op: 'add_edge', edge } })),
  ]
  writeFileSync(join(dir, 'history.jsonl'), `${historial.map((h) => JSON.stringify(h)).join('\n')}\n`, 'utf8')
}

function listar(): void {
  if (!existsSync(PROJECTS_DIR)) {
    console.log('No hay tableros todavía.')
    return
  }
  console.log('')
  for (const id of readdirSync(PROJECTS_DIR)) {
    // Los directorios apartados por migraciones o vaciados no son tableros
    // vivos; enseñarlos solo confunde.
    if (/\.(migrado|vaciado-\d+|movido-\d+)$/.test(id)) continue
    const p = leerProyecto(id)
    const b = leerTablero(id)
    const sesiones = existsSync(join(dirOf(id), 'sessions.jsonl'))
      ? readFileSync(join(dirOf(id), 'sessions.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length
      : 0

    console.log(`  ${p?.name ?? id}`)
    console.log(`    id        ${id}`)
    console.log(`    ruta      ${p?.root ?? '?'}`)
    console.log(`    remoto    ${p?.remote ?? '— (sin remoto: este tablero NO es compartible)'}`)
    console.log(`    tablero   ${b ? `${b.nodes.length} nodos, ${b.edges.length} aristas` : 'vacío'}`)
    console.log(`    sesiones  ${sesiones} eventos`)
    console.log('')
  }
}

function exportar(id: string, salida?: string): void {
  const b = leerTablero(id)
  if (!b) {
    console.error(`El tablero "${id}" no existe o está vacío.`)
    process.exit(1)
  }
  const destino = salida ?? `4code-${id}-${new Date(b.savedAt).toISOString().slice(0, 10)}.json`
  writeFileSync(destino, JSON.stringify(b, null, 2), 'utf8')
  console.log(`Exportado a ${destino}`)
  console.log(`  ${b.nodes.length} nodos, ${b.edges.length} aristas`)
  console.log(`\n  Guárdalo en sitio seguro: hoy no hay copia de seguridad de esto en ningún lado.`)
}

function importar(fichero: string, destino: string | undefined): void {
  const b = JSON.parse(readFileSync(fichero, 'utf8')) as BoardFile
  const id = destino ?? b.project?.id
  if (!id) {
    console.error('No sé a qué tablero importar. Usa --into <id>.')
    process.exit(1)
  }

  const existente = leerTablero(id)
  console.log(`\nImportar ${b.nodes.length} nodos y ${b.edges.length} aristas → ${id}`)
  if (existente) console.log(`  ATENCIÓN: sustituye el tablero actual (${existente.nodes.length} nodos)`)
  if (!aplicar) {
    console.log('\n  Simulación. Añade --apply para hacerlo.\n')
    return
  }

  const project = leerProyecto(id) ?? b.project
  escribirTablero(id, { ...project, id }, b.nodes, b.edges)
  console.log('  Hecho.\n')
}

function reset(id: string): void {
  const b = leerTablero(id)
  if (!b) {
    console.log(`El tablero "${id}" ya está vacío.`)
    return
  }
  console.log(`\nVaciar ${id}: ${b.nodes.length} nodos y ${b.edges.length} aristas`)
  console.log('  Las sesiones capturadas por hooks NO se tocan.')

  if (!aplicar) {
    console.log('\n  Simulación. Añade --apply para hacerlo.')
    console.log(`  Antes, considera: node server/src/board.ts export ${id}\n`)
    return
  }

  // Se aparta en vez de borrarse: rehacer el tablero cuesta tokens y un
  // arrepentimiento a los cinco minutos no debería ser irreversible.
  const marca = Date.now()
  for (const f of ['diagram.json', 'history.jsonl']) {
    const p = join(dirOf(id), f)
    if (existsSync(p)) renameSync(p, `${p}.vaciado-${marca}`)
  }
  console.log(`  Hecho. Lo anterior queda como *.vaciado-${marca} por si acaso.\n`)
}

function mover(origen: string, destino: string): void {
  const b = leerTablero(origen)
  if (!b) {
    console.error(`El tablero "${origen}" no existe o está vacío.`)
    process.exit(1)
  }
  const pDestino = leerProyecto(destino)
  console.log(`\nMover ${b.nodes.length} nodos: ${origen} → ${destino}`)
  if (!pDestino) console.log(`  El destino no existe todavía; se creará.`)
  if (leerTablero(destino)) console.log(`  ATENCIÓN: el destino ya tiene tablero y se sustituye.`)

  if (!aplicar) {
    console.log('\n  Simulación. Añade --apply para hacerlo.\n')
    return
  }

  // `b.project` sale del snapshot, que puede llevar meses ahí y conservar datos
  // de antes de cualquier migración. El project.json es lo último que se supo.
  //
  // El remoto no se hereda: un id distinto significa un repositorio distinto, y
  // arrastrar el del origen escribiría un dato falso. Se deja vacío y lo rellena
  // el canvas-server la próxima vez que abra el proyecto, ya derivado de git.
  const base = leerProyecto(origen) ?? b.project
  const { remote: _delOrigen, ...sinRemoto } = base
  escribirTablero(destino, { ...(pDestino ?? sinRemoto), id: destino }, b.nodes, b.edges)
  const marca = Date.now()
  for (const f of ['diagram.json', 'history.jsonl']) {
    const p = join(dirOf(origen), f)
    if (existsSync(p)) renameSync(p, `${p}.movido-${marca}`)
  }
  console.log(`  Hecho. El origen conserva su historial como *.movido-${marca}.\n`)
}

/**
 * Reparte un tablero entre los repositorios que contiene.
 *
 * Un directorio paraguas con varios repos dentro produce un tablero que abarca
 * el sistema entero. Es el más útil para entenderlo, pero no es compartible: no
 * hay un remoto único que lo identifique.
 *
 * Al partirlo, las conexiones que cruzaban de un repo a otro se convierten en
 * nodos `external` en cada lado — que es exactamente para lo que existe ese
 * tipo. Así el tablero del frontend sigue diciendo "aquí hablo con el backend"
 * sin arrastrarlo entero. Con `--sin-externos` se hace el corte limpio.
 */
function split(id: string): void {
  const b = leerTablero(id)
  const proyecto = leerProyecto(id)
  if (!b || !proyecto) {
    console.error(`El tablero "${id}" no existe o está vacío.`)
    process.exit(1)
  }

  const conExternos = !argv.includes('--sin-externos')

  // Primer segmento de la ruta = subdirectorio = candidato a repo.
  const grupoDe = new Map<string, string>()
  for (const n of b.nodes) {
    if (n.path) grupoDe.set(n.id, n.path.replace(/\\/g, '/').split('/')[0]!)
  }

  /** Los nodos sin ruta van donde tengan más conexiones; si empatan, a los dos. */
  const sinRuta = b.nodes.filter((n) => !n.path)
  for (const n of sinRuta) {
    const votos = new Map<string, number>()
    for (const e of b.edges) {
      const otro = e.source === n.id ? e.target : e.target === n.id ? e.source : null
      if (!otro) continue
      const g = grupoDe.get(otro)
      if (g) votos.set(g, (votos.get(g) ?? 0) + 1)
    }
    const orden = [...votos.entries()].sort((a, c) => c[1] - a[1])
    if (orden.length === 1 || (orden.length > 1 && orden[0]![1] > orden[1]![1])) {
      grupoDe.set(n.id, orden[0]![0])
    }
    // Sin ganador claro se queda sin grupo y acaba duplicado en todos.
  }

  const grupos = [...new Set([...grupoDe.values()])].filter((g) => existsSync(join(proyecto.root, g)))
  if (grupos.length < 2) {
    console.error(`\nNo veo varios repositorios dentro de ${proyecto.root}. Nada que partir.\n`)
    process.exit(1)
  }

  console.log(`\nPartir "${proyecto.name}" (${b.nodes.length} nodos, ${b.edges.length} aristas)`)
  console.log(`  El original NO se toca: esto crea tableros nuevos.\n`)

  const huerfanos = b.nodes.filter((n) => !grupoDe.has(n.id))
  const planes: { grupo: string; destino: ProjectRef; nodes: DiagramNode[]; edges: DiagramEdge[]; externos: number }[] = []

  for (const grupo of grupos) {
    const destino = detectProject(join(proyecto.root, grupo))
    const propios = new Set(b.nodes.filter((n) => grupoDe.get(n.id) === grupo).map((n) => n.id))
    for (const h of huerfanos) propios.add(h.id) // sin grupo claro → a todos

    const nodes: DiagramNode[] = b.nodes
      .filter((n) => propios.has(n.id))
      .map((n) => ({
        ...n,
        // Las rutas pasan a ser relativas al repo, no al directorio paraguas.
        ...(n.path && { path: n.path.replace(/\\/g, '/').replace(new RegExp(`^${grupo}/?`), '') || n.path }),
      }))

    const edges: DiagramEdge[] = []
    const externos = new Map<string, DiagramNode>()

    for (const e of b.edges) {
      const dentroA = propios.has(e.source)
      const dentroB = propios.has(e.target)
      if (dentroA && dentroB) {
        edges.push(e)
        continue
      }
      if (!conExternos || (!dentroA && !dentroB)) continue

      // Cruza la frontera: el extremo de fuera entra como dependencia externa.
      const fuera = b.nodes.find((n) => n.id === (dentroA ? e.target : e.source))
      if (!fuera) continue
      externos.set(fuera.id, {
        id: fuera.id,
        kind: 'external',
        label: fuera.label,
        detail: `Vive en ${grupoDe.get(fuera.id) ?? 'otro repositorio'}. ${fuera.detail ?? ''}`.trim(),
      })
      edges.push(e)
    }

    planes.push({ grupo, destino, nodes: [...nodes, ...externos.values()], edges, externos: externos.size })
  }

  for (const plan of planes) {
    console.log(`  → ${plan.grupo}  →  ${plan.destino.id}`)
    console.log(`     ${plan.destino.remote ?? 'SIN REMOTO — seguirá sin ser compartible'}`)
    console.log(`     ${plan.nodes.length - plan.externos} nodos propios${plan.externos ? ` + ${plan.externos} externos` : ''}, ${plan.edges.length} aristas`)
    if (leerTablero(plan.destino.id)) console.log(`     ATENCIÓN: ese tablero ya existe y se sustituye`)
  }
  if (huerfanos.length) {
    console.log(`\n  ${huerfanos.length} nodo(s) sin repo claro se duplican en todos: ${huerfanos.map((n) => n.label).join(', ')}`)
  }

  if (!aplicar) {
    console.log('\n  Simulación. Añade --apply para hacerlo.\n')
    return
  }

  for (const plan of planes) {
    escribirTablero(plan.destino.id, plan.destino, plan.nodes, plan.edges)
    console.log(`  ${plan.destino.id} creado.`)
  }
  console.log(`\n  Hecho. "${proyecto.name}" sigue intacto por si quieres volver.\n`)
}

switch (comando) {
  case 'list':
    listar()
    break
  case 'export':
    exportar(posicionales[0]!, posicionales[1])
    break
  case 'import':
    importar(posicionales[0]!, flag('into'))
    break
  case 'reset':
    reset(posicionales[0]!)
    break
  case 'move':
    mover(posicionales[0]!, posicionales[1]!)
    break
  case 'split':
    split(posicionales[0]!)
    break
  default:
    console.log(`
Gestión de tableros de 4Code.

  list                        Todos los tableros, con si son compartibles o no
  export <id> [fichero]       Saca el tablero a JSON (y te sirve de copia)
  import <f.json> --into <id> Mete un tablero exportado
  reset  <id>                 Vacía el tablero para volver a mapear
  move   <origen> <destino>   Lleva un tablero a otro proyecto
  split  <id>                 Reparte un tablero entre los repos que contiene

Lo que destruye o mueve simula por defecto. Añade --apply para hacerlo de verdad.
En split, --sin-externos hace el corte limpio sin conservar las conexiones cruzadas.

Estos comandos escriben en disco por debajo del canvas-server, que mantiene los
tableros abiertos en memoria. Reinícialo después de tocar algo o seguirás viendo
el estado anterior.
`)
}
