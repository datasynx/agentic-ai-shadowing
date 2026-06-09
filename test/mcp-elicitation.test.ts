import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '../src/mcp-server.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import type { SOP } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-mcp-elicit-${Date.now()}.db`);

let db: ShadowingDB;
let client: Client;
let sop: SOP;

async function connect(opts: { elicitation: boolean; respond?: (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } }): Promise<void> {
  const server = buildMcpServer(db, getDefaultConfig());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client(
    { name: 'elicit-test', version: '1.0.0' },
    opts.elicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, (req) => {
      return Promise.resolve(opts.respond!(req.params.message ?? ''));
    });
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  const task = db.createTask('Review flow task');
  sop = db.createSOP(task.id, {
    title: 'Rotate API Credentials',
    description: 'Rotate service credentials safely.',
    content_md: '# Rotate API Credentials\n## Steps\n### Step 1: Locate\nx\n### Step 2: Rotate\ny',
  });
});

afterEach(async () => {
  await client.close();
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('shadowing_review_sop — elicitation approval flow (#30)', () => {
  it('approves the SOP when the user accepts with decision=approve', async () => {
    let elicitedMessage = '';
    await connect({
      elicitation: true,
      respond: (message) => {
        elicitedMessage = message;
        return { action: 'accept', content: { decision: 'approve' } };
      },
    });

    const result = await client.callTool({ name: 'shadowing_review_sop', arguments: { sop_id: sop.id } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { success: boolean }).success).toBe(true);
    // Elicited payload is a compact summary, not the full markdown
    expect(elicitedMessage).toContain('Rotate API Credentials');
    expect(elicitedMessage).toContain('2 steps');
    expect(elicitedMessage.length).toBeLessThan(500);

    expect(db.getSOP(sop.id)!.status).toBe('approved');
  });

  it('keeps the SOP in draft and records feedback on reject', async () => {
    await connect({
      elicitation: true,
      respond: () => ({ action: 'accept', content: { decision: 'reject', feedback: 'Step 2 is wrong' } }),
    });

    const result = await client.callTool({ name: 'shadowing_review_sop', arguments: { sop_id: sop.id } });
    expect((result.structuredContent as { success: boolean }).success).toBe(false);
    expect(db.getSOP(sop.id)!.status).toBe('draft');

    const audit = db.getAuditLog('sop', sop.id);
    const rejection = audit.find(a => a.action === 'review_rejected');
    expect(rejection?.new_value).toBe('Step 2 is wrong');
  });

  it('keeps the SOP in draft when the user declines the elicitation', async () => {
    await connect({ elicitation: true, respond: () => ({ action: 'decline' }) });
    const result = await client.callTool({ name: 'shadowing_review_sop', arguments: { sop_id: sop.id } });
    expect((result.structuredContent as { success: boolean }).success).toBe(false);
    expect(db.getSOP(sop.id)!.status).toBe('draft');
  });

  it('NEVER elicits when the client lacks the capability — returns a manual-review hint', async () => {
    await connect({ elicitation: false });
    const result = await client.callTool({ name: 'shadowing_review_sop', arguments: { sop_id: sop.id } });

    const structured = result.structuredContent as { success: boolean; elicitation_supported: boolean; message: string };
    expect(structured.elicitation_supported).toBe(false);
    expect(structured.message).toContain('shadowing_approve_sop');
    expect(db.getSOP(sop.id)!.status).toBe('draft');
  });

  it('is a no-op for already-approved SOPs (no elicitation round-trip)', async () => {
    db.updateSOPStatus(sop.id, 'approved');
    let elicited = false;
    await connect({ elicitation: true, respond: () => { elicited = true; return { action: 'accept', content: { decision: 'approve' } }; } });

    const result = await client.callTool({ name: 'shadowing_review_sop', arguments: { sop_id: sop.id } });
    expect((result.structuredContent as { success: boolean }).success).toBe(true);
    expect(elicited).toBe(false);
  });

  it('errors cleanly for unknown SOP ids', async () => {
    await connect({ elicitation: true, respond: () => ({ action: 'cancel' }) });
    const result = await client.callTool({ name: 'shadowing_review_sop', arguments: { sop_id: 'nope' } });
    expect(result.isError).toBe(true);
  });
});
