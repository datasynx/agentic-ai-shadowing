import { createInterface } from 'node:readline';
import { ShadowingDB } from './db.js';
import { TaskManager, formatDuration } from './task-manager.js';
import { Anonymizer } from './anonymizer.js';
import { Exporter } from './exporter.js';
import { calculateSOPMetrics } from './metrics.js';
import { loadConfig, getDbPath } from './config.js';
import type { ShadowingConfig, SOPStatus, TaskStatus } from './types.js';

// ── MCP Protocol Types ──────────────────────────────────────────────────────

interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS: MCPToolDefinition[] = [
  {
    name: 'shadowing_start_task',
    description: 'Start tracking a new task. The task title describes what the user is working on. Only one task can be active at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the task being tracked' },
        description: { type: 'string', description: 'Optional description or notes' },
      },
      required: ['title'],
    },
  },
  {
    name: 'shadowing_complete_task',
    description: 'Complete the currently active task. This calculates the duration and can trigger SOP generation.',
    inputSchema: {
      type: 'object',
      properties: {
        complexity_rating: { type: 'number', minimum: 1, maximum: 5, description: 'Complexity rating 1-5 (optional)' },
        notes: { type: 'string', description: 'Final notes about the completed task' },
      },
    },
  },
  {
    name: 'shadowing_pause_task',
    description: 'Pause the currently active task.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shadowing_resume_task',
    description: 'Resume a paused task.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shadowing_get_status',
    description: 'Get the current shadowing status: active task, statistics, observation session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shadowing_list_sops',
    description: 'List all SOPs (Standard Operating Procedures). Filter by status, tag, or search text.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'reviewed', 'approved', 'exported', 'archived'], description: 'Filter by SOP status' },
        tag: { type: 'string', description: 'Filter by tag name' },
        search: { type: 'string', description: 'Search in title and content' },
      },
    },
  },
  {
    name: 'shadowing_get_sop',
    description: 'Get a specific SOP by ID, including content, tags, metrics, and version history.',
    inputSchema: {
      type: 'object',
      properties: {
        sop_id: { type: 'string', description: 'SOP ID (hex string)' },
      },
      required: ['sop_id'],
    },
  },
  {
    name: 'shadowing_update_sop',
    description: 'Update a SOP content, title, or description. Creates a new version automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        sop_id: { type: 'string', description: 'SOP ID to update' },
        title: { type: 'string', description: 'New title (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        content_md: { type: 'string', description: 'New markdown content (optional)' },
      },
      required: ['sop_id'],
    },
  },
  {
    name: 'shadowing_approve_sop',
    description: 'Move a SOP to approved status.',
    inputSchema: {
      type: 'object',
      properties: {
        sop_id: { type: 'string', description: 'SOP ID to approve' },
      },
      required: ['sop_id'],
    },
  },
  {
    name: 'shadowing_add_tags',
    description: 'Add tags to a SOP for categorization.',
    inputSchema: {
      type: 'object',
      properties: {
        sop_id: { type: 'string', description: 'SOP ID' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
      },
      required: ['sop_id', 'tags'],
    },
  },
  {
    name: 'shadowing_log_observation',
    description: 'Log a manual observation action to the active observation session. Use this to record what Claude Code is doing (tool calls, file edits, commands run).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['shell', 'git', 'file', 'manual'], description: 'Action source type' },
        description: { type: 'string', description: 'Description of the observed action' },
        command: { type: 'string', description: 'Command that was executed (for shell/git sources)' },
        file_path: { type: 'string', description: 'File path (for file source)' },
        metadata: { type: 'object', description: 'Additional metadata as key-value pairs' },
      },
      required: ['source', 'description'],
    },
  },
  {
    name: 'shadowing_start_observation',
    description: 'Start an observation session to track workflow actions.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Session title (e.g. "Claude Code Session")' },
      },
    },
  },
  {
    name: 'shadowing_stop_observation',
    description: 'Stop the active observation session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shadowing_get_stats',
    description: 'Get global statistics: task counts, SOP counts, quality scores, export counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shadowing_export_sops',
    description: 'Export SOPs as anonymized markdown files with a manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        sop_ids: { type: 'array', items: { type: 'string' }, description: 'SOP IDs to export. If empty, exports all approved SOPs.' },
      },
    },
  },
  {
    name: 'shadowing_list_tasks',
    description: 'List all tracked tasks with their status and duration.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'completed', 'cancelled'], description: 'Filter by task status' },
      },
    },
  },
  {
    name: 'shadowing_get_timeline',
    description: 'Get the action timeline for an observation session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Observation session ID' },
        source: { type: 'string', enum: ['window', 'shell', 'git', 'file', 'manual'], description: 'Filter by action source' },
        limit: { type: 'number', description: 'Max actions to return (default 50)' },
      },
      required: ['session_id'],
    },
  },
];

// ── MCP Server ──────────────────────────────────────────────────────────────

export class MCPServer {
  private db: ShadowingDB;
  private config: ShadowingConfig;
  private taskManager: TaskManager;

  constructor(db: ShadowingDB, config: ShadowingConfig) {
    this.db = db;
    this.config = config;
    this.taskManager = new TaskManager(db);
  }

  getToolDefinitions(): MCPToolDefinition[] {
    return TOOLS;
  }

  handleInitialize(): Record<string, unknown> {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'shadowing-mcp',
        version: '0.1.0',
      },
    };
  }

  handleToolsList(): { tools: MCPToolDefinition[] } {
    return { tools: TOOLS };
  }

  handleToolCall(name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    try {
      const result = this.executeTool(name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : 'Unknown error' }],
        isError: true,
      };
    }
  }

  private executeTool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'shadowing_start_task': {
        const title = args['title'] as string;
        const description = args['description'] as string | undefined;
        const task = this.taskManager.startTask(title, description);
        return { success: true, task, message: `Task "${title}" gestartet.` };
      }

      case 'shadowing_complete_task': {
        const result = this.taskManager.completeTask(args['complexity_rating'] as number | undefined);
        if (args['notes'] && result.task.description) {
          this.db.updateTask(result.task.id, {
            description: result.task.description + '\n' + (args['notes'] as string),
          });
        } else if (args['notes']) {
          this.db.updateTask(result.task.id, { description: args['notes'] as string });
        }
        return { success: true, task: result.task, duration: result.duration, message: `Task abgeschlossen (${result.duration}).` };
      }

      case 'shadowing_pause_task': {
        const task = this.taskManager.pauseTask();
        return { success: true, task, message: 'Task pausiert.' };
      }

      case 'shadowing_resume_task': {
        const task = this.taskManager.resumeTask();
        return { success: true, task, message: 'Task fortgesetzt.' };
      }

      case 'shadowing_get_status': {
        const activeTask = this.db.getActiveTask();
        const stats = this.db.getGlobalStats();
        const activeSession = this.db.getActiveObservationSession();
        return {
          active_task: activeTask ? {
            ...activeTask,
            running_since: activeTask.started_at,
            elapsed: formatDuration(Math.floor((Date.now() - new Date(activeTask.started_at + 'Z').getTime()) / 1000)),
          } : null,
          active_observation_session: activeSession,
          stats,
        };
      }

      case 'shadowing_list_sops': {
        const filter: { status?: SOPStatus; tag?: string; search?: string } = {};
        if (args['status']) filter.status = args['status'] as SOPStatus;
        if (args['tag']) filter.tag = args['tag'] as string;
        if (args['search']) filter.search = args['search'] as string;
        const sops = this.db.listSOPs(filter);
        return sops.map(s => ({
          ...s,
          tags: this.db.getTagsForSOP(s.id).map(t => t.name),
        }));
      }

      case 'shadowing_get_sop': {
        const id = args['sop_id'] as string;
        const sop = this.db.getSOP(id);
        if (!sop) throw new Error(`SOP "${id}" nicht gefunden.`);
        const tags = this.db.getTagsForSOP(id).map(t => t.name);
        const metrics = calculateSOPMetrics(this.db, id, this.config.metrics.quality_score_weights);
        const versions = this.db.getSOPVersions(id);
        return { ...sop, tags, metrics, versions };
      }

      case 'shadowing_update_sop': {
        const id = args['sop_id'] as string;
        const updates: Record<string, unknown> = {};
        if (args['title']) updates['title'] = args['title'];
        if (args['description']) updates['description'] = args['description'];
        if (args['content_md']) updates['content_md'] = args['content_md'];
        const sop = this.db.updateSOP(id, updates as { title?: string; description?: string; content_md?: string });
        return { success: true, sop, message: `SOP "${sop.title}" aktualisiert (v${sop.version}).` };
      }

      case 'shadowing_approve_sop': {
        const id = args['sop_id'] as string;
        const sop = this.db.updateSOPStatus(id, 'approved');
        return { success: true, sop, message: `SOP "${sop.title}" genehmigt.` };
      }

      case 'shadowing_add_tags': {
        const id = args['sop_id'] as string;
        const tags = args['tags'] as string[];
        for (const tag of tags) {
          this.db.addTagToSOP(id, tag, false);
        }
        const allTags = this.db.getTagsForSOP(id).map(t => t.name);
        return { success: true, tags: allTags, message: `${tags.length} Tag(s) hinzugefügt.` };
      }

      case 'shadowing_log_observation': {
        const session = this.db.getActiveObservationSession();
        if (!session) {
          // Auto-start a session for convenience
          const newSession = this.db.startObservationSession('Claude Code Auto-Session');
          const action = this.db.logObservedAction(newSession.id, {
            source: args['source'] as 'shell' | 'git' | 'file' | 'manual',
            window_title: args['description'] as string,
            command: args['command'] as string | undefined,
            file_path: args['file_path'] as string | undefined,
            metadata: args['metadata'] as Record<string, unknown> | undefined,
          });
          return { success: true, action, session_id: newSession.id, auto_started: true };
        }
        const action = this.db.logObservedAction(session.id, {
          source: args['source'] as 'shell' | 'git' | 'file' | 'manual',
          window_title: args['description'] as string,
          command: args['command'] as string | undefined,
          file_path: args['file_path'] as string | undefined,
          metadata: args['metadata'] as Record<string, unknown> | undefined,
        });
        return { success: true, action, session_id: session.id };
      }

      case 'shadowing_start_observation': {
        const title = (args['title'] as string) ?? 'Claude Code Session';
        const existing = this.db.getActiveObservationSession();
        if (existing) {
          return { success: true, session: existing, message: 'Session bereits aktiv.', already_active: true };
        }
        const session = this.db.startObservationSession(title);
        return { success: true, session, message: `Observation-Session "${title}" gestartet.` };
      }

      case 'shadowing_stop_observation': {
        const session = this.db.getActiveObservationSession();
        if (!session) throw new Error('Keine aktive Observation-Session.');
        const completed = this.db.completeObservationSession(session.id);
        return { success: true, session: completed, message: `Session beendet (${completed.total_actions} Actions).` };
      }

      case 'shadowing_get_stats':
        return this.db.getGlobalStats();

      case 'shadowing_export_sops': {
        const sopIds = (args['sop_ids'] as string[]) ?? [];
        const anonymizer = new Anonymizer(this.config.anonymization);
        const exporter = new Exporter(this.db, anonymizer, this.config);
        if (sopIds.length === 0) {
          const result = exporter.exportAll();
          return { success: true, ...result, message: `${result.sop_count} SOPs exportiert.` };
        }
        const result = exporter.exportSOPs(sopIds);
        return { success: true, ...result, message: `${result.sop_count} SOPs exportiert.` };
      }

      case 'shadowing_list_tasks': {
        const filter = args['status'] ? { status: args['status'] as TaskStatus } : undefined;
        return this.db.listTasks(filter);
      }

      case 'shadowing_get_timeline': {
        const sessionId = args['session_id'] as string;
        const source = args['source'] as 'window' | 'shell' | 'git' | 'file' | 'manual' | undefined;
        const limit = (args['limit'] as number) ?? 50;
        return this.db.getObservedActions(sessionId, { source, limit });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// ── Stdio Transport ─────────────────────────────────────────────────────────

export function startMCPServer(): void {
  const config = loadConfig();
  const dbPath = getDbPath();
  const db = new ShadowingDB(dbPath);
  db.initialize();

  const server = new MCPServer(db, config);

  const rl = createInterface({ input: process.stdin, terminal: false });

  function send(msg: MCPResponse | MCPNotification): void {
    const json = JSON.stringify(msg);
    process.stdout.write(json + '\n');
  }

  rl.on('line', (line) => {
    let parsed: MCPRequest | MCPNotification;
    try {
      parsed = JSON.parse(line) as MCPRequest | MCPNotification;
    } catch {
      return; // Skip malformed lines
    }

    // Notifications (no id) — just ack
    if (!('id' in parsed) || parsed.id === undefined) {
      if ((parsed as MCPNotification).method === 'notifications/initialized') {
        // Client confirmed initialization — nothing to do
      }
      return;
    }

    const req = parsed as MCPRequest;

    switch (req.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id: req.id, result: server.handleInitialize() });
        break;

      case 'tools/list':
        send({ jsonrpc: '2.0', id: req.id, result: server.handleToolsList() });
        break;

      case 'tools/call': {
        const params = req.params as { name: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) {
          send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Missing tool name' } });
          break;
        }
        const result = server.handleToolCall(params.name, params.arguments ?? {});
        send({ jsonrpc: '2.0', id: req.id, result });
        break;
      }

      default:
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
    }
  });

  rl.on('close', () => {
    db.close();
    process.exitCode = 0;
  });

  process.stderr.write('shadowing-mcp: Server gestartet (stdio)\n');
}
