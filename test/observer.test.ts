import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { Observer, matchesPattern, matchesExclusionRules, isWithinWorkHours, getDefaultObserverConfig } from '../src/observer.js';
import type { WindowInfo } from '../src/observer.js';
import type { ObserverConfig } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-observer-test-${Date.now()}.db`);
let db: ShadowingDB;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('Observer — Session Management', () => {
  it('start creates a new session', () => {
    const observer = new Observer(db, { poll_interval_ms: 60000 });
    const session = observer.start('Test Session');
    expect(session.status).toBe('active');
    expect(session.title).toBe('Test Session');
    observer.stop();
  });

  it('stop completes the session', () => {
    const observer = new Observer(db, { poll_interval_ms: 60000 });
    observer.start();
    const completed = observer.stop();
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe('completed');
  });

  it('pause and resume work correctly', () => {
    const observer = new Observer(db, { poll_interval_ms: 60000 });
    observer.start('Pause Test');

    observer.pause();
    expect(observer.getSession()?.status).toBe('paused');
    expect(observer.isRunning()).toBe(false);

    observer.resume();
    expect(observer.getSession()?.status).toBe('active');
    expect(observer.isRunning()).toBe(true);

    observer.stop();
  });

  it('start throws if already running', () => {
    const observer = new Observer(db, { poll_interval_ms: 60000 });
    observer.start();
    expect(() => observer.start()).toThrow('already running');
    observer.stop();
  });

  it('resumes existing active session', () => {
    // Create an active session manually
    const session = db.startObservationSession('Existing');

    const observer = new Observer(db, { poll_interval_ms: 60000 });
    const resumed = observer.start();
    expect(resumed.id).toBe(session.id);
    observer.stop();
  });

  it('logManualAction adds an action', () => {
    const observer = new Observer(db, { poll_interval_ms: 60000 });
    observer.start();

    const action = observer.logManualAction('Test note');
    expect(action).not.toBeNull();
    expect(action!.source).toBe('manual');
    expect(action!.window_title).toBe('Test note');

    const actions = db.getObservedActions(observer.getSession()!.id);
    expect(actions).toHaveLength(1);

    observer.stop();
  });

  it('logManualAction returns null when no session', () => {
    const observer = new Observer(db, { poll_interval_ms: 60000 });
    expect(observer.logManualAction('test')).toBeNull();
  });
});

describe('Observer — Heartbeat Pattern', () => {
  it('heartbeatAction merges matching action within pulsetime', () => {
    const session = db.startObservationSession();

    // Create an initial action
    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'VS Code',
      window_title: 'index.ts',
    });

    // Heartbeat with same state — should merge
    const merged = db.heartbeatAction(session.id, {
      source: 'window',
      app_name: 'VS Code',
      window_title: 'index.ts',
      pulsetime_seconds: 30,
    });

    expect(merged).not.toBeNull();
    expect(merged!.app_name).toBe('VS Code');
  });

  it('heartbeatAction returns null on state change', () => {
    const session = db.startObservationSession();

    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'VS Code',
      window_title: 'index.ts',
    });

    // Different window title — should NOT merge
    const merged = db.heartbeatAction(session.id, {
      source: 'window',
      app_name: 'VS Code',
      window_title: 'config.ts',
      pulsetime_seconds: 30,
    });

    expect(merged).toBeNull();
  });

  it('heartbeatAction returns null on different source', () => {
    const session = db.startObservationSession();

    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'VS Code',
      window_title: 'index.ts',
    });

    const merged = db.heartbeatAction(session.id, {
      source: 'shell',
      app_name: 'VS Code',
      window_title: 'index.ts',
      pulsetime_seconds: 30,
    });

    expect(merged).toBeNull();
  });

  it('heartbeatAction returns null when no actions exist', () => {
    const session = db.startObservationSession();
    const merged = db.heartbeatAction(session.id, {
      source: 'window',
      app_name: 'Test',
      window_title: 'Test',
      pulsetime_seconds: 30,
    });
    expect(merged).toBeNull();
  });
});

describe('Observer — Window Detection with Exclusions', () => {
  it('polls and creates actions from window detector', async () => {
    const observer = new Observer(db, { poll_interval_ms: 60000 });

    let callCount = 0;
    observer.setWindowDetector(async (): Promise<WindowInfo | null> => {
      callCount++;
      return { app_name: 'Firefox', window_title: 'GitHub' };
    });

    observer.start();
    await observer.poll(); // Call poll directly
    observer.stop();

    expect(callCount).toBeGreaterThanOrEqual(1);

    const sessions = db.listObservationSessions();
    const actions = db.getObservedActions(sessions[0]!.id);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0]!.app_name).toBe('Firefox');
  });

  it('skips excluded apps', async () => {
    db.addExclusionRule('app', '1Password');

    const observer = new Observer(db, { poll_interval_ms: 60000 });
    observer.setWindowDetector(async () => ({ app_name: '1Password', window_title: 'Vault' }));

    observer.start();
    await observer.poll();

    const actions = db.getObservedActions(observer.getSession()!.id);
    expect(actions).toHaveLength(0);
    observer.stop();
  });

  it('skips excluded title patterns', async () => {
    db.addExclusionRule('title_pattern', '*banking*');

    const observer = new Observer(db, { poll_interval_ms: 60000 });
    observer.setWindowDetector(async () => ({ app_name: 'Firefox', window_title: 'Online Banking Portal' }));

    observer.start();
    await observer.poll();

    const actions = db.getObservedActions(observer.getSession()!.id);
    expect(actions).toHaveLength(0);
    observer.stop();
  });
});

describe('Observer — Action Queries', () => {
  it('getActionTimeline returns ordered actions', () => {
    const session = db.startObservationSession();

    db.logObservedAction(session.id, { source: 'window', app_name: 'A', window_title: 'First' });
    db.logObservedAction(session.id, { source: 'shell', command: 'npm test' });
    db.logObservedAction(session.id, { source: 'window', app_name: 'B', window_title: 'Third' });

    const timeline = db.getActionTimeline(session.id);
    expect(timeline).toHaveLength(3);
    // ASC order
    expect(timeline[0]!.window_title).toBe('First');
  });

  it('getActionSummary groups by source', () => {
    const session = db.startObservationSession();

    db.logObservedAction(session.id, { source: 'window', app_name: 'VS Code', duration_seconds: 100 });
    db.logObservedAction(session.id, { source: 'window', app_name: 'Firefox', duration_seconds: 50 });
    db.logObservedAction(session.id, { source: 'shell', command: 'ls', duration_seconds: 1 });

    const summary = db.getActionSummary(session.id);
    const windowSummary = summary.find(s => s.source === 'window');
    expect(windowSummary).toBeDefined();
    expect(windowSummary!.count).toBe(2);
    expect(windowSummary!.total_seconds).toBe(150);
  });

  it('getObservedActions supports source filter', () => {
    const session = db.startObservationSession();

    db.logObservedAction(session.id, { source: 'window', app_name: 'A' });
    db.logObservedAction(session.id, { source: 'shell', command: 'ls' });
    db.logObservedAction(session.id, { source: 'window', app_name: 'B' });

    const windowOnly = db.getObservedActions(session.id, { source: 'window' });
    expect(windowOnly).toHaveLength(2);

    const shellOnly = db.getObservedActions(session.id, { source: 'shell' });
    expect(shellOnly).toHaveLength(1);
  });

  it('getObservedActions supports limit and offset', () => {
    const session = db.startObservationSession();

    for (let i = 0; i < 10; i++) {
      db.logObservedAction(session.id, { source: 'manual', window_title: `Action ${i}` });
    }

    const limited = db.getObservedActions(session.id, { limit: 3 });
    expect(limited).toHaveLength(3);

    const paged = db.getObservedActions(session.id, { limit: 3, offset: 3 });
    expect(paged).toHaveLength(3);
  });
});

describe('matchesPattern', () => {
  it('matches exact string', () => {
    expect(matchesPattern('Firefox', 'Firefox')).toBe(true);
    expect(matchesPattern('Firefox', 'Chrome')).toBe(false);
  });

  it('matches wildcard *', () => {
    expect(matchesPattern('*banking*', 'Online Banking Portal')).toBe(true);
    expect(matchesPattern('*banking*', 'Shopping Cart')).toBe(false);
  });

  it('matches wildcard ?', () => {
    expect(matchesPattern('VS Code?', 'VS Code!')).toBe(true);
    expect(matchesPattern('VS Code?', 'VS Code')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesPattern('firefox', 'Firefox')).toBe(true);
    expect(matchesPattern('FIREFOX', 'firefox')).toBe(true);
  });
});

describe('matchesExclusionRules', () => {
  it('matches app rules', () => {
    const rules = [
      { id: '1', rule_type: 'app' as const, pattern: '1Password', created_at: '' },
    ];
    expect(matchesExclusionRules(rules, { app_name: '1Password' })).toBe(true);
    expect(matchesExclusionRules(rules, { app_name: 'Firefox' })).toBe(false);
  });

  it('matches title_pattern rules', () => {
    const rules = [
      { id: '1', rule_type: 'title_pattern' as const, pattern: '*private*', created_at: '' },
    ];
    expect(matchesExclusionRules(rules, { window_title: 'Private Browsing' })).toBe(true);
    expect(matchesExclusionRules(rules, { window_title: 'Normal Tab' })).toBe(false);
  });

  it('matches path_pattern rules', () => {
    const rules = [
      { id: '1', rule_type: 'path_pattern' as const, pattern: '*.env*', created_at: '' },
    ];
    expect(matchesExclusionRules(rules, { file_path: '.env.local' })).toBe(true);
    expect(matchesExclusionRules(rules, { file_path: 'index.ts' })).toBe(false);
  });

  it('returns false for empty rules', () => {
    expect(matchesExclusionRules([], { app_name: 'anything' })).toBe(false);
  });
});

describe('isWithinWorkHours', () => {
  it('returns true during work hours', () => {
    const config: ObserverConfig = {
      ...getDefaultObserverConfig(),
      work_hours_only: true,
      work_hours_start: 0,
      work_hours_end: 24,
    };
    expect(isWithinWorkHours(config)).toBe(true);
  });

  it('returns false outside work hours', () => {
    const hour = new Date().getHours();
    const config: ObserverConfig = {
      ...getDefaultObserverConfig(),
      work_hours_only: true,
      // Set impossible range
      work_hours_start: (hour + 2) % 24,
      work_hours_end: (hour + 3) % 24,
    };
    expect(isWithinWorkHours(config)).toBe(false);
  });
});
