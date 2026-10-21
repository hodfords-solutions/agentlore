---
"agentlore": minor
---

Add knowledge mode. `lore mode on|off [--here]` (and `lore mode reset --here`) turns it on globally or per folder, stored in `~/.agentlore/mode.json`. When it is on, the MCP server tells agents in every client to search past sessions at the start of each new task instead of only when earlier work matters. For Claude Code, `lore hooks install claude` adds a `UserPromptSubmit` hook (the settings file is backed up first; `lore hooks uninstall claude` and `lore hooks status` are also available). In knowledge mode the hook adds pointers to clearly related excerpts from other projects (the best one as a short passage, at most 900 characters in all) and asks the agent to call the `context` or `search` tool before answering; generic prompts get nothing. It never blocks a prompt. `lore` now loads the MCP SDK only for `lore mcp`, so the other commands start faster.
