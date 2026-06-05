# Architecture Decisions

> Records significant architectural choices made during enterprise hardening (2026-03-06).

---

## ADR-01: Custom Lightweight Logger over External Dependency

**Status:** Accepted
**Context:** Enterprise requires structured logging with levels, timestamps, and NDJSON output. Options: `pino`, `tslog`, or custom module.
**Decision:** Custom `src/logger.ts` (~100 LOC). The project principle is "fully local, minimal dependencies." A custom logger avoids supply-chain risk and keeps bundle size small.
**Consequences:** No log rotation or transport plugins out-of-box. Acceptable for a CLI tool where stderr is typically piped to systemd/journald.

## ADR-02: Unified Error Hierarchy with ShadowingError

**Status:** Accepted
**Context:** Errors were thrown as plain `Error` with string messages. No machine-readable codes, no HTTP status mapping, no retryability signal.
**Decision:** `ShadowingError` base class with `code: ShadowingErrorCode`, `httpStatus` getter, and `retryable` getter. `SOPGenerationError` extends it for backward compatibility.
**Consequences:** All catch sites can switch on `error.code`. The UI server maps errors to HTTP responses automatically. Existing `SOPGenerationError` imports continue to work.

## ADR-03: Bearer Token Auth for UI Server

**Status:** Accepted
**Context:** The REST API had no authentication. Any process on localhost could read/modify data.
**Decision:** Optional Bearer token passed via `UIServerOptions.authToken` or `config.ui_auth_token`. Auto-generated via `crypto.randomBytes(32)` if not set. All `/api/*` routes require the token.
**Consequences:** Breaking change for API consumers — they must include `Authorization: Bearer <token>`. The token is printed to stderr on server start. Static HTML dashboard (GET /) remains unauthenticated.

## ADR-04: In-Memory Sliding Window Rate Limiter

**Status:** Accepted
**Context:** Need basic DoS protection for the REST API.
**Decision:** In-memory `RateLimiter` class with configurable read/write limits per minute. Uses `Map<string, number[]>` with periodic cleanup via `setInterval().unref()`.
**Consequences:** State is lost on restart (acceptable for local CLI tool). No Redis/external store needed. The `.unref()` prevents the timer from blocking process exit.

## ADR-05: Audit Log in SQLite

**Status:** Accepted
**Context:** Enterprise compliance requires tracking who changed what and when.
**Decision:** `audit_log` table with `entity_type`, `entity_id`, `action`, `old_value`, `new_value`, `source`, `timestamp`. Logged on SOP create/update/status-change.
**Consequences:** Adds ~1 write per mutation. Negligible performance impact with WAL mode. Queryable via API (`GET /api/sops/:id` includes `audit_history`).

## ADR-06: API Usage Tracking in SQLite

**Status:** Accepted
**Context:** Need visibility into Claude API costs (tokens consumed, latency).
**Decision:** `api_usage` table logging `model`, `input_tokens`, `output_tokens`, `duration_ms` per API call. Aggregated via `getApiUsageSummary()`.
**Consequences:** Enables cost dashboards and budget alerts. Data stays local.

## ADR-07: RedactionSummary for Compliance Auditing

**Status:** Accepted
**Context:** Anonymizer stripped PII but provided no feedback on what was redacted.
**Decision:** `anonymizeWithSummary()` returns `{ text, summary: RedactionSummary }` with counts per PII category. The original `anonymize()` is kept as a backward-compatible wrapper.
**Consequences:** Export manifests include `redaction_summary`. Compliance teams can verify PII handling without inspecting content.

## ADR-08: Central Error Handler in UI Server

**Status:** Accepted
**Context:** Each route had its own try/catch with inconsistent error responses.
**Decision:** Single error handler that maps `ShadowingError` → `{ error, code, details }` with correct HTTP status, `ZodError` → 422 with `issues` array, unknown errors → 500 without stack trace.
**Consequences:** Consistent error format across all endpoints. No information leakage from stack traces in production.

## ADR-09: Request Tracing via X-Request-Id

**Status:** Accepted
**Context:** Need to correlate log entries across a single API request.
**Decision:** Generate `X-Request-Id` (8 random hex bytes) for each request. Propagate in response headers. Include in all log entries within that request scope.
**Consequences:** Enables log correlation in multi-request debugging scenarios.

## ADR-10: Zod Validation at API Boundaries

**Status:** Accepted
**Context:** Query parameters and request bodies were used without validation.
**Decision:** Validate all API inputs with Zod schemas. Invalid input returns 422 with structured `issues` array.
**Consequences:** Type-safe at runtime. Clear error messages for API consumers.
