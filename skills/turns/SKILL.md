---
name: turns
description: List recent agent turns recorded by Turnback, with their prompts and changed files. Use when the user asks what the agent changed recently or which turn to undo.
argument-hint: "[limit]"
---

Call the `list_turns` tool from the `turnback` MCP server with `workspace` set to the current project directory and `limit` set to the number requested by the user or supplied in invocation arguments, otherwise 10. Show the result as returned: one line per turn with its number, time, agent, changed files, and prompt, followed by its ID. The user can ask Turnback to show a turn's diff or undo it by ID.
