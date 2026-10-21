---
"agentlore": patch
---

Opt-in semantic search: `lore embed` installs Transformers.js into `~/.agentlore/runtime`, downloads a multilingual model once and embeds every chunk; `lore search` and the MCP `search` tool then fuse keyword and semantic matches (hits found only by meaning say `by meaning`), and `lore index` embeds new chunks. `lore embed --remove` turns it off, `--no-semantic` skips it for one search. Without `lore embed`, nothing changes and nothing is downloaded. Existing indexes are rebuilt once.
