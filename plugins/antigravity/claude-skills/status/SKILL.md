---
name: status
description: Use when inspecting the current state of a tracked Antigravity job.
argument-hint: "[job-id] [runtime options]"
allowed-tools: Bash
---

Run exactly this command and return its complete stdout unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/antigravity-delegator/scripts/antigravity-delegator.mjs" status $ARGUMENTS
```
