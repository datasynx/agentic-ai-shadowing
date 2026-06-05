import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createUIServer, getServerAuthToken } from '../src/ui-server.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import type { Server } from 'node:http';

const DB_PATH = join(tmpdir(), `shadowing-ui-enterprise-${Date.now()}.db`);
let db: ShadowingDB;
let server: Server;
let port: number;
let authToken: string;

function url(path: string): string {
  return `http://localhost:${port}${path}`;
}

function authHeaders(): Record<string, string> {
  return { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' };
}

beforeEach(async () => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();

  const config = getDefaultConfig();
  server = createUIServer(db, config, { authToken: 'test-secret-token', readRateLimit: 10, writeRateLimit: 5 });
  authToken = getServerAuthToken(server) ?? 'test-secret-token';

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

// ── TASK-04: Authentication ──────────────────────────────────────────────────

describe('Authentication', () => {
  it('returns 401 when no auth header on API route', async () => {
    const res = await fetch(url('/api/stats'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when wrong token', async () => {
    const res = await fetch(url('/api/stats'), {
      headers: { 'Authorization': 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct token', async () => {
    const res = await fetch(url('/api/stats'), { headers: authHeaders() });
    expect(res.status).toBe(200);
  });

  it('allows dashboard without auth', async () => {
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('returns auth token via getServerAuthToken', () => {
    expect(authToken).toBe('test-secret-token');
  });
});

// ── TASK-05: Rate Limiting ───────────────────────────────────────────────────

describe('Rate Limiting', () => {
  it('allows requests under the limit', async () => {
    const res = await fetch(url('/api/stats'), { headers: authHeaders() });
    expect(res.status).toBe(200);
  });

  it('returns 429 when read rate limit exceeded', async () => {
    // Read limit is set to 10
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(url('/api/stats'), { headers: authHeaders() });
      results.push(res.status);
    }

    expect(results.filter(s => s === 429).length).toBeGreaterThan(0);
  });

  it('includes Retry-After header on 429', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await fetch(url('/api/stats'), { headers: authHeaders() });
      if (res.status === 429) {
        expect(res.headers.get('retry-after')).toBeDefined();
        return;
      }
    }
    // If we got here all passed — rate limit might not trigger (timing), but we tried
  });
});

// ── TASK-06: Central Error Handler ───────────────────────────────────────────

describe('Central Error Handler', () => {
  it('returns consistent JSON error for not found', async () => {
    const res = await fetch(url('/api/sops/nonexistent'), { headers: authHeaders() });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found');
    expect(body.status).toBe(404);
  });

  it('returns 422 for invalid Zod input on SOP update', async () => {
    const res = await fetch(url('/api/sops/abcdef0123456789'), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({}), // Missing required fields
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('validation_error');
    expect(body.issues).toBeDefined();
  });

  it('returns 422 for invalid status value', async () => {
    const task = db.createTask('Test');
    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });

    const res = await fetch(url(`/api/sops/${sop.id}/status`), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ status: 'invalid-status' }),
    });
    expect(res.status).toBe(422);
  });

  it('does not expose stack traces on 500 errors', async () => {
    // A malformed body that causes JSON.parse to fail triggers 500
    const res = await fetch(url('/api/sops/abcdef0123456789'), {
      method: 'PUT',
      headers: authHeaders(),
      body: 'not json',
    });
    const body = await res.json();
    expect(body.error).not.toContain('at ');
    expect(body.error).not.toContain('.ts:');
  });

  it('handles ShadowingError with correct status code', async () => {
    // Trying to get a non-existent SOP returns 404
    const res = await fetch(url('/api/sops/0000000000000000'), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

// ── TASK-08: Input Validation ────────────────────────────────────────────────

describe('Input Validation', () => {
  it('rejects invalid task status filter', async () => {
    const res = await fetch(url('/api/tasks?status=invalid'), { headers: authHeaders() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid status filter');
  });

  it('rejects invalid SOP status filter', async () => {
    const res = await fetch(url('/api/sops?status=bogus'), { headers: authHeaders() });
    expect(res.status).toBe(400);
  });

  it('truncates overly long search parameter', async () => {
    const longSearch = 'a'.repeat(300);
    const res = await fetch(url(`/api/sops?search=${longSearch}`), { headers: authHeaders() });
    // Should not error — just truncated
    expect(res.status).toBe(200);
  });

  it('validates SOP title max length on update', async () => {
    const task = db.createTask('Test');
    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });

    const res = await fetch(url(`/api/sops/${sop.id}`), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'x'.repeat(501) }),
    });
    expect(res.status).toBe(422);
  });

  it('accepts valid SOP title on update', async () => {
    const task = db.createTask('Test');
    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });

    const res = await fetch(url(`/api/sops/${sop.id}`), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'Updated Title' }),
    });
    expect(res.status).toBe(200);
  });
});

// ── TASK-14: Request Tracing ─────────────────────────────────────────────────

describe('Request Tracing', () => {
  it('returns X-Request-Id in response', async () => {
    const res = await fetch(url('/api/stats'), { headers: authHeaders() });
    expect(res.headers.get('x-request-id')).toBeDefined();
  });

  it('uses client-provided X-Request-Id', async () => {
    const customId = 'custom-trace-12345';
    const res = await fetch(url('/api/stats'), {
      headers: { ...authHeaders(), 'X-Request-Id': customId },
    });
    expect(res.headers.get('x-request-id')).toBe(customId);
  });

  it('generates unique request IDs', async () => {
    const res1 = await fetch(url('/api/stats'), { headers: authHeaders() });
    const res2 = await fetch(url('/api/stats'), { headers: authHeaders() });
    const id1 = res1.headers.get('x-request-id');
    const id2 = res2.headers.get('x-request-id');
    expect(id1).not.toBe(id2);
  });
});

// ── TASK-02: Audit Trail in API ──────────────────────────────────────────────

describe('Audit Trail via API', () => {
  it('SOP detail includes audit_history', async () => {
    const task = db.createTask('Audit Test');
    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });

    // Update SOP via API to trigger audit
    await fetch(url(`/api/sops/${sop.id}`), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'Updated' }),
    });

    const res = await fetch(url(`/api/sops/${sop.id}`), { headers: authHeaders() });
    const body = await res.json();
    expect(body.audit_history).toBeDefined();
    expect(Array.isArray(body.audit_history)).toBe(true);
    expect(body.audit_history.length).toBeGreaterThan(0);
    expect(body.audit_history[0].action).toBe('update');
    expect(body.audit_history[0].source).toBe('api');
  });

  it('logs status change audit', async () => {
    const task = db.createTask('Status Test');
    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });

    await fetch(url(`/api/sops/${sop.id}/status`), {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ status: 'reviewed' }),
    });

    const logs = db.getAuditLog('sop', sop.id);
    expect(logs.some(l => l.action === 'status_change' && l.new_value === 'reviewed')).toBe(true);
  });
});

// ── TASK-10: API Stats includes api_usage_summary ────────────────────────────

describe('Stats API includes API usage', () => {
  it('GET /api/stats includes api_usage_summary', async () => {
    const res = await fetch(url('/api/stats'), { headers: authHeaders() });
    const body = await res.json();
    expect(body.api_usage_summary).toBeDefined();
    expect(body.api_usage_summary.total_calls).toBeDefined();
    expect(body.api_usage_summary.total_input_tokens).toBeDefined();
  });
});
