# 4Code — plugin de Claude Code

Mientras trabajas, el tablero dibuja la arquitectura de tu proyecto y registra qué se
ha hecho. Tu código nunca sale de tu máquina.

## Instalarlo

```
/plugin marketplace add https://github.com/4code-bit/4code.git
/plugin install 4code@4code
```

Eso trae de una vez el servidor MCP, los hooks de captura, el skill que le dice a
Claude que diagrame y los comandos. **No hay que tocar ningún `settings.json` ni
instalar nada por separado**, que era exactamente el problema de la versión anterior:
seis pasos manuales, uno de ellos con una ruta absoluta al disco de otra persona.

Hace falta **git en el PATH**: instalar el plugin es clonar un repositorio, así que sin
git el primer comando falla antes de llegar a ninguna parte. El tablero también lo usa
para saber en qué proyecto estás. Ojo si instalas desde la terminal de un editor: esa
terminal heredó el PATH de cuando el editor arrancó, así que si git o Node llegaron
después hay que **cerrar el editor entero** y volver a abrirlo — el panel no basta.
Comprueba con `git --version` y `node --version` en la terminal donde vas a escribir.

Hace falta **Node 22.6 o superior** (24 recomendado): el plugin va sin compilar, así
que necesita un Node que ejecute `.ts`. De 22.6 a 22.17 se lo pide con
`--experimental-strip-types`; por debajo, lo dice con palabras al arrancar en vez de
morir con un error de sintaxis. Y **los hooks entran en la sesión siguiente**, así que
después de instalar o actualizar conviene abrir una nueva.

Para que tus tableros se sincronicen y tus colaboradores los vean:

```
/4code:login
```

Se abre el navegador, apruebas, y listo. **No hay ningún token que copiar**: el
proceso local no tiene navegador ni puede leer la cookie de tu sesión —ni debería—,
así que pide un código y espera tu aprobación desde la web. Es el mismo patrón que
`gh auth login` o `docker login`.

| Comando | Qué hace |
|---|---|
| `/4code:login` | Vincula esta máquina con tu cuenta |
| `/4code:status` | Si está vinculada, y qué tableros hay |
| `/4code:board` | Abre el tablero en el navegador |

**En un repositorio grande, no pidas «mapea el proyecto entero».** El tablero es el
único canal que pasa por el modelo y ese barrido cuesta tokens de verdad. Pide zonas
(«mapea la capa de autenticación») conforme trabajes en ellas.

## Desarrollarlo

```bash
npm install          # dependencias del servidor
npm install --prefix web   # las de la web van aparte: sin workspaces, ver package.json

npm run canvas       # estado del diagrama + WebSocket (solo 127.0.0.1)
npm run web:dev      # la web, en http://localhost:5173

# Cargarlo en Claude Code sin publicar nada
claude --plugin-dir ./plugin
```

### Ver la demo sin gastar tokens

```bash
node verify/demo-feed.ts          # a ritmo real, para grabar el GIF
node verify/demo-feed.ts --fast   # instantáneo
```

## Las cinco vistas

El rail de la izquierda cambia entre ellas. **Solo una gasta tokens** — el tablero,
porque el criterio de qué importa lo pone el modelo. Las otras cuatro salen de
datos que ya existen.

| Vista | Qué enseña | De dónde sale | Tokens |
|---|---|---|---|
| **Tablero** | El grafo en vivo | El diagrama que Claude declara por MCP | Reales |
| **Tareas** | Qué está bloqueado, en curso, planificado o hecho | El `status` de cada pieza, que Claude ya marca al diagramar | Cero |
| **Actividad** | La línea temporal del proyecto, con hora | `history.jsonl`, que ya se escribía y nadie miraba | Cero |
| **Piezas** | La lista buscable y filtrable | El mismo grafo, ordenado por número de conexiones | Cero |
| **Sesiones** | Cada sesión de Claude: herramientas, ficheros, subagentes y capa de trabajo | Hooks | Cero |

Las tareas **no** son un kanban: nada se asigna, nada se arrastra y nada dispara
trabajo. Es un espejo de solo lectura de lo que Claude ya dijo, que es
precisamente lo que evita la fatiga de revisión que mató a Vibe Kanban.

## Los hooks

Los declara el propio plugin en `hooks/hooks.json`, con `${CLAUDE_PLUGIN_ROOT}` en
vez de rutas fijas. Van `async` para no añadir latencia a cada llamada de
herramienta, y se desactivan desactivando el plugin.

Dos cosas que costaron un rato aprender y conviene no repetir:

- **Nada de comentarios `"//"` dentro del objeto `hooks`.** Claude Code valida cada
  clave contra su lista de eventos y saca un aviso en cada arranque por las que no
  reconoce. Por eso toda la explicación vive aquí y no en el JSON.
- **Los hooks de usuario y de proyecto se SUMAN**, no se sustituyen. Declararlos en
  dos sitios registra cada evento por duplicado.

`UserPromptSubmit` no está **y no debe añadirse**: trae el prompt literal y no hay
forma segura de registrarlo (§2.2).

**`hooks/capture.ts` es donde se hace cumplir el contrato de datos (§2.2)**, y por
eso merece leerse antes de tocarlo. Los hooks reciben `tool_input` y `tool_output`
enteros: el `new_string` de cada edición, el contenido de cada `Write`, el
`command` de cada `Bash`, el resultado de cada `Read`. `UserPromptSubmit` recibe
el prompt literal.

Nada de eso puede sobrevivir a ese fichero. El filtro es una **allowlist**: se
construye un evento nuevo con los campos permitidos en vez de copiar el payload y
borrar lo que sobra. Copiar-y-borrar falla en silencio en cuanto Claude Code añade
un campo; construir de cero, no. `UserPromptSubmit` no se registra en absoluto.

De ahí sale también la **capa de trabajo** (§4.3): `permission_mode === 'plan'`
delata la planificación, y las rutas dicen el resto. Si nada domina, la respuesta
es «sin determinar» — una capa equivocada rompería la confianza en todo lo demás.

## La vista de equipo sale de git, no de un servidor

Saber en qué rama trabaja cada quién, qué ficheros toca y en qué capa anda **no
necesita servidor ni que tus colaboradores instalen nada**. El remoto del
repositorio ya es un canal compartido con los permisos resueltos: basta con
`git fetch` y leerlo.

De ahí salen las ramas activas con su último autor, cuántos commits te llevan, y
—lo más útil— **las colisiones**: si alguien tocó en otra rama un fichero que tú
tienes a medias, aparece un aviso rojo en el rail. Enterarse ahora es accionable;
enterarse en el merge, no (§4.2).

Lo que git no puede dar, y es correcto que no pueda: lo que alguien tiene **sin
commitear**. Eso vive solo en su disco, es tentativo, y anunciarlo sería ruido y
presión.

Para eso está la **presencia** en la nube, que sí necesita que la otra persona
tenga el plugin y esté vinculada. Late cada minuto con dos datos —rama y capa—
y nada más: 99 bytes. Ni ficheros ni rutas, porque para saber que dos personas
van a chocar basta con eso y el detalle ya lo da git en local.

Se apaga con `FOURCODE_PRESENCE=off`, y sin vincular la máquina no late en
absoluto.

## Un tablero por proyecto

Cada proyecto tiene el suyo. El servidor MCP arranca con el directorio del
proyecto como cwd, sube hasta la raíz del repositorio y deriva un id estable, así
que trabajar en `src/auth/` y en la raíz cuentan como el mismo sitio. La web trae
un selector y guarda el elegido en la URL (`?project=…`), de modo que puedes dejar
una pestaña fija por repositorio.

**El id sale del remoto de git, no de la ruta.** Esa es la diferencia entre un
tablero personal y uno que se puede compartir: `github.com/viupik/viupikhub` →
`viupikhub-6f2a1988`, el mismo para cualquiera que clone ese repo, esté donde
esté en su disco y lo haya clonado por HTTPS o por SSH. Si la URL de clonado
llevaba credenciales, se descartan antes de calcular nada.

Un repositorio **sin remoto** cae al id por ruta, y entonces su tablero no es
compartible. Es correcto que así sea: sin remoto no hay forma de saber que el
repo de otra persona es "el mismo".

El **branch** no forma parte de la identidad — un tablero por rama fragmentaría
la arquitectura sin motivo — pero sí viaja con cada operación y cada evento, que
es lo que §4.2 necesita para correlacionar por *(repo, branch)*.

Para los tableros creados antes de este cambio:

```bash
node server/src/migrate-ids.ts            # enseña qué haría
node server/src/migrate-ids.ts --apply    # lo hace
```

## Gestionar los tableros

```bash
node server/src/board.ts list                        # cuáles hay y si son compartibles
node server/src/board.ts export <id> [fichero]       # sacarlo a JSON
node server/src/board.ts import <f.json> --into <id>
node server/src/board.ts reset  <id>                 # vaciarlo para remapear
node server/src/board.ts move   <origen> <destino>
node server/src/board.ts split  <id>                 # repartirlo entre sus repos
```

Todo lo que destruye o mueve **simula por defecto**; hay que añadir `--apply`. Y
nada se borra de verdad: lo sustituido se aparta con sufijo (`.vaciado-…`,
`.movido-…`), porque rehacer un tablero cuesta tokens y arrepentirse a los cinco
minutos no debería ser irreversible.

`export` es además la única copia de seguridad que existe hoy — la nube es Fase 1.

### `split`: un directorio con varios repos dentro

Trabajar desde una carpeta paraguas que contiene varios repositorios produce un
tablero que abarca el sistema entero. Es el más útil para entenderlo, y a la vez
no es compartible: no hay un remoto único que lo identifique.

`split` lo reparte entre sus repos. Las conexiones que cruzaban de uno a otro se
conservan como nodos `external` en cada lado — que es exactamente para lo que
existe ese tipo — así que el tablero del frontend sigue diciendo «aquí hablo con
el backend» sin arrastrarlo entero. Con `--sin-externos` se hace el corte limpio.

El tablero de origen **no se toca**: crea tableros nuevos y deja el original por
si quieres volver.

> Estos comandos escriben por debajo del canvas-server, que mantiene los tableros
> abiertos en memoria. Hay que reiniciarlo después o se sigue viendo el estado
> anterior.

El estado vive en `~/.4code/projects/<id>/` y **sobrevive a los reinicios**:

| Fichero | Qué |
|---|---|
| `history.jsonl` | Append-only. La fuente de verdad, y **es** la línea temporal del proyecto |
| `diagram.json` | Snapshot para arrancar rápido. Caché reconstruible desde el historial |
| `project.json` | Nombre y ruta del proyecto |

`FOURCODE_HOME` mueve todo eso de sitio — es lo que usan las pruebas para no
tocar tus tableros reales.

## Verificaciones

Las dos que el plan marcaba como bloqueantes, más la del núcleo:

```bash
node verify/dagre-stability.ts   # ¿constraints evita que el layout salte?
node verify/mcp-stdout.ts        # ¿sobrevive el protocolo al arrancar HTTP+WS?
node verify/core.ts              # aislamiento entre proyectos, persistencia y URLs
```

**Resultados obtenidos** (27 jul 2026, Node 24.18, `@dagrejs/dagre` 3.0.0):

| Verificación | Resultado |
|---|---|
| 20 adiciones sucesivas sin `constraints` | 656 inversiones de orden |
| 20 adiciones sucesivas con `constraints` | **13 inversiones** |
| Determinismo (10 ejecuciones idénticas) | 1 único resultado |
| `stdout` del MCP al lanzar HTTP+WS | 4 mensajes JSON-RPC, **0 líneas de basura** |

## Cómo está montado

```
Claude Code ──stdio──▶ mcp-server ──HTTP──▶ canvas-server ──WS──▶ navegador
            └─hook────▶ board-up ───────────────▲
                        lo levanta al empezar   │
                        la sesión, sin gastar   │
                        un solo token           │
                                        (el mcp también,
                                         si hiciera falta)
```

Tres decisiones que no son negociables:

1. **Procesos separados.** La spec de MCP prohíbe escribir a stdout algo que no sea
   protocolo. El canvas-server se lanza con su stdout a `'ignore'` y su stderr a
   `~/.4code/canvas.log` — a fichero y no heredado, porque sobrevive a quien lo lanzó y
   heredar una tubería que nadie va a cerrar deja al padre sin poder terminar.
   Compartir proceso es la forma documentada de romper la conexión al arrancar.
2. **Solo loopback + validación de `Origin`.** Un sitio cualquiera puede pedirle a tu
   navegador que abra un WebSocket contra `127.0.0.1`. La spec de MCP lo advierte y
   ningún canvas MCP de la comunidad lo defiende.
3. **Operaciones incrementales, no redibujados.** Los tokens los paga el usuario. Y el
   log de operaciones *es* la línea temporal de la sesión.

## Ficheros

| Ruta | Qué es |
|---|---|
| `shared/diagram.ts` | Modelo y reducer. Fuente de verdad compartida por servidor y web. |
| `shared/project.ts` | Identidad de proyecto: lo que impide que dos repos se mezclen. |
| `server/src/project.ts` | Detecta la raíz del repo y deriva el id estable. |
| `server/src/store.ts` | Persistencia: snapshot + historial append-only por proyecto. |
| `server/src/canvas-server.ts` | Estado canónico por proyecto, HTTP y WebSocket. |
| `launch.mjs` · `node-ts.mjs` | Ejecutan el `.ts` del plugin en el Node que haya: nativo, con flag, o un motivo legible. |
| `server/src/ensure.ts` | Levantar el canvas-server. Lo usan el MCP y el hook de sesión. |
| `server/src/mcp-server.ts` | Las 7 herramientas que ve Claude. |
| `hooks/board-up.ts` | Deja el tablero en pie al empezar la sesión, y abre la pestaña si nadie la mira. |
| `web/src/layout.ts` | dagre con `constraints` derivadas del orden persistido. |
| `web/src/nodes.tsx` | Un componente por tipo de nodo. |

## Lo que todavía NO hace

Sin Stripe, sin daemon de bandeja y sin edición del tablero desde la nube. El tablero
local no pide token para leerse (el `Origin` sí se valida) porque solo escucha en
`127.0.0.1`.

Y la sincronización sube **solo el diagrama**. Las sesiones capturadas por hooks —qué
ficheros tocas y cuándo— se quedan en tu máquina.
