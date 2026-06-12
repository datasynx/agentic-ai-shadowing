---
date: 2026-06-12T12:00:07Z
researcher: majone
git_commit: 4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9
branch: main
repository: agentic-ai-shadowing
topic: "Issue #48 — Dashboard binds to all interfaces and leaks its auth token via the unauthenticated / page"
tags: [research, codebase, ui-server, security, dashboard, mcp-server, auth-token]
status: complete
last_updated: 2026-06-12
last_updated_by: majone
---

# Research: Issue #48 — Dashboard bind host & unauthenticated token exposure

**Date**: 2026-06-12T12:00:07Z
**Researcher**: majone
**Git Commit**: 4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9
**Branch**: main
**Repository**: agentic-ai-shadowing

## Research Question

Document how the web dashboard's network binding and auth-token handling work today, as described in GitHub issue #48 ("Dashboard binds to all interfaces and leaks its auth token via the unauthenticated `/` page"). Map the relevant components: the UI server bind/listen, its auth gate, the token embedding in the served HTML, the contrasting MCP-server bind guard, and existing test/config coverage.

> Scope note: this document describes the system **as it exists at commit `4d17aab`**. It does not propose fixes or evaluate the implementation — the issue itself contains the proposed remediation.

## Summary

The dashboard is started by the `shadowing ui` CLI command, which calls `createUIServer(db, config)` and then `server.listen(port, …)` **with no host argument** — so Node binds all interfaces (`0.0.0.0` / `::`). The UI server generates (or accepts) a Bearer auth token and enforces it on every `/api/*` route, but **not** on `GET /` / `GET /index.html`, which serve the dashboard HTML. That HTML has the token interpolated into it as `window.__SHADOWING_TOKEN__ = "<token>"`, which the client-side JS reads to set the `Authorization: Bearer <token>` header on API calls.

By contrast, the **MCP server** (`src/mcp-server.ts`) defaults its host to `127.0.0.1` and refuses to bind a non-loopback host unless `SHADOWING_MCP_TOKEN` is set. The UI server has no equivalent default-host or non-loopback guard, and no `--host` option. Config exposes `ui_port` (default 3847), `ui_auth_token`, and `ui_allowed_origins`, but no bind-host field.

## Detailed Findings

### UI server: creation, binding, and startup

`createUIServer()` builds the server with `node:http`'s `createServer` but does **not** bind — it returns the server object. Binding happens in the CLI.

- Server construction — [`src/ui-server.ts:135-136`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L135-L136)
- CLI `ui` command definition — [`src/cli.ts:690-695`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/cli.ts#L690-L695)
- Port resolution (`opts.port ?? config.ui_port`) — [`src/cli.ts:701`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/cli.ts#L701)
- The `listen` call — **port only, no host** — [`src/cli.ts:706`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/cli.ts#L706):

```typescript
const { createUIServer } = await import('./ui-server.js');
const server = createUIServer(db, config);

server.listen(port, () => {
  process.stderr.write(`\n  Shadowing Dashboard started.\n`);
  process.stderr.write(`  http://localhost:${port}\n\n`);   // logs "localhost" but binds all interfaces
  process.stderr.write('  Ctrl+C to quit.\n');
});
```

There is no `--host` option on the `ui` command, and no host value is threaded from config into `listen()`.

### UI server: auth token generation, the auth gate, and routes

The auth token is resolved from three sources, falling back to a random 32-byte hex string:

- Token resolution — [`src/ui-server.ts:104-107`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L104-L107):

```typescript
const authToken = opts?.authToken
  ?? process.env['SHADOWING_UI_TOKEN']
  ?? randomBytes(32).toString('hex');
```

- API-route detection — [`src/ui-server.ts:162`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L162): `const isApiRoute = path.startsWith('/api/');`
- The auth gate — applies **only** to `/api/*` — [`src/ui-server.ts:188-196`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L188-L196):

```typescript
if (isApiRoute) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${authToken}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized', status: 401 }));
    return;
  }
}
```

- The HTML route — **no auth**, and passes the token into the HTML generator — [`src/ui-server.ts:325-327`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L325-L327):

```typescript
} else if (path === '/' || path === '/index.html') {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getDashboardHTML(config, authToken));
```

- Token attached to server object + accessor — [`src/ui-server.ts:359`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L359) and [`src/ui-server.ts:371-373`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L371-L373) (`getServerAuthToken`).

**Routes served** (all `/api/*` require the Bearer token; `GET /` and `/index.html` do not):
`GET /api/stats`, `GET /api/tasks`, `GET /api/tasks/active`, `GET /api/sops`, `GET|PUT /api/sops/{id}`, `PUT /api/sops/{id}/status`, `PUT /api/sops/{id}/tags`, `GET /api/sops/{id}/diff`, `GET /api/sops/{id}/preview`, `GET /api/tags`, `GET|POST /api/exports`, `GET /api/sessions`, `GET /api/sessions/{id}/timeline`, `GET /api/sessions/{id}/summary` (handlers at [`src/ui-server.ts:200-324`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L200-L324)).

Additional protections already present in the same handler: a CORS / same-origin allowlist returning 403 for disallowed cross-origin API calls ([`src/ui-server.ts:114-172`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L114-L172)) and per-IP read/write rate limiting ([`src/ui-server.ts:46-91`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L46-L91), [`175-186`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L175-L186)).

### Token embedding in the served HTML

`getDashboardHTML(config, authToken)` interpolates the token into an inline script as a global the client reads.

- Function signature & token serialization — [`src/dashboard-html.ts:5-8`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/dashboard-html.ts#L5-L8): `const tokenLiteral = JSON.stringify(authToken);` (JSON-stringified to keep the inline script well-formed / avoid breaking out of the assignment).
- Token injection — [`src/dashboard-html.ts:379`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/dashboard-html.ts#L379): `window.__SHADOWING_TOKEN__ = ${tokenLiteral};`
- Client-side use of the token — [`src/dashboard-html.ts:380-384`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/dashboard-html.ts#L380-L384):

```javascript
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (window.__SHADOWING_TOKEN__) h['Authorization'] = 'Bearer ' + window.__SHADOWING_TOKEN__;
  return h;
}
```

The `API` object's get/put/post helpers call `authHeaders()` on every fetch ([`src/dashboard-html.ts:386-400`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/dashboard-html.ts#L386-L400)).

**Token flow:** generated/resolved in `createUIServer` ([`ui-server.ts:104-107`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L104-L107)) → passed to `getDashboardHTML(config, authToken)` on the unauthenticated `/` route ([`ui-server.ts:327`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/ui-server.ts#L327)) → interpolated into the HTML ([`dashboard-html.ts:379`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/dashboard-html.ts#L379)) → read by client JS to authorize `/api/*` calls.

### Contrast: MCP server bind host & non-loopback token guard

The MCP HTTP server implements the default-loopback + non-loopback-requires-token pattern the issue references.

- Defaults — [`src/mcp-server.ts:954-955`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/mcp-server.ts#L954-L955):

```typescript
const port = opts.port ?? 3848;
const host = opts.host ?? '127.0.0.1';
```

- Non-loopback guard — [`src/mcp-server.ts:956-965`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/mcp-server.ts#L956-L965):

```typescript
if (host !== '127.0.0.1' && host !== 'localhost' && !process.env['SHADOWING_MCP_TOKEN']) {
  log.error(
    'refusing to bind a non-loopback host without SHADOWING_MCP_TOKEN set — ' +
    'exposure beyond localhost without authentication is unsupported',
    { host },
  );
  process.exitCode = 1;
  db.close();
  return;
}
```

- Token read — [`src/mcp-server.ts:867`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/mcp-server.ts#L867): `const authToken = opts?.authToken ?? process.env['SHADOWING_MCP_TOKEN'];`
- Per-request validation — [`src/mcp-server.ts:897-903`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/mcp-server.ts#L897-L903) (Bearer match, else 401 via `deny()`).
- Loopback detection is inline string comparison (no shared helper): startup guard checks `'127.0.0.1' / 'localhost'` ([`:956`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/mcp-server.ts#L956)); origin validation additionally recognizes `'[::1]'` ([`:869-879`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/mcp-server.ts#L869-L879)).

### Configuration

Config schema and defaults live in `src/config.ts` / `src/types.ts`:

- `ui_port: z.number().int().min(1024).max(65535).default(3847)` — [`src/config.ts:46`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/config.ts#L46)
- `ui_auth_token: z.string().optional()` — [`src/config.ts:47`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/config.ts#L47)
- `ui_allowed_origins: z.array(z.string()).optional()` — [`src/config.ts:49`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/config.ts#L49)
- Default value `ui_port: 3847` — [`src/config.ts:102`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/config.ts#L102)
- Type fields — [`src/types.ts:125-129`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/src/types.ts#L125-L129)

There is **no bind-host config field** for the UI server. Note `config.ui_auth_token` is defined in schema/types, but `createUIServer` resolves its token from `opts.authToken` / `SHADOWING_UI_TOKEN` / random — it does not read `config.ui_auth_token`.

### Existing tests

UI / dashboard test coverage today:

- `test/ui-server.test.ts` — core API + auth (issue #9). Notably: token embedded in served HTML ([`:174-178`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/ui-server.test.ts#L174-L178)), embedded token wires into Authorization header ([`:180-185`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/ui-server.test.ts#L180-L185)), API rejects no-token with 401 ([`:200-203`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/ui-server.test.ts#L200-L203)).
- `test/ui-server-enterprise.test.ts` — auth (401 on missing/wrong token; dashboard allowed without auth — [`:49-78`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/ui-server-enterprise.test.ts#L49-L78)), `getServerAuthToken` ([`:75-77`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/ui-server-enterprise.test.ts#L75-L77)), rate limiting, error handling, audit trail.
- `test/ui-server-cors.test.ts` — CORS/origin (DNS-rebinding) defaults and allowlist behavior.
- `test/dashboard-xss.test.ts` — `esc`/`escJs`/`renderMD` XSS protection and HTML integration.
- `test/mcp-http.test.ts` — MCP origin validation ([`:75-83`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/mcp-http.test.ts#L75-L83)) and Bearer-token auth ([`:99-116`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/mcp-http.test.ts#L99-L116)).
- `test/config-comprehensive.test.ts` — default `ui_port` 3847 ([`:31`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/config-comprehensive.test.ts#L31)) and port range validation ([`:96-107`](https://github.com/datasynx/agentic-ai-shadowing/blob/4d17aab9eea9c72c7fdc68a982d190dccd1eb5c9/test/config-comprehensive.test.ts#L96-L107)).

No existing test currently asserts the UI server's **bind host**, nor an unauthenticated-`/`-token-exposure expectation as a failing condition (current tests assert the token *is* embedded and *does* authenticate, i.e. the present behavior).

## Code References

- `src/cli.ts:690-717` — `shadowing ui` command; `server.listen(port, …)` with no host at `:706`.
- `src/ui-server.ts:104-107` — auth token resolution (`opts` / `SHADOWING_UI_TOKEN` / random).
- `src/ui-server.ts:162` — `isApiRoute` detection.
- `src/ui-server.ts:188-196` — Bearer auth gate (API routes only).
- `src/ui-server.ts:325-327` — unauthenticated `GET /` serves HTML with token.
- `src/ui-server.ts:359,371-373` — token metadata + `getServerAuthToken`.
- `src/dashboard-html.ts:5-8,379-400` — token interpolation `window.__SHADOWING_TOKEN__` + client `authHeaders`.
- `src/mcp-server.ts:954-955` — MCP default host `127.0.0.1`.
- `src/mcp-server.ts:956-965` — MCP non-loopback-requires-token guard.
- `src/mcp-server.ts:867,897-903` — MCP token read + per-request validation.
- `src/config.ts:46-49,102` — `ui_port` / `ui_auth_token` / `ui_allowed_origins` schema + default.
- `src/types.ts:125-129` — config type fields.

## Architecture Documentation

Two HTTP surfaces exist with divergent network-exposure conventions:

| Aspect | UI server (`ui-server.ts`) | MCP server (`mcp-server.ts`) |
|---|---|---|
| Token env var | `SHADOWING_UI_TOKEN` | `SHADOWING_MCP_TOKEN` |
| Token default | auto-generated random hex | unset = no auth |
| Default bind host | none passed to `listen()` (all interfaces) | `127.0.0.1` |
| `--host` option | none | yes |
| Non-loopback guard | none | refuse unless token set |
| Default port | 3847 | 3848 |
| Token on unauth `/` | yes (`/` serves token in HTML) | n/a (no HTML page) |

The UI server's auth model assumes a loopback-only deployment where embedding the token in the served page is equivalent to handing it to the local user's browser; the MCP server's model assumes the host may be configurable and gates non-loopback exposure behind an explicit token.

## Historical Context

The issue body references a companion enterprise-readiness research doc, `docs/research/2026-06-12-issue-39-harness-adapter-reverification.md`, but that file (and the `docs/research/` directory) did not exist in the working tree at commit `4d17aab` — this is the first document created under `docs/research/`. The UI auth-token mechanism traces to issue #9 (referenced in `test/ui-server.test.ts` around the auth tests).

## Related Research

None found in-repo (no prior `docs/research/` or `thoughts/` directory present at this commit).

## Open Questions

- Whether `config.ui_auth_token` (defined in schema/types) is intended to feed `createUIServer` — currently the function does not read it; the token comes from `opts.authToken` / `SHADOWING_UI_TOKEN` / random.
