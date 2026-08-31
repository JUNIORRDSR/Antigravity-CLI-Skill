# Recovery and control

Use `status <job-id> --json` before acting. A background job records state, stream events, attempts, messages, result, and heartbeat outside the target workspace. State is keyed by canonical workspace path; pass `--state-dir` only for controlled locations or tests.

| Situation | Action |
| --- | --- |
| Need extra context | `send <job-id> "message"`; messages persist until acknowledged. |
| Current direction is wrong | `steer <job-id> "correction"`; this records the correction and continues the recorded conversation. |
| Need an update | Use one `status` or bounded `wait`, not continuous polling. |
| Heartbeat is stale | Run `recover <job-id>` only after checking worker reachability and conversation ID. |
| Job is canceled | Leave it canceled; recovery never restarts it automatically. |
| Need to stop work | `cancel <job-id>`; the worker's authenticated loopback control channel is preferred over a stored PID. |

If an absent worker has a conversation ID, recovery marks the job orphaned and may continue that exact conversation. Without one, a restart begins from the original prompt and must state that continuity was lost. Recovery uses a compare-and-claim guard so two callers cannot launch duplicate workers. A failed control check, not PID reuse, determines whether replacement is safe.

The CLI documents continuation by `--conversation` and terminal statuses; persistent records, heartbeat interpretation, durable messages, and control-channel rules are wrapper behavior. Source: [headless continuation and status](https://antigravity.google/docs/cli/headless/).
