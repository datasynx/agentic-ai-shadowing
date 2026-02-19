import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { IPCServer, cleanStaleSocket } from './ipc.js';
import { NotificationService } from './notify.js';
import { runShadowCycle } from './agent.js';
import type { ShadowConfig, ShadowStatus, ClientMessage, CartographyDB } from './types.js';

// ── Snapshot ─────────────────────────────────────────────────────────────────

export function takeSnapshot(config: ShadowConfig): string {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).toString();
    } catch {
      return `(${cmd}: not available)`;
    }
  };

  const ss = run('ss -tnp 2>/dev/null || ss -tn 2>/dev/null || echo "ss not available"');
  const ps = run('ps aux --sort=-start_time 2>/dev/null | head -50');

  let win = '';
  if (config.trackWindowFocus) {
    try {
      win = execSync('xdotool getactivewindow getwindowname 2>/dev/null', {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 2000,
      }).toString().trim();
    } catch {
      win = '';
    }
  }

  return `=== TCP ===\n${ss}\n=== PS ===\n${ps}\n=== Window ===\n${win}`;
}

// ── ShadowDaemon ─────────────────────────────────────────────────────────────

export class ShadowDaemon {
  private running = false;
  private paused = false;
  private prevSnapshot = '';
  private cyclesRun = 0;
  private cyclesSkipped = 0;
  private lastTaskCount = 0;
  private sessionId = '';

  constructor(
    private config: ShadowConfig,
    private db: CartographyDB,
    private ipc: IPCServer,
    private notify: NotificationService,
  ) {}

  async run(): Promise<string> {
    this.running = true;
    this.sessionId = this.db.createSession('shadow', this.config);

    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
    process.on('SIGUSR1', () => this.pause());
    process.on('SIGUSR2', () => this.resume());

    // Handle IPC commands from attached clients
    this.ipc.on('message', (msg: ClientMessage) => {
      switch (msg.type) {
        case 'command':
          if (msg.command === 'pause') this.pause();
          else if (msg.command === 'resume') this.resume();
          else if (msg.command === 'stop') this.stop();
          else if (msg.command === 'status') {
            this.ipc.broadcast({ type: 'status', data: this.getStatus() });
          } else if (msg.command === 'new-task') {
            this.db.startTask(this.sessionId);
            this.ipc.broadcast({ type: 'info', message: 'Task gestartet' });
          } else if (msg.command === 'end-task') {
            this.db.endCurrentTask(this.sessionId);
            this.ipc.broadcast({ type: 'info', message: 'Task beendet' });
          }
          break;
        case 'task-description':
          this.db.updateTaskDescription(this.sessionId, msg.description);
          break;
        case 'prompt-response':
          // Handle SOP candidate response
          if (msg.id.startsWith('sop-suggest:')) {
            const taskId = msg.id.replace('sop-suggest:', '');
            if (msg.answer === 'ja' || msg.answer === 'yes' || msg.answer === 'Ja, als SOP speichern') {
              this.db.markTaskAsSOPCandidate(taskId);
              this.ipc.broadcast({ type: 'info', message: `Task als SOP-Kandidat markiert` });
            }
          }
          break;
      }
    });

    while (this.running) {
      if (this.paused) {
        // Still broadcast status while paused
        this.ipc.broadcast({ type: 'status', data: this.getStatus() });
        await sleep(this.config.pollIntervalMs);
        continue;
      }

      const snapshot = takeSnapshot(this.config);

      if (snapshot !== this.prevSnapshot) {
        try {
          await runShadowCycle(
            this.config,
            this.db,
            this.sessionId,
            this.prevSnapshot,
            snapshot,
            (msg) => {
              if (this.ipc.hasClients()) {
                this.ipc.broadcast({ type: 'agent-output', text: JSON.stringify(msg) });
              }
            },
          );
          this.cyclesRun++;
        } catch (err) {
          process.stderr.write(`⚠ Cycle error: ${err}\n`);
        }
        this.prevSnapshot = snapshot;

        // Check for newly completed tasks → suggest as SOP
        this.checkForCompletedTasks();
      } else {
        this.cyclesSkipped++;
      }

      // Broadcast status
      this.ipc.broadcast({ type: 'status', data: this.getStatus() });

      // Desktop notification if no clients attached
      if (!this.ipc.hasClients()) {
        const stats = this.db.getStats(this.sessionId);
        if (stats.events > 0 && this.cyclesRun % 10 === 0) {
          this.notify.workflowDetected(stats.tasks, `${stats.events} events so far`);
        }
      }

      await sleep(this.config.pollIntervalMs);
    }

    this.db.endSession(this.sessionId);
    this.ipc.stop();
    cleanup(this.config);
    return this.sessionId;
  }

  pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.ipc.broadcast({ type: 'info', message: '⏸ Shadow-Daemon pausiert' });
    }
  }

  resume(): void {
    if (this.paused) {
      this.paused = false;
      this.ipc.broadcast({ type: 'info', message: '▶ Shadow-Daemon fortgesetzt' });
    }
  }

  stop(): void {
    this.running = false;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private checkForCompletedTasks(): void {
    const tasks = this.db.getTasks(this.sessionId);
    const completedCount = tasks.filter(t => t.status === 'completed').length;

    if (completedCount > this.lastTaskCount) {
      // New task(s) completed — suggest as SOP candidate
      const newlyCompleted = tasks
        .filter(t => t.status === 'completed' && !t.isSOPCandidate)
        .slice(-1); // most recent

      for (const task of newlyCompleted) {
        const desc = task.description ?? `Task ${task.id.substring(0, 8)}`;
        if (this.ipc.hasClients()) {
          this.ipc.broadcast({
            type: 'prompt',
            id: `sop-suggest:${task.id}`,
            prompt: {
              kind: 'task-boundary',
              context: { taskId: task.id, description: desc },
              options: ['Ja, als SOP speichern', 'Nein, überspringen'],
              defaultAnswer: 'Ja, als SOP speichern',
              timeoutMs: 30_000,
              createdAt: new Date().toISOString(),
            },
          });
        } else {
          // Auto-mark as candidate when no client is attached
          this.db.markTaskAsSOPCandidate(task.id);
        }
      }
      this.lastTaskCount = completedCount;
    }
  }

  private getStatus(): ShadowStatus {
    const stats = this.db.getStats(this.sessionId);
    const sops = this.db.getSOPs(this.sessionId);
    return {
      pid: process.pid,
      uptime: process.uptime(),
      nodeCount: stats.nodes,
      eventCount: stats.events,
      taskCount: stats.tasks,
      sopCount: sops.length,
      pendingPrompts: 0,
      autoSave: this.config.autoSaveNodes,
      mode: this.config.shadowMode,
      agentActive: false,
      paused: this.paused,
      cyclesRun: this.cyclesRun,
      cyclesSkipped: this.cyclesSkipped,
    };
  }
}

// ── Daemon Lifecycle ──────────────────────────────────────────────────────────

export function forkDaemon(config: ShadowConfig): number {
  // The daemon entry is the same cli.ts but with --daemon flag via env
  const child = spawn(
    process.execPath,
    [process.argv[1] ?? 'datasynx-cartography', 'shadow', 'start', '--foreground', '--daemon-child'],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CARTOGRAPHYY_DAEMON: '1',
        CARTOGRAPHYY_CONFIG: JSON.stringify(config),
      },
    }
  );
  child.unref();

  const pid = child.pid;
  if (!pid) throw new Error('Failed to fork daemon');

  writeFileSync(config.pidFile, String(pid), 'utf8');
  return pid;
}

export function isDaemonRunning(pidFile: string): { running: boolean; pid?: number } {
  if (!existsSync(pidFile)) return { running: false };

  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid)) return { running: false };

    process.kill(pid, 0); // throws if process doesn't exist
    return { running: true, pid };
  } catch {
    // Stale PID file
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    return { running: false };
  }
}

export function stopDaemon(pidFile: string): boolean {
  const { running, pid } = isDaemonRunning(pidFile);
  if (!running || !pid) return false;

  try {
    process.kill(pid, 'SIGTERM');
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    return true;
  } catch {
    return false;
  }
}

export function pauseDaemon(pidFile: string): boolean {
  const { running, pid } = isDaemonRunning(pidFile);
  if (!running || !pid) return false;
  try { process.kill(pid, 'SIGUSR1'); return true; } catch { return false; }
}

export function resumeDaemon(pidFile: string): boolean {
  const { running, pid } = isDaemonRunning(pidFile);
  if (!running || !pid) return false;
  try { process.kill(pid, 'SIGUSR2'); return true; } catch { return false; }
}

function cleanup(config: ShadowConfig): void {
  try { unlinkSync(config.socketPath); } catch { /* already gone */ }
  try { unlinkSync(config.pidFile); } catch { /* already gone */ }
}

// ── startDaemonProcess ───────────────────────────────────────────────────────

export async function startDaemonProcess(
  config: ShadowConfig,
  db?: CartographyDB,
): Promise<void> {
  cleanStaleSocket(config.socketPath);

  // If no DB provided, try to load from peer dependency
  if (!db) {
    try {
      const peerPkg = '@datasynx/agentic-ai-cartography';
      const cartography = await import(peerPkg) as {
        CartographyDB: new (path: string) => CartographyDB;
      };
      db = new cartography.CartographyDB(config.dbPath);
    } catch {
      throw new Error(
        'CartographyDB not provided and @datasynx/agentic-ai-cartography not installed. ' +
        'Install the peer dependency or pass a compatible DB instance.',
      );
    }
  }

  const ipc = new IPCServer();
  const notify = new NotificationService(config.enableNotifications);

  ipc.start(config.socketPath);

  const daemon = new ShadowDaemon(config, db, ipc, notify);
  await daemon.run();

  db.close();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
