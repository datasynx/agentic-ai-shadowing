import { z } from 'zod';

// ── NodeType (re-defined locally, originally from @datasynx/agentic-ai-cartography) ──

export const NODE_TYPES = [
  'service', 'database', 'queue', 'cache', 'storage',
  'api', 'cdn', 'dns', 'loadbalancer', 'gateway',
  'external', 'unknown',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

// ── ShadowConfig ────────────────────────────────────────────────────────────

export interface ShadowConfig {
  shadowMode: 'foreground' | 'daemon';
  pollIntervalMs: number;
  inactivityTimeoutMs: number;
  promptTimeoutMs: number;
  trackWindowFocus: boolean;
  autoSaveNodes: boolean;
  enableNotifications: boolean;
  shadowModel: string;
  socketPath: string;
  pidFile: string;
  dbPath: string;
}

export const MIN_POLL_INTERVAL_MS = 15_000;

export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  shadowMode: 'daemon',
  pollIntervalMs: 30_000,
  inactivityTimeoutMs: 300_000,
  promptTimeoutMs: 60_000,
  trackWindowFocus: false,
  autoSaveNodes: false,
  enableNotifications: true,
  shadowModel: 'claude-haiku-4-5-20251001',
  socketPath: `${process.env['HOME'] ?? '/tmp'}/.cartography/daemon.sock`,
  pidFile: `${process.env['HOME'] ?? '/tmp'}/.cartography/daemon.pid`,
  dbPath: `${process.env['HOME'] ?? '/tmp'}/.cartography/cartography.db`,
};

// ── Event Types ─────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  'process_start', 'process_end',
  'connection_open', 'connection_close',
  'window_focus', 'tool_switch',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EventSchema = z.object({
  eventType: z.enum(EVENT_TYPES),
  process: z.string(),
  pid: z.number(),
  target: z.string().optional(),
  targetType: z.enum(NODE_TYPES).optional(),
  protocol: z.string().optional(),
  port: z.number().optional(),
});

export type ActivityEvent = z.infer<typeof EventSchema>;

// ── DB Row Types ────────────────────────────────────────────────────────────

export interface EventRow {
  id: string;
  sessionId: string;
  taskId?: string;
  timestamp: string;
  eventType: EventType;
  process: string;
  pid: number;
  target?: string;
  targetType?: NodeType;
  port?: number;
  durationMs?: number;
}

export interface TaskRow {
  id: string;
  sessionId: string;
  description?: string;
  startedAt: string;
  completedAt?: string;
  steps: string;
  involvedServices: string;
  status: 'active' | 'completed' | 'cancelled';
  isSOPCandidate: boolean;
}

export interface WorkflowRow {
  id: string;
  sessionId: string;
  name?: string;
  pattern: string;
  taskIds: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  avgDurationMs: number;
  involvedServices: string;
}

export interface SessionRow {
  id: string;
  mode: string;
  startedAt: string;
  endedAt?: string;
}

export interface SOPRow {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  steps: string;
  involvedSystems: string;
  estimatedDuration: string;
  frequency: string;
  confidence: number;
  createdAt: string;
}

// ── IPC Protocol ────────────────────────────────────────────────────────────

export interface PendingPrompt {
  kind: 'node-approval' | 'task-boundary' | 'task-end';
  context: Record<string, unknown>;
  options: string[];
  defaultAnswer: string;
  timeoutMs: number;
  createdAt: string;
}

export type DaemonMessage =
  | { type: 'event'; data: EventRow }
  | { type: 'prompt'; id: string; prompt: PendingPrompt }
  | { type: 'status'; data: ShadowStatus }
  | { type: 'agent-output'; text: string }
  | { type: 'info'; message: string };

export type ClientMessage =
  | { type: 'prompt-response'; id: string; answer: string }
  | { type: 'command'; command: 'new-task' | 'end-task' | 'status' | 'stop' | 'pause' | 'resume' }
  | { type: 'task-description'; description: string };

// ── ShadowStatus ────────────────────────────────────────────────────────────

export interface ShadowStatus {
  pid: number;
  uptime: number;
  nodeCount: number;
  eventCount: number;
  taskCount: number;
  sopCount: number;
  pendingPrompts: number;
  autoSave: boolean;
  mode: 'foreground' | 'daemon';
  agentActive: boolean;
  paused: boolean;
  cyclesRun: number;
  cyclesSkipped: number;
}

// ── CartographyDB interface ─────────────────────────────────────────────────
// Defines the DB methods required by the shadow daemon.
// At runtime, provide an instance from @datasynx/agentic-ai-cartography or
// a compatible implementation.

export interface CartographyDB {
  createSession(mode: string, config: ShadowConfig): string;
  endSession(sessionId: string): void;
  getLatestSession(mode: string): SessionRow | null;

  saveEvent(sessionId: string, event: ActivityEvent): string;
  getEvents(sessionId: string): EventRow[];

  startTask(sessionId: string): string;
  endCurrentTask(sessionId: string): void;
  updateTaskDescription(sessionId: string, description: string): void;
  markTaskAsSOPCandidate(taskId: string): void;
  getTasks(sessionId: string): TaskRow[];

  getStats(sessionId: string): { nodes: number; events: number; tasks: number };
  getSOPs(sessionId: string): SOPRow[];
  insertSOP(sessionId: string, sop: Omit<SOPRow, 'id' | 'sessionId' | 'createdAt'>): string;

  close(): void;
}
