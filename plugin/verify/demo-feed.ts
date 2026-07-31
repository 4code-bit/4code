/**
 * Alimenta el canvas simulando una sesión de Claude, sin gastar un solo token.
 *
 * Dos usos:
 *  1. Probar el flujo completo (layout, animación, estados, reconexión).
 *  2. Grabar el GIF de la Fase 0. Si ese GIF no impresiona, el producto no existe.
 *
 *   node verify/demo-feed.ts          → ritmo normal
 *   node verify/demo-feed.ts --fast   → sin esperas
 */
import { readLock } from '../server/src/lockfile.ts'
import type { Operation } from '../shared/diagram.ts'

const fast = process.argv.includes('--fast')
const lock = readLock()
if (!lock) {
  console.error('No hay canvas-server vivo. Arráncalo con: npm run canvas')
  process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, fast ? 0 : ms))

/**
 * Proyecto propio para la demo. Va aparte a propósito: grabar el GIF no debe
 * ensuciar el tablero real de nadie, y así aparece como un proyecto más en el
 * selector, que es justo lo que queremos enseñar.
 */
const DEMO_PROJECT = {
  id: 'demo-00000000',
  name: 'demo',
  root: '/demo',
}

async function push(ops: Operation[], note: string) {
  const res = await fetch(`http://127.0.0.1:${lock!.port}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fourcode-token': lock!.token },
    body: JSON.stringify({ project: DEMO_PROJECT, operations: ops }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  console.log(`  ${note}`)
}

const node = (
  id: string,
  kind: Operation extends { op: 'add_node'; node: infer N } ? (N extends { kind: infer K } ? K : never) : never,
  label: string,
  extra: {
    detail?: string
    path?: string
    status?: 'planned' | 'building' | 'done' | 'problem'
    url?: string
  } = {},
): Operation => ({ op: 'add_node', node: { id, kind, label, ...extra } })

const edge = (
  source: string,
  target: string,
  kind: 'imports' | 'calls' | 'reads' | 'writes' | 'extends' | 'depends',
): Operation => ({ op: 'add_edge', edge: { id: `${source}->${target}:${kind}`, source, target, kind } })

console.log('\nSimulando una sesión de trabajo…\n')

await push([{ op: 'reset' }], 'lienzo limpio')
await sleep(600)

// ── Claude explora el proyecto ──────────────────────────────────────────────
await push(
  [
    node('service:api', 'service', 'API HTTP', {
      detail: 'Servidor Fastify. Punto de entrada de todo el tráfico externo.',
      path: 'src/server.ts',
      status: 'done',
      url: 'http://localhost:3000',
    }),
  ],
  'encuentra el punto de entrada',
)
await sleep(1100)

await push(
  [
    node('module:auth', 'module', 'Autenticación', {
      detail: 'Sesiones con JWT y refresh rotativo.',
      path: 'src/auth/',
      status: 'done',
    }),
    node('module:billing', 'module', 'Facturación', {
      detail: 'Suscripciones vía Stripe. Todavía sin webhooks.',
      path: 'src/billing/',
      status: 'building',
    }),
    edge('service:api', 'module:auth', 'calls'),
    edge('service:api', 'module:billing', 'calls'),
  ],
  'mapea los dos módulos principales',
)
await sleep(1300)

await push(
  [
    node('datastore:pg', 'datastore', 'PostgreSQL', {
      detail: 'Base de datos principal. Migraciones con Drizzle.',
      status: 'done',
    }),
    node('datastore:redis', 'datastore', 'Redis', {
      detail: 'Cache de sesiones y rate limiting.',
      status: 'done',
    }),
    edge('module:auth', 'datastore:pg', 'reads'),
    edge('module:auth', 'datastore:redis', 'writes'),
    edge('module:billing', 'datastore:pg', 'writes'),
  ],
  'descubre la capa de datos',
)
await sleep(1300)

await push(
  [
    node('external:stripe', 'external', 'Stripe API', {
      detail: 'Pasarela de pago. Requiere verificar firma en los webhooks.',
    }),
    edge('module:billing', 'external:stripe', 'calls'),
  ],
  'identifica la dependencia externa',
)
await sleep(1200)

// ── Claude empieza a construir ──────────────────────────────────────────────
await push(
  [
    node('file:webhooks', 'file', 'Webhooks de Stripe', {
      detail: 'Lo que voy a implementar ahora.',
      path: 'src/billing/webhooks.ts',
      status: 'planned',
    }),
    edge('module:billing', 'file:webhooks', 'imports'),
    edge('external:stripe', 'file:webhooks', 'calls'),
  ],
  'planifica el trabajo',
)
await sleep(1400)

await push([{ op: 'set_status', id: 'file:webhooks', status: 'building' }], 'empieza a escribirlo')
await sleep(1800)

await push(
  [
    node('decision:idempotency', 'decision', 'Idempotencia', {
      detail:
        'Stripe reintenta los webhooks. Guardo el event.id en Postgres con índice único y descarto duplicados, en vez de fiarme del orden de llegada.',
    }),
    edge('file:webhooks', 'decision:idempotency', 'depends'),
  ],
  'registra una decisión de arquitectura',
)
await sleep(1600)

await push(
  [
    node('datastore:events', 'datastore', 'tabla stripe_events', {
      detail: 'Índice único sobre event_id. Es lo que hace la operación idempotente.',
      path: 'src/db/schema/events.ts',
      status: 'done',
    }),
    edge('file:webhooks', 'datastore:events', 'writes'),
  ],
  'crea la tabla de soporte',
)
await sleep(1500)

await push(
  [
    { op: 'set_status', id: 'file:webhooks', status: 'done' },
    {
      op: 'annotate',
      id: 'file:webhooks',
      detail: 'Implementado. Verifica la firma, descarta duplicados por event_id y confirma con 200.',
    },
  ],
  'termina la implementación',
)
await sleep(1400)

// ── Y encuentra un problema ─────────────────────────────────────────────────
await push(
  [
    { op: 'set_status', id: 'module:auth', status: 'problem' },
    {
      op: 'annotate',
      id: 'module:auth',
      detail:
        'El refresh token no se invalida al cerrar sesión: sigue siendo válido hasta que expira. Hay que añadir una lista de revocación en Redis.',
    },
  ],
  'detecta un fallo de seguridad de paso',
)
await sleep(900)

await push([{ op: 'set_status', id: 'module:billing', status: 'done' }], 'cierra el módulo')

const final = (await (
  await fetch(`http://127.0.0.1:${lock.port}/state?project=${DEMO_PROJECT.id}`)
).json()) as {
  nodes: unknown[]
  edges: unknown[]
  seq: number
}
console.log(
  `\nListo. ${final.nodes.length} nodos, ${final.edges.length} aristas, ${final.seq} operaciones.`,
)
console.log(`Míralo en el proyecto "${DEMO_PROJECT.name}" del selector.\n`)
