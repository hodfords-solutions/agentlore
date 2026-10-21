---
"agentlore": patch
---

`lore search` takes `--since`/`--until` (dates or ISO 8601 times) and `--said user`, and the MCP `search` tool takes the same as `since`, `until` and `said`. A new `lore coverage` command shows how many sessions are indexed per month and tool. Sessions written to in the last 30 minutes, usually the asking one echoing the query, now rank below older ones. A query word typed with Vietnamese diacritics no longer matches a different accented word (`xây` finds `xay`, not `xảy`). Existing indexes are rebuilt once.
