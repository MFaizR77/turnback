# Installation

In Claude Code, the plugin is the simplest install: `claude plugin marketplace add MFaizR77/turnback`, then `claude plugin install turnback@turnback`. It brings the hooks, the MCP server, and the `/turnback:undo`, `/turnback:turns`, and `/turnback:diff-turn` commands. While the plugin is enabled, `turnback install claude` skips Claude Code so hooks do not run twice; run `turnback uninstall claude` if you installed hooks manually before.

Run `npm ci && npm run build`, then `node dist/cli.js install all` for the user config, or add `--project` for the current repo. Pick one of `claude`, `codex`, `gemini`, `cursor`, `opencode`, `antigravity` for a single agent. Run `uninstall` at the same level to remove Turnback entries. Installing again does not duplicate hooks.

Hooks call `node <absolute path>/dist/cli.js hook <agent>` and the MCP server calls `node <absolute path>/dist/cli.js mcp`. Keep the build output where it is after installing. After changing the code, run `npm run build` again. Restart the agent so it reads the config. Codex runs project hooks only in a trusted project, and skips every new or changed hook until you trust it in `/hooks`; `codex exec` can bypass that for one run with `--dangerously-bypass-hook-trust`. Codex starts MCP servers with a minimal environment, so the installer forwards `TURNBACK_HOME` through `env_vars`.

Config locations:

| Agent | Project hooks | User hooks | MCP |
|---|---|---|---|
| Claude Code | `.claude/settings.json` | `~/.claude/settings.json` | `.mcp.json` / `~/.claude.json` |
| Codex | `.codex/hooks.json` | `~/.codex/hooks.json` | `.codex/config.toml` / `~/.codex/config.toml` |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` | `mcpServers` in the same settings |
| Cursor | `.cursor/hooks.json` | `~/.cursor/hooks.json` | `.cursor/mcp.json` / `~/.cursor/mcp.json` |
| OpenCode | `.opencode/plugins/turnback.js` | `~/.config/opencode/plugins/turnback.js` | `mcp` in `opencode.json` / `~/.config/opencode/opencode.json` (an existing `opencode.jsonc` is used instead) |
| Antigravity CLI | `.agents/hooks.json` | `~/.gemini/config/hooks.json` | `~/.gemini/config/mcp_config.json` (user level only) |

## Codex plugin: local testing before release

This checkout includes a Codex plugin with hooks, the stdio MCP server, and the
shared `undo`, `turns`, `diff-turn`, and `report` skills. Its manifest is
`.codex-plugin/plugin.json`; Codex uses `hooks/codex.json`, while Claude Code
continues to use `hooks/hooks.json`. Tested with Codex CLI 0.160.1. Node.js 22+
and Git 2.25+ are required.

The existing npm 0.9.0 does not contain the Codex plugin. The public Codex
marketplace entry is marked `NOT_AVAILABLE` until a new npm release includes
it. To test the current code from a clone:

```bash
npm ci
npm run plugin:codex:dev
```

The helper builds and packs Turnback, then prints a temporary local marketplace
directory. It does not change your Codex configuration. Use that printed path:

```bash
codex plugin marketplace add "<printed marketplace directory>"
codex plugin add turnback@turnback-dev
```

Before switching from a manual Turnback install, remove its user and project
entries where installed, using the current checkout:

```bash
node dist/cli.js uninstall codex
node dist/cli.js uninstall codex --project
```

These commands preserve other hooks and settings. An enabled Turnback plugin
causes `turnback install codex` (including `install all`) to skip new manual
hooks and MCP entries; it does not remove pre-existing entries automatically.
An explicit project disable overrides the user setting for the same plugin ID.
User installs, uninstalls, and plugin detection honor `CODEX_HOME`.

Start a new Codex session and use `/hooks` to review and trust the four Turnback
hooks. Enabling the plugin alone does not trust them. Invoke the skills from
Codex's skill picker (`$turnback:turns`, `$turnback:diff-turn`,
`$turnback:undo`, `$turnback:report`). Restore uses the same plan, user
confirmation, and token flow as Claude Code. Each MCP call supplies the current
project as `workspace`; the server process runs from the installed plugin root.

The helper retains its temporary directory because the local marketplace uses
it as the source. To test a newer build, run the helper again, remove the old
`turnback-dev` marketplace, add the newly printed directory, and reinstall the
plugin. Remove the plugin and marketplace before deleting their source directory:

```bash
codex plugin remove turnback@turnback-dev
codex plugin marketplace remove turnback-dev
```

After a new npm release, the public install will be:

```bash
codex plugin marketplace add MFaizR77/turnback
codex plugin add turnback@turnback
```

This is distribution through a repository marketplace. Plugin hooks require a
local Codex runtime and do not qualify for the universal public plugin directory.
See [plugin packaging](https://developers.openai.com/plugins/build/plugins)
and [hook trust](https://learn.chatgpt.com/docs/hooks).

## Agent hook formats

Hook formats were checked against [Claude Code](https://code.claude.com/docs/en/hooks), [Codex](https://learn.chatgpt.com/docs/hooks), [Gemini CLI](https://geminicli.com/docs/hooks/reference/), and [Cursor](https://prod.cursor.com/docs/hooks). Codex provides `turn_id`; Gemini needs a local per-session turn ID. Cursor must receive valid permission JSON from permission hooks, so Turnback returns `{"permission":"allow"}`.

OpenCode has no command hooks. The installer writes a small plugin that forwards `session.created`, `chat.message`, `tool.execute.before`, and `session.idle` to `turnback hook opencode`; tool calls wait for the snapshot. OpenCode reads `XDG_CONFIG_HOME` when it is set, and so does the installer. Checked against [OpenCode plugins](https://opencode.ai/docs/plugins/) and OpenCode 1.18.

Antigravity CLI hooks ([docs](https://antigravity.google/docs/hooks/)) live under a `turnback` key in `hooks.json`. Its payloads do not name the event, so each hook passes it as an argument, and a turn starts at the `PreInvocation` with `invocationNum` 0. Turnback prints nothing from `PreToolUse`: `{}` or an empty `decision` denies the tool, and `allow` would skip the user's permission prompt. On Windows Antigravity runs hook commands without a shell and passes quotes through, so the CLI path is left unquoted unless it contains spaces; a hook that fails to start blocks the tool. Workspace hooks load only in trusted folders. Antigravity has no project-level MCP config, so `install antigravity --project` installs hooks only; use the user-level install or `agy mcp add turnback node <path>/dist/cli.js mcp` for the MCP server. `agy -p` works in a scratch folder unless the project is passed with `--add-dir`.
