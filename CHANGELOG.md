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
