# ADR 0004: Project memory, a second brain over the transcripts

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

agentlore indexes every session, so any session can search what others said. That is episodic
memory: raw, complete and only reachable by asking the right question. A user who works on one
project across several sessions (one on the database, one on the code, one on the business rules)
still has no session that knows all of it. Each new session starts empty and only learns what it
thinks to search for. The prompt hook also left out the current project, assuming the agent sees
its own repo; it does not see what the project's other sessions learned.

A person who knows a project does not replay every conversation. They carry a consolidated
understanding (the gist, the decisions, the rules), recall it without effort when they walk into
the project, and look up details only when needed. Brains get there in steps that map onto
agentlore:

| Brain | agentlore |
|---|---|
| Episodic memory (hippocampus): every experience, fast | The index of transcripts (unchanged) |
| Consolidation (sleep): replay, keep the gist in the cortex | Notes per project, written by the working agent and by a nightly pass |
| Semantic memory (cortex): facts and rules, not episodes | Project notes: a brief plus topics, ranked above transcripts |
| Priming: context recalled on entering a place | The brief, the topic list and related projects added at session start |
| Association: one concept activates related ones | Groups of projects (one customer, one product) whose briefs come along |
| Reconsolidation: recalling updates the memory | A note is rewritten whole; the previous version is kept |
| Metacognition: knowing what you know | `recall` lists the topics known; the session-start context names them |

## Decision

1. **Notes are files**, `AGENTLORE_HOME/memory/<project-slug>/<topic>.md`, Markdown with a small
   front matter (project, topic, updated, by). The topic `brief` is the project overview. Users can
   read and edit them. They are user data, not cache: a rebuild never touches them (ADR 0001
   rule 3). Before a note is replaced, the old version goes to `.history/` (the last 10 per topic).
2. **Notes are indexed** by a `memory` adapter as `note` chunks, so `search` finds them, ranked
   above transcripts. A deleted note is removed from the index, not archived (ADR 0002 is for
   transcripts a tool deleted, not for a user's own edits).
3. **The working agent writes them** (`remember`, MCP), reading them first (`recall`). In knowledge
   mode a Claude Code `Stop` hook asks for it as soon as the user makes a decision (a user turn
   with a decision word of a language pack), and once a session has covered enough new ground, at
   most once per ~250 KB of transcript. A `SessionEnd` hook indexes the ended session in the
   background, so it is searchable at once.
4. **A nightly pass catches the rest** (`lore consolidate`, opt-in): for projects with new
   sessions since their last pass, it asks a model (`claude -p`, no tools, no MCP, no session
   saved, agentlore's hooks off) to update the notes from the new excerpts. Excerpts are redacted
   already and the output is redacted again. It is the only feature that sends data to a model,
   it costs the user's quota, and it runs only when the user turns it on.
5. **Sessions start primed.** In knowledge mode a `SessionStart` hook adds the project's brief, its
   topic list and its group's related projects (bounded). The prompt hook now includes the current
   project's other sessions too, leaving out only the current session, and tells an open session
   which notes changed since its last prompt.
6. **Groups** (`lore group`) link projects that belong together; a project's group siblings come
   with its brief and with `recall`.
7. **A user profile** (`_user/profile.md`) holds how the user works and talks, for every project:
   languages, answer length, what short replies mean, repeated rules, what they correct agents
   for. Sessions start with it (also outside any project); agents save it with `remember` topic
   `user`, asked to by the `Stop` hook when the user corrects them; consolidation updates it from
   the user's own messages in all projects, never the agents' turns, without names, paths or
   project facts. It is not indexed for search.
8. Notes are written by agents and can be wrong. They are labelled with who wrote them and when,
   framed as data, and agents are told to verify them against the code.

## Consequences

- A new session in a project knows its brief without searching, and every session can add to it.
- Notes can drift from the code. The nightly pass sees newer sessions and corrections; users can
  edit or delete a note, and `.history/` keeps what was replaced.
- The MCP tool list grows by two tools (~270 tokens per session).
- Consolidation spends the user's model quota; it is off until `lore schedule install --consolidate`
  or a manual `lore consolidate`, and bounded per run (projects and characters).
