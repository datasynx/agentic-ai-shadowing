import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';

describe('ShadowingDB directory auto-creation (issue #50)', () => {
  const root = join(tmpdir(), `shadowing-autocreate-${process.pid}`);
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a missing parent directory when opening the DB', () => {
    const missingDir = join(root, 'does', 'not', 'exist');
    const dbPath = join(missingDir, 'shadowing.db');
    expect(existsSync(missingDir)).toBe(false);

    // Mirrors the `shadowing mcp` first-run path (mcp-server.ts opens the DB
    // with no prior `init`); before the fix this threw
    // "Cannot open database because the directory does not exist".
    const db = new ShadowingDB(dbPath);
    db.initialize();
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });
});
