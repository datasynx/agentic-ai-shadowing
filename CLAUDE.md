# Agentic AI Shadowing

Beobachtet Tasks von Mitarbeitern, generiert SOPs (Standard Operating Procedures) — vollständig lokal und anonymisiert.

## Tech Stack

TypeScript 5.7+ strict, ESM only, Node 20+
@anthropic-ai/sdk + better-sqlite3 + commander + @inquirer/prompts + zod
Build: tsup | Test: vitest | Dev: tsx

## Coding Rules

Named exports, 2-Space, kein `any`, ISO 8601 UTC, IDs: hex(randomblob(8))
Terminal auf stderr, process.exitCode statt exit(), .js Extensions

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
