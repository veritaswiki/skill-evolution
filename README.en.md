# 🧬 Skill Evolution (`skill-evolution`)

[![CI](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml/badge.svg)](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20.11-informational.svg)](#development)
[![Tests](https://img.shields.io/badge/tests-70%20passed-34d399.svg)](#development)
[![Hermes parity](https://img.shields.io/badge/Hermes%20parity-41%2F41-8b7cf6.svg)](#capability-parity-and-audits)

> In DSH the `skill` tool can load skills but cannot write them back. This plugin adds that write-back path: after a turn ends it reviews the session, distills the lesson into a skill draft, runs four code-level gates, and waits for your directive — with a ledger and single-entry rollback.

[中文文档 (README.md)](./README.md) · [Changelog (CHANGELOG.md)](./CHANGELOG.md)

---

## What it does

1. **Post-turn review** — listens on `turn/end` and `session/flush`, detects `user-correction`, `new-technique` and `skill-was-wrong` signals, throttles by `minTurnsBetween` turns / `minMinutesBetween` minutes (`.throttle.json`, cross-process), and bounds the snapshot by `maxMessages` and `maxChars`.
2. **The review is read-only** — it runs either in a host subagent fork (`subagents.startActivation`, tool allowlist `skill` / `glob` / `grep` / `read`) or against an OpenAI-compatible auxiliary endpoint. Neither path writes files: writes happen in the plugin, after the gates. A newer turn aborts the previous review, and every run has a timeout.
3. **Drafts by default** — with `mode: draft` output goes to `<skillsRoot>/.staging/` and the real skill library stays untouched. Promotion moves the draft into the skills directory, where DSH's skill filesystem hot-reloads it.
4. **Four code-level gates plus provenance protection** — see the gate table below. Only skills with `metadata.createdBy: agent` are ever auto-modified; user-authored skills are left alone.
5. **Ledger and single-entry rollback** — every create / patch / directive refinement / promotion / consolidation / archive appends to `.evolution_ledger.jsonl`, and file contents are stored deduplicated by SHA-256 under `.evolution_backups/blobs/`. Rollback takes a safety snapshot first and refuses (fail-closed) when that snapshot fails.
6. **Lifecycle and umbrella consolidation** — sidecar `.usage.json` telemetry drives `active → stale(14d) → archived(30d)` (zero-use immunity, `pinned` exemption, protected built-ins, archive never deletes). An LLM umbrella pass can merge narrow skills into class-level ones; it previews by default and does not touch disk.

---

## How it works

### Pipeline modules

| Stage | File | What it does |
|---|---|---|
| Collect | `lib/collector.js` | Strips system-injected blocks, detects review signals, throttles, digests older turns, trims to `maxChars` |
| Review | `lib/reflector.js` + `lib/prompts.js` | Read-only fork or auxiliary endpoint; prompts are verbatim from Hermes (see `vendor/hermes/`) |
| Synthesize | `lib/synthesizer.js` | Structured JSON → `SKILL.md` content (pure functions) |
| Gate | `lib/gatekeeper.js` | Four static checks, see the table below |
| Apply | `lib/applier.js` | draft/apply destination, provenance protection, draft promotion |
| Record | `lib/ledger.js` | JSONL ledger, SHA-256 blobs, single-entry rollback, rotation and blob GC |
| Lifecycle | `lib/usage.js` | `.usage.json` telemetry, three states, pinned/protected skills, adopt/disown |
| Consolidate | `lib/consolidation.js` | Prefix clustering plus LLM plan validation (atomic: one non-compliant entry rejects the batch) |
| Surface | `client.js` + `lib/http-api.js` | Web workbench and `/dsh-evolution/api/*` |

### The four gates (`lib/gatekeeper.js`)

| # | Check | Rejects |
|---|---|---|
| 1 | Name | Non-kebab-case, over 64 chars, session artifacts such as `fix-X` / `debug-Y` / PR numbers / dates, bare library names |
| 2 | Frontmatter | Missing `description`; `description` over 80 chars; `frontmatter.name` not matching the target |
| 3 | Forbidden content | Negative tool claims (`X tool does not work`), environment failures (`command not found`), one-off narratives |
| 4 | Size and paths | Body over 24000 chars; `add_reference` paths that are not `references/<topic>.md` or that carry date stamps |

### Client mount points (`client.js`)

| Slot | order | Content |
|---|---|---|
| `main` | — | Full workbench: overview / drafts / skills / ledger / settings views |
| `sidebar.panellist` | 15 | Sidebar entry |
| `settings.section` | 30 | Engine settings and status only, not the review workbench |
| `settings.section.icon` | — | Settings section icon |

Styling uses only host `--dsw-alias-*` tokens so it follows light and dark themes (720px container, 20/14/12 type scale, `.5px` row separators, 36×20 native switch).

### HTTP API (`lib/http-api.js`)

Prefix `/dsh-evolution`; `GET /dsh-evolution/mobile` returns the standalone mobile page.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-evolution/api/status` | Full state (skill counts, drafts with bodies and briefings, ledger, last review, throttle, config) |
| GET | `/dsh-evolution/api/skills` | Skill list (lifecycle state, use count, whether created by the agent) |
| GET | `/dsh-evolution/api/drafts` | Pending drafts (full `SKILL.md` plus `briefing`) |
| GET | `/dsh-evolution/api/skill/:name` | One skill in detail |
| GET | `/dsh-evolution/api/ledger` | Ledger entries (`?limit=`) |
| GET | `/dsh-evolution/api/ledger/:id` | One ledger entry with before/after SHA lists |
| GET | `/dsh-evolution/api/candidates` | Skills eligible for consolidation |
| POST | `/dsh-evolution/api/refine-draft` | Rewrite a draft from your directive and refresh the briefing |
| POST | `/dsh-evolution/api/promote` | Promote a draft (optionally fusing the directive first) |
| POST | `/dsh-evolution/api/promote-batch` | Atomic batch promotion |
| POST | `/dsh-evolution/api/discard` | Reject a draft |
| POST | `/dsh-evolution/api/tidy` | One-click triage of a draft backlog |
| POST | `/dsh-evolution/api/rollback` | Roll back by ledger `id` |
| POST | `/dsh-evolution/api/pin` | Pin / unpin |
| POST | `/dsh-evolution/api/adopt` · `/disown` | Take over / release a skill |
| POST | `/dsh-evolution/api/consolidate` | Umbrella consolidation (`dryRun: true` previews) |
| POST | `/dsh-evolution/api/config` | Save config |
| POST | `/dsh-evolution/api/review` | Trigger one review manually |

---

## Install

**Option A: plugin manager**

```bash
# installs into the given profile (a pnpm add inside that profile)
dsh plugin add github:veritaswiki/skill-evolution
```

Then add the package name to that profile's `dsh.profile.bundles` and restart DSH. The plugin's own `cordis.patch.yml` carries the defaults (it tightens the DSH skill catalog description cap from 500 to 80 chars, and inserts its own config).

**Option B: config file**

Skip the bundle and write into `~/.dsh/cordis.patch.yml`:

```yaml
- id: tool-skill
  config:
    catalogDescriptionMaxLength: 80
- insert:
    - id: skill-evolution
      name: 'skill-evolution'
      config:
        enabled: true
        mode: draft
```

**Option C: from source**

```bash
git clone https://github.com/veritaswiki/skill-evolution.git
dsh plugin add ./skill-evolution
```

After installing, `/evolution status` should show the skills root, mode, skill count, draft count and ledger entry count.

---

## Configuration

Defaults in `cordis.patch.yml` match the Schemastery definition in `index.js`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable post-turn review |
| `skillsRoot` | string | `""` (→ `~/.dsh/skills`) | Skills root; drafts, ledger and telemetry live here |
| `mode` | `"draft" \| "apply"` | `"draft"` | `draft` writes only to `.staging/`; `apply` writes into the library after the gates |
| `minTurnsBetween` | number | `1` | Minimum reviewable turns between two reviews |
| `minMinutesBetween` | number | `2` | Minimum minutes between two reviews |
| `maxMessages` | number | `24` | Recent messages kept in the snapshot |
| `maxChars` | number | `24000` | Snapshot character budget per review |
| `reviewTimeoutSeconds` | number | `180` | Per-review timeout |
| `reviewModel.provider` | string | `""` | Review-only provider; empty inherits the session model |
| `reviewModel.model` | string | `""` | Review-only model; empty inherits the session model |
| `reviewModel.reasoningEffort` | string | `""` | Passed through to the host |
| `curatorEnabled` | boolean | `true` | Enable lifecycle maintenance |
| `consolidate` | boolean | `false` | Run umbrella consolidation in the curator timer |
| `consolidateDryRun` | boolean | `true` | Consolidation previews only |
| `staleAfterDays` | number | `14` | Days of non-use before `stale` |
| `archiveAfterDays` | number | `30` | Days of non-use before moving to `.archive/` (no delete) |

Environment variables (all optional):

| Variable | Purpose |
|---|---|
| `DSH_EVOLUTION_BASE_URL` | OpenAI-compatible auxiliary endpoint (e.g. `https://host/v1`). Unset means reviews go through the host subagent fork |
| `DSH_EVOLUTION_API_KEY` | Bearer token for that endpoint |
| `DSH_EVOLUTION_MODEL` | Model name used on that endpoint |
| `DSH_EVOLUTION_PORT` | Fixed port for the standalone mobile service, default `18890` |
| `DSH_HOME` | DSH home directory, default `~/.dsh` |

### Commands and tools

`/evolution` subcommands: `brief [name]` / `drafts`, `refine <name> <directive>`, `approve <name> <directive>` (`promote` is an alias and also requires a directive), `reject <name> <directive>` (`discard` is an alias), `ledger`, `skills`, `adopt <name>`, `disown <name>`, `rollback <id>`, `review`, `consolidate [--apply]`, `status` (default).

The `evolution_review_center` tool targets chat and mobile clients: `action` is one of `brief`, `interactive_review` (default), `refine`, `approve`, `reject`.

---

## Known limitations

- **The auxiliary channel is yours to configure**: the package ships no gateway address and no credentials. Without `DSH_EVOLUTION_BASE_URL`, reviews go through the host subagent fork and you do not get the low-latency auxiliary path.
- **Gates cannot judge value**: the four gates are static checks (name, frontmatter, forbidden content, size). Whether a lesson is worth recording is still the model's call, so drafts need a human read.
- **The UI is Chinese only**: `locale/en.json` covers just the plugin name and description; the workbench has no English UI.
- **Interactive cards need host support**: `evolution_review_center` asks through the host `userQuestions` service. Without it, the tool falls back to Chinese briefing text and the user replies with a directive.
- **The local HTTP API has no authentication**: the fixed-port service binds `0.0.0.0:18890` for local or trusted-network use; if the port is taken it silently skips.
- **`mode: apply` writes the real skill library**: only for skills with `metadata.createdBy: agent`; the default is still `draft`.
- **Archiving does not free disk**: skills move to `.archive/` and you delete them yourself.
- **Body cap is 24000 chars**: beyond that, depth has to go into `references/`.

---

## Development

```bash
npm test                # 70 unit tests (node --test test/*.test.js)
npm run audit:parity    # 41-item capability audit (37 Hermes capabilities + 4 DSH-only)
npm run audit:prompts   # byte-level prompt fidelity (LESSON_LAYER_BLOCK / _DO_NOT_CAPTURE_BLOCK)
npm run sanitize        # sanitization gate, must report 0 hits
```

Requires Node ≥ 20.11 (`tools/*.mjs` use `import.meta.dirname`). CI runs the syntax check, the 70 tests, both audits and the sanitization gate.

### Capability parity and audits

`npm run audit:parity` checks each ported Hermes capability and lists the 4 DSH-only ones. `npm run audit:prompts` compares the two prompt blocks in `lib/prompts.js` byte for byte against `vendor/hermes/background_review.py` (currently 2098 / 1690 chars, identical).

`vendor/hermes/` is a verbatim copy of Nous Research `hermes-agent` (MIT), see [`vendor/hermes/PROVENANCE.md`](./vendor/hermes/PROVENANCE.md).

---

## License

[MIT](./LICENSE). Reference sources under `vendor/hermes/` come from Nous Research `hermes-agent`, also MIT.
