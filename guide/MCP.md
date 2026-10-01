# MCP

`node dist/cli.js mcp` runs a stdio server. `install` registers it for the selected agents. This process's stdout carries only the MCP protocol.

Read tools: `list_turns`, `diff_turn`, `turn_steps`, `file_history`, `search_turns`, `diff_range`, `session_report`, `compare_turns`, `blame_file`, `recover_file`, `status`. `blame_file` gives each line of a file the turn that last wrote it (optionally `start`/`end`). `recover_file` finds the newest snapshot with a different version of one file or folder and returns a `target` and `paths` for `restore` (for a folder, only its files that are missing or different); it writes nothing itself. `diff_range` shows what changed from a turn start, mark, or ref to another point, or to the current files when `to` is omitted; for that it takes an internal snapshot that gc removes after a day. No MCP tool writes to the user's git repository. Write tools: `restore`, `redo`. All accept an optional `workspace`. `restore` takes a `target` (turn ID, mark label, or snapshot ref such as a step `ref` from `turn_steps`) and optional `paths`; `redo` uses the safety snapshot of the last restore. The first call without `token` returns a plan and a `confirm_token`. The second call sends that token as `token`. The server rechecks the plan under the lock before writing.

```json
{"name":"restore","arguments":{"target":"<turn-id>","workspace":"/path/to/project"}}
{"name":"restore","arguments":{"target":"<turn-id>","workspace":"/path/to/project","token":"<confirm_token>"}}
```

For files the user may have edited, the server uses the MCP SDK v2 `inputRequired` mechanism when the client advertises elicitation support. If the client does not support it or declines approval, those files are skipped and the CLI is suggested. See [SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) and the [2026-07-28 protocol migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).
