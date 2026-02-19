import net from 'node:net';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import type { DaemonMessage, ClientMessage } from './types.js';

// ── IPCServer ────────────────────────────────────────────────────────────────

export class IPCServer extends EventEmitter {
  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();

  start(socketPath: string): void {
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      this.emit('client-connect', socket);

      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as ClientMessage;
            this.emit('message', msg, socket);
          } catch {
            // Ignore malformed JSON
          }
        }
      });

      socket.on('close', () => {
        this.clients.delete(socket);
        this.emit('client-disconnect', socket);
      });

      socket.on('error', () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // chmod may fail in some environments — non-fatal
      }
    });
  }

  broadcast(msg: DaemonMessage): void {
    const line = JSON.stringify(msg) + '\n';
    for (const socket of this.clients) {
      try {
        socket.write(line);
      } catch {
        this.clients.delete(socket);
      }
    }
  }

  hasClients(): boolean {
    return this.clients.size > 0;
  }

  stop(): void {
    for (const socket of this.clients) {
      socket.destroy();
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }
}

// ── IPCClient ────────────────────────────────────────────────────────────────

export class IPCClient extends EventEmitter {
  private socket: net.Socket | null = null;

  connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        resolve();
      });

      socket.on('error', (err) => {
        reject(err);
      });

      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as DaemonMessage;
            this.emit('message', msg);
          } catch {
            // Ignore malformed JSON
          }
        }
      });

      socket.on('close', () => {
        this.emit('disconnect');
      });

      this.socket = socket;
    });
  }

  send(msg: ClientMessage): void {
    if (!this.socket) return;
    try {
      this.socket.write(JSON.stringify(msg) + '\n');
    } catch {
      // Socket may have closed
    }
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function cleanStaleSocket(socketPath: string): void {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Already gone
    }
  }
}
