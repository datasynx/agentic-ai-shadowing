# MCP Streamable HTTP Transport Hardening (Issue #49) — Implementation Plan

## Overview

Harden the hand-rolled MCP Streamable HTTP server (`createMcpHttpServer`,
`src/mcp-server.ts:866-935`) against the six gaps in GitHub issue #49: enable the
SDK's DNS-rebinding protection as a second layer, compare the bearer token in
constant time, cap request body size (413), add a per-IP rate limit (429), fix
the IPv6-loopback Origin bracket mismatch, and make the 404 generic. The UI
server (`src/ui-server.ts`) already implements most of these patterns; we extract
the reusable pieces into a shared `src/http-security.ts` module so both servers
share one correct implementation, and we also fix the UI server's identical
plain-`!==` token comparison.

## Current State Analysis

- `createMcpHttpServer` (`src/mcp-server.ts:866-935`) enforces, in order: path
  (`/mcp` only), manual Origin check, optional bearer token, POST-only, then
  buffers + `JSON.parse`s the body and builds a fresh SDK server+transport per
  request (stateless).
- **Issue point 1** — transport built with only `{ sessionIdGenerator: undefined }`
  (`:922`); SDK rebinding options unused. Installed SDK is **1.29.0**;
  `enableDnsRebindingProtection`/`allowedHosts`/`allowedOrigins` exist but are
  JSDoc-`@deprecated` ("use external middleware instead"). They still function:
  `validateRequestHeaders` returns **403 / -32000** on a Host not in `allowedHosts`
  (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:107-131`).
- **Issue point 2** — `header !== \`Bearer ${authToken}\`` (`:899`), non-constant-time.
  No `crypto.timingSafeEqual` anywhere in the repo. The UI server has the same
  weakness (`src/ui-server.ts:208`).
- **Issue point 3** — body buffered with no cap before `JSON.parse` (`:910-918`).
- **Issue point 4** — no rate limiting on `/mcp`.
- **Issue point 5** — `originAllowed` compares `url.hostname` to the bracketed
  literal `'[::1]'` (`:875`); `new URL('http://[::1]:3848').hostname` is `'::1'`,
  so the IPv6-loopback arm never matches.
- **Issue point 6** — 404 body is `'Not found — the MCP endpoint is /mcp'` (`:890`),
  returned before auth.

### Key Discoveries

- **The UI server is the pattern source.** It already has:
  - `RateLimiter` class (`src/ui-server.ts:67-108`) — per-IP read/write buckets,
    60 s window, `setInterval` cleanup with `.unref()`, `destroy()`.
  - `readBody` + `MAX_BODY_SIZE = 1 MB` (`src/ui-server.ts:419-437`) — streams,
    destroys the request and rejects on overflow.
  - `isLoopbackHost` (`src/ui-server.ts:19-21`) — **correctly** handles both
    `'::1'` and `'[::1]'`.
  - Client-IP extraction (`src/ui-server.ts:193-194`).
- The transport is built **per request** (`:920-932`), so SDK options can be
  passed per request from a closure that learns the bound port on `listening`
  (works with the tests' `listen(0)`).
- The HTTP server entry points: `startMCPServer` (`src/mcp-server.ts:945-985`,
  CLI `shadowing mcp --http`, `src/cli.ts:1574-1586`) and the test helper
  `startServer` (`test/mcp-http.test.ts:18-29`).
- `McpHttpOptions` (`src/mcp-server.ts:854-857`) currently only has `authToken`.

## Desired End State

`createMcpHttpServer` rejects oversized bodies with 413, rate-limits per IP with
429, compares the token in constant time, accepts IPv6-loopback Origins, returns
a generic 404, and runs the SDK's `enableDnsRebindingProtection` (Host pin) as a
second layer behind the fixed manual Origin check. The UI server uses the same
shared timing-safe token comparison. All existing tests still pass; new tests
cover 413, 429, IPv6 Origin, Host-pin 403, and the generic 404.

Verify: `npm run lint && npm test && npm run build` green; new test cases pass.

## What We're NOT Doing

- Not adding `allowedOrigins` to the SDK layer — Origin stays enforced by the
  (fixed) manual check; the SDK layer pins **Host** only. This avoids the SDK
  rejecting a valid loopback Origin on a different port and double-validating.
- Not making the MCP server stateful or changing its stateless-per-request model.
- Not adding new config-file fields (e.g. an MCP `rate_limit`); limits are code
  defaults overridable via `McpHttpOptions`. (`ui_rate_limit_per_minute` in
  `src/config.ts:49` stays as-is — out of scope.)
- Not touching the UI server's rate limiter / body cap (already present) — only
  its token comparison and the relocation of shared helpers.
- Not redesigning the CLI surface (no new flags).

## Implementation Approach

Extract the reusable primitives into `src/http-security.ts`, wire the MCP server
to use them plus the SDK Host pin, and repoint the UI server at the shared module
(behavior-preserving) while fixing its token comparison. The SDK options are
deprecated but explicitly required by the issue's acceptance criteria; we use
them as defense-in-depth with the robust manual check retained.

---

## Phase 1: Shared `http-security` module

### Overview
Create one home for the HTTP-security primitives both servers need.

### Changes Required

#### 1. New file `src/http-security.ts`
**Changes**: Constant-time comparison, bounded body reader, client-IP helper,
relocated `RateLimiter` and `isLoopbackHost`, SDK Host-pin builder.

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Loopback hostnames a server may bind / accept without an auth token. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** Constant-time string equality (hash both sides → fixed length, never throws, no length leak). */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

/** Constant-time check of an Authorization header against the expected bearer token. */
export function timingSafeBearerEqual(header: string | undefined, token: string): boolean {
  if (!header) return false;
  return timingSafeStrEqual(header, `Bearer ${token}`);
}

export const MAX_HTTP_BODY_BYTES = 1024 * 1024; // 1 MB

export class BodyTooLargeError extends Error {
  constructor() { super('Request body too large'); this.name = 'BodyTooLargeError'; }
}

/** Buffer a request body, aborting with BodyTooLargeError once maxBytes is exceeded. */
export function readLimitedBody(req: IncomingMessage, maxBytes = MAX_HTTP_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new BodyTooLargeError()); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Best-effort client IP for rate limiting (x-forwarded-for first hop, else socket). */
export function clientIpOf(req: IncomingMessage): string {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress ?? 'unknown';
}

/** SDK allowedHosts entries (Host header is "hostname:port") for a bound port + extra hosts. */
export function loopbackHostHeaders(port: number, extraHosts: string[] = []): string[] {
  const hosts = ['127.0.0.1', 'localhost', '[::1]', '::1', ...extraHosts];
  return hosts.map(h => `${h}:${port}`);
}

interface RateLimitEntry { count: number; resetAt: number }

/** Per-IP read/write rate limiter (relocated verbatim from ui-server.ts). */
export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  constructor(private readLimit = 100, private writeLimit = 20, private windowMs = 60_000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs);
    this.cleanupTimer.unref();
  }
  check(ip: string, isWrite: boolean): { allowed: boolean; retryAfter?: number } {
    const key = `${ip}:${isWrite ? 'w' : 'r'}`;
    const now = Date.now();
    const limit = isWrite ? this.writeLimit : this.readLimit;
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) { entry = { count: 0, resetAt: now + this.windowMs }; this.entries.set(key, entry); }
    entry.count++;
    if (entry.count > limit) return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    return { allowed: true };
  }
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (now >= entry.resetAt) this.entries.delete(key);
  }
  destroy(): void { clearInterval(this.cleanupTimer); }
}
```

#### 2. `src/ui-server.ts` — consume the shared module (behavior-preserving)
**Changes**:
- Remove the local `RateLimiter` class (`:63-108`), `isLoopbackHost` (`:19-21`),
  `readBody`+`MAX_BODY_SIZE` (`:419-437`); import them from `./http-security.js`.
- **Re-export** `isLoopbackHost` so the public API (used by `bindRefusalReason`
  and `src/cli.ts:708`) is unchanged: `export { isLoopbackHost } from './http-security.js';`
- Replace the client-IP inline expression (`:193-194`) with `clientIpOf(req)`.
- **Fix the token comparison** (`:208`):
  `if (!timingSafeBearerEqual(req.headers['authorization'], authToken))`.

### Success Criteria

#### Automated Verification:
- [x] Type checks: `npm run lint`
- [x] Build succeeds: `npm run build`
- [x] Existing UI server tests pass: `npm test -- ui-server`
- [x] No remaining local `class RateLimiter` / `function readBody` in `src/ui-server.ts` (grep)

#### Manual Verification:
- [x] UI dashboard still loads and authenticates (token in URL fragment → API calls succeed).

---

## Phase 2: Harden `createMcpHttpServer`

### Overview
Apply all six fixes inside `src/mcp-server.ts`, reusing the Phase 1 helpers.

### Changes Required

#### 1. Imports + options (`src/mcp-server.ts`)
```ts
import {
  isLoopbackHost, timingSafeBearerEqual, readLimitedBody, BodyTooLargeError,
  clientIpOf, RateLimiter, loopbackHostHeaders, MAX_HTTP_BODY_BYTES,
} from './http-security.js';

export interface McpHttpOptions {
  authToken?: string;
  /** Per-IP request cap per minute (default 240). */
  rateLimitPerMinute?: number;
  /** Extra hostnames (besides loopback) allowed in the Host header for SDK rebinding protection. */
  allowedHosts?: string[];
}
```

#### 2. Fix `originAllowed` (`:869-879`) — issue point 5
```ts
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers['origin'];
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (req.headers['host'] && url.host === req.headers['host']) return true;
    return isLoopbackHost(url.hostname); // handles '::1' (URL().hostname is unbracketed)
  } catch { return false; }
}
```

#### 3. Generic 404 (`:890`) — issue point 6
```ts
if (path !== '/mcp') { deny(res, 404, 'Not found'); return; }
```

#### 4. Constant-time token (`:897-903`) — issue point 2
```ts
if (authToken && !timingSafeBearerEqual(req.headers['authorization'], authToken)) {
  deny(res, 401, 'Unauthorized'); return;
}
```

#### 5. Rate limit + body cap inside the handler
Instantiate once in the closure; clean up on server close. Add the rate check
after the Origin check (before auth, mirroring the UI server), and the size
checks at body read:
```ts
const rateLimiter = new RateLimiter(
  opts?.rateLimitPerMinute ?? 240, opts?.rateLimitPerMinute ?? 240,
);
const sdkAllowedHosts = new Set<string>();
const httpServer = createHttpServer((req, res) => { void (async () => {
  // ...path, origin checks...
  const rate = rateLimiter.check(clientIpOf(req), false);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    deny(res, 429, 'Rate limit exceeded'); return;
  }
  // ...auth, method checks...

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
    deny(res, 413, 'Request body too large'); return;            // early reject (issue point 3)
  }
  let body: unknown;
  try {
    body = JSON.parse((await readLimitedBody(req)).toString('utf8'));
  } catch (err) {
    if (err instanceof BodyTooLargeError) { deny(res, 413, 'Request body too large'); return; }
    deny(res, 400, 'Invalid JSON body'); return;                  // streamed-overflow vs parse error
  }
  // ...build server + transport...
})(); });
httpServer.on('listening', () => {
  const addr = httpServer.address();
  if (addr && typeof addr === 'object') {
    for (const h of loopbackHostHeaders(addr.port, opts?.allowedHosts ?? [])) sdkAllowedHosts.add(h);
  }
});
httpServer.on('close', () => rateLimiter.destroy());
return httpServer;
```

#### 6. SDK Host pin (`:922`) — issue point 1
```ts
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableDnsRebindingProtection: true,
  allowedHosts: [...sdkAllowedHosts],   // populated on 'listening'; Host-header pin
});
```
The manual Origin check remains the Origin layer; the SDK pins the Host header
against the bound loopback host:port (and any `opts.allowedHosts`). Note: SDK
options are `@deprecated` upstream but functional in 1.29.0 — documented tradeoff,
kept as a second layer per the issue's acceptance criteria.

#### 7. Thread non-loopback host into `allowedHosts` (`startMCPServer`, `:953-971`)
When binding a non-loopback host (token mode), include it so the SDK Host pin
doesn't 403 legitimate traffic:
```ts
const server = createMcpHttpServer(db, config, host && !isLoopbackHost(host) ? { allowedHosts: [host] } : undefined);
```

### Success Criteria

#### Automated Verification:
- [x] Type checks: `npm run lint`
- [x] Build succeeds: `npm run build`
- [x] Full suite green: `npm test`

#### Manual Verification:
- [x] `shadowing mcp --http` starts; a Claude Code MCP client connects and lists/calls tools over `/mcp`.
- [x] `curl -i http://127.0.0.1:3848/wrong` returns a 404 whose body does not contain `/mcp`.

---

## Phase 3: Tests

### Overview
Add HTTP-level tests for the new behaviors; add a unit test for the timing-safe
helper. Existing cases in `test/mcp-http.test.ts` must keep passing unchanged.

### Changes Required

#### 1. `test/mcp-http.test.ts` — new cases (helper `startServer` at `:18-29`)
- **413 (Content-Length):** POST with `Content-Length` > 1 MB → `expect(res.status).toBe(413)`.
- **413 (streamed):** POST a >1 MB body without a usable length → 413.
- **429:** issue >240 POSTs from one client in the window → a later one returns 429 with a `Retry-After` header.
- **IPv6 Origin:** POST with `Origin: http://[::1]:<port>` → 200 (regression guard for issue point 5).
- **Host pin 403:** POST with `Host: evil.example.com` (override) → 403 (SDK rebinding layer).
- **Generic 404 body:** POST to `/wrong` → 404 and body does **not** include `/mcp`.
- Adjust the existing `'rejects non-/mcp paths...'` assertion (`:118-123`) if it asserts the old 404 string.

#### 2. New `test/http-security.test.ts` — unit tests
- `timingSafeBearerEqual('Bearer t', 't')` → true; wrong token / `undefined` header → false.
- `isLoopbackHost` true for `127.0.0.1`/`localhost`/`::1`/`[::1]`, false for `evil.com`.
- `readLimitedBody` resolves under the cap; rejects with `BodyTooLargeError` over it.
- `loopbackHostHeaders(3848)` includes `127.0.0.1:3848` and `[::1]:3848`.

### Success Criteria

#### Automated Verification:
- [x] New + existing tests pass: `npm test -- mcp-http http-security`
- [x] Full suite + coverage gate green: `npm test`
- [x] Lint + build: `npm run lint && npm run build`

#### Manual Verification:
- [x] None beyond Phase 2.

---

## Testing Strategy

### Unit Tests (`test/http-security.test.ts`)
- Constant-time comparison correctness (match / mismatch / missing header).
- Loopback recognition incl. both `::1` forms.
- Bounded body reader (under cap resolves, over cap throws typed error).

### Integration Tests (`test/mcp-http.test.ts`)
- 413 on oversized body (both length-declared and streamed).
- 429 after exceeding the per-IP cap, with `Retry-After`.
- IPv6-loopback Origin accepted.
- Host-pin 403 via the SDK layer.
- Generic 404.
- Unchanged: round-trip, statelessness, disallowed Origin 403, bearer 401/success,
  405, malformed-JSON 400.

### Manual Testing Steps
1. `npm run build && node dist/cli.js mcp --http` — connect a real MCP client, list + call a tool.
2. `curl -i http://127.0.0.1:3848/nope` → 404 without `/mcp` in the body.
3. `curl -i -H 'Content-Length: 2000000' ...` (or a large `--data`) → 413.
4. Start the UI (`shadowing ui`), confirm the dashboard authenticates (timing-safe swap is transparent).

## Performance Considerations

- SHA-256 over the Authorization header per request is negligible vs. per-request
  SDK server construction already in the path.
- `RateLimiter` is an in-memory `Map` with an `.unref()`ed cleanup timer; bounded
  by distinct client IPs (effectively 1 on loopback).
- Body cap reduces worst-case memory from unbounded to ≤1 MB per request.

## Migration Notes

None — no schema, config, or CLI-surface changes. Default behavior on loopback is
unchanged for legitimate clients; only abusive/oversized/cross-host requests are
newly rejected. `McpHttpOptions` gains optional fields (backward compatible).

## References

- Issue: GitHub #49 — *Harden the MCP Streamable HTTP transport*
- Research: `docs/research/2026-06-12-issue-49-mcp-http-transport-hardening.md`
- Sibling precedent: `docs/research/2026-06-12-issue-48-dashboard-bind-token-exposure.md`
- Target code: `src/mcp-server.ts:866-935` (`createMcpHttpServer`), `:945-985` (`startMCPServer`)
- Pattern source: `src/ui-server.ts:19-21,67-108,193-203,419-437`
- SDK transport options: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.{d.ts,js}` (1.29.0)
- Tests: `test/mcp-http.test.ts:18-133`
