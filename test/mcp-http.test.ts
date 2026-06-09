import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../src/mcp-server.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import type { Server } from 'node:http';

const DB_PATH = join(tmpdir(), `shadowing-mcp-http-${Date.now()}.db`);

let db: ShadowingDB;
let server: Server;
let port: number;

async function startServer(authToken?: string): Promise<void> {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  server = createMcpHttpServer(db, getDefaultConfig(), authToken ? { authToken } : undefined);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
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

describe('Streamable HTTP transport (#23) — protocol round-trip', () => {
  beforeEach(() => startServer());

  it('initialize → tools/list → tools/call over HTTP', async () => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      expect(client.getServerVersion()?.name).toBe('shadowing-mcp');

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(18);

      const result = await client.callTool({
        name: 'shadowing_start_task',
        arguments: { title: 'HTTP transport task' },
      });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { task: { title: string } }).task.title).toBe('HTTP transport task');
    } finally {
      await client.close();
    }
  });

  it('is stateless: a second independent client sees the shared DB state', async () => {
    const clientA = new Client({ name: 'a', version: '1' });
    await clientA.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await clientA.callTool({ name: 'shadowing_start_task', arguments: { title: 'Stateless check' } });
    await clientA.close();

    const clientB = new Client({ name: 'b', version: '1' });
    await clientB.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const status = await clientB.callTool({ name: 'shadowing_get_status', arguments: {} });
    await clientB.close();
    expect((status.structuredContent as { active_task: { title: string } }).active_task.title).toBe('Stateless check');
  });
});

describe('Streamable HTTP transport — security envelope', () => {
  it('rejects disallowed Origins with 403 (DNS-rebinding protection)', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows localhost Origins', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Origin': `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    });
    expect(res.status).toBe(200);
  });

  it('requires the bearer token when configured', async () => {
    await startServer('sekrit');
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(unauthorized.status).toBe(401);

    const client = new Client({ name: 'authed', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { 'Authorization': 'Bearer sekrit' } } },
    ));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(18);
    await client.close();
  });

  it('rejects non-/mcp paths and non-POST methods', async () => {
    await startServer();
    expect((await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/mcp`)).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });

  it('rejects malformed JSON bodies with 400', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ nope',
    });
    expect(res.status).toBe(400);
  });
});
