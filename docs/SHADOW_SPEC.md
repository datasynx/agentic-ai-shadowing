# Shadow Feature Spec — `@datasynx/cartography-shadow`

> Extracted from `@datasynx/agentic-ai-cartography` v0.2.6
> Goal: Standalone npm package with peer dependency on `@datasynx/agentic-ai-cartography`

---

## Overview

The Shadow feature is a background monitoring system that continuously observes system state (processes, TCP connections, window focus), analyzes changes via Claude Haiku, and derives tasks, events, and SOPs from them.

**Package name:** `@datasynx/cartography-shadow`
**Peer dependency:** `@datasynx/agentic-ai-cartography >= 0.3.0`
**New npm dependency:** `node-notifier ^10.0.1`

---

## Architecture

```
CLI (shadow start/stop/pause/resume/status/attach)
  └── forkDaemon() → detached child process (CARTOGRAPHYY_DAEMON=1)
      └── startDaemonProcess()
          ├── CartographyDB  (peer-dep: from @datasynx/agentic-ai-cartography)
          ├── IPCServer      (Unix socket: ~/.cartography/daemon.sock)
          ├── NotificationService (node-notifier)
          └── ShadowDaemon.run()
              ├── takeSnapshot()  → ss + ps [no Claude!]
              ├── Diff-Check      → on change, call runShadowCycle()
              └── Broadcast status/events/agent-output via IPCServer

AttachClient (shadow attach)
  └── IPCClient → connects to daemon.sock
      └── Terminal UI with hotkeys [T] [S] [P] [D] [Q]

ForegroundClient (shadow start --foreground)
  └── startDaemonProcess() inline (no fork)
```

---

## Files (extracted from the old package)

| File | Description |
|------|-------------|
| `src/daemon.ts` | `ShadowDaemon`, `takeSnapshot()`, `forkDaemon()`, `isDaemonRunning()`, `stopDaemon()`, `pauseDaemon()`, `resumeDaemon()`, `startDaemonProcess()` |
| `src/ipc.ts` | `IPCServer`, `IPCClient`, `cleanStaleSocket()` — UNIX socket, JSON-NDJF |
| `src/client.ts` | `ForegroundClient`, `AttachClient` — Terminal UI |
| `src/notify.ts` | `NotificationService` — Desktop notifications via node-notifier |
| `src/agent.ts` | `runShadowCycle()`, `generateSOPs()`, `clusterTasks()` |
| `test/ipc.test.ts` | IPC tests |

---

## Types (must be redefined in the Shadow package)

### IPC Protocol

```typescript
// Daemon → Client
export type DaemonMessage =
  | { type: 'event'; data: EventRow }
  | { type: 'prompt'; id: string; prompt: PendingPrompt }
  | { type: 'status'; data: ShadowStatus }
  | { type: 'agent-output'; text: string }
  | { type: 'info'; message: string };

// Client → Daemon
export type ClientMessage =
  | { type: 'prompt-response'; id: string; answer: string }
  | { type: 'command'; command: 'new-task' | 'end-task' | 'status' | 'stop' | 'pause' | 'resume' }
  | { type: 'task-description'; description: string };
```

### PendingPrompt

```typescript
export interface PendingPrompt {
  kind: 'node-approval' | 'task-boundary' | 'task-end';
  context: Record<string, unknown>;
  options: string[];
  defaultAnswer: string;
  timeoutMs: number;
  createdAt: string; // ISO 8601 UTC
}
```

### ShadowStatus

```typescript
export interface ShadowStatus {
  pid: number;
  uptime: number;          // process.uptime() in seconds
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
```

### DB Row Types (shadow-specific)

```typescript
export interface EventRow {
  id: string;
  sessionId: string;
  taskId?: string;
  timestamp: string; // ISO 8601 UTC
  eventType: 'process_start' | 'process_end' | 'connection_open' | 'connection_close' | 'window_focus' | 'tool_switch';
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
  startedAt: string;       // ISO 8601 UTC
  completedAt?: string;    // ISO 8601 UTC
  steps: string;           // JSON array
  involvedServices: string; // JSON array of node IDs
  status: 'active' | 'completed' | 'cancelled';
  isSOPCandidate: boolean;
}

export interface WorkflowRow {
  id: string;
  sessionId: string;
  name?: string;
  pattern: string;
  taskIds: string;         // JSON array
  occurrences: number;
  firstSeen: string;       // ISO 8601 UTC
  lastSeen: string;        // ISO 8601 UTC
  avgDurationMs: number;
  involvedServices: string; // JSON array
}
```

### EventSchema (Zod)

```typescript
export const EVENT_TYPES = [
  'process_start', 'process_end',
  'connection_open', 'connection_close',
  'window_focus', 'tool_switch',
] as const;

export const EventSchema = z.object({
  eventType: z.enum(EVENT_TYPES),
  process: z.string(),
  pid: z.number(),
  target: z.string().optional(),
  targetType: z.enum(NODE_TYPES).optional(),
  protocol: z.string().optional(),
  port: z.number().optional(),
});
```

---

## Config Fields (shadow-specific)

These fields are extracted from `CartographyConfig` and moved into a separate `ShadowConfig`:

```typescript
export interface ShadowConfig {
  shadowMode: 'foreground' | 'daemon';
  pollIntervalMs: number;        // default: 30_000 (30s)
  inactivityTimeoutMs: number;   // default: 300_000 (5 min)
  promptTimeoutMs: number;       // default: 60_000 (60s)
  trackWindowFocus: boolean;     // default: false — requires xdotool
  autoSaveNodes: boolean;        // default: false
  enableNotifications: boolean;  // default: true
  shadowModel: string;           // default: 'claude-haiku-4-5-20251001'
  socketPath: string;            // default: ~/.cartography/daemon.sock
  pidFile: string;               // default: ~/.cartography/daemon.pid
  dbPath: string;                // inherited from CartographyConfig
}

export const MIN_POLL_INTERVAL_MS = 15_000; // 15s minimum (Agent SDK overhead)
```

**Important:** `MIN_POLL_INTERVAL_MS = 15_000` — less than 15s causes problems because the Agent SDK (Claude Haiku) itself takes several seconds. Below 15s, cycles would overlap.

---

## Snapshot Logic

### `takeSnapshot(config: ShadowConfig): string`

Runs without Claude — purely CLI-based:

```typescript
const ss  = execSync('ss -tnp 2>/dev/null || ss -tn 2>/dev/null || echo "ss not available"');
const ps  = execSync('ps aux --sort=-start_time 2>/dev/null | head -50');
let win   = '';
if (config.trackWindowFocus) {
  win = execSync('xdotool getactivewindow getwindowname 2>/dev/null');
}
return `=== TCP ===\n${ss}\n=== PS ===\n${ps}\n=== Window ===\n${win}`;
```

**Timeout:** 5000ms per command, 2000ms for xdotool.

---

## Shadow Cycle Analysis

### `runShadowCycle(config, db, sessionId, prevSnapshot, currSnapshot, onOutput?): Promise<void>`

- **Model:** `config.shadowModel` (default: Claude Haiku — cheap!)
- **maxTurns:** 5 (short analysis, not full discovery)
- **permissionMode:** `'bypassPermissions'`
- **Allowed tools:** `save_event`, `save_node`, `save_edge`, `get_catalog`, `manage_task`
- **No Bash** — only MCP tools (security-critical!)

**System prompt (short version):**
```
Analyze the diff between two system snapshots.
Find:
- New/closed TCP connections → save_event
- New/terminated processes → save_event
- Previously unknown services → check get_catalog, then save_node
- Task boundaries (inactivity, tool switches) → manage_task
target = host:port ONLY. Be concise and efficient.
```

**Diff check:** Claude is ONLY called when `snapshot !== prevSnapshot`. If the system is unchanged → `cyclesSkipped++`, no API call. In practice, the daemon skips 90%+ of cycles → very cheap.

---

## SOP Generation

### `generateSOPs(db, sessionId): Promise<number>`

- **Model:** `claude-sonnet-4-5-20250929` (Anthropic Messages API, no agent loop)
- **Input:** completed tasks (`status === 'completed'`) from the DB
- **Clustering:** Tasks are grouped by overlapping `involvedServices`
- **Output:** one SOP object (JSON) per cluster via `db.insertSOP()`
- **Return value:** number of generated SOPs

**SOP JSON format:**
```json
{
  "title": "...",
  "description": "...",
  "steps": [
    { "order": 1, "instruction": "...", "tool": "...", "target": "...", "notes": "..." }
  ],
  "involvedSystems": ["..."],
  "estimatedDuration": "~N minutes",
  "frequency": "X times daily",
  "confidence": 0.8
}
```

---

## IPC Protocol

**Transport:** UNIX socket (`~/.cartography/daemon.sock`)
**Format:** JSON-NDJF (newline-delimited JSON — each message = one line + `\n`)
**Socket permissions:** `chmod 0o600` after creation

### Message Flow

```
Client → Daemon:  { type: 'command', command: 'status' }
Daemon → Client:  { type: 'status', data: ShadowStatus }

Client → Daemon:  { type: 'command', command: 'new-task' }
Daemon → Client:  { type: 'info', message: 'Task started' }

Client → Daemon:  { type: 'task-description', description: 'Deploy to prod' }

Daemon → Client:  { type: 'event', data: EventRow }
Daemon → Client:  { type: 'agent-output', text: '...' }
Daemon → Client:  { type: 'prompt', id: 'sop-suggest:uuid', prompt: PendingPrompt }
Client → Daemon:  { type: 'prompt-response', id: 'sop-suggest:uuid', answer: 'Yes, save as SOP' }
```

---

## Signal Handling (Daemon Process)

| Signal | Action |
|--------|--------|
| `SIGTERM` | Graceful stop — `ShadowDaemon.stop()` |
| `SIGINT` | Graceful stop — `ShadowDaemon.stop()` |
| `SIGUSR1` | Pause — `ShadowDaemon.pause()` |
| `SIGUSR2` | Resume — `ShadowDaemon.resume()` |

---

## Daemon Lifecycle

### Fork Strategy

```
CLI (shadow start)
  → forkDaemon(config)
      → spawn(process.execPath, [...args], { detached: true, stdio: 'ignore' })
        env: CARTOGRAPHYY_DAEMON=1, CARTOGRAPHYY_CONFIG=JSON.stringify(config)
      → child.unref()  // Parent process can exit
      → writeFileSync(pidFile, String(pid))

child process:
  → checks process.env.CARTOGRAPHYY_DAEMON === '1'
  → startDaemonProcess(config)
```

### Daemon Detection

```typescript
isDaemonRunning(pidFile): { running: boolean; pid?: number }
// Reads PID file, checks via process.kill(pid, 0)
// Stale PID files are automatically deleted
```

### Stale Socket Cleanup

```typescript
cleanStaleSocket(socketPath): void
// Deletes daemon.sock if present (call before daemon start)
```

---

## CLI Commands

All commands must be re-implemented in the Shadow package (as a `commander` plugin or standalone binary `datasynx-shadow`).

### `shadow start`

```
Options:
  --interval <ms>       Poll interval           (default: 30000, min: 15000)
  --inactivity <ms>     Task boundary inactiv.  (default: 300000 = 5 min)
  --model <m>           Analysis model          (default: claude-haiku-4-5-20251001)
  --track-windows       Track window focus      (requires xdotool)
  --auto-save           Save nodes without prompt
  --no-notifications    Disable desktop notifications
  --foreground          Run in terminal (no daemon fork)
  --db <path>           DB path
```

**Flow:**
1. `checkPrerequisites()` (Claude CLI + API key)
2. `checkPollInterval(ms)` — blocks if < `MIN_POLL_INTERVAL_MS`
3. `isDaemonRunning(pidFile)` — error if already running
4. `forkDaemon(config)` or `ForegroundClient.run(config)`

### `shadow stop`

**Flow:**
1. `stopDaemon(pidFile)` — SIGTERM
2. Wait briefly (500ms) for DB to flush
3. Call `generateSOPs(db, sessionId)`
4. Export SOPs as Markdown + HTML dashboard
5. Close DB

### `shadow pause` / `shadow resume`

```typescript
pauseDaemon(pidFile)   // SIGUSR1
resumeDaemon(pidFile)  // SIGUSR2
```

### `shadow status`

```typescript
const { running, pid } = isDaemonRunning(config.pidFile);
// shows PID + socket path
```

### `shadow attach`

```typescript
const client = new AttachClient();
await client.attach(config.socketPath);
```

**Hotkeys in attach mode:**
| Key | Action |
|-----|--------|
| `T` | Start new task (prompts for description) |
| `S` | Show status (nodes, events, tasks, cycles) |
| `P` | Toggle pause/resume |
| `D` | Detach — daemon continues running |
| `Q` | Stop daemon and exit |

### `sops [session-id]`

```
datasynx-cartography sops [session-id]
→ generateSOPs(db, session.id)
```

Reads `getLatestSession('shadow')` if no session-id is provided.

---

## DB Schema (shadow-specific)

The following tables must be added to `CartographyDB` (or as a separate migration in the Shadow package):

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  process TEXT NOT NULL,
  pid INTEGER NOT NULL,
  target TEXT,
  target_type TEXT,
  port INTEGER,
  duration_ms INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  description TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  steps TEXT DEFAULT '[]',
  involved_services TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active',
  is_sop_candidate INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT,
  pattern TEXT NOT NULL,
  task_ids TEXT DEFAULT '[]',
  occurrences INTEGER DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  avg_duration_ms REAL DEFAULT 0,
  involved_services TEXT DEFAULT '[]',
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### Required DB Methods (must be available in the Shadow package or CartographyDB)

```typescript
// Events
saveEvent(sessionId: string, event: ActivityEvent): string
getEvents(sessionId: string): EventRow[]

// Tasks
startTask(sessionId: string): string
endCurrentTask(sessionId: string): void
updateTaskDescription(sessionId: string, description: string): void
markTaskAsSOPCandidate(taskId: string): void
getTasks(sessionId: string): TaskRow[]

// Sessions (shadow-specific)
getLatestSession(mode: 'shadow'): SessionRow | null
```

---

## Desktop Notifications

### `NotificationService`

```typescript
class NotificationService {
  constructor(private enabled: boolean) {}
  nodeDiscovered(nodeId: string, via: string): void   // "📍 Node discovered"
  workflowDetected(count: number, desc: string): void // "🔄 N workflow(s) detected"
  taskBoundary(gapMinutes: number): void              // "⏸ Task boundary detected"
}
```

**Dependency:** `node-notifier ^10.0.1`
**Behavior:** Notifications are ONLY sent when no client is attached (`!ipc.hasClients()`). Errors during sending are silently ignored. `sound: false`.

---

## Costs

| Mode | Model | Interval | per Hour | per 8h Day |
|------|-------|----------|----------|------------|
| Shadow (active) | Haiku | 30s | $0.12–0.36 | $0.96–2.88 |
| Shadow (active) | Haiku | 60s | $0.06–0.18 | $0.48–1.44 |
| Shadow (quiet) | Haiku | 30s | ~$0.02 | ~$0.16 |
| SOP gen | Sonnet | one-shot | $0.01–0.03 | one-shot |

**"Quiet"** = 90%+ of cycles are skipped when the system doesn't change.

---

## Learnings / Decisions

### Why MIN_POLL_INTERVAL_MS = 15,000?

The Claude Agent SDK has ~2-5s overhead at startup (model loading, tool schema serialization). With a 15s interval and ~5s agent runtime, there is enough buffer. Below 15s, cycles would overlap or the daemon wouldn't reach a resting state.

### Why Claude Haiku for Shadow?

- Discovery (one-time) → Sonnet (powerful, ~$0.15-0.50 one-time)
- Shadow monitoring (continuous) → Haiku (cheap, ~$0.02-0.36/h depending on activity)
- SOP generation (one-time at the end) → Sonnet (quality more important than cost)

### Why no Bash in the Shadow cycle?

`runShadowCycle()` intentionally does not allow the `Bash` tool — only MCP tools. The snapshot is already created beforehand via `takeSnapshot()`. This prevents the agent from executing unexpected shell commands during monitoring.

### UNIX Socket vs. TCP

UNIX socket (`~/.cartography/daemon.sock`) instead of TCP port because:
- No port conflicts possible
- Permissions via `chmod 0o600` → local user only
- Faster (no network stack)

### Daemon Detection via PID File

`~/.cartography/daemon.pid` — simple and robust. `isDaemonRunning()` checks via `process.kill(pid, 0)` whether the process is still alive without actually signaling it. Stale PID files are automatically deleted.

### Foreground Mode

`--foreground` starts the daemon in the same process (no fork). Useful for debugging and development. `ForegroundClient` calls `startDaemonProcess()` directly.

### SOP Clustering Algorithm

Simple overlap clustering: Tasks are grouped if they share at least one common service in `involvedServices`. No ML — intentionally simple for transparency and traceability.

---

## Dependencies of the New Package

```json
{
  "name": "@datasynx/cartography-shadow",
  "peerDependencies": {
    "@datasynx/agentic-ai-cartography": ">=0.3.0"
  },
  "dependencies": {
    "@anthropic-ai/claude-code": "1.0.128",
    "@anthropic-ai/sdk": "^0.74.0",
    "better-sqlite3": "^12.6.0",
    "commander": "^12.1.0",
    "node-notifier": "^10.0.1",
    "zod": "^3.24.0"
  }
}
```

---

## Open Questions for Implementation

1. **DB access:** Does the Shadow package access the SQLite file directly (own DB class) or extend `CartographyDB` via dependency injection? → Recommendation: own `ShadowDB extends CartographyDB`
2. **CLI integration:** Separate binary `datasynx-shadow` or plugin system for `datasynx-cartography`? → Recommendation: separate binary for clean separation
3. **Types sharing:** Shared `@datasynx/cartography-types` for `NodeType`, `SessionRow`, etc.? → Recommendation: yes, as a third package to avoid duplication
4. **MCP tool `save_event`:** Missing from the core toolbox — must be added in the Shadow package
5. **MCP tool `manage_task`:** Also missing — Shadow-specific
