# Commands

Every command prints text for people. Where noted, `--json` prints the raw data instead.

| Command | What it does |
|---|---|
| `install <agent\|all> [--project] [--no-mcp]` | Adds Turnback hooks (and the MCP server unless `--no-mcp`) to the agent's config. Without `--project` it writes the user-level config. Other config is kept. |
| `uninstall <agent\|all> [--project]` | Removes only Turnback entries. |
| `list [--json]` | Turns, newest first: prompt, agent, and changed file count. |
| `diff <turn>` | Patch of what the turn changed. |
| `undo [--dry-run \| --yes] [--json]` | Returns the files to how they were before the latest turn. Run again to go one turn further back. |
| `redo [--dry-run \| --yes] [--json]` | Returns to the safety snapshot taken before the last restore or undo. |
| `restore <turn\|mark\|snapshot> [--path <p>...] [--dry-run \| --yes] [--json]` | Returns to the start of a turn, a mark, or a snapshot ref. `--path` limits it to some files. Without `--yes` it only prints the plan. |
| `recover <file> [--dry-run \| --yes] [--json]` | Brings back one file: the newest snapshot whose version differs from the file on disk, or, for a deleted file, the last snapshot that still had it. Other files are left alone. |
| `run [--label <text>] -- <command...>` | Runs any command as one turn of the `manual` agent, so `list`, `undo`, `diff`, and `report` work without an agent: a code generator, a codemod, a migration script, or an agent without hooks (`turnback run -- aider` records the whole session as one turn). The separator is optional; a leading `--label <text>` is still parsed without it. Missing commands or commands starting with `-` print usage and exit 2 without recording a turn. The command's exit code is passed through, and the turn is recorded even if the command fails. A single argument is run as a shell line; several arguments are quoted for the shell. |
| `steps <turn> [--json]` | Each edit and shell command of a turn. |
| `restore <turn> --before-step N` | Returns to just before step N and keeps the earlier steps. N must be a positive whole step number listed by `steps <turn>`. |
| `log <file\|folder> [--json]` | Turns that changed that path. |
| `blame <file> [-L <start>,<end>] [--json]` | For each line of a text file, the turn that last wrote it (number as in `list`, agent, time, prompt), `(before Turnback)`, or `(outside a turn)` for changes made between turns. Turns removed by `gc` fall back to `(before Turnback)`. |
| `search <text> [--json]` | Turns whose prompt, command, or paths match. |
| `mark <label>` / `marks [--json]` | Saves the whole workspace as a checkpoint that `restore <label>` returns to. Labels matching an existing full or short turn ID are refused; choose a different label. Existing marks can also be restored by their snapshot ref from `marks --json`. |
| `ui [--port <n>] [--no-open]` | Read-only timeline of turns, steps, and diffs in the browser. The port must be a whole number from 0 to 65535; omitted or 0 chooses an available port. |
| `report [--session <id>] [--html [--out <file>]]` | Markdown summary of the latest session, for a PR description or an audit. `--html` writes a self-contained page with each turn's diff instead. |
| `compare <a> <b> [--json]` | How two turns' results differ, for example two agents given the same task. |
| `export <turn...> [--out <file>]` | Prints the turns as a patch, or writes it to a file. |
| `export <turn...> --commit [--message <text>]` | Commits just those turns' files to your repository with the prompt as message, and refuses if they changed since. It is the only command that writes to your own git repository. |
| `stats [--days <n>] [--json] [--svg <file>]` | What agents did in this workspace over the last N days (default 7): turns per agent, files created, changed, and deleted, shell commands, and files brought back by restores. `--svg` writes a 1200×630 card to share. |
| `status [--json]` | Workspace, mode, storage, and any failed or skipped snapshots. |
| `gc` | Cleans up turns older than 7 days that are outside the last 50. Runs automatically at most once a day. |
| `--version` | Prints the installed version (also `-v` and `version`). |
| `mcp` | Starts the stdio MCP server (see [MCP](MCP.md)). |

Restoring changes project files; the agent's conversation is not restored, so tell the agent what changed.

For restore commands, --json without --yes (or with --dry-run) prints only the plan. With --yes, it prints one object combining the plan and result fields (applied, failed, and safety); an operation on an agent turn also includes a note that the conversation is not restored.

Set `{"prompts": false}` in `~/.turnback/config.json` to stop recording prompts.
