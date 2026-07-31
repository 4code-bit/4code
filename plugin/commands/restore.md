---
description: Trae de la nube el tablero de este proyecto, para un PC nuevo o reinstalado
disable-model-invocation: true
---

Ejecuta este comando desde la carpeta del proyecto y enseña la salida **tal cual**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" server/src/cloud.ts restore $ARGUMENTS
```

Reconstruye el tablero de esta carpeta —piezas, conexiones, notas y el historial de
operaciones— desde lo que hay en la nube. Es para cuando el tablero existe allí pero
no aquí: un ordenador nuevo, un PC reinstalado, o un repositorio que acabas de
clonar y cuyo tablero ya mapeó otra persona del equipo.

Necesita dos cosas: que la máquina esté vinculada (`/4code:login`) y que el
repositorio tenga remoto de GitHub, que es de donde sale el permiso de lectura.

**Si aquí ya hay un tablero con piezas, el comando se detiene** en vez de pisarlo, y
dice cómo forzarlo y cómo guardar antes el que hay. Lo que se descarga no se vuelve
a subir: esta máquina solo enviará lo que haga de aquí en adelante.

Lo que **no** se restaura es el historial de sesiones —qué ficheros tocaste y
cuándo—, porque eso nunca sale de la máquina por diseño. Se pierde con el disco.
