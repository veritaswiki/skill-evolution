# Changelog

All notable changes to `skill-evolution` will be documented in this file.

## [0.3.0] - 2026-11-08

### Added
- **Chinese Briefing & Mandatory User Directive Fusion**:
  - Added `.briefing.json` generation and `ReviewBrief` UI card displaying plain-language summaries (`whatItIs`, `keyRules`, `ifApprove`, `ifReject`).
  - Added mandatory user directive (`comment`) input with quick-directive chips and AI-powered draft refinement (`POST /dsh-evolution/api/refine-draft` and `evolveWithComment` in `POST /dsh-evolution/api/promote`).
- **Full Desktop, Mobile PWA & Remote App Support**:
  - Mounted workbench into both `conversation.view` (session header tab bar) and `settings.section`.
  - Added standalone Mobile PWA workbench (`GET /dsh-evolution/mobile` and fixed port `18890`) with bottom tab bar and iOS `16px` zoom prevention.
  - Added `evolution_review_center` tool (with native `ask_user_question` interactive cards for Remote/Mobile apps) and `/evolution brief|refine|approve|reject` slash commands.
- **LLM Umbrella Consolidation Workbench**:
  - Ported `CURATOR_REVIEW_PROMPT` and implemented `lib/consolidation.js` for prefix-cluster umbrella merging (`create`, `patch`, `write_file`, `archive` with mandatory `absorbedInto`).
- **Short-Lived Process Flush Barrier**:
  - Subscribed to `session/flush` with `inflightPromises` barrier so one-shot/headless runs never truncate in-flight reviews before exit.

### Fixed
- Fixed DSH `session/event` nested `ev.data` envelope parsing and filtered system-injected `<system-reminder>` / runtime-context blocks.
- Fixed `SettingsPanel` child component focus loss by hoisting field components to module scope.
- Refined `NEGATIVE_CLAIM_PATTERNS` in `lib/gatekeeper.js` to avoid false positives on cautionary prose.
