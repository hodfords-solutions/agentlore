---
"agentlore": patch
---

Sessions whose transcript is deleted (Claude Code deletes transcripts inactive for 30 days by default) now stay searchable: agentlore archives what it indexed from them, keeps it across rebuilds and redacts it again when the rules change. `lore forget <id>` removes such a session, and `lore status` shows how many are kept. Existing indexes are rebuilt once.
