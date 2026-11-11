# Vendored Hermes source — provenance and porting notes

These files are **verbatim copies** of the Hermes agent source (Nous Research, MIT licensed)
that this plugin ports. They are kept here as the authoritative reference: every ported
constant, guard, and invariant in `lib/` is meant to be checked against these files, not
against a paraphrase.

## Provenance

| | |
|---|---|
| Upstream | Nous Research `hermes-agent` |
| Vendored on | 2026-11-07 |
| License | MIT (see upstream `LICENSE`) |

## Files

| File | Lines | What it is | Ported into |
|---|---|---|---|
| `background_review.py` | 1390 | Per-turn background review fork + the three review prompts | `lib/prompts.js`, `lib/reflector.js` |
| `curator.py` | 1214 | Inactivity-triggered skill lifecycle orchestrator + consolidation prompt | `lib/usage.js`, `index.js` curator timer |
| `skill_ledger.py` | 633 | Per-mutation JSONL ledger, sha256 blobs, single-edit rollback | `lib/ledger.js` |
| `skill_usage.py` | 773 | Sidecar `.usage.json` telemetry + active/stale/archived lifecycle | `lib/usage.js` |
| `skill_provenance.py` | 44 | Write-origin ContextVar (foreground vs background_review) | `lib/provenance.js` |
| `skill_manager_tool.py` | 943 | Agent-managed skill create/patch/write_file/delete | `lib/applier.js` |
| `skill_manager_guards.py` | 286 | Write/delete guards for `skill_manage` | `lib/applier.js` (provenance check) |
| `skills_guard.py` | — | Optional security scan for agent-created skills | not ported (opt-in upstream, off by default) |

## What is ported verbatim vs. adapted

### Verbatim (do not paraphrase)

- **The three review prompts** in `background_review.py`:
  `_SKILL_REVIEW_PROMPT`, `_COMBINED_REVIEW_PROMPT`, `_LESSON_LAYER_BLOCK`,
  `_DO_NOT_CAPTURE_BLOCK`, `_MEMORY_ROUTING_BLOCK`.
  These encode what to save, what must never be saved, and what a good skill looks like.
  `lib/prompts.js` reproduces them with only these substitutions:
  - `skill_view` / `skills_list` / `skill_manage` → DSH's `skill` tool and the write path
  - `~/.hermes/skills/` → the DSH skills root
  - tool-name references that do not exist in DSH

  Everything else — every rule, every example, every warning — is unchanged. If you edit
  `lib/prompts.js`, diff it against this file first and justify the change.

- **The lifecycle invariants** in `skill_usage.py`:
  - telemetry lives in a sidecar file, never in `SKILL.md` frontmatter
  - `use_count == 0` is *absence of evidence*, not staleness — never archive on zero use
  - `pinned` bypasses every automatic transition
  - `PROTECTED_BUILTIN_SKILLS` are never archived or consolidated
  - lifecycle is `active → stale → archived`, and archiving **moves**, never deletes

- **The ledger contract** in `skill_ledger.py`:
  - one JSONL entry per mutation, any actor
  - file contents stored content-addressed (sha256-deduped)
  - JSONL not a database: durable, greppable, survives resets
  - **telemetry, not a gate** — write paths swallow failures
  - **except rollback, which fails closed** when its safety capture fails

- **The provenance invariant** in `skill_provenance.py`:
  - `foreground` vs `background_review`
  - the curator only curates what the self-improvement review created
  - **skills the user asked for belong to the user**

### Adapted (Python → JavaScript, Hermes runtime → Cordis)

- `contextvars` → `AsyncLocalStorage`
- `threading` daemon fork → `ctx.subagents.startActivation` with a read-only tool allowlist
- `fcntl` file locking → atomic `rename` writes
- `Path`/`os` → `node:fs/promises` + `node:path`
- Hermes `skill_manage` tool calls → `lib/applier.js` writes performed by the plugin itself
  (the DSH review fork is read-only by design, so it emits structured JSON instead)

## Deliberate divergences

1. **The review fork cannot write.** In Hermes the fork calls `skill_manage` directly.
   In DSH the fork is read-only and returns JSON per `OUTPUT_CONTRACT`; the plugin applies it
   under the gate. This is stricter, not looser: the model never touches the filesystem.
2. **`skills_guard.py` is not ported.** Upstream it is opt-in and off by default
   (`skills.guard_agent_created` defaults to `False`), because `terminal()` runs the same code
   ungated. The DSH gate covers the structural risks instead (naming, forbidden content, size).
3. **The curator's LLM consolidation pass is not ported yet.** The deterministic lifecycle
   transitions are; the umbrella-building fork is future work (Phase 3).
4. **Memory writes are not automated.** `_MEMORY_ROUTING_BLOCK` is carried in the prompt for
   completeness, but the DSH plugin never writes to Hindsight or Nowledge Mem automatically.
   Memory pollution is worse than skill pollution, so this stays manual until Phase 4.

## Verified substitutions (prompt fidelity audit)

A scripted diff of `lib/prompts.js` against `background_review.py` confirms:

- `_LESSON_LAYER_BLOCK` — **byte-identical** (2098 chars)
- `_DO_NOT_CAPTURE_BLOCK` — **byte-identical** (1690 chars)
- `_SKILL_REVIEW_PROMPT` — 54 of 66 string fragments byte-identical; the 12 differing
  fragments are exactly the tool-name substitutions below, nothing else.

The complete substitution table (Hermes → DSH). No other wording changed.

| Hermes | DSH | Why |
|---|---|---|
| `skill_view(name)` | load with the `skill` tool | DSH's loader tool is named `skill` |
| `skill_view(name, file_path=...)` | load that exact file | DSH has no per-file loader parameter |
| `skills_list` | the skill catalog | DSH renders the catalog into the session, not a tool call |
| `skill_manage action=write_file` | the write path | DSH's fork is read-only; the plugin writes |
| `skill_manage refuses it` | the write is refused | tool name does not exist in DSH |
| `` `hermes curator lock` `` | (dropped) | DSH has no curator CLI; `pinned` covers the intent |
| `~/.hermes/skills/` | the DSH skills root | different home directory |

To re-run the audit:

```bash
node tools/verify-prompt-fidelity.mjs
```
