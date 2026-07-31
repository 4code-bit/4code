---
description: Check whether this board can be shared, and what is missing if it cannot
disable-model-invocation: true
---

Run the check and **show me its whole output, verbatim**. Do not summarise it: every line
says which requirement is met and which one is not.

```bash
node "${CLAUDE_PLUGIN_ROOT}/launch.mjs" server/src/cloud.ts team
```

There are five requirements, and sharing a board fails on any one of them: the folder has
to be a repository, it needs a GitHub remote, this machine has to be linked, your account
has to reach the repository, and there has to be a board up there.

If one fails, the command itself says which and where it is fixed. If I ask you anything
afterwards, answer from that output rather than from guesswork.
