import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { ShadowingDB } from './db.js';
import { TaskManager, formatDuration } from './task-manager.js';
import { Anonymizer, createCaptureRedactor } from './anonymizer.js';
import { Exporter } from './exporter.js';
import { calculateSOPMetrics } from './metrics.js';
import { loadConfig, getDbPath } from './config.js';
import { getPackageVersion } from './version.js';
import type { ShadowingConfig, SOPStatus, TaskStatus } from './types.js';
import { getLogger } from './logger.js';
import {
  isLoopbackHost,
  timingSafeBearerEqual,
  readLimitedBody,
  BodyTooLargeError,
  clientIpOf,
  RateLimiter,
  loopbackHostHeaders,
  MAX_HTTP_BODY_BYTES,
} from './http-security.js';

const log = getLogger('mcp-server');

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
    description: 'List SOPs (Standard Operating Procedures). Prefer status/tag/search filters over paging through everything. Paginated: max 200 per page, pass next_cursor as cursor for more.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'reviewed', 'approved', 'exported', 'archived'], description: 'Filter by SOP status' },
        tag: { type: 'string', description: 'Filter by tag name' },
        search: { type: 'string', description: 'Search in title and content' },
        limit: { type: 'number', description: 'Page size (default 50, max 200)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page (next_cursor)' },
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
    description: 'List tracked tasks with status and duration. Paginated: max 200 per page, pass next_cursor as cursor for more.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'completed', 'cancelled'], description: 'Filter by task status' },
        limit: { type: 'number', description: 'Page size (default 50, max 200)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page (next_cursor)' },
      },
    },
  },
  {
    name: 'shadowing_review_sop',
    description: 'Review a draft SOP with the user: shows a summary and asks for approval via elicitation (approve / reject / keep as draft). Falls back to a manual-review hint when the client does not support elicitation.',
    inputSchema: {
      type: 'object',
      properties: {
        sop_id: { type: 'string', description: 'SOP ID to review' },
      },
      required: ['sop_id'],
    },
  },
  {
    name: 'shadowing_get_timeline',
    description: 'Get the action timeline for an observation session. Paginated: max 200 per page, pass next_cursor as cursor for more.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Observation session ID' },
        source: { type: 'string', enum: ['window', 'shell', 'git', 'file', 'manual'], description: 'Filter by action source' },
        limit: { type: 'number', description: 'Page size (default 50, max 200)' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page (next_cursor)' },
      },
      required: ['session_id'],
    },
  },
];

// ── Pagination (#34) ─────────────────────────────────────────────────────────
// List tools never dump unbounded result sets into model context: default
// page size 50, hard max 200, opaque cursor (offset encoded as string).

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(n, 1), MAX_PAGE_SIZE);
}

function parseCursor(value: unknown): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function paginate<T>(items: T[], key: string, args: Record<string, unknown>): Record<string, unknown> {
  const limit = clampLimit(args['limit']);
  const offset = parseCursor(args['cursor']);
  const page = items.slice(offset, offset + limit);
  return {
    [key]: page,
    next_cursor: offset + limit < items.length ? String(offset + limit) : null,
  };
}

// ── MCP Server ──────────────────────────────────────────────────────────────

export class MCPServer {
  private db: ShadowingDB;
  private config: ShadowingConfig;
  private taskManager: TaskManager;

  constructor(db: ShadowingDB, config: ShadowingConfig) {
    this.db = db;
    this.config = config;
    this.taskManager = new TaskManager(db, createCaptureRedactor(config) ?? undefined);
  }

  getToolDefinitions(): MCPToolDefinition[] {
    return TOOLS;
  }

  handleInitialize(): Record<string, unknown> {
    return {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'shadowing-mcp',
        version: getPackageVersion(),
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

  /** Execute a tool and return its raw result (throws on error). Used by the SDK handlers. */
  callTool(name: string, args: Record<string, unknown>): unknown {
    return this.executeTool(name, args);
  }

  private executeTool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'shadowing_start_task': {
        const title = args['title'] as string;
        const description = args['description'] as string | undefined;
        const task = this.taskManager.startTask(title, description);
        return { success: true, task, message: `Task "${title}" started.` };
      }

      case 'shadowing_complete_task': {
        const result = this.taskManager.completeTask(
          args['complexity_rating'] as number | undefined,
          args['notes'] as string | undefined,
        );
        return { success: true, task: result.task, duration: result.duration, message: `Task completed (${result.duration}).` };
      }

      case 'shadowing_pause_task': {
        const task = this.taskManager.pauseTask();
        return { success: true, task, message: 'Task paused.' };
      }

      case 'shadowing_resume_task': {
        const task = this.taskManager.resumeTask();
        return { success: true, task, message: 'Task resumed.' };
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
        const all = this.db.listSOPs(filter).map(s => ({
          ...s,
          tags: this.db.getTagsForSOP(s.id).map(t => t.name),
        }));
        return paginate(all, 'sops', args);
      }

      case 'shadowing_get_sop': {
        const id = args['sop_id'] as string;
        const sop = this.db.getSOP(id);
        if (!sop) throw new Error(`SOP "${id}" not found.`);
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
        return { success: true, sop, message: `SOP "${sop.title}" updated (v${sop.version}).` };
      }

      case 'shadowing_approve_sop': {
        const id = args['sop_id'] as string;
        const sop = this.db.updateSOPStatus(id, 'approved');
        return { success: true, sop, message: `SOP "${sop.title}" approved.` };
      }

      case 'shadowing_add_tags': {
        const id = args['sop_id'] as string;
        const tags = args['tags'] as string[];
        for (const tag of tags) {
          this.db.addTagToSOP(id, tag, false);
        }
        const allTags = this.db.getTagsForSOP(id).map(t => t.name);
        return { success: true, tags: allTags, message: `${tags.length} tag(s) added.` };
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
          return { success: true, session: existing, message: 'Session already active.', already_active: true };
        }
        const session = this.db.startObservationSession(title);
        return { success: true, session, message: `Observation session "${title}" started.` };
      }

      case 'shadowing_stop_observation': {
        const session = this.db.getActiveObservationSession();
        if (!session) throw new Error('No active observation session.');
        const completed = this.db.completeObservationSession(session.id);
        return { success: true, session: completed, message: `Session ended (${completed.total_actions} actions).` };
      }

      case 'shadowing_get_stats':
        return this.db.getGlobalStats();

      case 'shadowing_export_sops': {
        const sopIds = (args['sop_ids'] as string[]) ?? [];
        const anonymizer = new Anonymizer(this.config.anonymization);
        const exporter = new Exporter(this.db, anonymizer, this.config);
        if (sopIds.length === 0) {
          const result = exporter.exportAll();
          return { success: true, ...result, message: `${result.sop_count} SOPs exported.` };
        }
        const result = exporter.exportSOPs(sopIds);
        return { success: true, ...result, message: `${result.sop_count} SOPs exported.` };
      }

      case 'shadowing_list_tasks': {
        const filter = args['status'] ? { status: args['status'] as TaskStatus } : undefined;
        return paginate(this.db.listTasks(filter), 'tasks', args);
      }

      case 'shadowing_get_timeline': {
        const sessionId = args['session_id'] as string;
        const source = args['source'] as 'window' | 'shell' | 'git' | 'file' | 'manual' | undefined;
        // Fetch one extra row beyond the page to know whether more exist
        const limit = clampLimit(args['limit']);
        const offset = parseCursor(args['cursor']);
        const page = this.db.getObservedActions(sessionId, { source, limit: limit + 1, offset });
        const actions = page.slice(0, limit);
        return {
          actions,
          next_cursor: page.length > limit ? String(offset + limit) : null,
        };
      }

      case 'shadowing_review_sop':
        throw new Error('shadowing_review_sop requires a connected MCP client (elicitation) — use shadowing_approve_sop for direct approval.');

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// ── Stdio Transport ─────────────────────────────────────────────────────────

// ── SDK Tool Registrations ──────────────────────────────────────────────────
// Protocol plumbing is delegated to @modelcontextprotocol/sdk (#22): the SDK
// handles initialize/ping/tools list+call, input validation (zod), and
// structured output validation. MCPServer above stays the business-logic layer.

const SOP_STATUS_VALUES = ['draft', 'reviewed', 'approved', 'exported', 'archived'] as const;
const TASK_STATUS_VALUES = ['active', 'paused', 'completed', 'cancelled'] as const;

/** Loose result schema: success/message where present, everything else passed through. */
const ObjectResultSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
}).passthrough();

interface ToolRegistration {
  name: string;
  title: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  outputSchema: ZodTypeAny;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };

const TOOL_REGISTRATIONS: ToolRegistration[] = [
  {
    name: 'shadowing_start_task',
    title: 'Start Task',
    inputSchema: {
      title: z.string().describe('Title of the task being tracked'),
      description: z.string().optional().describe('Optional description or notes'),
    },
    annotations: WRITE,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_complete_task',
    title: 'Complete Task',
    inputSchema: {
      complexity_rating: z.number().min(1).max(5).optional().describe('Complexity rating 1-5 (optional)'),
      notes: z.string().optional().describe('Final notes about the completed task'),
    },
    annotations: WRITE,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_pause_task',
    title: 'Pause Task',
    inputSchema: {},
    annotations: WRITE,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_resume_task',
    title: 'Resume Task',
    inputSchema: {},
    annotations: WRITE,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_get_status',
    title: 'Get Status',
    inputSchema: {},
    annotations: READ_ONLY,
    outputSchema: z.object({}).passthrough(),
  },
  {
    name: 'shadowing_list_sops',
    title: 'List SOPs',
    inputSchema: {
      status: z.enum(SOP_STATUS_VALUES).optional().describe('Filter by SOP status'),
      tag: z.string().optional().describe('Filter by tag name'),
      search: z.string().optional().describe('Search in title and content'),
      limit: z.number().optional().describe('Page size (default 50, max 200)'),
      cursor: z.string().optional().describe('Opaque cursor from a previous page (next_cursor)'),
    },
    annotations: READ_ONLY,
    outputSchema: z.object({ sops: z.array(z.unknown()), next_cursor: z.string().nullable() }),
  },
  {
    name: 'shadowing_get_sop',
    title: 'Get SOP',
    inputSchema: {
      sop_id: z.string().describe('SOP ID (hex string)'),
    },
    annotations: READ_ONLY,
    outputSchema: z.object({}).passthrough(),
  },
  {
    name: 'shadowing_update_sop',
    title: 'Update SOP',
    inputSchema: {
      sop_id: z.string().describe('SOP ID to update'),
      title: z.string().optional().describe('New title (optional)'),
      description: z.string().optional().describe('New description (optional)'),
      content_md: z.string().optional().describe('New markdown content (optional)'),
    },
    annotations: WRITE, // not idempotent: every content change increments the version
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_approve_sop',
    title: 'Approve SOP',
    inputSchema: {
      sop_id: z.string().describe('SOP ID to approve'),
    },
    annotations: WRITE_IDEMPOTENT,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_add_tags',
    title: 'Add Tags',
    inputSchema: {
      sop_id: z.string().describe('SOP ID'),
      tags: z.array(z.string()).describe('Tags to add'),
    },
    annotations: WRITE_IDEMPOTENT,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_log_observation',
    title: 'Log Observation',
    inputSchema: {
      source: z.enum(['shell', 'git', 'file', 'manual']).describe('Action source type'),
      description: z.string().describe('Description of the observed action'),
      command: z.string().optional().describe('Command that was executed (for shell/git sources)'),
      file_path: z.string().optional().describe('File path (for file source)'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata as key-value pairs'),
    },
    annotations: WRITE,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_start_observation',
    title: 'Start Observation Session',
    inputSchema: {
      title: z.string().optional().describe('Session title (e.g. "Claude Code Session")'),
    },
    annotations: WRITE_IDEMPOTENT, // returns the existing session when one is active
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_stop_observation',
    title: 'Stop Observation Session',
    inputSchema: {},
    annotations: WRITE,
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_get_stats',
    title: 'Get Statistics',
    inputSchema: {},
    annotations: READ_ONLY,
    outputSchema: z.object({}).passthrough(),
  },
  {
    name: 'shadowing_export_sops',
    title: 'Export SOPs',
    inputSchema: {
      sop_ids: z.array(z.string()).optional().describe('SOP IDs to export. If empty, exports all approved SOPs.'),
    },
    annotations: WRITE, // creates a new export directory on every call
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_list_tasks',
    title: 'List Tasks',
    inputSchema: {
      status: z.enum(TASK_STATUS_VALUES).optional().describe('Filter by task status'),
      limit: z.number().optional().describe('Page size (default 50, max 200)'),
      cursor: z.string().optional().describe('Opaque cursor from a previous page (next_cursor)'),
    },
    annotations: READ_ONLY,
    outputSchema: z.object({ tasks: z.array(z.unknown()), next_cursor: z.string().nullable() }),
  },
  {
    name: 'shadowing_review_sop',
    title: 'Review SOP (elicitation)',
    inputSchema: {
      sop_id: z.string().describe('SOP ID to review'),
    },
    annotations: WRITE_IDEMPOTENT, // approving an approved SOP is a no-op
    outputSchema: ObjectResultSchema,
  },
  {
    name: 'shadowing_get_timeline',
    title: 'Get Session Timeline',
    inputSchema: {
      session_id: z.string().describe('Observation session ID'),
      source: z.enum(['window', 'shell', 'git', 'file', 'manual']).optional().describe('Filter by action source'),
      limit: z.number().optional().describe('Page size (default 50, max 200)'),
      cursor: z.string().optional().describe('Opaque cursor from a previous page (next_cursor)'),
    },
    annotations: READ_ONLY,
    outputSchema: z.object({ actions: z.array(z.unknown()), next_cursor: z.string().nullable() }),
  },
];

const SERVER_INSTRUCTIONS =
  'Shadowing tracks what the user works on and turns it into SOPs. ' +
  'Call shadowing_start_task when the user begins a piece of work and shadowing_complete_task when it is done. ' +
  'Use shadowing_log_observation to record notable actions (commands, file edits) during a task. ' +
  'SOPs start as drafts: review them with shadowing_get_sop, refine with shadowing_update_sop, ' +
  'then shadowing_approve_sop before exporting with shadowing_export_sops.';

/**
 * Build the SDK server on top of the MCPServer business logic.
 * Exported separately so tests can drive it via an in-memory transport.
 */
export function buildMcpServer(db: ShadowingDB, config: ShadowingConfig): McpServer {
  const logic = new MCPServer(db, config);

  const server = new McpServer(
    { name: 'shadowing-mcp', version: getPackageVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Read-only context as resources (#34): hosts can load these as context
  // instead of spending a tool call.
  server.registerResource(
    'global-stats',
    'shadowing://stats',
    {
      title: 'Shadowing statistics',
      description: 'Global task/SOP/export statistics as JSON.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(db.getGlobalStats(), null, 2) }],
    }),
  );

  server.registerResource(
    'approved-sops',
    new ResourceTemplate('shadowing://sops/{id}', {
      list: () => ({
        resources: db.listSOPs({ status: 'approved' }).map(s => ({
          uri: `shadowing://sops/${s.id}`,
          name: s.title,
          description: s.description ?? undefined,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Approved SOPs',
      description: 'Markdown of an approved Standard Operating Procedure.',
      mimeType: 'text/markdown',
    },
    (uri, variables) => {
      const sop = db.getSOP(String(variables['id']));
      if (!sop || sop.status !== 'approved') {
        throw new Error(`No approved SOP with id ${String(variables['id'])}`);
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: sop.content_md }],
      };
    },
  );

  registerReviewSopTool(server, db);

  for (const reg of TOOL_REGISTRATIONS) {
    if (reg.name === 'shadowing_review_sop') continue; // registered above (elicitation handler)
    const description = TOOLS.find(t => t.name === reg.name)?.description ?? reg.title;
    server.registerTool(
      reg.name,
      {
        title: reg.title,
        description,
        inputSchema: reg.inputSchema,
        outputSchema: reg.outputSchema,
        annotations: reg.annotations,
      },
      (args: Record<string, unknown>) => {
        try {
          const result = logic.callTool(reg.name, args ?? {});
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: err instanceof Error ? err.message : 'Unknown error' }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

/**
 * shadowing_review_sop (#30): elicitation-based in-session approval.
 * Capability-gated — clients without elicitation get a manual-review hint,
 * never an elicitation request. Approval here only changes SOP status;
 * publishing into agent files still goes through the diff+confirm flow (#28).
 */
function registerReviewSopTool(server: McpServer, db: ShadowingDB): void {
  const reg = TOOL_REGISTRATIONS.find(r => r.name === 'shadowing_review_sop')!;
  const description = TOOLS.find(t => t.name === reg.name)!.description;

  server.registerTool(
    reg.name,
    {
      title: reg.title,
      description,
      inputSchema: reg.inputSchema,
      outputSchema: reg.outputSchema,
      annotations: reg.annotations,
    },
    async (args: Record<string, unknown>) => {
      const wrap = (result: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> } => ({
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });

      const sopId = args['sop_id'] as string;
      const sop = db.getSOP(sopId);
      if (!sop) {
        return { content: [{ type: 'text' as const, text: `SOP "${sopId}" not found.` }], isError: true };
      }
      if (sop.status === 'approved') {
        return wrap({ success: true, sop, message: 'SOP is already approved.' });
      }

      const capabilities = server.server.getClientCapabilities();
      if (!capabilities?.elicitation) {
        return wrap({
          success: false,
          elicitation_supported: false,
          message: `Client does not support elicitation. Review manually: shadowing_get_sop ${sopId}, then shadowing_approve_sop.`,
        });
      }

      const stepCount = sop.content_md.match(/^###\s+Step/gm)?.length ?? 0;
      const result = await server.server.elicitInput({
        message: `Approve SOP "${sop.title}" (v${sop.version}, ${stepCount} steps)? ${sop.description ?? ''}`.trim(),
        requestedSchema: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['approve', 'reject', 'keep-draft'],
              description: 'approve = mark the SOP approved; reject = keep as draft and record feedback; keep-draft = decide later',
            },
            feedback: { type: 'string', description: 'Optional feedback (stored with the SOP on reject)' },
          },
          required: ['decision'],
        },
      });

      const decision = result.action === 'accept' ? (result.content?.['decision'] as string | undefined) : undefined;

      if (decision === 'approve') {
        // Audit is written atomically inside updateSOPStatus (#56).
        const approved = db.updateSOPStatus(sopId, 'approved', { action: 'status_change', source: 'mcp-elicitation' });
        return wrap({ success: true, sop: approved, message: `SOP "${approved.title}" approved.` });
      }

      if (decision === 'reject') {
        const feedback = (result.content?.['feedback'] as string | undefined) ?? '';
        db.logAudit({ entity_type: 'sop', entity_id: sopId, action: 'review_rejected', new_value: feedback, source: 'mcp-elicitation' });
        return wrap({ success: false, sop, message: `SOP stays in draft.${feedback ? ` Feedback recorded: ${feedback}` : ''}` });
      }

      return wrap({ success: false, sop, message: 'Review postponed — SOP stays in draft.' });
    },
  );
}

/** Names registered with the SDK — must stay in sync with TOOLS (asserted by tests). */
export function getRegisteredToolNames(): string[] {
  return TOOL_REGISTRATIONS.map(r => r.name);
}

// ── Streamable HTTP Transport (#23) ──────────────────────────────────────────

export interface McpHttpOptions {
  /** Bearer token required on every request (default: SHADOWING_MCP_TOKEN env, unset = no auth). */
  authToken?: string;
  /** Per-IP request cap per minute (default 240). */
  rateLimitPerMinute?: number;
  /** Extra hostnames (besides loopback) allowed in the Host header for SDK rebinding protection. */
  allowedHosts?: string[];
}

/**
 * Stateless Streamable HTTP server on a single /mcp endpoint.
 * Security posture: bind loopback (caller's responsibility via listen host),
 * Origin validation with 403 on mismatch (DNS-rebinding protection), and an
 * optional bearer token. Stateless by design — our state lives in SQLite, and
 * the upcoming spec generation moves the protocol core to stateless anyway.
 */
export function createMcpHttpServer(db: ShadowingDB, config: ShadowingConfig, opts?: McpHttpOptions): Server {
  const authToken = opts?.authToken ?? process.env['SHADOWING_MCP_TOKEN'];
  const perMinute = opts?.rateLimitPerMinute ?? 240;
  const rateLimiter = new RateLimiter(perMinute, perMinute);
  // Host allowlist for the SDK's DNS-rebinding protection. Populated on the
  // 'listening' event (below) so it works with an OS-assigned port (listen(0)).
  const sdkAllowedHosts = new Set<string>();

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers['origin'];
    if (!origin) return true; // non-browser clients
    try {
      const url = new URL(origin);
      if (req.headers['host'] && url.host === req.headers['host']) return true;
      // url.hostname is unbracketed ('::1', not '[::1]') — isLoopbackHost covers both.
      return isLoopbackHost(url.hostname);
    } catch {
      return false;
    }
  }

  function deny(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  }

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== '/mcp') {
        deny(res, 404, 'Not found');
        return;
      }
      if (!originAllowed(req)) {
        deny(res, 403, 'Origin not allowed');
        return;
      }
      const rate = rateLimiter.check(clientIpOf(req), false);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfter));
        deny(res, 429, 'Rate limit exceeded');
        return;
      }
      if (authToken && !timingSafeBearerEqual(req.headers['authorization'], authToken)) {
        deny(res, 401, 'Unauthorized');
        return;
      }
      if (req.method !== 'POST') {
        // Stateless mode: no server-initiated SSE streams, no sessions to delete
        deny(res, 405, 'Method not allowed — stateless server, POST only');
        return;
      }

      // Reject oversized bodies before buffering when the length is declared,
      // and as a hard stream cap otherwise (chunked / mislabelled requests).
      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_BODY_BYTES) {
        deny(res, 413, 'Request body too large');
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse((await readLimitedBody(req)).toString('utf8'));
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          deny(res, 413, 'Request body too large');
          return;
        }
        deny(res, 400, 'Invalid JSON body');
        return;
      }

      // Stateless: a fresh server + transport per request avoids id collisions.
      // The SDK's DNS-rebinding protection pins the Host header (second layer
      // behind the manual Origin check above).
      const server = buildMcpServer(db, config);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts: [...sdkAllowedHosts],
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) deny(res, 500, 'Internal server error');
      }
    })();
  });

  httpServer.on('listening', () => {
    const addr = httpServer.address();
    if (addr && typeof addr === 'object') {
      for (const h of loopbackHostHeaders(addr.port, opts?.allowedHosts ?? [])) {
        sdkAllowedHosts.add(h);
      }
    }
  });
  httpServer.on('close', () => rateLimiter.destroy());

  return httpServer;
}

// ── Transport startup ────────────────────────────────────────────────────────

export interface StartMCPServerOptions {
  http?: boolean;
  port?: number;
  host?: string;
}

export async function startMCPServer(opts?: StartMCPServerOptions): Promise<void> {
  const config = loadConfig();
  const dbPath = getDbPath();
  const db = new ShadowingDB(dbPath);
  db.initialize();
  // MCP tools log observations (commands, file paths) — redact before persisting.
  db.setCaptureRedactor(createCaptureRedactor(config));

  if (opts?.http) {
    const port = opts.port ?? 3848;
    const host = opts.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost' && !process.env['SHADOWING_MCP_TOKEN']) {
      log.error(
        'refusing to bind a non-loopback host without SHADOWING_MCP_TOKEN set — ' +
        'exposure beyond localhost without authentication is unsupported',
        { host },
      );
      process.exitCode = 1;
      db.close();
      return;
    }
    const server = createMcpHttpServer(
      db,
      config,
      isLoopbackHost(host) ? undefined : { allowedHosts: [host] },
    );
    server.listen(port, host, () => {
      log.info(`Streamable HTTP server on http://${host}:${port}/mcp (stateless)`);
    });
    return;
  }

  const server = buildMcpServer(db, config);

  // stdio rule: stdout carries ONLY JSON-RPC frames (handled by the SDK
  // transport); all human-facing output goes to stderr.
  await server.connect(new StdioServerTransport());

  process.stdin.on('close', () => {
    db.close();
    process.exitCode = 0;
  });

  log.info('Server started (stdio)');
}
