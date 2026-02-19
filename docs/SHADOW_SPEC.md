# Shadow Feature Spec — `@datasynx/cartography-shadow`

> Extracted from `@datasynx/agentic-ai-cartography` v0.2.6
> Ziel: Eigenständiges npm-Paket mit Peer-Dependency auf `@datasynx/agentic-ai-cartography`

---

## Übersicht

Das Shadow-Feature ist ein Hintergrund-Monitoring-System, das kontinuierlich den System-Zustand beobachtet (Prozesse, TCP-Verbindungen, Fenster-Fokus), Änderungen per Claude Haiku analysiert und daraus Tasks, Events und SOPs ableitet.

**Paketname:** `@datasynx/cartography-shadow`
**Peer-Dependency:** `@datasynx/agentic-ai-cartography >= 0.3.0`
**Neue npm-Dependency:** `node-notifier ^10.0.1`

---

## Architektur

```
CLI (shadow start/stop/pause/resume/status/attach)
  └── forkDaemon() → detached child process (CARTOGRAPHYY_DAEMON=1)
      └── startDaemonProcess()
          ├── CartographyDB  (peer-dep: aus @datasynx/agentic-ai-cartography)
          ├── IPCServer      (Unix socket: ~/.cartography/daemon.sock)
          ├── NotificationService (node-notifier)
          └── ShadowDaemon.run()
              ├── takeSnapshot()  → ss + ps [kein Claude!]
              ├── Diff-Check      → bei Änderung runShadowCycle() aufrufen
              └── Broadcast status/events/agent-output via IPCServer

AttachClient (shadow attach)
  └── IPCClient → verbindet sich mit daemon.sock
      └── Terminal-UI mit Hotkeys [T] [S] [P] [D] [Q]

ForegroundClient (shadow start --foreground)
  └── startDaemonProcess() inline (kein fork)
```

---

## Files (aus dem alten Paket extrahiert)

| Datei | Beschreibung |
|-------|-------------|
| `src/daemon.ts` | `ShadowDaemon`, `takeSnapshot()`, `forkDaemon()`, `isDaemonRunning()`, `stopDaemon()`, `pauseDaemon()`, `resumeDaemon()`, `startDaemonProcess()` |
| `src/ipc.ts` | `IPCServer`, `IPCClient`, `cleanStaleSocket()` — UNIX socket, JSON-NDJF |
| `src/client.ts` | `ForegroundClient`, `AttachClient` — Terminal-UI |
| `src/notify.ts` | `NotificationService` — Desktop-Notifications via node-notifier |
| `src/agent.ts` | `runShadowCycle()`, `generateSOPs()`, `clusterTasks()` |
| `test/ipc.test.ts` | IPC-Tests |

---

## Types (müssen im Shadow-Paket neu definiert werden)

### IPC-Protokoll

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
  uptime: number;          // process.uptime() in Sekunden
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

### DB Row Types (shadow-spezifisch)

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

## Config-Felder (shadow-spezifisch)

Diese Felder werden aus `CartographyConfig` extrahiert und in eine eigene `ShadowConfig` überführt:

```typescript
export interface ShadowConfig {
  shadowMode: 'foreground' | 'daemon';
  pollIntervalMs: number;        // default: 30_000 (30s)
  inactivityTimeoutMs: number;   // default: 300_000 (5 min)
  promptTimeoutMs: number;       // default: 60_000 (60s)
  trackWindowFocus: boolean;     // default: false — erfordert xdotool
  autoSaveNodes: boolean;        // default: false
  enableNotifications: boolean;  // default: true
  shadowModel: string;           // default: 'claude-haiku-4-5-20251001'
  socketPath: string;            // default: ~/.cartography/daemon.sock
  pidFile: string;               // default: ~/.cartography/daemon.pid
  dbPath: string;                // aus CartographyConfig erben
}

export const MIN_POLL_INTERVAL_MS = 15_000; // 15s Minimum (Agent SDK Overhead)
```

**Wichtig:** `MIN_POLL_INTERVAL_MS = 15_000` — weniger als 15s führt zu Problemen weil der Agent SDK (Claude Haiku) selbst mehrere Sekunden braucht. Unter 15s würden Zyklen überlappen.

---

## Snapshot-Logik

### `takeSnapshot(config: ShadowConfig): string`

Läuft ohne Claude — rein CLI-basiert:

```typescript
const ss  = execSync('ss -tnp 2>/dev/null || ss -tn 2>/dev/null || echo "ss not available"');
const ps  = execSync('ps aux --sort=-start_time 2>/dev/null | head -50');
let win   = '';
if (config.trackWindowFocus) {
  win = execSync('xdotool getactivewindow getwindowname 2>/dev/null');
}
return `=== TCP ===\n${ss}\n=== PS ===\n${ps}\n=== Window ===\n${win}`;
```

**Timeout:** 5000ms per Kommando, 2000ms für xdotool.

---

## Shadow-Zyklus-Analyse

### `runShadowCycle(config, db, sessionId, prevSnapshot, currSnapshot, onOutput?): Promise<void>`

- **Modell:** `config.shadowModel` (Standard: Claude Haiku — günstig!)
- **maxTurns:** 5 (kurze Analyse, nicht Full-Discovery)
- **permissionMode:** `'bypassPermissions'`
- **Erlaubte Tools:** `save_event`, `save_node`, `save_edge`, `get_catalog`, `manage_task`
- **Kein Bash** — nur MCP-Tools (sicherheitskritisch!)

**System-Prompt (Kurzversion):**
```
Analyze the diff between two system snapshots.
Find:
- New/closed TCP connections → save_event
- New/terminated processes → save_event
- Previously unknown services → check get_catalog, then save_node
- Task boundaries (inactivity, tool switches) → manage_task
target = host:port ONLY. Be concise and efficient.
```

**Diff-Check:** Claude wird NUR aufgerufen wenn `snapshot !== prevSnapshot`. Bei unverändertem System → `cyclesSkipped++`, kein API-Call. In der Praxis überspringt der Daemon 90%+ der Zyklen → sehr günstig.

---

## SOP-Generierung

### `generateSOPs(db, sessionId): Promise<number>`

- **Modell:** `claude-sonnet-4-5-20250929` (Anthropic Messages API, kein Agent Loop)
- **Input:** abgeschlossene Tasks (`status === 'completed'`) aus der DB
- **Clustering:** Tasks werden nach überlappenden `involvedServices` gruppiert
- **Output:** pro Cluster ein SOP-Objekt (JSON) via `db.insertSOP()`
- **Rückgabe:** Anzahl generierter SOPs

**SOP JSON-Format:**
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

## IPC-Protokoll

**Transport:** UNIX-Socket (`~/.cartography/daemon.sock`)
**Format:** JSON-NDJF (newline-delimited JSON — jede Nachricht = eine Zeile + `\n`)
**Socket-Permissions:** `chmod 0o600` nach Erstellung

### Nachrichtenfluss

```
Client → Daemon:  { type: 'command', command: 'status' }
Daemon → Client:  { type: 'status', data: ShadowStatus }

Client → Daemon:  { type: 'command', command: 'new-task' }
Daemon → Client:  { type: 'info', message: 'Task gestartet' }

Client → Daemon:  { type: 'task-description', description: 'Deploy to prod' }

Daemon → Client:  { type: 'event', data: EventRow }
Daemon → Client:  { type: 'agent-output', text: '...' }
Daemon → Client:  { type: 'prompt', id: 'sop-suggest:uuid', prompt: PendingPrompt }
Client → Daemon:  { type: 'prompt-response', id: 'sop-suggest:uuid', answer: 'Ja, als SOP speichern' }
```

---

## Signal-Handling (Daemon-Prozess)

| Signal | Aktion |
|--------|--------|
| `SIGTERM` | Graceful Stop — `ShadowDaemon.stop()` |
| `SIGINT` | Graceful Stop — `ShadowDaemon.stop()` |
| `SIGUSR1` | Pause — `ShadowDaemon.pause()` |
| `SIGUSR2` | Resume — `ShadowDaemon.resume()` |

---

## Daemon-Lifecycle

### Fork-Strategie

```
CLI (shadow start)
  → forkDaemon(config)
      → spawn(process.execPath, [...args], { detached: true, stdio: 'ignore' })
        env: CARTOGRAPHYY_DAEMON=1, CARTOGRAPHYY_CONFIG=JSON.stringify(config)
      → child.unref()  // Elternprozess kann enden
      → writeFileSync(pidFile, String(pid))

child process:
  → checks process.env.CARTOGRAPHYY_DAEMON === '1'
  → startDaemonProcess(config)
```

### Daemon-Erkennung

```typescript
isDaemonRunning(pidFile): { running: boolean; pid?: number }
// Liest PID-Datei, prüft via process.kill(pid, 0)
// Bei veralteter PID-Datei: automatisch löschen
```

### Stale Socket Cleanup

```typescript
cleanStaleSocket(socketPath): void
// Löscht daemon.sock wenn vorhanden (vor Daemon-Start aufrufen)
```

---

## CLI-Kommandos

Alle Kommandos müssen im Shadow-Paket re-implementiert werden (als `commander`-Plugin oder eigenständige Binary `datasynx-shadow`).

### `shadow start`

```
Options:
  --interval <ms>       Poll-Intervall        (default: 30000, min: 15000)
  --inactivity <ms>     Task-Grenze Inaktiv.  (default: 300000 = 5 min)
  --model <m>           Analyse-Modell        (default: claude-haiku-4-5-20251001)
  --track-windows       Fenster-Fokus tracken (erfordert xdotool)
  --auto-save           Nodes ohne Prompt speichern
  --no-notifications    Desktop-Notifications deaktivieren
  --foreground          Im Terminal ausführen (kein Daemon-Fork)
  --db <path>           DB-Pfad
```

**Ablauf:**
1. `checkPrerequisites()` (Claude CLI + API Key)
2. `checkPollInterval(ms)` — blockiert wenn < `MIN_POLL_INTERVAL_MS`
3. `isDaemonRunning(pidFile)` — Fehler wenn bereits läuft
4. `forkDaemon(config)` oder `ForegroundClient.run(config)`

### `shadow stop`

**Ablauf:**
1. `stopDaemon(pidFile)` — SIGTERM
2. Kurz warten (500ms) damit DB geflusht wird
3. `generateSOPs(db, sessionId)` aufrufen
4. SOPs als Markdown exportieren + HTML-Dashboard
5. DB schließen

### `shadow pause` / `shadow resume`

```typescript
pauseDaemon(pidFile)   // SIGUSR1
resumeDaemon(pidFile)  // SIGUSR2
```

### `shadow status`

```typescript
const { running, pid } = isDaemonRunning(config.pidFile);
// zeigt PID + socket path
```

### `shadow attach`

```typescript
const client = new AttachClient();
await client.attach(config.socketPath);
```

**Hotkeys im Attach-Modus:**
| Taste | Aktion |
|-------|--------|
| `T` | Neuen Task starten (fragt nach Beschreibung) |
| `S` | Status anzeigen (nodes, events, tasks, cycles) |
| `P` | Pause/Resume umschalten |
| `D` | Trennen — Daemon läuft weiter |
| `Q` | Daemon stoppen und beenden |

### `sops [session-id]`

```
datasynx-cartography sops [session-id]
→ generateSOPs(db, session.id)
```

Liest `getLatestSession('shadow')` wenn keine session-id angegeben.

---

## DB-Schema (shadow-spezifisch)

Die folgenden Tabellen müssen in `CartographyDB` ergänzt werden (oder im Shadow-Paket eigene Migration):

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

### Benötigte DB-Methoden (müssen im Shadow-Paket oder CartographyDB verfügbar sein)

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

// Sessions (shadow-spezifisch)
getLatestSession(mode: 'shadow'): SessionRow | null
```

---

## Desktop-Notifications

### `NotificationService`

```typescript
class NotificationService {
  constructor(private enabled: boolean) {}
  nodeDiscovered(nodeId: string, via: string): void   // "📍 Node entdeckt"
  workflowDetected(count: number, desc: string): void // "🔄 N Workflow(s) erkannt"
  taskBoundary(gapMinutes: number): void              // "⏸ Task-Grenze erkannt"
}
```

**Dependency:** `node-notifier ^10.0.1`
**Verhalten:** Notifications werden NUR gesendet wenn kein Client angehängt ist (`!ipc.hasClients()`). Fehler beim Senden werden still ignoriert. `sound: false`.

---

## Kosten

| Modus | Modell | Intervall | pro Stunde | pro 8h Tag |
|-------|--------|-----------|------------|------------|
| Shadow (aktiv) | Haiku | 30s | $0.12–0.36 | $0.96–2.88 |
| Shadow (aktiv) | Haiku | 60s | $0.06–0.18 | $0.48–1.44 |
| Shadow (ruhig) | Haiku | 30s | ~$0.02 | ~$0.16 |
| SOP-Gen | Sonnet | one-shot | $0.01–0.03 | one-shot |

**"Ruhig"** = 90%+ Zyklen werden übersprungen wenn das System sich nicht ändert.

---

## Learnings / Entscheidungen

### Warum MIN_POLL_INTERVAL_MS = 15_000?

Der Claude Agent SDK hat beim Start (model loading, tool schema serialization) ~2–5s Overhead. Bei 15s-Intervall und ~5s Agent-Laufzeit bleibt genug Puffer. Bei < 15s würden Zyklen überlappen oder der Daemon käme nicht zur Ruhe.

### Warum Claude Haiku für Shadow?

- Discovery (einmalig) → Sonnet (leistungsfähig, ~$0.15-0.50 einmalig)
- Shadow-Monitoring (kontinuierlich) → Haiku (günstig, ~$0.02-0.36/h je nach Aktivität)
- SOP-Generierung (einmalig am Ende) → Sonnet (Qualität wichtiger als Kosten)

### Warum kein Bash im Shadow-Zyklus?

`runShadowCycle()` erlaubt bewusst kein `Bash`-Tool — nur MCP-Tools. Der Snapshot wird bereits vorher via `takeSnapshot()` erstellt. Das verhindert, dass der Agent während des Monitorings unerwartete Shell-Kommandos ausführt.

### UNIX Socket vs. TCP

UNIX-Socket (`~/.cartography/daemon.sock`) statt TCP-Port weil:
- Kein Port-Konflikt möglich
- Permissions via `chmod 0o600` → nur lokaler User
- Schneller (kein Netzwerk-Stack)

### Daemon-Erkennung via PID-File

`~/.cartography/daemon.pid` — einfach und robust. `isDaemonRunning()` prüft via `process.kill(pid, 0)` ob der Prozess noch lebt, ohne ihm zu signalisieren. Veraltete PID-Files werden automatisch gelöscht.

### Foreground-Modus

`--foreground` startet den Daemon im selben Prozess (kein Fork). Nützlich für Debugging und Entwicklung. `ForegroundClient` ruft `startDaemonProcess()` direkt auf.

### SOP-Clustering-Algorithmus

Einfaches Overlap-Clustering: Tasks werden gruppiert wenn sie mindestens einen gemeinsamen Service in `involvedServices` haben. Kein ML — absichtlich simpel für Transparenz und Nachvollziehbarkeit.

---

## Abhängigkeiten des neuen Pakets

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

## Offene Fragen für die Implementierung

1. **DB-Zugang:** Greift das Shadow-Paket direkt auf die SQLite-Datei zu (eigene DB-Klasse) oder erweitert es `CartographyDB` via Dependency-Injection? → Empfehlung: eigene `ShadowDB extends CartographyDB`
2. **CLI-Integration:** Eigene Binary `datasynx-shadow` oder Plugin-System für `datasynx-cartography`? → Empfehlung: eigene Binary für saubere Trennung
3. **Types-Sharing:** Gemeinsame `@datasynx/cartography-types` für `NodeType`, `SessionRow` etc.? → Empfehlung: ja, als drittes Paket um Duplikation zu vermeiden
4. **MCP-Tool `save_event`:** Fehlt in der Kern-Toolbox — muss im Shadow-Paket hinzugefügt werden
5. **MCP-Tool `manage_task`:** Fehlt ebenfalls — Shadow-spezifisch
