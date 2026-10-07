---
name: diff-turn
description: Show the file changes made during one agent turn recorded by Turnback. Use when the user asks what a specific turn changed.
argument-hint: "[turn-id]"
---

1. Use the turn ID in the user's request or invocation arguments. If none is given, call `list_turns` from the `turnback` MCP server with `limit` 1 and use that turn's ID. Always pass `workspace` set to the current project directory.
2. Call `diff_turn` with that `turn` and `patch` true.
3. Summarize the changes per file in a few lines, then show the patch. If the result says `truncated`, say so. For the full patch, resolve the installed plugin root from `PLUGIN_ROOT` (Codex) or `CLAUDE_PLUGIN_ROOT` (Claude Code) and run `node <plugin-root>/dist/cli.js diff <turn>` in the project directory, quoting the resolved path for the current shell. If the plugin root cannot be resolved, report that the CLI fallback is unavailable.
