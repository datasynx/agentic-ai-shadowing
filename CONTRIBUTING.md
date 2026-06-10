# Contributing

Thanks for your interest in improving **Agentic AI Shadowing**. This document
covers how to get set up, the quality gates, and how releases work.

## Development setup

```bash
git clone https://github.com/datasynx/agentic-ai-shadowing.git
cd agentic-ai-shadowing
npm ci
```

Requirements: **Node.js >= 22.12** (see `.nvmrc`).

## Project conventions

- **TypeScript 5.7+ strict, ESM only.** Named exports, 2-space indentation,
  no `any`. Use `.js` extensions in import specifiers.
- IDs are `hex(randomblob(8))`; timestamps are ISO 8601 UTC.
- Human-facing diagnostic output goes through the structured logger
  (`src/logger.ts`), not raw `process.stderr.write` — the only exceptions are
  CLI user-facing prompts/output.
- Privacy is a hard constraint: secrets/PII are redacted **on capture** (DB
  layer) and again at export. Never weaken a redaction without a test proving
  the new behavior.

## Quality gates (run before pushing)

```bash
npm run lint           # tsc --noEmit (strict)
npm test               # vitest
npm run test:coverage  # vitest with coverage thresholds
npm run build          # tsup
```

All four must pass. CI enforces the same gates plus CodeQL, `npm audit`, a
license check, and package validation (`publint`, `attw`).

### Coverage

The coverage gate (`vitest.config.ts`) targets the **testable core**. Three
files are excluded by design: `cli.ts` (argv wiring that delegates to the
tested core), `dashboard-html.ts` (an HTML string template — its logic lives
in the fully covered `dashboard-client.ts`), and `window-detector.ts`
(platform-specific OS shell-outs). New business logic is expected to ship with
tests; don't lower the thresholds to make a change pass.

## Commits & branches

- Work on a feature branch; open changes against `main`.
- **Conventional Commits** are required — semantic-release derives the version
  and changelog from them:
  - `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major
  - `docs:`, `chore:`, `test:`, `ci:`, `refactor:` → no release
- Keep the subject imperative and under ~72 chars.

## Pull requests

- Fill in the PR template. Link any related issue.
- Ensure CI is green. A maintainer reviews and squash-merges with a
  Conventional-Commit title.

## Releases

Merging to `main` triggers `release.yml`: it re-runs lint/test/build and, only
if green, publishes to npm (with provenance) and the MCP Registry, and creates
the GitHub release. You don't need to bump versions manually.

## Reporting security issues

Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for private
vulnerability reporting.
