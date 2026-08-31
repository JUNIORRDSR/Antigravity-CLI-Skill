---
name: recover
description: Use when reconciling an interrupted or stale tracked Antigravity job.
argument-hint: "[job-id] [message] [runtime options]"
allowed-tools: Bash
---

Run exactly this command and return its complete stdout unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/antigravity-delegator/scripts/antigravity-delegator.mjs" recover $ARGUMENTS
```
