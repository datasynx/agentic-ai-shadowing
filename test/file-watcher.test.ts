import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFileWatcher, shouldIgnorePath } from '../src/file-watcher.js';
import { ShadowingDB } from '../src/db.js';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExclusionRule } from '../src/types.js';

const DB_PATH = join(tmpdir(), `shadowing-watch-${Date.now()}.db`);

let db: ShadowingDB;
let watchDir: string;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  watchDir = mkdtempSync(join(tmpdir(), 'shadowing-watch-dir-'));
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
  rmSync(watchDir, { recursive: true, force: true });
});

function rule(pattern: string): ExclusionRule {
  return { id: 'r1', rule_type: 'path_pattern', pattern, created_at: '' };
}

describe('shouldIgnorePath — filtering before anything is logged', () => {
  it('always ignores VCS/dependency/build directories', () => {
    expect(shouldIgnorePath('.git/HEAD', [])).toBe(true);
    expect(shouldIgnorePath('node_modules/x/index.js', [])).toBe(true);
    expect(shouldIgnorePath('packages/app/node_modules/y.js', [])).toBe(true);
    expect(shouldIgnorePath('dist/cli.js', [])).toBe(true);
  });

  it('applies user exclusion rules (e.g. *.env*)', () => {
    expect(shouldIgnorePath('.env.local', [rule('*.env*')])).toBe(true);
    expect(shouldIgnorePath('config/secrets/credentials.json', [rule('*credentials*')])).toBe(true);
    expect(shouldIgnorePath('src/index.ts', [rule('*.env*')])).toBe(false);
  });
});

describe('createFileWatcher — integration', () => {
  it('logs file events into the session, never for excluded paths', async () => {
    db.addExclusionRule('path_pattern', '*.env*');
    const session = db.startObservationSession('watch test');
    const watcher = createFileWatcher(db, session.id, watchDir, { debounceMs: 50 });

    // chokidar needs a moment to set up its watchers
    await new Promise(r => setTimeout(r, 300));

    writeFileSync(join(watchDir, 'notes.md'), 'hello', 'utf8');
    writeFileSync(join(watchDir, '.env.production'), 'SECRET=x', 'utf8');
    mkdirSync(join(watchDir, '.git'));
    writeFileSync(join(watchDir, '.git', 'HEAD'), 'ref', 'utf8');

    // Wait for events + debounce flush
    await new Promise(r => setTimeout(r, 1200));
    await watcher.close();

    const actions = db.getObservedActions(session.id);
    const paths = actions.map(a => a.file_path);
    expect(paths).toContain('notes.md');
    expect(paths.some(p => p?.includes('.env'))).toBe(false);
    expect(paths.some(p => p?.includes('.git'))).toBe(false);
  }, 15_000);
});
