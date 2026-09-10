# Codex and Claude integration

## Codex

The canonical package is `plugins/antigravity/skills/antigravity-delegator`. Codex should load its `SKILL.md` directly and invoke the runtime relative to that directory:

```text
node <skill-dir>/scripts/antigravity-delegator.mjs doctor --json
node <skill-dir>/scripts/antigravity-delegator.mjs delegate --read-only "..." --json
```

The installer provides `node scripts/install-codex.mjs --check`, `--copy`, and `--link`. Its default target is `$CODEX_HOME/skills/antigravity-delegator`, then `~/.codex/skills/antigravity-delegator`. `--check` is read-only. Copy/link modes print source and target and refuse an unrelated existing directory; a matching installation is identified by `name: antigravity-delegator` in `SKILL.md`.

Use that standalone installation for personal workflows. For distribution through Codex, the shared plugin root also contains `.codex-plugin/plugin.json`; it exposes only `./skills/`, so Codex receives the portable workflow and its `agents/openai.yaml` interface metadata without Claude-only adapters. Codex can select it implicitly from its description or explicitly as `$antigravity-delegator`. See [OpenAI: build skills](https://developers.openai.com/codex/build-skills) and [build plugins](https://developers.openai.com/codex/build-plugins).

## Claude Code

The Claude plugin contains the same canonical skill in `skills/`. Its host-specific lifecycle adapters use the current `claude-skills/<name>/SKILL.md` layout declared by `.claude-plugin/plugin.json`; they appear as `/antigravity:delegate`, `/antigravity:status`, `/antigravity:wait`, `/antigravity:send`, `/antigravity:result`, `/antigravity:recover`, `/antigravity:cancel`, and `/antigravity:doctor`. The old `commands/*.md` legacy format is intentionally absent.

The delegate skill forwards to the bounded `antigravity:antigravity-runner` subagent. That agent defaults to Gemini 3.8 Flash (`gemini-3.8-flash`) with high reasoning effort (`effort: high`) so delegated tasks receive thorough thinking and strong results; its `maxTurns` can be modified to maintain a fluid workflow instead of being restricted to the default ceiling of 3 turns. Antigravity performs the delegated work. The other lifecycle skills call the same runtime directly through `${CLAUDE_PLUGIN_ROOT}`. Run `/reload-plugins` after changing plugin components. See [Anthropic: skills](https://code.claude.com/docs/en/slash-commands) and [plugin reference](https://code.claude.com/docs/en/plugins-reference).

For a distributable archive, run `npm run package:claude`. The generated `dist/antigravity-claude-plugin.zip` places both host manifests plus `agents/`, `claude-skills/`, and `skills/` directly at the ZIP root. Load it with `claude --plugin-dir ./dist/antigravity-claude-plugin.zip`. Do not ZIP the repository root or the parent `antigravity/` directory, because Claude resolves `.claude-plugin/plugin.json` from the archive root.

Host adapters do not alter Antigravity's credentials, permission settings, credit settings, or model quotas. The runtime is portable Node 18.18+; see [Antigravity headless mode](https://antigravity.google/docs/cli/headless/) for the underlying CLI requirements. Installer behavior and Claude adapter conventions are package design, not documented Antigravity behavior.
