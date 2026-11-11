# Security Policy

## Safety Invariants

`skill-evolution` enforces strict security boundaries by design:
- **Read-Only Review Fork**: The review fork cannot write files or execute shell commands directly; it emits structured JSON validated by `lib/gatekeeper.js`.
- **Provenance Isolation**: Skills without `metadata.createdBy: "agent"` are treated as user-owned and are never auto-modified.
- **No Destructive Deletes**: Archiving moves skills into `.archive/`; every mutation is recorded in `.evolution_ledger.jsonl` with content-addressed SHA-256 blobs and fail-closed rollback.
- **No bundled endpoint or credentials**: the package ships no gateway address and no keys. The optional auxiliary review channel is only used when `DSH_EVOLUTION_BASE_URL` (plus `DSH_EVOLUTION_API_KEY` / `DSH_EVOLUTION_MODEL`) is set by the user.
- **Local HTTP API is unauthenticated**: the workbench API and the fixed-port mobile page (default `18890`, `DSH_EVOLUTION_PORT`) are meant for local or trusted-network use. Do not expose them to the public internet.

## Reporting a Vulnerability

Please open a security advisory on GitHub at `https://github.com/veritaswiki/skill-evolution/security/advisories`.
