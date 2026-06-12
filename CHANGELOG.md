## [2.0.8](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.7...v2.0.8) (2026-06-12)


### Bug Fixes

* **db:** versioned user_version migrations with upgrade tests ([#55](https://github.com/datasynx/agentic-ai-shadowing/issues/55)) ([0919219](https://github.com/datasynx/agentic-ai-shadowing/commit/0919219c24827fa4f70360b7cc01ef90d7e92f44))

## [2.0.7](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.6...v2.0.7) (2026-06-12)


### Bug Fixes

* **privacy:** redact US SSN and connection-string credentials ([#54](https://github.com/datasynx/agentic-ai-shadowing/issues/54)) ([0393b4c](https://github.com/datasynx/agentic-ai-shadowing/commit/0393b4c368ddcf298b90a280b9bbac678ce1d928))

## [2.0.6](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.5...v2.0.6) (2026-06-12)


### Bug Fixes

* **privacy:** redact SOP title/description/content on capture and add scrubSOPs ([#53](https://github.com/datasynx/agentic-ai-shadowing/issues/53)) ([9510ca2](https://github.com/datasynx/agentic-ai-shadowing/commit/9510ca2c58a1f46f334bd5a24ab6b4d41ecb5029))

## [2.0.5](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.4...v2.0.5) (2026-06-12)


### Bug Fixes

* **db:** wrap multi-statement writes in transactions ([#56](https://github.com/datasynx/agentic-ai-shadowing/issues/56)) ([efbad37](https://github.com/datasynx/agentic-ai-shadowing/commit/efbad370540e2ecb9dcfb9ae51d83a76aab7c03a))

## [2.0.4](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.3...v2.0.4) (2026-06-12)


### Bug Fixes

* **cli:** auto-create config/data dir when opening the DB ([#50](https://github.com/datasynx/agentic-ai-shadowing/issues/50)) ([526eb0e](https://github.com/datasynx/agentic-ai-shadowing/commit/526eb0ed5fb8e15d238afd5814bee76a8f4e137b))

## [2.0.3](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.2...v2.0.3) (2026-06-12)


### Bug Fixes

* **mcp:** harden Streamable HTTP transport ([#49](https://github.com/datasynx/agentic-ai-shadowing/issues/49)) ([#71](https://github.com/datasynx/agentic-ai-shadowing/issues/71)) ([61bbce2](https://github.com/datasynx/agentic-ai-shadowing/commit/61bbce23a4492371b4c66739b040ee442e4a3a06))

## [2.0.2](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.1...v2.0.2) (2026-06-12)


### Bug Fixes

* **ui:** bind dashboard to loopback and stop leaking auth token via GET / ([#48](https://github.com/datasynx/agentic-ai-shadowing/issues/48)) ([889f231](https://github.com/datasynx/agentic-ai-shadowing/commit/889f2318cb7597aeb01914bcd39e4b4b2f344c1d))

## [2.0.1](https://github.com/datasynx/agentic-ai-shadowing/compare/v2.0.0...v2.0.1) (2026-06-12)


### Bug Fixes

* replace deprecated default Claude model with claude-sonnet-4-6 ([#69](https://github.com/datasynx/agentic-ai-shadowing/issues/69)) ([4d17aab](https://github.com/datasynx/agentic-ai-shadowing/commit/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9))

# [2.0.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.12.3...v2.0.0) (2026-06-10)


* feat(deps)!: require Node >= 22.12, upgrade zod 4 / commander 15 / inquirer 8 ([19920e3](https://github.com/datasynx/agentic-ai-shadowing/commit/19920e34fef11d4ecd11b683912982bfa833e8b8))


### BREAKING CHANGES

* Node.js >= 22.12.0 is now required (Node 20 is EOL).

https://claude.ai/code/session_01EBjXR9PCj5kGRvBYoj4Xp1

## [1.12.3](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.12.2...v1.12.3) (2026-06-10)


### Bug Fixes

* **security:** enforce input limits at the DB layer, add CodeQL/Dependabot/SECURITY.md ([ff8cd23](https://github.com/datasynx/agentic-ai-shadowing/commit/ff8cd234c3e75a97770aa3d2ab507c022b48b5ed))

## [1.12.2](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.12.1...v1.12.2) (2026-06-10)


### Bug Fixes

* **mcp-registry:** shorten server.json description to registry limit ([#36](https://github.com/datasynx/agentic-ai-shadowing/issues/36)) ([d4b2690](https://github.com/datasynx/agentic-ai-shadowing/commit/d4b2690325d3ac0850a0a1edf7236e113906cfb7))

## [1.12.1](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.12.0...v1.12.1) (2026-06-10)


### Bug Fixes

* enforce redact-on-capture for task titles/descriptions, structured SOP output in analyzer ([dc1319c](https://github.com/datasynx/agentic-ai-shadowing/commit/dc1319c3dfd667fc762df1165c2ab40071cbc405)), closes [20/#21](https://github.com/datasynx/agentic-ai-shadowing/issues/21) [#25](https://github.com/datasynx/agentic-ai-shadowing/issues/25)

# [1.12.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.11.0...v1.12.0) (2026-06-09)


### Features

* task-boundary suggestions and optional file watching ([5c22230](https://github.com/datasynx/agentic-ai-shadowing/commit/5c22230cf478240e6ae8243dd7f72d689a7291f1)), closes [#29](https://github.com/datasynx/agentic-ai-shadowing/issues/29) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.11.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.10.0...v1.11.0) (2026-06-09)


### Features

* MCP pagination and read-only resources ([9fafb73](https://github.com/datasynx/agentic-ai-shadowing/commit/9fafb7370348e218c2344ffeb075e8ac516bb4a1)), closes [#34](https://github.com/datasynx/agentic-ai-shadowing/issues/34) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.10.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.9.0...v1.10.0) (2026-06-09)


### Features

* elicitation-based SOP review (shadowing_review_sop) ([ae2431b](https://github.com/datasynx/agentic-ai-shadowing/commit/ae2431b9f508f334c4aa70f4be7b42ceebbe3e3e)), closes [#30](https://github.com/datasynx/agentic-ai-shadowing/issues/30) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31) [#28](https://github.com/datasynx/agentic-ai-shadowing/issues/28)

# [1.9.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.8.0...v1.9.0) (2026-06-09)


### Features

* stateless Streamable HTTP transport for the MCP server ([2b685f2](https://github.com/datasynx/agentic-ai-shadowing/commit/2b685f29c2224c61ee4b7f9f24a7a4d715f3c7bc)), closes [#23](https://github.com/datasynx/agentic-ai-shadowing/issues/23) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.8.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.7.0...v1.8.0) (2026-06-09)


### Features

* publish approved SOPs into agent context (SKILL.md / AGENTS.md index) ([d5ce085](https://github.com/datasynx/agentic-ai-shadowing/commit/d5ce08522d9da331102c700893b60dcaf2aeff84)), closes [#28](https://github.com/datasynx/agentic-ai-shadowing/issues/28) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.7.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.6.0...v1.7.0) (2026-06-09)


### Features

* multi-framework harness adapters (Codex, OpenClaw, Hermes, AGENTS.md) ([909a500](https://github.com/datasynx/agentic-ai-shadowing/commit/909a5002b6d9b6bb6f8a9909056e1b9a78d18c05)), closes [#27](https://github.com/datasynx/agentic-ai-shadowing/issues/27) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31) [#24](https://github.com/datasynx/agentic-ai-shadowing/issues/24)

# [1.6.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.5.0...v1.6.0) (2026-06-09)


### Features

* MCP Registry manifest with release-synced versioning ([ab80f3c](https://github.com/datasynx/agentic-ai-shadowing/commit/ab80f3cd79a9dfd5dbe0d1a36220a2a3a7208a24)), closes [#32](https://github.com/datasynx/agentic-ai-shadowing/issues/32) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.5.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.4.0...v1.5.0) (2026-06-09)


### Features

* Claude Code plugin — MCP server, hooks, and skill in one install ([a6cfc8d](https://github.com/datasynx/agentic-ai-shadowing/commit/a6cfc8d752076a2f88942915b042b617caf9d966)), closes [#33](https://github.com/datasynx/agentic-ai-shadowing/issues/33) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.4.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.3.0...v1.4.0) (2026-06-09)


### Features

* idempotent Claude Code setup with --dry-run, --uninstall and scopes ([9c91289](https://github.com/datasynx/agentic-ai-shadowing/commit/9c91289ac1662db6a6449252b6514234fa5bf789)), closes [#24](https://github.com/datasynx/agentic-ai-shadowing/issues/24) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.3.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.2.0...v1.3.0) (2026-06-09)


### Features

* migrate MCP server to official @modelcontextprotocol/sdk v1.29 ([e7aee88](https://github.com/datasynx/agentic-ai-shadowing/commit/e7aee88d9229a8459122ee3cd0de5bd051a8012c)), closes [#22](https://github.com/datasynx/agentic-ai-shadowing/issues/22) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.2.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.1.0...v1.2.0) (2026-06-09)


### Features

* structured SOP output and configurable API endpoint for enterprise gateways ([da01c33](https://github.com/datasynx/agentic-ai-shadowing/commit/da01c3386a9671ac8464f9babba63028606ab244)), closes [#25](https://github.com/datasynx/agentic-ai-shadowing/issues/25) [#26](https://github.com/datasynx/agentic-ai-shadowing/issues/26) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)

# [1.1.0](https://github.com/datasynx/agentic-ai-shadowing/compare/v1.0.1...v1.1.0) (2026-06-09)


### Bug Fixes

* non-zero exit codes on not-found lookups and self-healing release versioning ([5c72b46](https://github.com/datasynx/agentic-ai-shadowing/commit/5c72b466021e3067447ac78c9201e923191d0ac6)), closes [#16](https://github.com/datasynx/agentic-ai-shadowing/issues/16) [#17](https://github.com/datasynx/agentic-ai-shadowing/issues/17)


### Features

* enterprise security & privacy hardening — secret redaction, redact-on-capture, dashboard XSS fix, CORS lockdown ([c2fa83e](https://github.com/datasynx/agentic-ai-shadowing/commit/c2fa83ed2ce223bb5cba211e20c296e731ce1cfc)), closes [#18](https://github.com/datasynx/agentic-ai-shadowing/issues/18) [#19](https://github.com/datasynx/agentic-ai-shadowing/issues/19) [#20](https://github.com/datasynx/agentic-ai-shadowing/issues/20) [#21](https://github.com/datasynx/agentic-ai-shadowing/issues/21) [#31](https://github.com/datasynx/agentic-ai-shadowing/issues/31) [hi#entropy](https://github.com/hi/issues/entropy)

# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-06-05

### Added

- **GitHub Actions CI/CD**: `ci.yml` (lint, test, build on Node 20+22, security audit, license compliance, SBOM) and `publish.yml` (idempotent npm auto-publish with provenance signing, git tags, GitHub Releases)

### Changed

- Upgraded `vitest` from v3 to v4 (fixes critical security vulnerability GHSA-5xrq-8626-4rwp)
- Fixed `npm audit` to pass cleanly (0 vulnerabilities across all dependencies)
- Security audit in CI scoped to production dependencies only (`--omit=dev`)

## [0.2.0] - 2026-03-06

### Added

- **Structured Logging** (TASK-01): `src/logger.ts` with `debug`/`info`/`warn`/`error` levels, ISO-8601 timestamps, module names, NDJSON and human-readable modes. Configurable via `LOG_LEVEL` env var.
- **Unified Error Codes** (TASK-12): `ShadowingError` base class with 20+ machine-readable codes, HTTP status mapping, and `retryable` flag. `SOPGenerationError` extends it for backward compatibility.
- **Bearer Token Auth** (TASK-04): UI server requires `Authorization: Bearer <token>` for all `/api/*` routes. Token auto-generated if not configured.
- **Rate Limiting** (TASK-05): In-memory sliding-window rate limiter with configurable read/write limits per IP.
- **Central Error Handler** (TASK-06): Consistent JSON error responses. `ShadowingError` → proper HTTP status, `ZodError` → 422 with issues, unknown → 500 without stack traces.
- **PII Redaction Summary** (TASK-07): `anonymizeWithSummary()` returns per-category redaction counts. Export manifests include `redaction_summary`.
- **Request Tracing** (TASK-08): `X-Request-Id` header generated per request and included in responses and logs.
- **Input Validation** (TASK-14): Zod validation for all API query parameters and request bodies. Invalid input returns 422 with structured error details.
- **Audit Log** (TASK-09): `audit_log` table tracks SOP create/update/delete/status-change with old/new values.
- **API Usage Tracking** (TASK-10): `api_usage` table logs Claude API calls with model, token counts, and duration. Aggregated via `getApiUsageSummary()`.
- **Response Size Guard** (TASK-11): SOP generator validates API responses don't exceed 500KB before persisting.
- **API Cost Visibility** (TASK-10): `/api/stats` includes `api_usage_summary` with total tokens and costs.
- **Documentation**: `docs/ARCHITECTURE_DECISIONS.md`, `docs/ERRORS.md`, `CHANGELOG.md`

### Changed

- All `throw new Error(...)` in `src/db.ts`, `src/task-manager.ts` replaced with `ShadowingError` using specific error codes.
- `anonymize()` is now a backward-compatible wrapper around `anonymizeWithSummary()`.
- `createUIServer()` accepts optional `UIServerOptions` with `authToken` and `rateLimitPerMinute`.
- Export manifest includes `redaction_summary` field.
- SOP detail endpoint includes `audit_history` array.
- Config schema extended with `ui_auth_token`, `ui_rate_limit_per_minute`, `log_level` fields.

### Fixed

- No stack traces leaked to API clients on 500 errors.

## [0.1.0] - 2026-03-05

### Added

- Initial release: CLI tool for task tracking and SOP generation
- SQLite database with WAL mode
- Claude API integration for SOP generation
- PII anonymization (emails, IPs, URLs, phone numbers, file paths, IBANs, credit cards)
- Markdown export with manifest.json
- Web dashboard with REST API
- Observation sessions and shell history integration
- Cartography graph integration
- Metrics: consistency, maturity, freshness, quality scores
- MCP server for tool integration
