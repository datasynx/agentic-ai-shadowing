import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MCPServer } from '../src/mcp-server.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-mcp-neg-${Date.now()}.db`);

let db: ShadowingDB;
let mcp: MCPServer;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  const config = getDefaultConfig();
  mcp = new MCPServer(db, config);
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('MCP Server — Negative Tests', () => {
  it('returns error for unknown tool name', () => {
    const result = mcp.handleToolCall('nonexistent_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown tool');
  });

  it('returns error when starting task without title', () => {
    const result = mcp.handleToolCall('shadowing_start_task', {});
    // Should attempt to start with undefined title
    expect(result.isError).toBeTruthy();
  });

  it('returns error when completing task with none active', () => {
    const result = mcp.handleToolCall('shadowing_complete_task', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No active task');
  });

  it('returns error when pausing with no active task', () => {
    const result = mcp.handleToolCall('shadowing_pause_task', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No active task');
  });

  it('returns error when resuming with no paused task', () => {
    const result = mcp.handleToolCall('shadowing_resume_task', {});
    expect(result.isError).toBe(true);
  });

  it('returns error when getting nonexistent SOP', () => {
    const result = mcp.handleToolCall('shadowing_get_sop', { sop_id: 'nonexistent123456' });
    expect(result.isError).toBe(true);
  });

  it('returns error when updating nonexistent SOP status', () => {
    const result = mcp.handleToolCall('shadowing_update_sop_status', {
      sop_id: 'nonexistent',
      status: 'reviewed',
    });
    expect(result.isError).toBe(true);
  });

  it('handles double start task correctly', () => {
    // Start first task
    mcp.handleToolCall('shadowing_start_task', { title: 'First' });
    // Try to start second — should error
    const result = mcp.handleToolCall('shadowing_start_task', { title: 'Second' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('already running');
  });

  it('handles empty string tool name', () => {
    const result = mcp.handleToolCall('', {});
    expect(result.isError).toBe(true);
  });

  it('handles tool list request', () => {
    const result = mcp.handleToolsList();
    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect(result.tools.length).toBeGreaterThan(0);
  });
});
