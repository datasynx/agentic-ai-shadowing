# Agentic AI Shadowing

Observes employee tasks, generates SOPs (Standard Operating Procedures) — fully local and anonymized.

## Tech Stack

TypeScript 5.7+ strict, ESM only, Node 20+
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

## Spec

@docs/PRODUCT_SPEC.md

## Tasks

@plan.md
