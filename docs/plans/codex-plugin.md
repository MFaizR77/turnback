# Codex plugin

## Outcome

Turnback installs as a Codex plugin containing hooks, the existing MCP server,
and the same four skills as Claude Code. Keep version 0.9.0 and do not publish
a release or tag during this work.

## Design

- Add `.codex-plugin/plugin.json`, selecting `hooks/codex.json`. Leave Claude
  Code's manifest and hook file in place. Use the documented compatibility
  format, verified against Codex CLI 0.160.1.
- Configure the local stdio MCP server in `mcp/codex.json`. Codex resolves its
  `cwd: "./"` to the installed plugin root; forward `TURNBACK_HOME` explicitly.
  Avoid root `.mcp.json`, which Claude Code auto-discovers.
- Adapt the existing skills to read arguments from the user's request, support
  either host's plugin-root variable for CLI fallback, and keep restore's
  plan/confirmation/token flow. Avoid duplicate skill folders.
- Detect an enabled Turnback plugin in Codex user/project TOML configuration
  before installing manual hooks or MCP. Use a TOML parser, respect project
  overrides, and never change unrelated configuration. Document removal of
  pre-existing manual Turnback entries before switching to the plugin.
- Include the Codex manifest and MCP configuration in the npm package.
  Codex's npm marketplace entry remains unavailable until a new npm version
  containing these files is released; the existing published 0.9.0 is unchanged.

## Work and validation

1. Add packaging and share the skills across the two hosts.
2. Add installer detection and regression tests for enabled/disabled plugins,
   project overrides, custom `CODEX_HOME`, and malformed TOML.
3. Build an npm tarball and install it through a temporary local Codex
   marketplace with an isolated `CODEX_HOME`.
4. Check that the installed package exposes four skills, Codex hooks, and MCP;
   record a destructive turn through its hook commands and restore via MCP.
5. Run the full test suite, validate the changed skills, update installation
   docs, and review the diff before merging and pushing main.

## References

- https://developers.openai.com/plugins/build/plugins
- https://learn.chatgpt.com/docs/hooks

Codex hooks require trust in `/hooks`. Marketplace distribution is separate
from the public plugin directory, which currently excludes lifecycle hooks.

## Validation result

- Codex CLI 0.160.1 installed the npm tarball from an isolated local marketplace.
  Its native app server discovered four skills, four Codex hooks, and 13 MCP tools.
  A native `status` call confirmed that `TURNBACK_HOME` reaches the server.
- Plugin integration tests delete both a regular file and a gitignored `.env`,
  then verify restore and redo through MCP, without `node_modules` and with
  spaces in the plugin path.
- The full suite passed: 268 tests in 33 files. Shared skill frontmatter/body
  validation passed, preserving Claude-specific invocation fields; Codex also
  loaded all four skills natively. Claude marketplace validation passed.
