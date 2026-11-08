# Contributing to Skill Evolution

Thank you for your interest in contributing to `skill-evolution`!

## Development Workflow

1. Clone the repository and run the verification suite:
   ```bash
   node --test test/
   node tools/verify-parity.mjs
   node tools/verify-prompt-fidelity.mjs
   ```
2. Keep `lib/Synthesizer` and `lib/Gatekeeper` pure and deterministic.
3. Do not paraphrase the core review rules in `lib/prompts.js` without updating `vendor/hermes/PROVENANCE.md` and running `npm run audit:prompts`.
4. Ensure every new feature or bug fix includes unit tests in `test/`.
