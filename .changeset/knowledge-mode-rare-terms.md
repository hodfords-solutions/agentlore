---
"agentlore": patch
---

Knowledge mode no longer adds context to chatty prompts that share a single rare word with a past
session: at least 2 key terms must each be rare (in at most 5% of the index). The added note
now tells the agent that excerpts are what past sessions said, to be checked against the code.
