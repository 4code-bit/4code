---
description: ¿Está esta máquina vinculada con 4Code, y qué tableros hay?
disable-model-invocation: true
---

Ejecuta este comando y enseña la salida **tal cual**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" server/src/cloud.ts status
```

Dice si la máquina está vinculada con la nube y lista los tableros locales: cuántas
piezas tiene cada uno, si es compartible, y —cuando lo es— su enlace en la nube o
cuántas operaciones le quedan por subir.

Un tablero solo es compartible si su repositorio tiene remoto de GitHub: sin
remoto no hay forma de saber quién debería poder verlo, así que se queda aquí.

Si hace falta más detalle de un tablero concreto (ruta en disco, sesiones
capturadas), está en:

```bash
node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" server/src/board.ts list
```
