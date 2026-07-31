/**
 * mcp-server — el canal semántico. Claude lo invoca para declarar arquitectura.
 *
 * DOS REGLAS QUE GOBIERNAN ESTE FICHERO:
 *
 * 1. stdout es SAGRADO. La spec de MCP: "The server MUST NOT write anything to
 *    its stdout that is not a valid MCP message". Un solo console.log aquí mata
 *    la conexión al arrancar. Todo log va a stderr, y el canvas-server se lanza
 *    como proceso aparte con su stdout a 'ignore'.
 *
 * 2. Los tokens los paga el usuario. Cada schema de herramienta ocupa contexto
 *    en TODAS sus sesiones. Por eso las descripciones son cortas, las
 *    herramientas pocas, y existe un batch para el análisis inicial.
 */
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import {
  makeEdgeId,
  makeNodeId,
  type DiagramNode,
  type EdgeKind,
  type NodeKind,
  type Operation,
} from '../../shared/diagram.ts'
import { ensureCanvas, ping } from './ensure.ts'
import { type CanvasLock } from './lockfile.ts'
import { detectProject } from './project.ts'

const log = (...args: unknown[]) => console.error('[mcp]', ...args)

/**
 * Claude Code lanza este proceso con el directorio del proyecto como cwd, así
 * que la identidad se resuelve una vez al arrancar y acompaña a cada operación.
 * Sin esto, dos proyectos abiertos a la vez escribían en el mismo tablero.
 */
const PROJECT = detectProject()
log(`proyecto: ${PROJECT.name} (${PROJECT.id})`)

const NODE_KINDS = [
  'module',
  'service',
  'file',
  'datastore',
  'external',
  'offer',
  'campaign',
  'channel',
  'segment',
  'goal',
  'note',
  'decision',
] as const
const EDGE_KINDS = [
  'imports',
  'calls',
  'reads',
  'writes',
  'extends',
  'depends',
  'promotes',
  'targets',
  'drives',
  'supports',
] as const
const STATUSES = ['planned', 'building', 'done', 'problem'] as const

// ── Conexión con el canvas-server ───────────────────────────────────────────

let cached: CanvasLock | null = null

function enviar(lock: CanvasLock, operations: Operation[]): Promise<Response> {
  return fetch(`http://127.0.0.1:${lock.port}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fourcode-token': lock.token },
    body: JSON.stringify({ project: PROJECT, operations }),
  })
}

async function send(operations: Operation[]): Promise<string> {
  if (!cached || !(await ping(cached))) cached = await ensureCanvas()
  let res = await enviar(cached, operations)

  /**
   * Un 401 con el puerto respondiendo significa que el canvas se reinició por su
   * cuenta y tiene un token nuevo: el `ping` pasa —`/health` no pide token— y solo
   * falla la escritura. Nuestra copia en memoria se quedó con el token viejo, y el
   * lockfile ya tiene el bueno.
   *
   * Pasa desde que el canvas no es solo hijo nuestro: el hook de sesión también lo
   * levanta (§4.11), así que una sesión de Claude larga puede sobrevivir a varios
   * canvas distintos. Antes hacía falta reiniciar Claude Code para volver a
   * dibujar; ahora se reintenta una vez con la credencial de disco.
   */
  if (res.status === 401) {
    log('el canvas cambió de token (se reinició); se recarga el lockfile')
    cached = await ensureCanvas()
    res = await enviar(cached, operations)
  }

  if (!res.ok) throw new Error(`el canvas respondió ${res.status}`)
  const { applied, seq } = (await res.json()) as { applied: number; seq: number }
  return `${applied} operación(es) aplicadas (seq ${seq})`
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
})

// ── Servidor ────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: '4code-diagram', version: '0.0.0' },
  {
    instructions: [
      'Tablero de arquitectura en vivo. Mientras trabajas en el proyecto, mantén el diagrama al día.',
      'Añade un nodo cuando descubras o crees una pieza relevante; conéctala; marca su estado.',
      'Usa ids estables y descriptivos (p. ej. "service:api", "file:src/auth.ts") y REUTILÍZALOS',
      'entre sesiones: volver a declarar un id existente lo actualiza, no lo duplica.',
      'Llama a diagram_get antes de añadir en bloque, para no repetir lo que ya está.',
      'Diagrama estructura y decisiones, no cada edición de fichero.',
      'Si una pieza se puede abrir en el navegador (una app, una web, una landing), pon su',
      'dirección en `url`: el tablero la convierte en un enlace para verla al momento.',
      'Hay DOS tableros, y no son el mismo grafo filtrado: son dos trabajos distintos. El técnico',
      'son module/service/file/datastore/external/note/decision. El de negocio son campaign/',
      'channel/segment/goal, y ese lo mantienes solo cuando el usuario hable de eso (qué vende, a',
      'quién, por qué canal, con qué objetivo): no lo inventes a partir del código. El tipo `offer`',
      'es el punto de contacto y sale en los dos. Cuando algo técnico sostenga una oferta,',
      'conéctalos con `supports`: la vista de Tareas lo usa para avisar de qué venta se queda',
      'parada si esa pieza se rompe.',
    ].join(' '),
  },
)

server.registerTool(
  'diagram_get',
  {
    title: 'Ver el diagrama actual',
    description: 'Devuelve los nodos y aristas que ya existen. Úsalo antes de añadir para no duplicar.',
    inputSchema: {},
  },
  async () => {
    try {
      if (!cached || !(await ping(cached))) cached = await ensureCanvas()
      const res = await fetch(
        `http://127.0.0.1:${cached.port}/state?project=${encodeURIComponent(PROJECT.id)}`,
      )
      const snap = (await res.json()) as { nodes: DiagramNode[]; edges: unknown[] }
      if (snap.nodes.length === 0) return ok(`El diagrama de ${PROJECT.name} está vacío.`)
      const lines = snap.nodes.map((n) => `${n.id} [${n.kind}] ${n.label}${n.status ? ` (${n.status})` : ''}`)

      /**
       * El orden que el humano ha puesto a mano en la vista de tareas. Es la
       * única información del tablero que va en sentido contrario —de la persona
       * al modelo— y por eso se destaca en vez de mezclarse con la lista: dice
       * por dónde quiere empezar, y eso no se puede deducir del código.
       */
      const priorizados = snap.nodes
        .filter((n) => n.priority !== undefined)
        .sort((a, b) => a.priority! - b.priority!)
        .map((n) => n.label)

      const orden = priorizados.length
        ? `\n\nOrden que ha puesto el humano (primero lo primero): ${priorizados.join(' → ')}`
        : ''

      return ok(`${snap.nodes.length} nodos, ${snap.edges.length} aristas:\n${lines.join('\n')}${orden}`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'diagram_node',
  {
    title: 'Añadir o actualizar un nodo',
    description: 'Declara una pieza de la arquitectura. Reutilizar un id existente lo actualiza.',
    inputSchema: {
      id: z.string().optional().describe('Id estable, p. ej. "service:api". Si se omite se deriva de kind+label.'),
      kind: z.enum(NODE_KINDS),
      label: z.string().describe('Nombre corto para mostrar'),
      detail: z.string().optional().describe('Qué hace y por qué existe'),
      path: z.string().optional().describe('Ruta relativa en el repo'),
      status: z.enum(STATUSES).optional(),
      url: z
        .string()
        .optional()
        .describe('Si se puede abrir en el navegador, su dirección. P. ej. http://localhost:3001/landing'),
    },
  },
  async ({ id, kind, label, detail, path, status, url }) => {
    try {
      const node: DiagramNode = {
        id: id ?? makeNodeId(kind as NodeKind, path ?? label),
        kind: kind as NodeKind,
        label,
        ...(detail !== undefined && { detail }),
        ...(path !== undefined && { path }),
        ...(status !== undefined && { status }),
        ...(url !== undefined && { url }),
      }
      const result = await send([{ op: 'add_node', node }])
      return ok(`${result} — id: ${node.id}`)
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'diagram_edge',
  {
    title: 'Conectar dos nodos',
    description: 'Crea una relación. Ambos nodos deben existir ya.',
    inputSchema: {
      source: z.string(),
      target: z.string(),
      kind: z.enum(EDGE_KINDS),
      label: z.string().optional(),
    },
  },
  async ({ source, target, kind, label }) => {
    try {
      return ok(
        await send([
          {
            op: 'add_edge',
            edge: {
              id: makeEdgeId(source, target, kind as EdgeKind),
              source,
              target,
              kind: kind as EdgeKind,
              ...(label !== undefined && { label }),
            },
          },
        ]),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'diagram_status',
  {
    title: 'Marcar el estado de un nodo',
    description: 'Refleja en qué punto está esa pieza: planned, building, done o problem.',
    inputSchema: { id: z.string(), status: z.enum(STATUSES) },
  },
  async ({ id, status }) => {
    try {
      return ok(await send([{ op: 'set_status', id, status }]))
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'diagram_note',
  {
    title: 'Anotar un nodo',
    description: 'Deja una explicación o una decisión razonada sobre esa pieza.',
    inputSchema: { id: z.string(), detail: z.string() },
  },
  async ({ id, detail }) => {
    try {
      return ok(await send([{ op: 'annotate', id, detail }]))
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'diagram_remove',
  {
    title: 'Eliminar un nodo o una arista',
    description: 'Quitar un nodo arrastra sus aristas.',
    inputSchema: { id: z.string(), type: z.enum(['node', 'edge']) },
  },
  async ({ id, type }) => {
    try {
      return ok(await send([type === 'node' ? { op: 'remove_node', id } : { op: 'remove_edge', id }]))
    } catch (err) {
      return fail(err)
    }
  },
)

server.registerTool(
  'diagram_batch',
  {
    title: 'Aplicar varias operaciones de golpe',
    description: 'Para el mapeo inicial de un proyecto. Mucho más barato que llamada a llamada.',
    inputSchema: {
      nodes: z
        .array(
          z.object({
            id: z.string().optional(),
            kind: z.enum(NODE_KINDS),
            label: z.string(),
            detail: z.string().optional(),
            path: z.string().optional(),
            status: z.enum(STATUSES).optional(),
            url: z.string().optional(),
          }),
        )
        .optional(),
      edges: z
        .array(z.object({ source: z.string(), target: z.string(), kind: z.enum(EDGE_KINDS) }))
        .optional(),
    },
  },
  async ({ nodes, edges }) => {
    try {
      const ops: Operation[] = []
      for (const n of nodes ?? []) {
        ops.push({
          op: 'add_node',
          node: {
            id: n.id ?? makeNodeId(n.kind as NodeKind, n.path ?? n.label),
            kind: n.kind as NodeKind,
            label: n.label,
            ...(n.detail !== undefined && { detail: n.detail }),
            ...(n.path !== undefined && { path: n.path }),
            ...(n.status !== undefined && { status: n.status }),
            ...(n.url !== undefined && { url: n.url }),
          },
        })
      }
      // Las aristas después de los nodos: add_edge rechaza extremos inexistentes.
      for (const e of edges ?? []) {
        ops.push({
          op: 'add_edge',
          edge: {
            id: makeEdgeId(e.source, e.target, e.kind as EdgeKind),
            source: e.source,
            target: e.target,
            kind: e.kind as EdgeKind,
          },
        })
      }
      if (ops.length === 0) return ok('Nada que aplicar.')
      return ok(await send(ops))
    } catch (err) {
      return fail(err)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
log('servidor MCP conectado por stdio')
