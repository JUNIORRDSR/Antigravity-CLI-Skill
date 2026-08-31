---
name: wait
description: Use when waiting for a tracked Antigravity job to change state or finish.
argument-hint: "[job-id] [--timeout milliseconds] [runtime options]"
allowed-tools: Bash
---

Run exactly this command and return its complete stdout unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/antigravity-delegator/scripts/antigravity-delegator.mjs" wait $ARGUMENTS
```
