---
"agentlore": patch
---

Hardening from a code review:

- Redact passwords in `curl -u user:pass`, `redis-cli -a pass` and `Authorization: token …`, and in password values that look like a one-folder path. Existing indexes are rebuilt once so the new rules apply to old content.
- Search and the prompt hook leave out the current project and session inside the query, so a project with many matching chunks no longer hides matches from other projects.
- Indexing is safe when two processes index the same source: the lock is never taken from a live process, a holder that lost the lock stops, and a save made from an outdated checkpoint is refused instead of duplicating chunks. An older agentlore no longer rebuilds an index written by a newer one.
- Lines over 64 MiB are skipped instead of failing the file on every run.
- `lore mode on|off|reset` refuses to overwrite an invalid `mode.json` (it used to drop every saved rule); `lore hooks status` reports an invalid `settings.json` instead of "not installed"; `lore search -n` accepts at most 100.
- Excerpts neutralise markup-like tags; the Windows hook command escapes `$` and backticks; a refused settings write no longer rotates out older backups; an existing `AGENTLORE_HOME` keeps its permissions.
