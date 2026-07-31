---
name: tablero
description: Mantiene un diagrama de arquitectura en vivo en 4Code mientras trabajas. Úsalo al empezar en un proyecto para mapear su estructura, y mantenlo al día conforme construyes, descubres piezas o tomas decisiones.
---

# Tablero de arquitectura en vivo

Hay un tablero abierto en el navegador del usuario que se actualiza en tiempo real
mediante las herramientas `diagram_*` del servidor MCP `4code`. Tu trabajo es que ese
tablero sea un reflejo útil de lo que el usuario está construyendo, **mientras** lo
construyes — no un informe al final.

## Al empezar

1. Llama a `diagram_get` para ver qué hay ya.
2. Si el tablero contiene un proyecto distinto al actual, empieza de cero.
3. Explora lo justo para entender la estructura real (no exhaustivamente) y publica el
   mapa inicial con **una sola llamada a `diagram_batch`**. Entre 6 y 15 nodos. Menos no
   dice nada; más es ruido en la primera impresión.

## Durante el trabajo

Actualiza el tablero cuando pase algo que cambie el mapa mental del usuario:

| Situación | Qué haces |
|---|---|
| Descubres una pieza relevante que no estaba | `diagram_node` |
| Vas a crear algo nuevo | `diagram_node` con `status: planned` |
| Empiezas a escribirlo | `diagram_status` → `building` |
| Lo terminas | `diagram_status` → `done` + `diagram_note` con qué quedó |
| Encuentras un fallo o una deuda | `diagram_status` → `problem` + `diagram_note` explicando |
| Tomas una decisión de arquitectura no obvia | nodo `decision` + `diagram_edge` a lo que afecta |
| Entiendes cómo se relacionan dos piezas | `diagram_edge` |

## Convención de ids — importante

Usa ids **estables y deterministas**, derivados de la ruta o del nombre real:

```
service:api          file:src/auth/login.ts       module:billing
datastore:postgres   external:stripe              decision:idempotencia
```

Reutilízalos siempre. Volver a declarar un id existente **lo actualiza, no lo duplica** —
esa es la forma correcta de cambiar algo. Nunca inventes un id nuevo para un concepto que
ya está en el tablero: acabarías con duplicados y el diagrama pierde todo su valor.

## Los dos tableros

Un solo grafo, dos vistas en el rail: **Tablero** (técnico) y **Negocio**. A qué
vista va cada pieza no es un campo que declares — sale del tipo que elijas.

| Vista | Tipos | Qué recoge |
|---|---|---|
| Tablero | `module` `service` `file` `datastore` `external` `note` `decision` | Cómo está hecho |
| Negocio | `campaign` `channel` `segment` `goal` | Qué se vende, a quién y por dónde |
| **Las dos** | `offer` | El punto de contacto |

**No son el mismo grafo con un filtro: son dos trabajos distintos.** «Planes de
suscripción» en negocio es decidir precios, nombres y qué entra en cada plan; en
técnica es la cuenta de Stripe, construir los planes y bloquear features. No
declares la misma pieza dos veces con otro nombre — declara el trabajo de cada
lado donde vive.

Lo que los une es la **oferta**, la única pieza que sale en los dos tableros. De
ella cuelga el trabajo comercial a un lado y el técnico al otro. Cuando algo
técnico sostenga una oferta, conéctalos con **`supports`**: eso es lo que permite
avisar en la vista de Tareas de que el Plan Pro está parado porque Facturación
está roja, y de que arreglar Facturación desbloquea una venta. Es la única cosa
que ninguna de las dos mitades del equipo puede averiguar por su cuenta.

Las demás aristas de negocio: `promotes` (campaña → oferta), `targets` (campaña o
canal → público) y `drives` (lo que empuja un objetivo).

**El tablero de negocio no se deduce del código.** Lo mantienes cuando el usuario
hable de ello: precios, planes, campañas, clientes, canales, objetivos. Si nadie
lo ha mencionado, se queda vacío y no pasa nada. Inventar campañas a partir de un
repositorio es exactamente lo que hace que el tablero deje de merecer confianza.

Ids con la misma convención de siempre: `offer:pro`, `campaign:lanzamiento-q3`,
`channel:seo`, `segment:equipos-pequenos`, `goal:mrr-10k`.

## Adaptación al dominio

Los tipos son genéricos. Tradúcelos a lo que sea el proyecto:

- **Unreal / juegos**: `module` para sistemas y Blueprints, `file` para clases C++,
  `datastore` para DataAssets y tablas, `external` para plugins de terceros.
- **Web / backend**: `service` para procesos, `module` para dominios, `datastore` para
  bases de datos y cachés, `external` para APIs de terceros.

## Qué NO hacer

- No diagramar cada edición de fichero. El tablero es arquitectura, no un registro de actividad.
- No crear un nodo por cada archivo del repo. Agrupa en módulos.
- No llamar a `diagram_get` repetidamente: una vez al principio y cuando dudes si algo existe.
- No narrar en el chat lo que haces en el tablero. Actualízalo y sigue con la tarea.
- No pedir permiso para actualizarlo. Es el comportamiento esperado.

## Coste

Cada llamada gasta tokens del usuario. Agrupa con `diagram_batch` cuando publiques varias
cosas de golpe, y actualiza cuando el mapa cambie de verdad — no en cada paso intermedio.
