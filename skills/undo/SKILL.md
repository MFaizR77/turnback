---
name: undo
description: Undo the file changes of an agent turn with Turnback, including shell commands and untracked files. Run only when the user invokes /turnback:undo.
argument-hint: "[turn-id] [file ...]"
disable-model-invocation: true
---

Restore project files with the `turnback` MCP tools from this plugin. Always pass `workspace` set to the current project directory.

1. Call `list_turns` with `limit` 5. If "$ARGUMENTS" names a turn ID, use it; otherwise use the newest turn. Tell the user which turn: its time, agent, prompt, and changed file count. If the user wants to keep part of the turn, call `turn_steps` and use the `ref` of the first step to undo as the `target`; that returns the files to just before that step. If the user only wants one file or folder back (for example one deleted several turns ago), call `recover_file` with its `path` and use the returned `target` and `paths` instead.
2. Call `restore` with `target` and, if the user named files, `paths`. This call only returns a plan and a `confirm_token`; nothing is written yet.
3. Show the plan: files to rewrite, delete, or recreate. Point out actions marked `uncertain`; those files may contain the user's own edits.
4. Ask the user to confirm. Only after a clear yes, call `restore` again with the same arguments plus `token` set to `confirm_token`.
5. Report restored, skipped, and failed files and the safety snapshot. Files you read earlier in this conversation may have changed: read them again before editing. The user can reverse this with the `redo` tool.

If the MCP tools are unavailable, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" undo --dry-run` in the project directory, show the plan, and after confirmation run it again with `--yes`.
