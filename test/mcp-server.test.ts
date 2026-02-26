import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { MCPServer } from '../src/mcp-server.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-mcp-test-${Date.now()}.db`);
let db: ShadowingDB;
let server: MCPServer;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  server = new MCPServer(db, getDefaultConfig());
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('MCPServer — initialize', () => {
  it('returns protocol version and capabilities', () => {
    const result = server.handleInitialize();
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toHaveProperty('tools');
    expect(result.serverInfo).toEqual({ name: 'shadowing-mcp', version: '0.1.0' });
  });
});

describe('MCPServer — tools/list', () => {
  it('returns all 17 tools', () => {
    const result = server.handleToolsList();
    expect(result.tools.length).toBe(17);
  });

  it('each tool has name, description, and inputSchema', () => {
    const { tools } = server.handleToolsList();
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toHaveProperty('type', 'object');
    }
  });

  it('all tool names start with shadowing_', () => {
    const { tools } = server.handleToolsList();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^shadowing_/);
    }
  });
});

describe('MCPServer — Task Tools', () => {
  it('start_task creates a new task', () => {
    const result = server.handleToolCall('shadowing_start_task', { title: 'MCP Test Task' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.task.title).toBe('MCP Test Task');
    expect(data.task.status).toBe('active');
  });

  it('start_task with description', () => {
    const result = server.handleToolCall('shadowing_start_task', {
      title: 'Described Task',
      description: 'Some notes',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.task.description).toBe('Some notes');
  });

  it('complete_task completes active task', () => {
    server.handleToolCall('shadowing_start_task', { title: 'To Complete' });
    const result = server.handleToolCall('shadowing_complete_task', { complexity_rating: 3 });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.task.status).toBe('completed');
    expect(data.duration).toBeTruthy();
  });

  it('complete_task fails when no active task', () => {
    const result = server.handleToolCall('shadowing_complete_task', {});
    expect(result.isError).toBe(true);
  });

  it('pause and resume task', () => {
    server.handleToolCall('shadowing_start_task', { title: 'Pausable' });

    const pauseResult = server.handleToolCall('shadowing_pause_task', {});
    const pauseData = JSON.parse(pauseResult.content[0]!.text);
    expect(pauseData.task.status).toBe('paused');

    const resumeResult = server.handleToolCall('shadowing_resume_task', {});
    const resumeData = JSON.parse(resumeResult.content[0]!.text);
    expect(resumeData.task.status).toBe('active');
  });

  it('list_tasks returns tasks', () => {
    const t1 = db.createTask('Task A');
    db.completeTask(t1.id);
    db.createTask('Task B');
    const result = server.handleToolCall('shadowing_list_tasks', {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(2);
  });

  it('list_tasks filters by status', () => {
    const t = db.createTask('Active');
    db.pauseTask(t.id);
    const t2 = db.createTask('Paused');
    db.pauseTask(t2.id);
    db.resumeTask(t.id);

    const result = server.handleToolCall('shadowing_list_tasks', { status: 'paused' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Paused');
  });
});

describe('MCPServer — SOP Tools', () => {
  let taskId: string;
  let sopId: string;

  beforeEach(() => {
    const task = db.createTask('SOP Task');
    taskId = task.id;
    const sop = db.createSOP(taskId, {
      title: 'Test SOP',
      content_md: '# Test\n## Objective\nTest content',
      tags: ['test', 'mcp'],
    });
    sopId = sop.id;
  });

  it('list_sops returns SOPs with tags', () => {
    const result = server.handleToolCall('shadowing_list_sops', {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(1);
    expect(data[0].tags).toEqual(expect.arrayContaining(['test', 'mcp']));
  });

  it('list_sops filters by tag', () => {
    const result = server.handleToolCall('shadowing_list_sops', { tag: 'mcp' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(1);
  });

  it('list_sops filters by search', () => {
    const result = server.handleToolCall('shadowing_list_sops', { search: 'Test SOP' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(1);
  });

  it('get_sop returns detail with metrics and versions', () => {
    const result = server.handleToolCall('shadowing_get_sop', { sop_id: sopId });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.title).toBe('Test SOP');
    expect(data.tags).toEqual(expect.arrayContaining(['test', 'mcp']));
    expect(data.metrics).toHaveProperty('consistency_score');
    expect(data.versions).toEqual([]);
  });

  it('get_sop returns error for unknown ID', () => {
    const result = server.handleToolCall('shadowing_get_sop', { sop_id: 'nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('update_sop creates new version', () => {
    const result = server.handleToolCall('shadowing_update_sop', {
      sop_id: sopId,
      content_md: '# Updated\n## Objective\nNew content',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.sop.version).toBe(2);
  });

  it('approve_sop changes status', () => {
    const result = server.handleToolCall('shadowing_approve_sop', { sop_id: sopId });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.sop.status).toBe('approved');
  });

  it('add_tags adds tags to SOP', () => {
    const result = server.handleToolCall('shadowing_add_tags', {
      sop_id: sopId,
      tags: ['new-tag', 'another'],
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.tags).toEqual(expect.arrayContaining(['test', 'mcp', 'new-tag', 'another']));
  });
});

describe('MCPServer — Observation Tools', () => {
  it('start_observation creates session', () => {
    const result = server.handleToolCall('shadowing_start_observation', { title: 'MCP Session' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.session.status).toBe('active');
    expect(data.session.title).toBe('MCP Session');
  });

  it('start_observation returns existing session if active', () => {
    server.handleToolCall('shadowing_start_observation', { title: 'First' });
    const result = server.handleToolCall('shadowing_start_observation', { title: 'Second' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.already_active).toBe(true);
    expect(data.session.title).toBe('First');
  });

  it('log_observation auto-starts session if none active', () => {
    const result = server.handleToolCall('shadowing_log_observation', {
      source: 'shell',
      description: 'git status',
      command: 'git status',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.auto_started).toBe(true);
    expect(data.action.source).toBe('shell');
  });

  it('log_observation logs to active session', () => {
    server.handleToolCall('shadowing_start_observation', { title: 'Active Session' });
    const result = server.handleToolCall('shadowing_log_observation', {
      source: 'file',
      description: 'Editing: src/main.ts',
      file_path: 'src/main.ts',
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.auto_started).toBeUndefined();
  });

  it('stop_observation completes session', () => {
    server.handleToolCall('shadowing_start_observation', { title: 'To Stop' });
    server.handleToolCall('shadowing_log_observation', { source: 'manual', description: 'test action' });

    const result = server.handleToolCall('shadowing_stop_observation', {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.success).toBe(true);
    expect(data.session.status).toBe('completed');
    expect(data.session.total_actions).toBe(1);
  });

  it('stop_observation fails when no session', () => {
    const result = server.handleToolCall('shadowing_stop_observation', {});
    expect(result.isError).toBe(true);
  });

  it('get_timeline returns actions', () => {
    const startResult = server.handleToolCall('shadowing_start_observation', { title: 'Timeline' });
    const sessionId = JSON.parse(startResult.content[0]!.text).session.id;

    server.handleToolCall('shadowing_log_observation', { source: 'shell', description: 'cmd1' });
    server.handleToolCall('shadowing_log_observation', { source: 'file', description: 'edit1' });

    const result = server.handleToolCall('shadowing_get_timeline', { session_id: sessionId });
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveLength(2);
  });
});

describe('MCPServer — Status & Stats', () => {
  it('get_status returns current state', () => {
    const result = server.handleToolCall('shadowing_get_status', {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.active_task).toBeNull();
    expect(data.active_observation_session).toBeNull();
    expect(data.stats).toHaveProperty('total_tasks');
  });

  it('get_status includes active task info', () => {
    db.createTask('Active Status Task');
    const result = server.handleToolCall('shadowing_get_status', {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.active_task).not.toBeNull();
    expect(data.active_task.title).toBe('Active Status Task');
    expect(data.active_task.elapsed).toBeTruthy();
  });

  it('get_stats returns global statistics', () => {
    const result = server.handleToolCall('shadowing_get_stats', {});
    const data = JSON.parse(result.content[0]!.text);
    expect(data).toHaveProperty('total_tasks');
    expect(data).toHaveProperty('total_sops');
    expect(data).toHaveProperty('total_exports');
  });
});

describe('MCPServer — Error Handling', () => {
  it('unknown tool returns error', () => {
    const result = server.handleToolCall('nonexistent_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown tool');
  });
});
