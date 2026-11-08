# Security Policy

## Safety Invariants

`skill-evolution` enforces strict security boundaries by design:
- **Read-Only Review Fork**: The review fork cannot write files or execute shell commands directly; it emits structured JSON validated by `lib/gatekeeper.js`.
- **Provenance Isolation**: Skills without `metadata.createdBy: "agent"` are treated as user-owned and are never auto-modified.
- **No Destructive Deletes**: Archiving moves skills into `.archive/`; every mutation is recorded in `.evolution_ledger.jsonl` with content-addressed SHA-256 blobs and fail-closed rollback.

## Reporting a Vulnerability

Please open a security advisory on GitHub at `https://github.com/veritaswiki/skill-evolution/security/advisories`.
