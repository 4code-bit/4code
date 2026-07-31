/**
 * VERIFICACIÓN BLOQUEANTE #1 del plan.
 *
 * `constraints` y `customOrder` están mergeados y publicados en @dagrejs/dagre
 * pero NO documentados en el README — solo aparecen en lib/types.ts. Toda la
 * estabilidad visual del diagrama depende de ellos, así que hay que ejecutarlos
 * antes de arquitecturar nada encima.
 *
 * Pregunta concreta: cuando el agente añade nodos a un grafo ya dibujado,
 * ¿podemos evitar que dagre reordene los nodos existentes?
 *
 * MEDICIÓN CORRECTA: comparar el orden RELATIVO de los nodos supervivientes
 * dentro de cada rank. Comparar listas completas es erróneo, porque añadir una
 * arista puede cambiar legítimamente el rank de un nodo (la topología cambió)
 * y eso no es "inestabilidad", es el grafo siendo distinto.
 *
 *   node verify/dagre-stability.ts
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EdgeLabel, GraphLabel, NodeLabel, OrderConstraint } from '@dagrejs/dagre'

/**
 * dagre es dependencia de la web, no del servidor, así que vive en
 * `web/node_modules` y un `import` normal desde aquí no lo encuentra. Se resuelve
 * explícitamente desde allí en vez de duplicar la dependencia: el layout que se
 * verifica tiene que ser exactamente la versión que dibuja el tablero.
 */
const require = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), '../web/package.json'),
)
const { Graph, layout } = require('@dagrejs/dagre') as typeof import('@dagrejs/dagre')

type G = Graph<GraphLabel, NodeLabel, EdgeLabel>
type Placement = Map<string, { rank: number; x: number }>

const NODE = { width: 140, height: 44 }

function build(nodes: string[], edges: [string, string][]): G {
  const g = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ directed: true })
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n, { ...NODE })
  for (const [v, w] of edges) g.setEdge(v, w)
  return g
}

function place(g: G): Placement {
  const p: Placement = new Map()
  for (const id of g.nodes()) {
    const n = g.node(id)
    if (n.rank === undefined || n.x === undefined) continue
    p.set(id, { rank: n.rank, x: n.x })
  }
  return p
}

function byRank(p: Placement): Map<number, string[]> {
  const m = new Map<number, { id: string; x: number }[]>()
  for (const [id, { rank, x }] of p) {
    if (!m.has(rank)) m.set(rank, [])
    m.get(rank)!.push({ id, x })
  }
  return new Map(
    [...m].map(([r, items]) => [r, items.sort((a, b) => a.x - b.x).map((i) => i.id)]),
  )
}

function show(label: string, p: Placement) {
  const ranks = byRank(p)
  console.log(`  ${label}`)
  for (const r of [...ranks.keys()].sort((a, b) => a - b)) {
    console.log(`    rank ${r}: ${ranks.get(r)!.join('  ')}`)
  }
}

/**
 * Cuenta inversiones de orden entre pares de nodos que (a) existían antes,
 * (b) siguen existiendo, y (c) siguen compartiendo rank entre sí.
 * 0 inversiones = el humano no ve saltar nada.
 */
function inversions(before: Placement, after: Placement): { swaps: number; pairs: number } {
  const shared = [...before.keys()].filter((id) => after.has(id))
  let swaps = 0
  let pairs = 0
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      const a = shared[i]
      const b = shared[j]
      const beforeSameRank = before.get(a)!.rank === before.get(b)!.rank
      const afterSameRank = after.get(a)!.rank === after.get(b)!.rank
      if (!beforeSameRank || !afterSameRank) continue
      pairs++
      const wasLeft = before.get(a)!.x < before.get(b)!.x
      const isLeft = after.get(a)!.x < after.get(b)!.x
      if (wasLeft !== isLeft) swaps++
    }
  }
  return { swaps, pairs }
}

/** Deriva constraints left/right del orden que ya teníamos persistido. */
function constraintsFrom(before: Placement, alive: Set<string>): OrderConstraint[] {
  const cs: OrderConstraint[] = []
  for (const ids of byRank(before).values()) {
    const kept = ids.filter((id) => alive.has(id))
    for (let i = 0; i < kept.length - 1; i++) cs.push({ left: kept[i], right: kept[i + 1] })
  }
  return cs
}

function report(name: string, before: Placement, after: Placement) {
  const { swaps, pairs } = inversions(before, after)
  const verdict = pairs === 0 ? 'sin pares comparables' : swaps === 0 ? 'ESTABLE' : `${swaps}/${pairs} pares invertidos`
  console.log(`  → ${name}: ${verdict}`)
  return swaps
}

// ── Grafo base ──────────────────────────────────────────────────────────────
const NODES = ['api', 'auth', 'db', 'cache', 'queue', 'worker', 'mailer', 'log']
const EDGES: [string, string][] = [
  ['api', 'auth'],
  ['api', 'db'],
  ['api', 'cache'],
  ['api', 'queue'],
  ['api', 'mailer'],
  ['api', 'log'],
  ['auth', 'db'],
  ['queue', 'worker'],
]

console.log('\n=== Layout de referencia ===================================')
const first = build(NODES, EDGES)
layout(first)
const baseline = place(first)
show('referencia', baseline)

// ── Caso A: nodos hoja nuevos (NO alteran el rank de nadie) ─────────────────
console.log('\n=== CASO A: el agente añade 3 nodos hoja ===================')
const aNodes = [...NODES, 'metrics', 'tracing', 'config']
const aEdges: [string, string][] = [
  ...EDGES,
  ['api', 'metrics'],
  ['api', 'tracing'],
  ['api', 'config'],
]

const aNaive = build(aNodes, aEdges)
layout(aNaive)
const aNaivePlace = place(aNaive)
show('sin constraints', aNaivePlace)
const aNaiveSwaps = report('control', baseline, aNaivePlace)

const aConstraints = constraintsFrom(baseline, new Set(aNodes))
const aStable = build(aNodes, aEdges)
layout(aStable, { constraints: aConstraints })
const aStablePlace = place(aStable)
show(`con ${aConstraints.length} constraints`, aStablePlace)
const aStableSwaps = report('constraints', baseline, aStablePlace)

// ── Caso B: crecimiento que sí cambia ranks ────────────────────────────────
console.log('\n=== CASO B: nodo intermedio que reordena la topología ======')
const bNodes = [...NODES, 'gateway']
const bEdges: [string, string][] = [...EDGES, ['api', 'gateway'], ['gateway', 'queue']]

const bNaive = build(bNodes, bEdges)
layout(bNaive)
const bNaivePlace = place(bNaive)
show('sin constraints', bNaivePlace)
const bNaiveSwaps = report('control', baseline, bNaivePlace)

const bConstraints = constraintsFrom(baseline, new Set(bNodes))
const bStable = build(bNodes, bEdges)
layout(bStable, { constraints: bConstraints })
const bStablePlace = place(bStable)
show(`con ${bConstraints.length} constraints`, bStablePlace)
const bStableSwaps = report('constraints', baseline, bStablePlace)

// ── Caso C: 20 adiciones sucesivas, arrastrando el orden cada vez ───────────
console.log('\n=== CASO C: 20 adiciones sucesivas (deriva acumulada) ======')
let curNodes = [...NODES]
let curEdges: [string, string][] = [...EDGES]
let prev = baseline
let totalNaive = 0
let totalStable = 0

for (let i = 0; i < 20; i++) {
  const id = `svc${i}`
  const parent = curNodes[i % curNodes.length]
  const nextNodes = [...curNodes, id]
  const nextEdges: [string, string][] = [...curEdges, [parent, id]]

  const naive = build(nextNodes, nextEdges)
  layout(naive)
  totalNaive += inversions(prev, place(naive)).swaps

  const g = build(nextNodes, nextEdges)
  layout(g, { constraints: constraintsFrom(prev, new Set(nextNodes)) })
  const p = place(g)
  totalStable += inversions(prev, p).swaps

  curNodes = nextNodes
  curEdges = nextEdges
  prev = p
}
console.log(`  → control    : ${totalNaive} inversiones acumuladas en 20 pasos`)
console.log(`  → constraints: ${totalStable} inversiones acumuladas en 20 pasos`)

// ── Determinismo ───────────────────────────────────────────────────────────
console.log('\n=== Determinismo ===========================================')
const runs = new Set<string>()
for (let i = 0; i < 10; i++) {
  const g = build(aNodes, aEdges)
  layout(g, { constraints: aConstraints })
  runs.add(JSON.stringify([...byRank(place(g))]))
}
console.log(`  10 ejecuciones idénticas → ${runs.size} resultado(s) distinto(s)`)

console.log('\n=== VEREDICTO ==============================================')
console.log(`  Caso A (hojas)      control ${aNaiveSwaps} vs constraints ${aStableSwaps}`)
console.log(`  Caso B (topología)  control ${bNaiveSwaps} vs constraints ${bStableSwaps}`)
console.log(`  Caso C (20 pasos)   control ${totalNaive} vs constraints ${totalStable}`)
console.log(`  Determinista        ${runs.size === 1 ? 'SÍ' : 'NO'}`)
const useful = totalStable < totalNaive || aStableSwaps < aNaiveSwaps || bStableSwaps < bNaiveSwaps
console.log(`\n  ¿constraints aporta algo? ${useful ? 'SÍ' : 'NO — buscar plan B'}`)
console.log()
