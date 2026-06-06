import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { MCPServer } from '../src/mcp-server.js';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';

// Issue #13: the README MCP tool list must match the tools the server exposes.
function actualToolNames(): string[] {
  const dbPath = join(tmpdir(), `shadowing-parity-${Date.now()}.db`);
  const db = new ShadowingDB(dbPath);
  db.initialize();
  const server = new MCPServer(db, getDefaultConfig());
  const names = server.handleToolsList().tools.map((t) => t.name);
  db.close();
  try { unlinkSync(dbPath); } catch { /* ok */ }
  return names;
}

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

describe('README ↔ MCP tool parity (issue #13)', () => {
  const names = actualToolNames();

  it('documents every tool the server actually exposes', () => {
    for (const name of names) {
      expect(README, `README should mention MCP tool "${name}"`).toContain(name);
    }
  });

  it('does not reference tool names that no longer exist', () => {
    const stale = [
      'task_start', 'task_status', 'task_complete', 'task_pause',
      'sop_list', 'sop_show', 'sop_generate', 'sop_update_status',
      'observe_start', 'observe_stop', 'timeline_show', 'session_analyze',
      'stats_show', 'consent_manage', 'exclude_manage', 'config_show',
    ];
    for (const bad of stale) {
      // Match as a backticked token to avoid false positives on prose.
      expect(README, `README should not list removed tool "${bad}"`).not.toContain('`' + bad + '`');
    }
  });

  it('states the correct tool count', () => {
    expect(README).toContain(`${names.length} tools`);
  });
});
