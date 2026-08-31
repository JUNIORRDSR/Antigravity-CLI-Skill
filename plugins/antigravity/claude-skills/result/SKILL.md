---
name: result
description: Use when retrieving the complete stored result of a tracked Antigravity job.
argument-hint: "[job-id] [runtime options]"
allowed-tools: Bash
---

Run exactly this command and return its complete stdout unchanged. Do not summarize, truncate, or claim the delegated work is verified:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/antigravity-delegator/scripts/antigravity-delegator.mjs" result $ARGUMENTS
```
