import { describe, it, expect, afterEach } from 'vitest';
import { IPCServer, IPCClient, cleanStaleSocket } from '../src/ipc.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const SOCKET = join(tmpdir(), `cartography-test-${Date.now()}.sock`);

let server: IPCServer | null = null;
let client: IPCClient | null = null;

afterEach(() => {
  client?.disconnect();
  server?.stop();
  cleanStaleSocket(SOCKET);
  server = null;
  client = null;
});

describe('IPCServer + IPCClient', () => {
  it('connects client to server', async () => {
    server = new IPCServer();
    server.start(SOCKET);

    client = new IPCClient();
    await client.connect(SOCKET);
    expect(server.hasClients()).toBe(true);
  });

  it('broadcasts messages to clients', async () => {
    server = new IPCServer();
    server.start(SOCKET);

    client = new IPCClient();
    await client.connect(SOCKET);

    const received = await new Promise<unknown>((resolve) => {
      client!.on('message', resolve);
      server!.broadcast({ type: 'info', message: 'hello' });
    });

    expect((received as { type: string; message: string }).message).toBe('hello');
  });

  it('receives client messages on server', async () => {
    server = new IPCServer();
    server.start(SOCKET);

    client = new IPCClient();
    await client.connect(SOCKET);

    const received = await new Promise<unknown>((resolve) => {
      server!.on('message', resolve);
      client!.send({ type: 'command', command: 'status' });
    });

    expect((received as { type: string; command: string }).command).toBe('status');
  });

  it('cleanStaleSocket removes socket file', async () => {
    // Create a dummy file
    const { writeFileSync } = await import('node:fs');
    writeFileSync(SOCKET, '');
    expect(existsSync(SOCKET)).toBe(true);
    cleanStaleSocket(SOCKET);
    expect(existsSync(SOCKET)).toBe(false);
  });
});
