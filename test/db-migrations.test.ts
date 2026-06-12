import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShadowingDB, applyMigrations } from '../src/db.js';
import { ShadowingError } from '../src/errors.js';

// Pre-migration "tasks" shape: no pause columns, no audit_log/api_usage tables,
// user_version 0 — the schema older builds of the tool wrote to disk.
function writeLegacyDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT, duration_seconds INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO tasks (id, title) VALUES ('legacy01', 'Legacy task')`).run();
  db.pragma('user_version = 0');
  db.close();
}

describe('schema migrations from legacy databases', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shadow-mig-'));
    dbPath = join(dir, 'legacy.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades a legacy DB cleanly, preserving data', () => {
    writeLegacyDb(dbPath);
    const db = new ShadowingDB(dbPath);
    expect(() => db.initialize()).not.toThrow();

    const raw = new Database(dbPath, { readonly: true });
    const cols = (raw.pragma('table_info(tasks)') as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('paused_at');
    expect(cols).toContain('paused_total_seconds');

    const tables = (raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toContain('audit_log');
    expect(tables).toContain('api_usage');

    expect(raw.pragma('user_version', { simple: true })).toBe(1);

    // pre-existing row survived and the added NOT NULL column has its default
    const row = raw.prepare(
      `SELECT title, paused_total_seconds FROM tasks WHERE id='legacy01'`,
    ).get();
    expect(row).toMatchObject({ title: 'Legacy task', paused_total_seconds: 0 });
    raw.close();

    // the upgraded task is usable through the normal API
    const t = db.pauseTask('legacy01');
    expect(t.status).toBe('paused');
    db.close();
  });

  it('is idempotent on re-open (no version drift, no throw)', () => {
    writeLegacyDb(dbPath);
    const a = new ShadowingDB(dbPath);
    a.initialize();
    a.close();

    const b = new ShadowingDB(dbPath);
    expect(() => b.initialize()).not.toThrow();
    b.close();

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(1);
    raw.close();
  });

  it('stamps a fresh DB at the latest version', () => {
    const db = new ShadowingDB(dbPath);
    db.initialize();
    db.close();

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(1);
    raw.close();
  });

  it('surfaces migration errors as ShadowingError instead of swallowing them', () => {
    // Drive the runner directly with a migration whose up() throws — the old
    // try/catch {} regression would have hidden this; the runner must wrap and
    // rethrow as ShadowingError('migration_failed').
    const raw = new Database(':memory:');
    const boom = [{ version: 1, up() { throw new Error('disk full'); } }];
    try {
      applyMigrations(raw, boom);
      expect.fail('applyMigrations should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('migration_failed');
      expect((err as ShadowingError).meta).toMatchObject({ from: 0, to: 1 });
      expect((err as Error).cause).toBeInstanceOf(Error);
    } finally {
      raw.close();
    }
  });

  it('rolls back a failed migration atomically (version + DDL)', () => {
    // A migration that ALTERs then throws must leave NO trace: user_version
    // unchanged and the column not added (transactional rollback).
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE tasks (id TEXT)');
    const partial = [{
      version: 1,
      up(db: Database.Database) {
        db.exec('ALTER TABLE tasks ADD COLUMN added TEXT');
        throw new Error('fail after DDL');
      },
    }];
    expect(() => applyMigrations(raw, partial)).toThrowError(ShadowingError);
    expect(raw.pragma('user_version', { simple: true })).toBe(0);
    const cols = (raw.pragma('table_info(tasks)') as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain('added');
    raw.close();
  });
});
