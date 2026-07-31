---
description: Open this project's board in the browser
disable-model-invocation: true
---

The board should already be up: a hook brings it online when each session starts. This
command only opens the window.

On Windows:

```bash
cmd /c start "" http://127.0.0.1:41847
```

On macOS `open http://127.0.0.1:41847`, on Linux `xdg-open http://127.0.0.1:41847`.

If the page does not respond, the canvas server is not alive. Bring it up without waiting
for me to diagram anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" hooks/board-up.ts < /dev/null
```

It takes a couple of seconds on a cold start, and opens the tab itself if you do not
already have one. To keep it in the foreground and watch its logs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" server/src/canvas-server.ts
```
