# Contributing to Skill Evolution

Thank you for your interest in contributing to `skill-evolution`!

## Development Workflow

1. Clone the repository and run the verification suite:
   ```bash
   npm test
   npm run audit:parity
   npm run audit:prompts
   npm run sanitize
   ```
2. Keep `lib/synthesizer.js` and `lib/gatekeeper.js` pure and deterministic.
3. Do not paraphrase the core review rules in `lib/prompts.js` without updating `vendor/hermes/PROVENANCE.md` and running `npm run audit:prompts`.
4. Ensure every new feature or bug fix includes unit tests in `test/`.
