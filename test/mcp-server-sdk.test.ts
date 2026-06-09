import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, getRegisteredToolNames, MCPServer } from '../src/mcp-server.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-mcp-sdk-${Date.now()}.db`);

let db: ShadowingDB;
let client: Client;

beforeEach(async () => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();

  const server = buildMcpServer(db, getDefaultConfig());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('MCP SDK server — protocol round-trip (#22)', () => {
  it('initializes with server info and instructions', () => {
    expect(client.getServerVersion()?.name).toBe('shadowing-mcp');
    expect(client.getInstructions()).toContain('shadowing_start_task');
  });

  it('answers ping', async () => {
    await expect(client.ping()).resolves.toBeDefined();
  });

  it('tools/list exposes all 18 tools with annotations and schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(18);

    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([...getRegisteredToolNames()].sort());

    const getStatus = tools.find(t => t.name === 'shadowing_get_status')!;
    expect(getStatus.annotations?.readOnlyHint).toBe(true);
    expect(getStatus.annotations?.openWorldHint).toBe(false);
    expect(getStatus.title).toBe('Get Status');

    const exportSops = tools.find(t => t.name === 'shadowing_export_sops')!;
    expect(exportSops.annotations?.readOnlyHint).toBe(false);
    expect(exportSops.annotations?.idempotentHint).toBe(false);

    const startTask = tools.find(t => t.name === 'shadowing_start_task')!;
    expect(startTask.inputSchema).toMatchObject({ type: 'object' });
    expect(startTask.outputSchema).toBeDefined();
  });

  it('tools/call executes a task lifecycle with structuredContent', async () => {
    const started = await client.callTool({
      name: 'shadowing_start_task',
      arguments: { title: 'Write release notes' },
    });
    expect(started.isError).toBeFalsy();
    const structured = started.structuredContent as { success: boolean; task: { title: string } };
    expect(structured.success).toBe(true);
    expect(structured.task.title).toBe('Write release notes');

    const status = await client.callTool({ name: 'shadowing_get_status', arguments: {} });
    const statusStructured = status.structuredContent as { active_task: { title: string } | null };
    expect(statusStructured.active_task?.title).toBe('Write release notes');
  });

  it('wraps array results in objects for structuredContent', async () => {
    db.createTask('A task');
    const result = await client.callTool({ name: 'shadowing_list_tasks', arguments: {} });
    const structured = result.structuredContent as { tasks: Array<{ title: string }> };
    expect(Array.isArray(structured.tasks)).toBe(true);
    expect(structured.tasks[0]!.title).toBe('A task');
  });

  it('rejects invalid arguments via SDK input validation', async () => {
    // title is required for shadowing_start_task — the SDK validates BEFORE
    // our handler runs and surfaces the failure as an error tool result.
    const result = await client.callTool({ name: 'shadowing_start_task', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('Input validation error');
  });

  it('returns isError results (not protocol errors) for business-logic failures', async () => {
    const result = await client.callTool({
      name: 'shadowing_get_sop',
      arguments: { sop_id: 'doesnotexist' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('not found');
  });
});

describe('pagination (#34) — no unbounded list responses', () => {
  it('pages list_tasks with next_cursor and respects the max page size', async () => {
    for (let i = 0; i < 60; i++) {
      const task = db.createTask(`Task ${i}`);
      db.completeTask(task.id);
    }

    const first = await client.callTool({ name: 'shadowing_list_tasks', arguments: {} });
    const page1 = first.structuredContent as { tasks: unknown[]; next_cursor: string | null };
    expect(page1.tasks).toHaveLength(50); // default page size
    expect(page1.next_cursor).toBe('50');

    const second = await client.callTool({ name: 'shadowing_list_tasks', arguments: { cursor: page1.next_cursor } });
    const page2 = second.structuredContent as { tasks: unknown[]; next_cursor: string | null };
    expect(page2.tasks).toHaveLength(10);
    expect(page2.next_cursor).toBeNull();

    const clamped = await client.callTool({ name: 'shadowing_list_tasks', arguments: { limit: 100000 } });
    expect((clamped.structuredContent as { tasks: unknown[] }).tasks.length).toBeLessThanOrEqual(200);
  });
});

describe('resources (#34) — read-only context without tool calls', () => {
  it('exposes global stats as a JSON resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.some(r => r.uri === 'shadowing://stats')).toBe(true);

    const stats = await client.readResource({ uri: 'shadowing://stats' });
    const parsed = JSON.parse((stats.contents[0] as { text: string }).text) as { total_tasks: number };
    expect(parsed).toHaveProperty('total_tasks');
  });

  it('lists APPROVED SOPs as markdown resources (drafts excluded)', async () => {
    const task = db.createTask('T');
    const draft = db.createSOP(task.id, { title: 'Draft SOP', content_md: '# Draft' });
    const approved = db.createSOP(task.id, { title: 'Approved SOP', content_md: '# Approved\nBody' });
    db.updateSOPStatus(approved.id, 'approved');

    const { resources } = await client.listResources();
    const uris = resources.map(r => r.uri);
    expect(uris).toContain(`shadowing://sops/${approved.id}`);
    expect(uris).not.toContain(`shadowing://sops/${draft.id}`);

    const content = await client.readResource({ uri: `shadowing://sops/${approved.id}` });
    expect((content.contents[0] as { text: string }).text).toContain('# Approved');

    await expect(client.readResource({ uri: `shadowing://sops/${draft.id}` })).rejects.toThrow();
  });
});

describe('stdout purity (stdio rule)', () => {
  it('writes nothing to stdout during a full tool session (only the transport may)', async () => {
    const writes: unknown[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      writes.push(chunk);
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;

    try {
      await client.listTools();
      await client.callTool({ name: 'shadowing_start_task', arguments: { title: 'purity check' } });
      await client.callTool({ name: 'shadowing_get_status', arguments: {} });
      await client.callTool({ name: 'shadowing_get_sop', arguments: { sop_id: 'missing' } }); // error path
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(writes).toEqual([]);
  });
});

describe('registration ↔ legacy tool list parity', () => {
  it('SDK registrations and the TOOLS definitions stay in sync', () => {
    const legacy = new MCPServer(db, getDefaultConfig()).handleToolsList().tools.map(t => t.name).sort();
    expect([...getRegisteredToolNames()].sort()).toEqual(legacy);
  });
});
