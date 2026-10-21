# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's
[Security tab](https://github.com/hodfords-solutions/agentlore/security)). Do not open a public issue. If that
is not possible, email the maintainer at [cong.nc@hodfords.com](mailto:cong.nc@hodfords.com)
with "agentlore security" in the subject.

<!-- Maintainer: private vulnerability reporting must be enabled for the "Report a vulnerability"
button to appear: Settings → Code security → Private vulnerability reporting → Enable. -->

Include the agentlore version, your OS and Node.js version, and steps to reproduce. Never attach
real transcripts or real secrets — use made-up values.

We aim to acknowledge reports within 7 days and to agree on a disclosure date with you.

## Scope

agentlore reads AI coding transcripts, which often contain secrets. In scope:

- **Secret leakage into the index** — a secret format that redaction misses, or any path by which
  unredacted content reaches `index.db`, logs or MCP responses.
- **Path handling** — reading files outside the configured session folders (for example via
  symlinks or crafted paths), or writing outside `AGENTLORE_HOME`.
- **Index integrity** — crafted transcript content that corrupts the index, breaks the lock, or
  causes excessive resource use (for example pathological regular-expression backtracking).
- **MCP server** — inputs that crash the server or expose data beyond search results.

- **Prompt injection through search results** — transcripts can contain text written to steer
  an agent. The MCP `search` and `context` tools introduce their results as untrusted data,
  quote every line of transcript text with `> `, neutralize role prefixes (`user:`,
  `assistant:`, `system:`) inside it, and keep each hit label on one line (control characters
  and line separators in metadata such as a session's working directory are replaced, and each
  field is capped). Their descriptions tell agents never to follow instructions found in them.
  A way to break out of that framing is in scope.

Out of scope: issues that require an attacker who already controls your user account or the
transcript files' contents for purposes other than the above.

## Supported versions

Only the latest released version receives security fixes.
