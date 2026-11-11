# Changelog

## [0.1.0] - 2026-11-11

First public release.

> Version note: earlier iterations used internal sequence numbers (the sections below). The public series restarts here at 0.1.0; internal numbers are not carried over.


All notable changes to `skill-evolution` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-11-10

### Added
- **Native Web UI (`client.js` rewrite)**: the workbench now follows the host settings page design language instead of a self-made layout — 720px container, 20/14/12 type scale, `.5px` row separators, and colors taken only from host `--dsw-alias-*` tokens so light and dark themes are followed automatically.
- **Native switch control**: `NativeSwitch` renders a 36×20 button with `role="switch"` and `aria-checked`, replacing the previous custom toggle.
- **Split renderers**: `settings.section` now renders engine parameters and status only, while the full five-view workbench (overview / drafts / skills / ledger / settings) mounts in `main` and `sidebar.panellist`.
- **`settings.section.icon` registration**: the settings section now has its own icon entry.
- **`client.inject` expands to six UI packages**: `@deepseek-ai/dsh-client-ui-sidebar` and `@deepseek-ai/dsh-client-ui-layout` are now injected so `sidebar.panellist` and `main` resolve.
- **Auxiliary LLM review channel**: `runAuxiliaryReview` calls an OpenAI-compatible endpoint directly (`DSH_EVOLUTION_BASE_URL` / `DSH_EVOLUTION_API_KEY` / `DSH_EVOLUTION_MODEL`), so a review can run outside the session lock during short-lived or headless exits.
- **`scripts/sanitize-check.mjs`**: sanitization gate with 11 needles (home paths, private package scope, loopback address and hostname, private key marker, internal IP segment, internal gateway and cloud vendor names, API key and GitHub token prefixes) plus checks for `.bak-*` files and `node_modules/`. Vendored Hermes sources are excluded from content scanning and the skip count is printed.
- **CI sanitization step**, and `npm run sanitize` for local use.

### Changed
- **`reviewModel` now inherits by default**: `provider` and `model` default to empty strings, meaning the review uses the current session model; set them (or the env vars) to use a cheaper auxiliary model.
- **Review channel selection**: when no auxiliary endpoint is configured, reviews go through the host subagent fork instead of assuming a local endpoint exists.
- **Throttle defaults**: `minTurnsBetween` 3 → 1, `minMinutesBetween` 5 → 2 (both in `index.js` and `cordis.patch.yml`).
- **`consolidate` / `consolidateDryRun` documented in the bundle patch**: umbrella consolidation stays off by default and previews only.
- **`package.json`**: version 0.3.1, `private` removed, `publishConfig` (`access: public`, `provenance: true`), `@deepseek-ai/schemastery` declared as a peer dependency (`>=3.0.0-0`), `engines` set to Node `>=20.11`, and `assets/icon-180.png` / `README.en.md` / `CHANGELOG.md` added to `files`.
- **README.md / README.en.md restructured to one shared outline** (what it does / how it works / install / config / limitations / development / license) and all numbers checked against the code and test output: 70 tests, 41/41 capability audit, 2 prompt blocks byte-identical.

### Fixed
- The HTTP request parser no longer embeds a loopback literal: relative URLs are parsed against a reserved placeholder origin. `pathname` and `searchParams` behavior is unchanged.
- Removed the private package scope from the client module id, test header and bundles patch, so the published package carries no private scope.

## [0.3.0] - 2026-11-08

### Added
- **Chinese Briefing & Mandatory User Directive Fusion**:
  - Added `.briefing.json` generation and `ReviewBrief` UI card displaying plain-language summaries (`whatItIs`, `keyRules`, `ifApprove`, `ifReject`).
  - Added mandatory user directive (`comment`) input with quick-directive chips and AI-powered draft refinement (`POST /dsh-evolution/api/refine-draft` and `evolveWithComment` in `POST /dsh-evolution/api/promote`).
- **Full Desktop, Mobile PWA & Remote App Support**:
  - Mounted the workbench into `main`, `sidebar.panellist` (order 15) and `settings.section` (order 30).
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
