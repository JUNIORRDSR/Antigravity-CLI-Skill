# Model routing and quotas

Run `models --json` to see the installed CLI's discovered slugs and route order. Exact `--model` values must be discovered values; an unknown explicit model fails rather than silently substituting one.

## Policy

The runtime groups models as `gemini` and `third-party` (Claude and GPT), then offers `auto`, `quality`, `balanced`, `fast`, `gemini-first`, `third-party-first`, or an explicit ordered slug list. `auto` may omit `--model` on its first attempt so Antigravity uses the user's default.

`quality` ranks opus-class models above pro/sonnet/gpt-5. Use it for audits and reviews: on a real audit the default model returned correct verdicts anchored to lines that did not contain the cited code, while an opus-class run returned findings that held up on inspection.

On quota, rate-limit, availability, or an explicit superior-agent instruction, it may select one discovered model in the other family and resume the same `conversation_id`. Transport errors retry with bounded backoff. Authentication failures, invalid arguments/models, permission denials, and deterministic task failures do not become quota fallback. Attempts and the evidence for each choice remain in `attempts.ndjson`, and every family switch is printed as a `Retry:` line by `status` and `result`; a fallback is never silent.

## Quota is per model

`Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h47m30s.` exhausts one model, not the account: another family was still serving at the same moment. The message can arrive inside a `SUCCESS` response rather than as an error, so the runtime scans the response text as well as `stderr`, reports the job as `failed` with the reset time, and names quota as the cause instead of leaving it buried in the output.

## What is documented versus inferred

Antigravity documents separate five-hour and weekly buckets for Gemini and Claude/GPT models, and documents the currently offered model families. It does not document a headless percentage/quota API. The family classifier, route names, conservative slug matching, reactive fallback, and any error classification are wrapper inferences; inspect output and do not treat them as billing authority. The runtime does not scrape private caches or enable credits.

Sources: [models and quota families](https://antigravity.google/docs/models/), [headless model selection](https://antigravity.google/docs/cli/headless/), [interactive quota view](https://antigravity.google/docs/cli/commands/usage/).
