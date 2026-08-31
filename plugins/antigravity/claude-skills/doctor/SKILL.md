---
name: doctor
description: Use when checking Antigravity runtime readiness without changing settings.
argument-hint: "[runtime options]"
allowed-tools: Bash
---

Run exactly this command and return its complete stdout unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/antigravity-delegator/scripts/antigravity-delegator.mjs" doctor $ARGUMENTS
```
