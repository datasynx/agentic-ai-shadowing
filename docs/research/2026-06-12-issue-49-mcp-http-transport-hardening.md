---
date: 2026-06-12T12:18:13Z
researcher: majone
git_commit: 889f2318cb7597aeb01914bcd39e4b4b2f344c1d
branch: main
repository: datasynx/agentic-ai-shadowing
topic: "GitHub issue #49 — Harden the MCP Streamable HTTP transport"
tags: [research, codebase, mcp, security, streamable-http, dns-rebinding, rate-limiting]
status: complete
last_updated: 2026-06-12
last_updated_by: majone
---

# Research: GitHub Issue #49 — Harden the MCP Streamable HTTP Transport

**Date**: 2026-06-12T12:18:13Z
**Researcher**: majone
**Git Commit**: 889f2318cb7597aeb01914bcd39e4b4b2f344c1d
**Branch**: main
**Repository**: datasynx/agentic-ai-shadowing

## Research Question

Document the current state of the codebase relevant to GitHub issue #49:
*"[High][mcp][security] Harden the MCP Streamable HTTP transport (SDK rebinding
protection, timing-safe token, body-size limit, rate limiting)."* What exists
today around `createMcpHttpServer`, how the sibling UI server handles the same
concerns, what the installed MCP SDK provides, and what tests cover the endpoint.

## Summary

The MCP HTTP transport lives in `createMcpHttpServer` (`src/mcp-server.ts:866-935`)
and is a hand-rolled stateless `/mcp` server. It enforces four checks in order:
path routing (`/mcp` only), a manual Origin check, an optional bearer token, and
a POST-only method guard. The six points raised in the issue all map cleanly to
the current source:

1. **SDK rebinding protection unused** — the transport is constructed with only
   `{ sessionIdGenerator: undefined }` (`src/mcp-server.ts:922`). The SDK's
   `enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins` options
   exist (installed SDK **1.29.0**) but are not passed; they default to off.
2. **Non-constant-time token comparison** — `header !== \`Bearer ${authToken}\``
   uses plain `!==` (`src/mcp-server.ts:899`). No `crypto.timingSafeEqual` is
   used anywhere in the codebase.
3. **No request-body size cap** — the body is fully buffered into an array of
   `Buffer` chunks then `JSON.parse`d, with no byte limit (`src/mcp-server.ts:912-914`).
4. **No rate limiting / concurrency cap** on `/mcp`.
5. **IPv6 loopback Origin mismatch** — the check compares `url.hostname` against
   the bracketed literal `'[::1]'` (`src/mcp-server.ts:875`), but `new URL().hostname`
   yields the unbracketed `'::1'`, so an IPv6-loopback Origin never matches that arm.
6. **404 body advertises `/mcp`** before any auth (`src/mcp-server.ts:890`).

The sibling **UI server** (`src/ui-server.ts`, hardened in commit #48) already
implements most of the patterns the issue asks for — per-IP rate limiting (a
`RateLimiter` class), a 1 MB request-body cap (`readBody`), an `isLoopbackHost`
helper, and a `bindRefusalReason` guard — though it shares the MCP server's two
weaknesses: plain `!==` token comparison and the same `'[::1]'` bracket literal
in `isLoopbackHost`.

> Note on the issue text: #49 references
> `docs/research/2026-06-12-issue-39-harness-adapter-reverification.md` for the
> "harness portion." That file does **not** exist in this repo; the only file
> under `docs/research/` is the issue-48 dashboard research doc.

## Detailed Findings

### The MCP HTTP transport — `createMcpHttpServer`

`src/mcp-server.ts:866-935`. Stateless single-endpoint server. Token resolution:
`opts?.authToken ?? process.env['SHADOWING_MCP_TOKEN']` (`src/mcp-server.ts:867`);
when both are unset there is **no auth**.

Request lifecycle inside the handler (`src/mcp-server.ts:886-933`):

- **Path routing** (`888-892`): anything other than `/mcp` → `deny(404, 'Not found — the MCP endpoint is /mcp')`. The 404 body names the endpoint before auth runs (issue point 6).
- **Origin check** (`893-896` → `originAllowed`, `869-879`):
  ```ts
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers['origin'];
    if (!origin) return true; // non-browser clients
    try {
      const url = new URL(origin);
      if (req.headers['host'] && url.host === req.headers['host']) return true;
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    } catch {
      return false;
    }
  }
  ```
  A missing Origin header is allowed (non-browser clients). The same-origin
  branch matches `url.host` (with port) against the `Host` header. The fallback
  branch compares `url.hostname` (no port, no brackets) against three literals —
  the third, `'[::1]'`, can never match because `new URL('http://[::1]:3848').hostname`
  is `'::1'` (issue point 5). On any mismatch → `deny(403, 'Origin not allowed')`.
- **Bearer token** (`897-903`): only when `authToken` is set:
  ```ts
  const header = req.headers['authorization'];
  if (header !== `Bearer ${authToken}`) { deny(res, 401, 'Unauthorized'); return; }
  ```
  Plain `!==`, non-constant-time (issue point 2).
- **Method guard** (`904-908`): non-`POST` → `deny(405, ...)`.
- **Body read + parse** (`910-918`): buffers all chunks, no size cap, then
  `JSON.parse`; parse failure → `deny(400, 'Invalid JSON body')` (issue point 3).
- **Per-request server + transport** (`920-932`): a fresh `buildMcpServer` and
  `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per
  request (stateless, avoids id collisions). `res.on('close')` closes both. The
  SDK rebinding options are not passed (issue point 1). Errors → `deny(500, ...)`.

The `deny` helper (`881-884`) writes a JSON-RPC error envelope
(`{ jsonrpc: '2.0', error: { code: -32000, message }, id: null }`).

### Transport startup & non-loopback guard

`startMCPServer` (`src/mcp-server.ts:945-985`). HTTP branch (`953-971`): default
`port = 3848`, `host = '127.0.0.1'` (`954-955`). Non-loopback guard (`956-965`):
refuses to bind anything other than `127.0.0.1`/`localhost` unless
`SHADOWING_MCP_TOKEN` is set, logging an error and setting `process.exitCode = 1`.
Note this guard reads the **env var directly**, independent of the `authToken`
option that `createMcpHttpServer` would actually enforce.

### Sibling pattern — the UI server (`src/ui-server.ts`)

Hardened in commit #48 ("bind dashboard to loopback and stop leaking auth
token", merged as 889f231). It already contains the patterns issue #49 requests:

- **Loopback helper** (`src/ui-server.ts:19-21`):
  ```ts
  export function isLoopbackHost(host: string): boolean {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }
  ```
  Recognizes both `'::1'` and `'[::1]'` (broader than the MCP Origin check).
- **Bind refusal** (`src/ui-server.ts:27-31`): `bindRefusalReason(host, hasToken)`
  returns a refusal string for non-loopback hosts without a token; its comment
  says it "Mirrors the MCP server's non-loopback guard." Called from
  `src/cli.ts:708`.
- **Per-IP rate limiting** — `RateLimiter` class (`src/ui-server.ts:67-107`):
  read limit 100, write limit 20, 60 s window, keyed `${ip}:${'w'|'r'}`.
  Enforced at `src/ui-server.ts:191-203`: client IP from `x-forwarded-for` or
  `req.socket.remoteAddress`; on exceed → `429` with a `Retry-After` header.
  (Config field `ui_rate_limit_per_minute` exists at `src/config.ts:49` but is
  not wired into the constructor; limits are hardcoded.)
- **Body-size cap** — `MAX_BODY_SIZE = 1 MB`, `readBody` (`src/ui-server.ts:419-437`)
  destroys the request and rejects once cumulative chunk size exceeds the cap.
- **Origin / DNS-rebinding** — `checkOrigin` (`src/ui-server.ts:138-150`) +
  enforcement at `184-189` (403 on disallowed cross-origin API requests).
- **Token comparison** — same weakness as MCP: plain `!==`
  (`src/ui-server.ts:208`), not constant-time.
- **Token delivery to browser** — via URL fragment `#token=...` set in
  `src/cli.ts:717-723`; the dashboard moves it into `sessionStorage` and scrubs
  the fragment (`src/dashboard-html.ts:375-386`).

### What the installed SDK provides (1.29.0)

`StreamableHTTPServerTransport` constructor options (typed in
`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts:41-103`):

- `sessionIdGenerator` — `(() => string) | undefined`; undefined = stateless.
- `enableDnsRebindingProtection: boolean` (default `false`) — **marked deprecated**
  in the type docs ("Use external middleware instead").
- `allowedHosts: string[]` — checked against the `Host` header (also deprecated).
- `allowedOrigins: string[]` — checked against the `Origin` header (also deprecated).
- Also: `onsessioninitialized`, `onsessionclosed`, `enableJsonResponse`,
  `eventStore`, `retryInterval`. There is **no** body-size / `maxMessageSize`
  option.

Internal validation — `validateRequestHeaders` (`.../webStandardStreamableHttp.js:107-131`):
when `enableDnsRebindingProtection` is true, rejects with **403 / JSON-RPC -32000**
if (a) `allowedHosts` is non-empty and the `Host` header is missing or not in the
list ("Invalid Host header"), or (b) `allowedOrigins` is non-empty and a present
`Origin` header is not in the list ("Invalid Origin header"). An **absent** Origin
is tolerated. When the flag is false, it returns `undefined` (no checks).

### Existing test coverage

`test/mcp-http.test.ts` is the dedicated HTTP-transport suite. Helper
`startServer(authToken?)` (lines 18-29) builds a temp DB, calls
`createMcpHttpServer(db, config, authToken ? { authToken } : undefined)`, listens
on port `0` / `127.0.0.1`, and returns the assigned port. Cases:

| Behavior | Test | Lines |
|---|---|---|
| Full round-trip (initialize → tools/list → tools/call) via `StreamableHTTPClientTransport` | `initialize → tools/list → tools/call over HTTP` | 40-58 |
| Statelessness across two clients | `is stateless: a second independent client...` | 60-71 |
| Disallowed Origin → 403 | `rejects disallowed Origins with 403 (DNS-rebinding protection)` | 75-83 |
| Localhost Origin → 200 | `allows localhost Origins` | 85-97 |
| Bearer required when configured (401 / success) | `requires the bearer token when configured` | 99-116 |
| Non-`/mcp` path 404, non-POST 405 | `rejects non-/mcp paths and non-POST methods` | 118-123 |
| Malformed JSON → 400 | `rejects malformed JSON bodies with 400` | 125-133 |

Not currently exercised at the HTTP level: request-body size limits, rate
limiting, IPv6-loopback Origin handling, Host-header validation. Business-logic
and SDK-layer tests live in `test/mcp-server.test.ts`,
`test/mcp-server-sdk.test.ts`, and `test/mcp-server-negative.test.ts`.

## Code References

- `src/mcp-server.ts:866-935` — `createMcpHttpServer` (the whole HTTP transport)
- `src/mcp-server.ts:869-879` — `originAllowed`; `[::1]` bracket literal at line 875
- `src/mcp-server.ts:881-884` — `deny` JSON-RPC error helper
- `src/mcp-server.ts:888-892` — path routing; 404 advertises `/mcp` (line 890)
- `src/mcp-server.ts:899` — plain `!==` bearer comparison
- `src/mcp-server.ts:910-918` — uncapped body buffer + `JSON.parse`
- `src/mcp-server.ts:922` — `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`
- `src/mcp-server.ts:956-965` — non-loopback bind guard (reads `SHADOWING_MCP_TOKEN`)
- `src/ui-server.ts:19-31` — `isLoopbackHost` + `bindRefusalReason`
- `src/ui-server.ts:67-107` + `191-203` — `RateLimiter` + enforcement (429)
- `src/ui-server.ts:208` — UI server plain `!==` token comparison
- `src/ui-server.ts:419-437` — `MAX_BODY_SIZE = 1 MB`, `readBody`
- `src/logger.ts:7-12` — `Logger` interface (`debug/info/warn/error(msg, meta?)`)
- `test/mcp-http.test.ts:18-133` — HTTP transport test suite
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts:41-103` — transport options
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:107-131` — `validateRequestHeaders`

### GitHub permalinks (commit 889f231)

- [`src/mcp-server.ts:866-935`](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/src/mcp-server.ts#L866-L935)
- [`src/mcp-server.ts:875` (`[::1]` literal)](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/src/mcp-server.ts#L875)
- [`src/mcp-server.ts:899` (`!==` token)](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/src/mcp-server.ts#L899)
- [`src/mcp-server.ts:912-914` (uncapped body)](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/src/mcp-server.ts#L912-L914)
- [`src/mcp-server.ts:922` (transport ctor)](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/src/mcp-server.ts#L922)
- [`src/ui-server.ts:67-107` (RateLimiter)](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/src/ui-server.ts#L67-L107)
- [`src/ui-server.ts:419-437` (readBody cap)](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/src/ui-server.ts#L419-L437)
- [`test/mcp-http.test.ts`](https://github.com/datasynx/agentic-ai-shadowing/blob/889f2318cb7597aeb01914bcd39e4b4b2f344c1d/test/mcp-http.test.ts)

## Architecture Documentation

- **Two-layer MCP design**: `MCPServer` (`src/mcp-server.ts:241-468`) is the
  business-logic layer (tool dispatch over `ShadowingDB`); `buildMcpServer`
  (`683-766`) wraps it in the SDK's `McpServer` with zod schemas, resources, and
  annotations. The HTTP transport (`createMcpHttpServer`) and stdio transport
  (`startMCPServer`) are two front-ends over the same `buildMcpServer`.
- **Stateless-per-request HTTP**: a new `buildMcpServer` + transport is created
  for every POST; state is durable in SQLite, so no session affinity is needed.
- **Two sibling HTTP servers** — MCP (`src/mcp-server.ts`) and UI
  (`src/ui-server.ts`) — share a deliberately parallel security posture
  (loopback-by-default, token-gated non-loopback, Origin validation). The UI
  server is the more fully hardened of the two today (rate limiting, body cap,
  `isLoopbackHost` covering both `::1` forms); the MCP server's checks are
  hand-rolled inline. Both compare bearer tokens with plain `!==`.
- **Logging**: structured `getLogger(module)` from `src/logger.ts`; loggers
  expose `debug/info/warn/error(msg, meta?)`, write NDJSON-or-text to stderr.

## Historical Context (from docs/)

- `docs/HARDENING_2026-06.md` — enterprise hardening log. Records **#23**
  (Streamable HTTP transport: "stateless `/mcp` endpoint, loopback default,
  origin validation, token enforcement") and **#19** (UI CORS lockdown / bearer
  on `/api/*`) as completed, plus #20/#21 redaction work and TASK-08 input
  limits at the DB layer.
- `docs/research/2026-06-12-issue-48-dashboard-bind-token-exposure.md` — the
  research behind commit #48 that hardened the UI server's binding and token
  delivery; the direct precedent and pattern source for #49.
- `docs/PRODUCT_SPEC.md` §8 — documents the UI server's loopback-default + token
  posture; the MCP transport mirrors that intent.

## Related Research

- `docs/research/2026-06-12-issue-48-dashboard-bind-token-exposure.md` — sibling
  UI-server hardening (loopback binding, token-via-fragment).

## Open Questions

- The non-loopback bind guard (`src/mcp-server.ts:956-965`) keys off
  `process.env['SHADOWING_MCP_TOKEN']` directly, while the enforced auth inside
  `createMcpHttpServer` keys off `opts?.authToken ?? env`. `startMCPServer` calls
  `createMcpHttpServer(db, config)` with no `opts` (`src/mcp-server.ts:966`), so
  in practice both resolve to the same env var — but the two code paths read it
  independently.
- The issue references
  `docs/research/2026-06-12-issue-39-harness-adapter-reverification.md`, which is
  absent from this repository (only the issue-48 doc exists under `docs/research/`).
