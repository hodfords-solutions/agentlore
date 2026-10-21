---
"agentlore": patch
---

Redaction now covers a `user/password` or `user:password` pair right after an IPv4 address (`203.0.113.7 root/ secret`, also on the next line), and no longer takes an IP address quoted after a password word for the password. Existing indexes are rebuilt once.
