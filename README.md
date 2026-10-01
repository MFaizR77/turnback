# Turnback

**Undo for AI coding agents, even after `rm -rf`.**

One undo history for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and Antigravity CLI.

[![npm](https://img.shields.io/npm/v/turnback)](https://www.npmjs.com/package/turnback)
[![CI](https://github.com/MFaizR77/turnback/actions/workflows/ci.yml/badge.svg)](https://github.com/MFaizR77/turnback/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![An agent runs rm -rf src .env; turnback undo brings both back](docs/demo.gif)

<sub>A real Turnback run. The agent is simulated with Claude Code's hook payloads; the `rm -rf` and every Turnback line are real. Recreate it with `python scripts/demo/make_demo.py`.</sub>

## Why

Agent checkpoints track the agent's own edit tools. Claude Code's documentation says it plainly: ["Checkpointing does not track files modified by Bash commands."](https://code.claude.com/docs/en/checkpointing#bash-command-changes-not-tracked) So when an agent runs `rm -rf`, `mv`, a code generator, or `git checkout -- .`, rewind cannot bring those files back.

Turnback snapshots the workspace before every shell command and edit, into a shadow git repo under `~/.turnback`:

- Undo a whole turn, or go back to just before one step of it.
- Tracked, untracked, and gitignored files (like `.env`) up to 5 MB are covered.
- Nothing writes to your project's `.git` unless you run `turnback export --commit`, and hooks never block the agent.
- One history across six agents. Through MCP, the agent can list and diff its own turns and restore them in two steps: a plan first, then the change.

## Install

In Claude Code:

```bash
claude plugin marketplace add MFaizR77/turnback
claude plugin install turnback@turnback
```

Then use `/turnback:turns`, `/turnback:diff-turn`, `/turnback:undo`, and `/turnback:report`.

For Codex, Cursor, Gemini CLI, OpenCode, Antigravity CLI, or the CLI on its own (Node.js 22+ and Git 2.25+):

```bash
npm install -g turnback
turnback install all            # user-level hooks and MCP for every agent
turnback install codex --project  # or one agent, in this project only
```

Claude Code, Codex, OpenCode, and Antigravity CLI have been tested live; Gemini CLI and Cursor are covered by tests built from their documented hook payloads. Details per agent: [installation](guide/INSTALL.md).

## Compared with Claude Code's `/rewind`

| | `/rewind` | Turnback |
|---|---|---|
| Edits made by the agent's edit tools | ✅ | ✅ |
| Files changed by shell commands (`rm`, `mv`, codegen) | ❌ | ✅ |
| Untracked and gitignored files | only files its edit tools changed | ✅ up to 5 MB |
| Other agents | ❌ | Codex, Cursor, Gemini CLI, OpenCode, Antigravity CLI |
| Go back to a point inside a turn | ❌ | ✅ `--before-step` |
| Rewind the conversation | ✅ | ❌ files only |

They work side by side: rewind the conversation with `/rewind`, and the files with Turnback.

## Everyday use

```bash
turnback list                       # recent turns with their prompts
turnback diff <turn>                # what a turn changed
turnback undo --dry-run             # show the plan
turnback undo --yes                 # undo the latest turn
turnback redo --yes                 # changed your mind
turnback steps <turn>               # each edit and shell command in a turn
turnback restore <turn> --before-step 3 --yes
turnback mark "before migration"    # a checkpoint of your own
turnback run -- npm run codegen     # any command as an undoable turn, no agent needed
turnback recover src/app.ts         # bring back one file (or a folder) an agent deleted turns ago
turnback blame src/auth.ts          # which turn and prompt wrote each line
turnback ui                         # timeline in the browser
```

### Without an agent

`turnback run` records any command as a turn, so a code generator, a codemod, or an agent without hooks gets the same undo. `blame` shows which turn wrote each line, and `recover` brings back a single file:

![turnback run records a code generator; blame shows its lines; recover brings back the file it deleted](docs/demo-cli.gif)

All commands, including `log`, `search`, `report`, `compare`, and `export`: [commands](guide/COMMANDS.md). More: [restore](guide/RESTORE.md), [MCP](guide/MCP.md), [scope and limits](guide/LIMITS.md).


## How it works

The hook before a mutating tool takes the turn baseline. The hook before a shell command captures the whole tree; later edits capture the affected paths. The end of the turn captures the result. The initial snapshot is warmed in the background on install and session start. Hooks always let the agent continue when recording fails; a `failed`, `skipped`, or `unprotected` state is visible through `status`.

Tracked, untracked, and gitignored files up to 5 MB are covered. Build output and dependency directories are excluded. Extra rules use gitignore syntax in `.turnbackignore`; global rules go in `~/.turnback/config.json` as `{"exclude":["pattern"]}`.

Workspaces above 100k files or 2 GB switch to `edits-only` mode: only paths touched by edit tools are snapshotted, shell commands are recorded as `unprotected`, and restore touches only recorded paths. Turns older than 7 days and outside the last 50 turns are cleaned up automatically, at most once a day.

## Contributing

Issues labeled [`good first issue`](https://github.com/MFaizR77/turnback/labels/good%20first%20issue) are small and say which files they touch, and [support for more agents](guide/ADAPTERS.md) is welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture overview](guide/ARCHITECTURE.md). Questions and ideas go to [Discussions](https://github.com/MFaizR77/turnback/discussions).

### Contributors

[![Contributors](https://contrib.rocks/image?repo=MFaizR77/turnback)](https://github.com/MFaizR77/turnback/graphs/contributors)

Every merged pull request is credited in the release notes.

## Development

| Module | Contents |
|---|---|
| `src/cli/` | `main.ts`: CLI and hook entry point (built as `dist/cli.js`); `args.ts`: argument parsing |
| `src/core/` | `recorder.ts`: snapshot rules per event; `store.ts`: journal, snapshots, turns, steps, marks, status, `gc`; `restore.ts`: restore planning and execution, undo, redo; `format.ts`: text output; `quote.ts`: shell-safe arguments; `journal.ts`, `lock.ts`, `config.ts`, `types.ts` |
| `src/git/` | `shadow.ts`: shadow git repo wrapper |
| `src/workspace/` | `workspace.ts`: workspace scanning and exclusion rules |
| `src/agents/` | `adapters.ts`: each agent's hook payload → `HookEvent`; `install.ts`: hook and MCP installation per agent; `opencode-plugin.ts`: generated OpenCode plugin |
| `src/mcp/` | `server.ts`: stdio MCP server |
| `src/ui/` | `server.ts`: read-only local server for `turnback ui`; `page.ts`: its single page |

```bash
npm run check
npm run bench
```

The benchmark creates a temporary 10k-file repo and reports latency without making it a strict CI gate. CI runs the tests and benchmark on Windows, macOS, and Linux × Node 22/24.

From a clone, run `npm ci && npm run build` and use `node dist/cli.js` in place of `turnback`.

## Releasing

Set the same version in `package.json` and in both version fields of `server.json`, commit, then push a `v<version>` tag. The `Publish` workflow checks that the versions match, runs the tests, publishes to npm through trusted publishing (provenance is attached automatically), and publishes `server.json` to the MCP registry as `io.github.MFaizR77/turnback`.

npm trusted publishing is configured on the package page at npmjs.com (repository `MFaizR77/turnback`, workflow `publish.yml`), which needs the package to exist. The first version is therefore published once by hand with `npm publish --access public`; pushing its tag afterwards skips npm (the version exists) and only publishes to the MCP registry. Later tags do both.

## License

MIT
