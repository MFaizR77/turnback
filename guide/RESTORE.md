# Restore

`turnback list` shows turn IDs. `turnback diff <id>` shows the changes from the baseline to the turn's last snapshot. Preview with `turnback restore <id> --dry-run`; select files with a repeated `--path src/file.ts`. Apply with `--yes`. `turnback undo --yes` picks the most recent turn not yet undone. `turnback redo --yes` uses the safety snapshot taken before the last restore. A new agent turn starts a new history: the next undo targets that turn, and earlier undos can no longer be redone.

In `edits-only` mode (`scope: recorded-paths` in the preview), restore touches only paths recorded by edit hooks since the target point; other files are left alone.

Before writing anything, Turnback takes a safety snapshot. Files are rewritten as their original bytes, including BOM and CRLF. Files created by the agent are deleted when restoring to the baseline; files deleted by the agent are recreated. Executable bits and symlinks are restored when the OS allows. If a file fails to write, the CLI exits with code 1 and lists the failures.

MCP tokens are bound to the target, the selected paths, and a hash of the workspace state. Stale tokens are rejected under the lock. A file counts as possibly edited manually when it changed since the end of the last finished turn. Files an agent is changing with its edit tools in a turn that is still running do not count, so an agent can undo its own unfinished work; changes made by shell commands in that turn still count, since Turnback cannot tell them from yours. Without direct approval support from the MCP client, files that may have been edited manually are skipped; use the CLI to inspect and restore them. After a restore, start a new agent conversation or tell the agent that the files have changed.

## Steps

`turnback steps <id>` lists the edit and shell steps of a turn. Each step has the snapshot taken just before it ran, so `turnback restore <id> --before-step N` returns the workspace to that point and keeps the work of steps 1 to N-1. Steps marked `unprotected` or `failed` have no snapshot and cannot be chosen. Over MCP, `turn_steps` returns each step's `ref`; pass it to `restore` as `target`.

## Marks

`turnback mark <label>` snapshots the whole workspace under a label, for example before letting an agent run unattended. `turnback marks` lists them and `turnback restore <label>` returns to one; a reused label resolves to the newest mark. New labels matching an existing full or short turn ID are refused, since a turn ID takes precedence over a mark with the same name. To restore an existing mark whose name collides, pass its snapshot `ref` from `turnback marks --json` instead. Marks are never removed by gc and are unavailable in `edits-only` mode.

## File history and UI

`turnback log <file|folder>` lists the turns whose changes include that path, newest first. `turnback ui` serves a read-only timeline on 127.0.0.1 under a random URL token and opens it in the browser (`--no-open` only prints the URL, `--port` picks the port). It never changes files; it shows the CLI command for each restore instead.

## Export and compare

`turnback export <turn...>` prints one patch from the oldest turn's baseline to the newest turn's end, limited to the files those turns changed; `--out <file>` writes it to a file for `git apply`. `turnback export <turn...> --commit` commits those files to your own repository with the prompt as message (`--message` overrides it). Only those paths are committed, so anything else you staged stays staged; files your repository ignores, such as `.env`, are skipped and listed; and the command refuses when a file no longer matches the newest turn's result. This is the only Turnback command that writes to your git repository.

`turnback compare <a> <b>` compares the results of two turns on the files either of them changed: changed only by one, by both with different results, or by both with the same result, followed by the diff from A to B.
