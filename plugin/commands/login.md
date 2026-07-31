---
description: Vincula esta máquina con tu cuenta de 4Code para que tus tableros se sincronicen
disable-model-invocation: true
---

Ejecuta este comando y muéstrale la salida al usuario **tal cual, sin resumirla**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" server/src/cloud.ts login $ARGUMENTS
```

Abre el navegador y espera a que la persona apruebe la vinculación desde la web,
donde ya está identificada con GitHub. No hay ningún token que copiar.

Lo importante que tiene que ver es el **código** que imprime en un recuadro: la
web le enseñará ese mismo código y tiene que comprobar que coincide antes de
aprobar. Si el navegador no se abre solo, en la salida está la URL para entrar a
mano. El comando espera hasta diez minutos y va diciendo cuánto queda.

Al terminar sube los tableros que ya hubiera en la máquina e imprime el enlace de
cada uno. No hay que reiniciar nada: la sincronización se activa por sí sola en
la siguiente operación del tablero.

Si la máquina ya estaba vinculada, el comando lo dice y no crea otra credencial
—solo sube lo que quedara pendiente.
