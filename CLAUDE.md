# Cartography Shadow

Shadow Daemon für @datasynx/agentic-ai-cartography. Kontinuierliches System-Monitoring via Claude Haiku.

## Tech Stack

TypeScript 5.7+ strict, ESM only, Node 18+
@anthropic-ai/claude-code + @anthropic-ai/sdk + better-sqlite3 + commander + zod + node-notifier
Build: tsup | Test: vitest | Dev: tsx

## Coding Rules

Named exports, 2-Space, kein `any`, ISO 8601 UTC, IDs: "{type}:{id}"
Terminal auf stderr, process.exitCode statt exit(), .js Extensions

## Commands

```
npm run build # tsup compile
npm run dev   # tsx src/cli.ts
npm run test  # vitest run
npm run lint  # tsc --noEmit
```

## Spec

@docs/SHADOW_SPEC.md

## Tasks

@docs/tasks.md
