---
"agentlore": patch
---

Search hits now say `user decided` for a user turn that decides something, and `--said decision` (MCP `said: "decision"`) keeps only those. A cited file is checked on disk (`file gone now`, `line gone now`, `file changed since`). A hit that a later hit seems to correct ranks lower and says `corrected later? see <id>`. Chunks that mostly repeat a better hit, such as a prompt pasted into a subagent, are left out.
