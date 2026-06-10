# Agentic AI Shadowing

Observes employee tasks, generates SOPs (Standard Operating Procedures) — fully local and anonymized.

## Tech Stack

TypeScript 5.7+ strict, ESM only, Node 22+
@anthropic-ai/sdk + better-sqlite3 + commander + @inquirer/prompts + zod
Build: tsup | Test: vitest | Dev: tsx

## Coding Rules

Named exports, 2-Space, no `any`, ISO 8601 UTC, IDs: hex(randomblob(8))
Output to stderr, use process.exitCode instead of exit(), .js Extensions

## Commands

```
npm run build # tsup compile
npm run dev   # tsx src/cli.ts
npm run test  # vitest run
npm run lint  # tsc --noEmit
```

## Git Workflow (autonomous merge)

Standing authorization — apply on every task, no need to ask:

1. Develop on the assigned feature branch, commit, and push it.
2. Verify green before merging. ci.yml only runs on `main` (push) and PRs, so a
   feature branch has no CI of its own — run `npm run lint && npm test &&
   npm run build` locally as the gate (skip the local run only for pure
   docs/markdown changes that can't affect the build).
3. Once green: **squash-merge the feature branch into `main`** with a
   Conventional-Commit message (so semantic-release versions correctly), then
   **delete the feature branch** (remote and local).
4. If verification fails: fix it and re-push; never merge a red build. If it
   can't be fixed or is out of scope, leave the branch unmerged and report why.
5. No pull request unless explicitly requested.

Safety net: merging to `main` triggers Release + npm publish — that is expected
and intended. release.yml re-runs lint/test/build and only publishes if green,
so a broken merge cannot ship a release.

## Spec

@docs/PRODUCT_SPEC.md

## Tasks

Active work is tracked in **GitHub Issues**. Historical context:
`docs/ENTERPRISE_TASKS.md` (enterprise-readiness tasks) and
`docs/HARDENING_2026-06.md` (hardening log).
