---
"agentlore": patch
---

Search hits now say who said their matching part (`user said`, `agent cites <file:line>`, `agent cites <file:line> + unverified claims`, `agent claim, unverified`, `agent task`; a citation only covers the sentence it is in), and rank an agent's unverified conclusions and agent-to-agent tasks below the user's words and answers that cite a file. Redaction now also covers passwords written in prose next to a login or password word (``login `user / secret` ``, ``password (`secret`)``, in English and Vietnamese) and later mentions of a secret in the same message; existing indexes are rebuilt once.
