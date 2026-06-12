# Issue #48 — Dashboard bind host & unauthenticated token exposure: Implementation Plan

## Overview

Harden the web dashboard against two LAN-exposure flaws: (1) it binds all
interfaces instead of loopback, and (2) it embeds its auth token in the
unauthenticated `GET /` HTML. After this change the dashboard binds `127.0.0.1`
by default, refuses a non-loopback bind unless `SHADOWING_UI_TOKEN` is set
(mirroring the MCP server), and delivers its token via the URL fragment so a
plain `GET /` leaks nothing.

## Current State Analysis

- `src/cli.ts:706` — `server.listen(port, …)` with **no host arg** → binds
  `0.0.0.0`/`::`. The `ui` command has `--port` but no `--host`.
- `src/ui-server.ts:188-196` — Bearer auth gate runs only when
  `path.startsWith('/api/')`; `GET /` and `/index.html` are unauthenticated
  (`src/ui-server.ts:325-327`).
- `src/ui-server.ts:104-107` — token resolves from `opts.authToken` →
  `SHADOWING_UI_TOKEN` → `randomBytes(32).hex`. (`config.ui_auth_token` exists
  in schema but is **not** read here — out of scope, see "What We're NOT Doing".)
- `src/dashboard-html.ts:5,8,379` — `getDashboardHTML(config, authToken='')`
  interpolates `window.__SHADOWING_TOKEN__ = "<token>"` into the served HTML;
  client `authHeaders()` (`:380-384`) reads it for `Authorization: Bearer`.
- `src/dashboard-html.ts` is the only non-test caller of `getDashboardHTML`
  (via `src/ui-server.ts:327`); tests `test/dashboard-xss.test.ts:109,127` pass
  a `'token'` arg.
- Contrast already implemented in MCP: `src/mcp-server.ts:954-955` defaults host
  `127.0.0.1`; `:956-965` refuses non-loopback bind without `SHADOWING_MCP_TOKEN`.
- Config: `src/config.ts:46` `ui_port` default 3847; no host field. Defaults in
  `getDefaultConfig()` (`src/config.ts:96-103`); type in `src/types.ts:125-129`.

Full background: `docs/research/2026-06-12-issue-48-dashboard-bind-token-exposure.md`.

## Desired End State

- `shadowing ui` binds `127.0.0.1` by default; `--host`/`config.ui_host` can
  change it, but a non-loopback host without `SHADOWING_UI_TOKEN` is refused
  (stderr message, `process.exitCode = 1`, DB closed, no bind).
- `GET /` returns the dashboard HTML with **no token anywhere in the body**.
- The CLI prints a launch URL carrying the token in the fragment
  (`http://localhost:3847/#token=<tok>`); the browser moves it into
  `sessionStorage`, scrubs the hash, and uses it for `/api/*`.
- Tests cover: loopback/non-loopback bind decision, and that `GET /` does not
  expose the token.

### Key Discoveries:
- MCP guard to mirror: `src/mcp-server.ts:956-965`.
- Single production caller of `getDashboardHTML`: `src/ui-server.ts:327`.
- Tests asserting the *old* embedding (must be rewritten):
  `test/ui-server.test.ts:173-204`; signature-only updates at
  `test/dashboard-xss.test.ts:109,127`.
- `getServerAuthToken(server)` (`src/ui-server.ts:371-373`) lets the CLI read the
  generated token to build the launch URL.

## What We're NOT Doing

- Not wiring `config.ui_auth_token` into `createUIServer` token resolution
  (pre-existing unused field; separate concern).
- Not introducing server-side session state, a `/api/session` endpoint, or
  cookies. Token delivery stays stateless via the URL fragment.
- Not changing the `/api/*` Bearer auth contract, CORS allowlist, or rate
  limiting. API clients/CLI/tests keep using `Authorization: Bearer <token>`.
- Not adding HTTPS/TLS — loopback default makes it unnecessary; non-loopback is
  an explicit, token-gated opt-in.
- Not touching the MCP server (already compliant).

## Implementation Approach

Three small phases: (1) host binding + guard, (2) token delivery via fragment,
(3) tests. Phases 1 and 2 are independent; both must land before tests pass.

---

## Phase 1: Loopback-default bind + non-loopback token guard

### Overview
Default the dashboard to `127.0.0.1`, add a `--host` flag and `ui_host` config,
and refuse non-loopback binds without `SHADOWING_UI_TOKEN`.

### Changes Required:

#### 1. Bind helpers (exported for reuse + testing)
**File**: `src/ui-server.ts`
**Changes**: Add two pure helpers near the top of the module.

```typescript
/** Loopback hostnames the UI server may bind without an auth token. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Refusal reason if binding `host` without a token is disallowed, else null.
 * Mirrors the MCP server's non-loopback guard (src/mcp-server.ts:956-965).
 */
export function bindRefusalReason(host: string, hasToken: boolean): string | null {
  if (isLoopbackHost(host) || hasToken) return null;
  return 'refusing to bind a non-loopback host without SHADOWING_UI_TOKEN set — ' +
    'exposure beyond localhost without authentication is unsupported';
}
```

#### 2. Config schema, defaults, type
**File**: `src/config.ts`
**Changes**: Add `ui_host` after `ui_port`.

```typescript
// in ConfigSchema (after ui_port, src/config.ts:46)
ui_host: z.string().min(1).default('127.0.0.1'),
```
```typescript
// in getDefaultConfig() (after ui_port: 3847, src/config.ts:102)
ui_host: '127.0.0.1',
```
**File**: `src/types.ts`
**Changes**: Add `ui_host: string;` next to `ui_port` (`src/types.ts:125`).

#### 3. CLI `ui` command
**File**: `src/cli.ts` (`:692-717`)
**Changes**: Add `--host`, resolve host, apply guard, pass host to `listen`,
print the token URL.

```typescript
program
  .command('ui')
  .description('Start web dashboard')
  .option('-p, --port <port>', 'Port (default: config.ui_port)')
  .option('--host <host>', 'Bind host (default: config.ui_host or 127.0.0.1)')
  .action(async (opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const config = loadConfig();
    const port = opts.port ? parseInt(opts.port, 10) : config.ui_port;
    const host = opts.host ?? config.ui_host ?? '127.0.0.1';

    const { createUIServer, getServerAuthToken, bindRefusalReason, isLoopbackHost } =
      await import('./ui-server.js');

    const refusal = bindRefusalReason(host, Boolean(process.env['SHADOWING_UI_TOKEN']));
    if (refusal) {
      process.stderr.write(`\n  ${refusal}\n\n`);
      process.exitCode = 1;
      db.close();
      return;
    }

    const server = createUIServer(db, config);
    const token = getServerAuthToken(server) ?? '';

    server.listen(port, host, () => {
      const shown = isLoopbackHost(host) ? 'localhost' : host;
      process.stderr.write(`\n  Shadowing Dashboard started.\n`);
      process.stderr.write(`  http://${shown}:${port}/#token=${token}\n\n`);
      process.stderr.write('  Open the URL above — it carries the dashboard auth token.\n');
      process.stderr.write('  Ctrl+C to quit.\n');
    });

    process.on('SIGINT', () => {
      server.close();
      db.close();
      process.stderr.write('\n  Dashboard stopped.\n');
    });
  });
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run lint`
- [x] Unit tests pass: `npm test`
- [x] Build succeeds: `npm run build`
- [x] New helper tests pass (Phase 3): `isLoopbackHost` / `bindRefusalReason`.

#### Manual Verification:
- [x] `npm run dev -- ui` then `ss -ltn` shows `127.0.0.1:3847`, not `*:3847`.
- [x] `npm run dev -- ui --host 0.0.0.0` (no env token) prints the refusal and exits non-zero.
- [x] `SHADOWING_UI_TOKEN=x npm run dev -- ui --host 0.0.0.0` binds and `ss -ltn` shows `0.0.0.0:3847`.

---

## Phase 2: Deliver token via URL fragment (stop embedding in `/`)

### Overview
Remove the token from the served HTML; have the client read it from
`location.hash`, persist to `sessionStorage`, and scrub the fragment.

### Changes Required:

#### 1. Drop the token parameter from the HTML generator
**File**: `src/dashboard-html.ts` (`:5-8`)
**Changes**: Remove the `authToken` param and `tokenLiteral`.

```typescript
export function getDashboardHTML(config: ShadowingConfig): string {
  const version = getPackageVersion();
  return `<!DOCTYPE html>
  ...`;
```

#### 2. Replace token injection + auth header builder
**File**: `src/dashboard-html.ts` (`:378-384`)
**Changes**: Swap the `window.__SHADOWING_TOKEN__` line and `authHeaders` for
fragment-based delivery.

```javascript
// Auth token arrives in the URL fragment (never sent to the server); persist it
// to sessionStorage for the tab session, then scrub the fragment from the URL.
(function () {
  try {
    const m = location.hash.match(/(?:^#|&)token=([^&]*)/);
    if (m && m[1]) {
      sessionStorage.setItem('shadowing_token', decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) { /* sessionStorage unavailable */ }
})();
function getToken() {
  try { return sessionStorage.getItem('shadowing_token') || ''; } catch (e) { return ''; }
}
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const t = getToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}
```

#### 3. Update the production caller
**File**: `src/ui-server.ts` (`:327`)
**Changes**: `res.end(getDashboardHTML(config));` (drop the `authToken` arg).
The server-side `authToken` variable stays — it still gates `/api/*` at
`src/ui-server.ts:188-196` and is returned by `getServerAuthToken`.

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run lint` (signature change has one caller + 2 test sites).
- [x] `npm test` passes after Phase 3 test updates.
- [x] Build succeeds: `npm run build`.

#### Manual Verification:
- [x] `curl -s http://127.0.0.1:3847/` output does **not** contain the token
      and has no `window.__SHADOWING_TOKEN__` assignment.
- [x] Opening the printed `…/#token=<tok>` URL loads the dashboard, data renders,
      and the address bar no longer shows the fragment after load.
- [x] Reloading the tab keeps working (sessionStorage); a fresh tab to
      `http://127.0.0.1:3847/` without the fragment shows 401-driven empty state.

---

## Phase 3: Tests

### Overview
Replace the old token-embedding assertions, and add coverage for the bind
decision and the unauthenticated-`/` exposure path.

### Changes Required:

#### 1. Rewrite the embedding-based auth tests
**File**: `test/ui-server.test.ts` (`:173-204`)
**Changes**: Replace "token embedded in HTML / wired into header" assertions
with:
- `GET /` body does **not** contain the server token (`getServerAuthToken(server)`)
  and contains no `window.__SHADOWING_TOKEN__` assignment.
- `GET /` body **does** contain the fragment-reading code (`location.hash` /
  `sessionStorage`).
- `/api/*` returns 401 without `Authorization` (keep), and 200 with
  `Authorization: Bearer <getServerAuthToken(server)>` (keep — uses header, not HTML).

#### 2. Fix `getDashboardHTML` call sites
**File**: `test/dashboard-xss.test.ts` (`:109,127`)
**Changes**: `getDashboardHTML(getDefaultConfig(), 'token')` →
`getDashboardHTML(getDefaultConfig())`. These tests assert `esc`/`escJs`
behavior, unaffected by token removal.

#### 3. New bind-guard / loopback tests
**File**: `test/ui-server.test.ts` (new `describe`)
**Changes**:
```typescript
import { isLoopbackHost, bindRefusalReason } from '../src/ui-server.js';

describe('bind host guard', () => {
  it('treats loopback hosts as loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '192.168.1.5', 'example.com']) expect(isLoopbackHost(h)).toBe(false);
  });
  it('permits loopback without a token', () => {
    expect(bindRefusalReason('127.0.0.1', false)).toBeNull();
  });
  it('refuses non-loopback without a token', () => {
    expect(bindRefusalReason('0.0.0.0', false)).toMatch(/SHADOWING_UI_TOKEN/);
  });
  it('permits non-loopback when a token is set', () => {
    expect(bindRefusalReason('0.0.0.0', true)).toBeNull();
  });
});
```

#### 4. (Optional) actual bind-address assertion
**File**: `test/ui-server.test.ts`
**Changes**: Start a server with `server.listen(0, '127.0.0.1', …)` and assert
`(server.address() as AddressInfo).address === '127.0.0.1'`, then close. Confirms
`listen` honors the host argument.

### Success Criteria:

#### Automated Verification:
- [x] `npm test` passes (all rewritten + new tests green).
- [x] `npm run lint` passes.
- [x] `npm run build` passes.
- [x] Coverage gate (if enforced in CI) still met.

#### Manual Verification:
- [x] `git grep -n "__SHADOWING_TOKEN__"` returns no production references.

---

## Testing Strategy

### Unit Tests:
- `isLoopbackHost` truth table; `bindRefusalReason` four-case matrix.
- `getDashboardHTML(config)` emits no token literal and includes the
  fragment-reading bootstrap.

### Integration Tests:
- Boot `createUIServer`, fetch `/` → assert token-free HTML; fetch `/api/stats`
  without/with Bearer header → 401/200.
- Bind to `127.0.0.1:0` → assert `server.address().address`.

### Manual Testing Steps:
1. `npm run build && node dist/cli.js ui` → `ss -ltn | grep 3847` shows loopback.
2. `curl -s localhost:3847/ | grep -i token` → no token leaked.
3. Open `…/#token=<tok>` in a browser → dashboard loads, hash scrubbed, reload works.
4. `node dist/cli.js ui --host 0.0.0.0` → refusal + non-zero exit.
5. `SHADOWING_UI_TOKEN=secret node dist/cli.js ui --host 0.0.0.0` → binds; `ss` shows `0.0.0.0`.

## Migration Notes

No data/schema migration. `ui_host` defaults to `127.0.0.1`, so existing
configs without the field validate and keep loopback behavior (zod default).
Anyone who relied on the old all-interfaces bind must now set `--host`/`ui_host`
**and** `SHADOWING_UI_TOKEN` — an intentional, documented hardening.

## Documentation

- `docs/PRODUCT_SPEC.md` §10 config example: add `"ui_host": "127.0.0.1"`.
- `docs/PRODUCT_SPEC.md` §8: note loopback-by-default + token-gated non-loopback
  and fragment token delivery.
- CLI help for `ui` already reflects `--host` via the option description.

## References

- Issue: GitHub #48 — "Dashboard binds to all interfaces and leaks its auth token via the unauthenticated / page"
- Research: `docs/research/2026-06-12-issue-48-dashboard-bind-token-exposure.md`
- Pattern to mirror: `src/mcp-server.ts:954-965`
- Token accessor: `src/ui-server.ts:371-373`
