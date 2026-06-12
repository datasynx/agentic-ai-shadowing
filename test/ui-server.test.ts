import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { createUIServer, isLoopbackHost, bindRefusalReason } from '../src/ui-server.js';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-ui-test-${Date.now()}.db`);
const TEST_AUTH_TOKEN = 'test-ui-token';
let db: ShadowingDB;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  const config = getDefaultConfig();
  server = createUIServer(db, config, { authToken: TEST_AUTH_TOKEN });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

const authHeaders = { 'Authorization': `Bearer ${TEST_AUTH_TOKEN}`, 'Content-Type': 'application/json' };

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders });
  return { status: res.status, data: await res.json() };
}

describe('UI Server — API', () => {
  it('GET / returns HTML dashboard', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Shadowing Dashboard');
  });

  it('GET /api/stats returns statistics', async () => {
    const { status, data } = await get('/api/stats');
    expect(status).toBe(200);
    expect(data).toHaveProperty('total_tasks');
    expect(data).toHaveProperty('total_sops');
    expect(data.total_tasks).toBe(0);
  });

  it('GET /api/tasks returns task list', async () => {
    db.createTask('API Task');
    const { status, data } = await get('/api/tasks');
    expect(status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('API Task');
  });

  it('GET /api/tasks?status=active filters tasks', async () => {
    const t1 = db.createTask('Active');
    db.pauseTask(t1.id);
    const t2 = db.createTask('Paused');
    db.pauseTask(t2.id);
    db.resumeTask(t1.id);

    const { data } = await get('/api/tasks?status=paused');
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Paused');
  });

  it('GET /api/tasks/active returns active task', async () => {
    db.createTask('Active Task');
    const { data } = await get('/api/tasks/active');
    expect(data.title).toBe('Active Task');
  });

  it('GET /api/tasks/active returns null when no active', async () => {
    const { data } = await get('/api/tasks/active');
    expect(data).toBeNull();
  });

  it('GET /api/sops returns SOPs with tags', async () => {
    const task = db.createTask('SOP Task');
    db.createSOP(task.id, { title: 'Test SOP', content_md: '# Test', tags: ['api', 'test'] });

    const { data } = await get('/api/sops');
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Test SOP');
    expect(data[0].tags).toEqual(expect.arrayContaining(['api', 'test']));
  });

  it('GET /api/sops/:id returns SOP detail with metrics and versions', async () => {
    const task = db.createTask('Detail Task');
    const sop = db.createSOP(task.id, { title: 'Detail SOP', content_md: '# Detail' });

    const { data } = await get(`/api/sops/${sop.id}`);
    expect(data.title).toBe('Detail SOP');
    expect(data).toHaveProperty('metrics');
    expect(data).toHaveProperty('versions');
    expect(data.metrics.execution_count).toBe(0);
  });

  it('GET /api/sops/:id returns 404 for unknown', async () => {
    const { status } = await get('/api/sops/nonexistent');
    expect(status).toBe(404);
  });

  it('PUT /api/sops/:id/status updates status', async () => {
    const task = db.createTask('Status Task');
    const sop = db.createSOP(task.id, { title: 'Status SOP', content_md: '# S' });

    const res = await fetch(`${baseUrl}/api/sops/${sop.id}/status`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ status: 'reviewed' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('reviewed');
  });

  it('GET /api/tags returns tags', async () => {
    const task = db.createTask('Tag Task');
    db.createSOP(task.id, { title: 'T', content_md: 'C', tags: ['alpha', 'beta'] });

    const { data } = await get('/api/tags');
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/exports returns export list', async () => {
    const { data } = await get('/api/exports');
    expect(data).toEqual([]);
  });

  it('returns 404 for unknown routes', async () => {
    const { status } = await get('/api/unknown');
    expect(status).toBe(404);
  });

  it('GET /api/sops/:id/diff returns empty diff for SOP without versions', async () => {
    const task = db.createTask('Diff Task');
    const sop = db.createSOP(task.id, { title: 'D', content_md: 'Content' });

    const { data } = await get(`/api/sops/${sop.id}/diff`);
    expect(data.addedCount).toBe(0);
    expect(data.removedCount).toBe(0);
  });

  it('GET /api/sops/:id/diff returns diff when versions exist', async () => {
    const task = db.createTask('Diff V Task');
    const sop = db.createSOP(task.id, { title: 'DV', content_md: 'Old content' });
    db.updateSOP(sop.id, { content_md: 'New content' });

    const { data } = await get(`/api/sops/${sop.id}/diff`);
    expect(data.fromVersion).toBe(1);
    expect(data.toVersion).toBe(2);
    expect(data.addedCount).toBeGreaterThan(0);
  });
});

describe('UI Server — dashboard authentication (issue #48)', () => {
  it('does not expose the auth token in the unauthenticated GET / HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).not.toContain(TEST_AUTH_TOKEN);
    expect(html).not.toContain('window.__SHADOWING_TOKEN__');
  });

  it('delivers the token via the URL fragment, not the page body', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    // The client reads the token from the URL fragment into sessionStorage.
    expect(html).toContain('location.hash');
    expect(html).toContain('sessionStorage');
    // And still attaches a Bearer token to API requests.
    expect(html).toMatch(/Authorization['"\]]{0,3}\s*[:=]\s*['"`]Bearer/);
  });

  it('authenticates against the API with a Bearer token', async () => {
    const apiRes = await fetch(`${baseUrl}/api/stats`, {
      headers: { Authorization: `Bearer ${TEST_AUTH_TOKEN}` },
    });
    expect(apiRes.status).toBe(200);
  });

  it('still rejects API calls that omit the token', async () => {
    const res = await fetch(`${baseUrl}/api/stats`);
    expect(res.status).toBe(401);
  });
});

describe('UI Server — bind host guard (issue #48)', () => {
  it('treats loopback hosts as loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['0.0.0.0', '192.168.1.5', 'example.com', '::']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('permits a loopback bind without a token', () => {
    expect(bindRefusalReason('127.0.0.1', false)).toBeNull();
    expect(bindRefusalReason('localhost', false)).toBeNull();
  });

  it('refuses a non-loopback bind without a token', () => {
    expect(bindRefusalReason('0.0.0.0', false)).toMatch(/SHADOWING_UI_TOKEN/);
  });

  it('permits a non-loopback bind when a token is set', () => {
    expect(bindRefusalReason('0.0.0.0', true)).toBeNull();
  });

  it('binds the server to the requested host', async () => {
    const guardServer = createUIServer(db, getDefaultConfig(), { authToken: 'x' });
    try {
      const addr = await new Promise<{ address: string }>((resolve) => {
        guardServer.listen(0, '127.0.0.1', () => {
          resolve(guardServer.address() as { address: string });
        });
      });
      expect(addr.address).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolve) => guardServer.close(() => resolve()));
    }
  });
});
