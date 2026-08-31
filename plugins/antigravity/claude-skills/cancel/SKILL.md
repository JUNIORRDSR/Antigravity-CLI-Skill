---
name: cancel
description: Use when requesting safe cancellation of a tracked Antigravity job.
argument-hint: "[job-id] [runtime options]"
allowed-tools: Bash
---

Run exactly this command and return its complete stdout unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/antigravity-delegator/scripts/antigravity-delegator.mjs" cancel $ARGUMENTS
```
