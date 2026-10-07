---
name: report
description: Write a markdown report of the latest agent session recorded by Turnback, with each turn's prompt, commands, and changed files. Use for PR descriptions, audits, or daily notes.
argument-hint: "[session-id]"
---

Call the `session_report` tool from the `turnback` MCP server with `workspace` set to the current project directory and `session` set to the session ID in the user's request or invocation arguments, when provided. Show the markdown as returned. If the user wants a PR description, rewrite it into a short summary followed by the file list, and keep every file path and command exactly as reported. Applying a report to a pull request requires the user's request to update that pull request.
