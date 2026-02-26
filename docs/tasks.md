# Agentic AI Shadowing — Task List

## Phase 1 — MVP (completed)

- [x] 1. Project restructuring: Remove old files, update dependencies, new directory structure
- [x] 2. src/types.ts — All TypeScript interfaces and Zod schemas
- [x] 3. src/config.ts — Config management (~/.datasynx/shadowing/config.json)
- [x] 4. src/db.ts — SQLite database with schema migration
- [x] 5. src/task-manager.ts — Task lifecycle (start, pause, resume, complete, cancel)
- [x] 6. src/sop-generator.ts — Claude API SOP generation
- [x] 7. src/metrics.ts — Quality score calculation (consistency, maturity, freshness)
- [x] 8. src/anonymizer.ts — PII detection and redaction
- [x] 9. src/exporter.ts — Markdown export with manifest.json
- [x] 10. src/cli.ts — Commander CLI (27 commands)
- [x] 11. src/index.ts — Public API re-exports
- [x] 12. tsup.config.ts — CLI binary + library entry
- [x] 13. Build, lint, test verification
- [x] 14. Documentation update

## Phase 1.5 — Extended Features (completed)

- [x] 15. src/observer.ts — Heartbeat-based workflow observation
- [x] 16. src/window-detector.ts — Cross-platform window detection (Linux/macOS/Windows)
- [x] 17. src/shell-history.ts — Multi-shell history parser (Zsh/Bash/Fish/PowerShell)
- [x] 18. src/session-analyzer.ts — Silence clustering + task detection (LLM)
- [x] 19. src/diff.ts — Version diff engine
- [x] 20. src/privacy.ts — Consent management + exclusion rules
- [x] 21. src/infra-context.ts — Infrastructure context extraction
- [x] 22. src/cartography.ts — JGF graph import + focused context
- [x] 23. src/ui-server.ts — REST API (17 endpoints) + HTML dashboard
- [x] 24. src/mcp-server.ts — MCP server (17 tools, stdio transport)
- [x] 25. src/hook-handler.ts — Claude Code event processing
- [x] 26. src/dashboard-html.ts — Embedded dark-theme dashboard
- [x] 27. Full test suite (373 tests, 19 test files)

## Phase 2 — English Translation (completed)

- [x] 28. Translate all CLI output, prompts, error messages to English
- [x] 29. Translate dashboard HTML to English
- [x] 30. Translate README.md to English with badges
- [x] 31. Translate all test fixtures to English
- [x] 32. Translate docs/ to English
- [x] 33. Change default language from 'de' to 'en'
- [x] 34. npm publish v0.2.0
