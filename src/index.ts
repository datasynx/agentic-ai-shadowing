// ── Public API ──────────────────────────────────────────────────────────────

// Types
export type {
  ShadowConfig,
  ShadowStatus,
  CartographyDB,
  DaemonMessage,
  ClientMessage,
  PendingPrompt,
  ActivityEvent,
  EventRow,
  TaskRow,
  WorkflowRow,
  SessionRow,
  SOPRow,
  NodeType,
  EventType,
} from './types.js';

export {
  DEFAULT_SHADOW_CONFIG,
  MIN_POLL_INTERVAL_MS,
  EVENT_TYPES,
  NODE_TYPES,
  EventSchema,
} from './types.js';

// Daemon
export {
  ShadowDaemon,
  takeSnapshot,
  forkDaemon,
  isDaemonRunning,
  stopDaemon,
  pauseDaemon,
  resumeDaemon,
  startDaemonProcess,
} from './daemon.js';

// IPC
export { IPCServer, IPCClient, cleanStaleSocket } from './ipc.js';

// Client
export { ForegroundClient, AttachClient } from './client.js';

// Notifications
export { NotificationService } from './notify.js';

// Agent
export { runShadowCycle, generateSOPs, clusterTasks } from './agent.js';
