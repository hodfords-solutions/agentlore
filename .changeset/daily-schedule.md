---
"agentlore": patch
---

New `lore schedule install|status|uninstall`: runs `lore index` once a day with the OS scheduler (launchd on macOS, a systemd user timer on Linux, Task Scheduler on Windows), so new sessions are indexed and deleted ones kept even on days nothing searches. `--at <HH:MM>` sets the time and `--dry-run` shows what would be written.
