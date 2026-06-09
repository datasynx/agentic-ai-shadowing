import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createUIServer } from '../src/ui-server.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import type { Server } from 'node:http';

const DB_PATH = join(tmpdir(), `shadowing-ui-cors-${Date.now()}.db`);
const ALLOWED_ORIGIN = 'https://dashboard.example.com';

let db: ShadowingDB;
let server: Server;
let port: number;

function url(path: string): string {
  return `http://localhost:${port}${path}`;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'Authorization': 'Bearer test-token', ...extra };
}

async function startServer(allowedOrigins?: string[]): Promise<void> {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  server = createUIServer(db, getDefaultConfig(), {
    authToken: 'test-token',
    allowedOrigins,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('CORS — secure defaults (no allowlist)', () => {
  beforeEach(() => startServer());

  it('emits NO Access-Control-Allow-Origin header by default', async () => {
    const res = await fetch(url('/api/stats'), { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows requests without an Origin header (curl, scripts)', async () => {
    const res = await fetch(url('/api/stats'), { headers: authHeaders() });
    expect(res.status).toBe(200);
  });

  it('allows same-origin requests (dashboard fetches)', async () => {
    const res = await fetch(url('/api/stats'), {
      headers: authHeaders({ 'Origin': `http://localhost:${port}` }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects cross-origin API requests with 403', async () => {
    const res = await fetch(url('/api/stats'), {
      headers: authHeaders({ 'Origin': 'https://evil.example.com' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Origin not allowed');
  });

  it('rejects cross-origin requests even with a valid token (CSRF/DNS-rebinding defense)', async () => {
    const res = await fetch(url('/api/stats'), {
      headers: authHeaders({ 'Origin': 'http://localhost:1' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects disallowed preflight (OPTIONS) with 403', async () => {
    const res = await fetch(url('/api/stats'), {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects malformed Origin headers', async () => {
    const res = await fetch(url('/api/stats'), {
      headers: authHeaders({ 'Origin': 'not a url' }),
    });
    expect(res.status).toBe(403);
  });

  it('still serves the dashboard HTML regardless of Origin', async () => {
    const res = await fetch(url('/'), { headers: { 'Origin': 'https://evil.example.com' } });
    expect(res.status).toBe(200);
  });
});

describe('CORS — explicit allowlist', () => {
  beforeEach(() => startServer([ALLOWED_ORIGIN]));

  it('allows an allowlisted origin and echoes it (never *)', async () => {
    const res = await fetch(url('/api/stats'), {
      headers: authHeaders({ 'Origin': ALLOWED_ORIGIN }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('answers preflight for an allowlisted origin', async () => {
    const res = await fetch(url('/api/stats'), {
      method: 'OPTIONS',
      headers: { 'Origin': ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('still rejects origins not on the allowlist', async () => {
    const res = await fetch(url('/api/stats'), {
      headers: authHeaders({ 'Origin': 'https://other.example.com' }),
    });
    expect(res.status).toBe(403);
  });
});
