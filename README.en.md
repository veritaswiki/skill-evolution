# 🧬 Skill Evolution (`skill-evolution`)

[![CI](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml/badge.svg)](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](./LICENSE)
[![Tests: 61 Passed](https://img.shields.io/badge/tests-61%20passed-34d399.svg)](#testing--audits)
[![Hermes Parity: 41/41](https://img.shields.io/badge/Hermes%20Parity-41%2F41-8b7cf6.svg)](#testing--audits)

**Skill Evolution** is a closed-loop procedural memory and skill self-evolution engine for AI coding agents.

Ported from and extending Nous Research's `hermes-agent` learning loop, it automatically reviews completed turns, distills reusable class-level skills (`SKILL.md`), generates human-friendly **briefings with mandatory user directive fusion**, enforces a **4-stage safety gate**, records every mutation in a **content-addressed SHA-256 ledger with single-entry rollback**, and provides **LLM-driven umbrella consolidation** alongside a full Web, Mobile PWA, and Remote workbench.

[中文文档 (README.md)](./README.md)

---

## ✨ Key Features

1. **6-Stage Closed Learning Loop**:
   - `Turn End & Flush Barrier` → `Bounded Snapshot Collector` → `Read-Only Review Fork` → `4-Stage Hard Gatekeeper` → `Briefing & Mandatory Directive Fusion` → `SHA-256 Ledger & Hot-Reload Applier`.
2. **Human-in-the-Loop Briefing & Directive Fusion**:
   - Explains in plain language what was distilled, key rules, impact if approved, and impact if rejected.
   - Requires a user directive (`comment`) before approval/rejection and lets the AI refine and merge the user's feedback into the skill before promotion.
3. **4-Stage Code-Level Gatekeeper**:
   - Enforces valid YAML frontmatter, class-level naming (rejecting `fix-X`, `debug-Y`, PR numbers, and dates), forbidden-content regex scanning (blocking negative tool claims and transient environment errors), and provenance protection (`metadata.createdBy: "agent"`).
4. **Curator Lifecycle & LLM Umbrella Consolidation**:
   - Sidecar `.usage.json` telemetry (`active → stale → archived`, never deleting, zero-use immunity, `pinned` exemption).
   - LLM-driven umbrella consolidation (`CURATOR_REVIEW_PROMPT`) with dry-run preview and atomic batch validation.
5. **Desktop, Mobile PWA & Remote Native Support**:
   - Mounts into both `conversation.view` and `settings.section`, serves a standalone mobile PWA at `/dsh-evolution/mobile` (and port `18890`), and registers the `evolution_review_center` tool + `/evolution` slash commands.

---

## 🧪 Testing & Audits

```bash
npm test                # Run all 61 unit tests
npm run audit:parity    # Verify 41/41 capability parity
npm run audit:prompts   # Verify byte-level prompt fidelity
```

## 📄 License

Released under the [MIT License](./LICENSE).
