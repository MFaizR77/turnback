---
name: undo
description: Undo the file changes of an agent turn with Turnback, including shell commands and untracked files, when the user requests a restore or invokes Turnback undo.
argument-hint: "[turn-id] [file ...]"
disable-model-invocation: true
---

Restore project files with the `turnback` MCP tools from this plugin. Always pass `workspace` set to the current project directory.

1. Call `list_turns` with `limit` 5. If the user's request or invocation arguments name a turn ID, use it; otherwise use the newest turn. Tell the user which turn: its time, agent, prompt, and changed file count. If the user wants to keep part of the turn, call `turn_steps` and use the `ref` of the first step to undo as the `target`; that returns the files to just before that step. If the user only wants one file or folder back (for example one deleted several turns ago), call `recover_file` with its `path` and use the returned `target` and `paths` instead.
2. Call `restore` with `target` and, if the user named files, `paths`. This call only returns a plan and a `confirm_token`; nothing is written yet.
3. Show the plan: files to rewrite, delete, or recreate. Point out actions marked `uncertain`; those files may contain the user's own edits.
4. Ask the user to confirm. Only after a clear yes, call `restore` again with the same arguments plus `token` set to `confirm_token`.
5. Report restored, skipped, and failed files and the safety snapshot. Files you read earlier in this conversation may have changed: read them again before editing. The user can reverse this with the `redo` tool.

If MCP is unavailable, resolve the installed plugin root from `PLUGIN_ROOT` (Codex) or `CLAUDE_PLUGIN_ROOT` (Claude Code) and run `node <plugin-root>/dist/cli.js` in the project directory. Quote the resolved path for the current shell. Use `undo --dry-run` for the latest turn, `restore <turn> --dry-run` for a named turn, or `recover <path> --dry-run` for one file or folder. Preserve any requested `--path` or `--before-step`. Show the plan and, after confirmation, run the same command with `--yes` instead of `--dry-run`. If the plugin root cannot be resolved, report that the integration is unavailable.
