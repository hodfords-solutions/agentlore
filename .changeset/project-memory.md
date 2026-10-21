---
"agentlore": patch
---

Project memory (docs/adr/0004): sessions save what they learned about a project as Markdown notes (`~/.agentlore/memory`, a brief plus topics, old versions kept) with the new MCP `remember` tool and read them with `recall`; notes are indexed and rank above transcripts. Where knowledge mode is on, Claude Code sessions start with the project's brief, topics and related projects (`SessionStart` hook), and a `Stop` hook now and then asks the agent to save what it learned; run `lore hooks install claude` again to add them. The prompt hook now includes the current project's other sessions. `lore consolidate` (opt-in, uses your Claude quota) updates notes from new sessions with `claude -p`, also daily with `lore schedule install --consolidate`. New commands: `lore memory`, `lore group`, `lore consolidate`.

Knowledge spreads between sessions faster: the `Stop` hook asks the agent to save a decision as soon as the user makes one (a turn with a decision word), not only after ~250 KB of transcript; open sessions are told at their next prompt which project notes changed; and a new `SessionEnd` hook indexes an ended session in the background. Run `lore hooks install claude` again to add it.

A user profile (`~/.agentlore/memory/_user/profile.md`) says how the user works and talks, for every project: sessions start with it, `recall`/`remember` read and save it with topic `user`, the `Stop` hook asks agents to save the user's corrections to it, and `lore consolidate` updates it from the user's own messages. `lore memory save` saves a note or the profile from the shell, for sessions whose MCP server predates `remember`.
