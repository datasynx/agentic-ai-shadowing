import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import { Observer, matchesExclusionRules, matchesPattern, isWithinWorkHours, getDefaultObserverConfig } from '../src/observer.js';
import type { ObserverConfig, ExclusionRule } from '../src/types.js';

describe('Observer — Comprehensive Tests', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-obs-comp-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── getDefaultObserverConfig ────────────────────────────────────────────────

  describe('getDefaultObserverConfig', () => {
    it('returns valid defaults', () => {
      const config = getDefaultObserverConfig();
      expect(config.poll_interval_ms).toBe(5000);
      expect(config.watch_git).toBe(true);
      expect(config.watch_files).toBe(true);
      expect(config.capture_shell_history).toBe(true);
      expect(config.work_hours_only).toBe(false);
      expect(config.work_hours_start).toBe(8);
      expect(config.work_hours_end).toBe(18);
    });
  });

  // ── Observer lifecycle ──────────────────────────────────────────────────────

  describe('Observer lifecycle', () => {
    it('starts and creates a session', () => {
      const obs = new Observer(db);
      const session = obs.start('Test Session');
      expect(session.status).toBe('active');
      expect(obs.isRunning()).toBe(true);
      expect(obs.getSession()).not.toBeNull();
      obs.stop();
    });

    it('stop returns completed session', () => {
      const obs = new Observer(db);
      obs.start('Test');
      const completed = obs.stop();
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(obs.isRunning()).toBe(false);
    });

    it('stop on non-started observer returns null', () => {
      const obs = new Observer(db);
      expect(obs.stop()).toBeNull();
    });

    it('throws on double start', () => {
      const obs = new Observer(db);
      obs.start();
      expect(() => obs.start()).toThrow('already running');
      obs.stop();
    });

    it('pause stops polling but keeps session', () => {
      const obs = new Observer(db);
      obs.start('Test');
      obs.pause();
      expect(obs.isRunning()).toBe(false);
      expect(obs.getSession()).not.toBeNull();
      expect(obs.getSession()!.status).toBe('paused');
      obs.stop();
    });

    it('resume restarts polling after pause', () => {
      const obs = new Observer(db);
      obs.start('Test');
      obs.pause();
      obs.resume();
      expect(obs.isRunning()).toBe(true);
      obs.stop();
    });

    it('resume without session is a no-op', () => {
      const obs = new Observer(db);
      obs.resume(); // Should not throw
      expect(obs.isRunning()).toBe(false);
    });

    it('logManualAction returns null when no session', () => {
      const obs = new Observer(db);
      expect(obs.logManualAction('test')).toBeNull();
    });

    it('logManualAction creates observed action', () => {
      const obs = new Observer(db);
      const session = obs.start('Test');
      const action = obs.logManualAction('Did something important');
      expect(action).not.toBeNull();
      expect(action!.source).toBe('manual');
      expect(action!.window_title).toBe('Did something important');
      obs.stop();
    });

    it('resumes existing active session', () => {
      // Pre-create an active session
      const session = db.startObservationSession('Existing');
      const obs = new Observer(db);
      const started = obs.start();
      expect(started.id).toBe(session.id);
      obs.stop();
    });
  });

  // ── Observer with window detector ──────────────────────────────────────────

  describe('Observer with window detector', () => {
    it('captures window info on poll', async () => {
      const obs = new Observer(db, { poll_interval_ms: 100000 }); // Very long interval
      obs.setWindowDetector(async () => ({
        app_name: 'VS Code',
        window_title: 'src/app.ts — VS Code',
      }));
      obs.start('Test');

      // Manual poll
      await obs.poll();

      const session = obs.getSession()!;
      const actions = db.getObservedActions(session.id);
      expect(actions.length).toBeGreaterThanOrEqual(1);
      const windowAction = actions.find(a => a.source === 'window');
      expect(windowAction).toBeDefined();
      expect(windowAction!.app_name).toBe('VS Code');
      obs.stop();
    });

    it('skips excluded windows', async () => {
      db.addExclusionRule('app', '1Password');
      const obs = new Observer(db, { poll_interval_ms: 100000 });
      obs.setWindowDetector(async () => ({
        app_name: '1Password',
        window_title: 'Vault',
      }));
      obs.start('Test');

      await obs.poll();

      const session = obs.getSession()!;
      const actions = db.getObservedActions(session.id);
      const windowActions = actions.filter(a => a.source === 'window');
      expect(windowActions).toHaveLength(0);
      obs.stop();
    });

    it('handles null from window detector', async () => {
      const obs = new Observer(db, { poll_interval_ms: 100000 });
      obs.setWindowDetector(async () => null);
      obs.start('Test');
      await obs.poll(); // Should not throw
      obs.stop();
    });

    it('handles window detector that throws', async () => {
      const obs = new Observer(db, { poll_interval_ms: 100000 });
      obs.setWindowDetector(async () => { throw new Error('X11 not available'); });
      obs.start('Test');
      await obs.poll(); // Should not throw — errors are silenced
      obs.stop();
    });
  });

  // ── Observer with shell history ────────────────────────────────────────────

  describe('Observer with shell history', () => {
    it('captures shell commands', async () => {
      const obs = new Observer(db, { poll_interval_ms: 100000, capture_shell_history: true });
      obs.setShellHistoryReader(async () => [
        { command: 'git status', timestamp: '2024-01-01 12:00:00' },
        { command: 'npm test', timestamp: '2024-01-01 12:01:00', duration_seconds: 5 },
      ]);
      obs.start('Test');
      await obs.poll();

      const session = obs.getSession()!;
      const actions = db.getObservedActions(session.id);
      const shellActions = actions.filter(a => a.source === 'shell');
      expect(shellActions).toHaveLength(2);
      const commands = shellActions.map(a => a.command);
      expect(commands).toContain('git status');
      expect(commands).toContain('npm test');
      obs.stop();
    });

    it('deduplicates shell commands by timestamp', async () => {
      const commands = [
        { command: 'git status', timestamp: '2024-01-01 12:00:00' },
      ];
      const obs = new Observer(db, { poll_interval_ms: 100000, capture_shell_history: true });
      obs.setShellHistoryReader(async () => commands);
      obs.start('Test');

      await obs.poll();
      await obs.poll(); // Second poll — same timestamp, should be skipped

      const session = obs.getSession()!;
      const actions = db.getObservedActions(session.id);
      const shellActions = actions.filter(a => a.source === 'shell');
      expect(shellActions).toHaveLength(1);
      obs.stop();
    });

    it('picks up new commands on subsequent polls', async () => {
      let callCount = 0;
      const obs = new Observer(db, { poll_interval_ms: 100000, capture_shell_history: true });
      obs.setShellHistoryReader(async () => {
        callCount++;
        if (callCount === 1) {
          return [{ command: 'cmd1', timestamp: '2024-01-01 12:00:00' }];
        }
        return [
          { command: 'cmd1', timestamp: '2024-01-01 12:00:00' },
          { command: 'cmd2', timestamp: '2024-01-01 12:01:00' },
        ];
      });
      obs.start('Test');
      await obs.poll();
      await obs.poll();

      const session = obs.getSession()!;
      const actions = db.getObservedActions(session.id);
      const shellActions = actions.filter(a => a.source === 'shell');
      expect(shellActions).toHaveLength(2);
      obs.stop();
    });

    it('skips shell history when capture_shell_history is false', async () => {
      const obs = new Observer(db, { poll_interval_ms: 100000, capture_shell_history: false });
      obs.setShellHistoryReader(async () => [
        { command: 'secret', timestamp: '2024-01-01 12:00:00' },
      ]);
      obs.start('Test');
      await obs.poll();

      const session = obs.getSession()!;
      const actions = db.getObservedActions(session.id);
      expect(actions.filter(a => a.source === 'shell')).toHaveLength(0);
      obs.stop();
    });

    it('handles shell reader that throws', async () => {
      const obs = new Observer(db, { poll_interval_ms: 100000, capture_shell_history: true });
      obs.setShellHistoryReader(async () => { throw new Error('No history file'); });
      obs.start('Test');
      await obs.poll(); // Should not throw
      obs.stop();
    });

    it('excludes commands matching title_pattern exclusion rules', async () => {
      db.addExclusionRule('title_pattern', '*password*');
      const obs = new Observer(db, { poll_interval_ms: 100000, capture_shell_history: true });
      obs.setShellHistoryReader(async () => [
        { command: 'cat /etc/password', timestamp: '2024-01-01 12:00:00' },
        { command: 'ls -la', timestamp: '2024-01-01 12:01:00' },
      ]);
      obs.start('Test');
      await obs.poll();

      const session = obs.getSession()!;
      const shellActions = db.getObservedActions(session.id).filter(a => a.source === 'shell');
      expect(shellActions).toHaveLength(1);
      expect(shellActions[0]!.command).toBe('ls -la');
      obs.stop();
    });
  });

  // ── Work hours check ───────────────────────────────────────────────────────

  describe('Observer work hours', () => {
    it('skips poll outside work hours when enabled', async () => {
      const obs = new Observer(db, {
        poll_interval_ms: 100000,
        work_hours_only: true,
        work_hours_start: 0, // 00:00
        work_hours_end: 0,   // 00:00 — always outside (0 to 0 = empty range)
      });
      obs.setWindowDetector(async () => ({ app_name: 'Test', window_title: 'Test' }));
      obs.start('Test');
      await obs.poll();

      const session = obs.getSession()!;
      const actions = db.getObservedActions(session.id);
      // Poll should be skipped — no actions logged
      expect(actions.filter(a => a.source === 'window')).toHaveLength(0);
      obs.stop();
    });
  });
});

// ── matchesExclusionRules ─────────────────────────────────────────────────────

describe('matchesExclusionRules — Comprehensive', () => {
  function makeRule(type: ExclusionRule['rule_type'], pattern: string): ExclusionRule {
    return { id: 'test', rule_type: type, pattern, created_at: '' };
  }

  it('returns false for empty rules', () => {
    expect(matchesExclusionRules([], { app_name: 'foo' })).toBe(false);
  });

  it('matches app name exactly', () => {
    const rules = [makeRule('app', '1Password')];
    expect(matchesExclusionRules(rules, { app_name: '1Password' })).toBe(true);
    expect(matchesExclusionRules(rules, { app_name: 'Chrome' })).toBe(false);
  });

  it('matches app with wildcard', () => {
    const rules = [makeRule('app', 'KeePass*')];
    expect(matchesExclusionRules(rules, { app_name: 'KeePassXC' })).toBe(true);
    expect(matchesExclusionRules(rules, { app_name: 'KeePass' })).toBe(true);
    expect(matchesExclusionRules(rules, { app_name: 'Chrome' })).toBe(false);
  });

  it('matches title_pattern', () => {
    const rules = [makeRule('title_pattern', '*banking*')];
    expect(matchesExclusionRules(rules, { window_title: 'Online Banking - Chrome' })).toBe(true);
    expect(matchesExclusionRules(rules, { window_title: 'Code Editor' })).toBe(false);
  });

  it('matches url_pattern', () => {
    const rules = [makeRule('url_pattern', '*bank*')];
    expect(matchesExclusionRules(rules, { url: 'https://mybank.com' })).toBe(true);
    expect(matchesExclusionRules(rules, { url: 'https://github.com' })).toBe(false);
  });

  it('matches path_pattern', () => {
    const rules = [makeRule('path_pattern', '*.env*')];
    expect(matchesExclusionRules(rules, { file_path: '.env.local' })).toBe(true);
    expect(matchesExclusionRules(rules, { file_path: 'src/app.ts' })).toBe(false);
  });

  it('does not match when context field is missing', () => {
    const rules = [makeRule('app', '1Password')];
    expect(matchesExclusionRules(rules, { window_title: '1Password' })).toBe(false);
    expect(matchesExclusionRules(rules, {})).toBe(false);
  });

  it('matches any rule in array', () => {
    const rules = [
      makeRule('app', 'Chrome'),
      makeRule('app', 'Firefox'),
    ];
    expect(matchesExclusionRules(rules, { app_name: 'Firefox' })).toBe(true);
  });

  it('handles multiple rule types', () => {
    const rules = [
      makeRule('app', 'Secret'),
      makeRule('title_pattern', '*private*'),
    ];
    expect(matchesExclusionRules(rules, { window_title: 'Private Browsing' })).toBe(true);
    expect(matchesExclusionRules(rules, { app_name: 'Secret' })).toBe(true);
    expect(matchesExclusionRules(rules, { app_name: 'Public', window_title: 'Normal' })).toBe(false);
  });
});

// ── matchesPattern ──────────────────────────────────────────────────────────

describe('matchesPattern — Comprehensive', () => {
  it('exact match', () => {
    expect(matchesPattern('hello', 'hello')).toBe(true);
    expect(matchesPattern('hello', 'world')).toBe(false);
  });

  it('case insensitive', () => {
    expect(matchesPattern('Hello', 'hello')).toBe(true);
    expect(matchesPattern('hello', 'HELLO')).toBe(true);
  });

  it('* matches any characters', () => {
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('foo*', 'foobar')).toBe(true);
    expect(matchesPattern('*bar', 'foobar')).toBe(true);
    expect(matchesPattern('*oba*', 'foobar')).toBe(true);
  });

  it('? matches single character', () => {
    expect(matchesPattern('h?llo', 'hello')).toBe(true);
    expect(matchesPattern('h?llo', 'hallo')).toBe(true);
    expect(matchesPattern('h?llo', 'hllo')).toBe(false);
  });

  it('escapes regex special characters', () => {
    expect(matchesPattern('file.txt', 'file.txt')).toBe(true);
    expect(matchesPattern('file.txt', 'filextxt')).toBe(false); // . is escaped
    expect(matchesPattern('a+b', 'a+b')).toBe(true);
    expect(matchesPattern('a[b]c', 'a[b]c')).toBe(true);
  });

  it('handles empty pattern and value', () => {
    expect(matchesPattern('', '')).toBe(true);
    expect(matchesPattern('*', '')).toBe(true);
    expect(matchesPattern('', 'hello')).toBe(false);
  });

  it('combines * and ?', () => {
    expect(matchesPattern('*.t?t', 'file.txt')).toBe(true);
    expect(matchesPattern('*.t?t', 'file.tnt')).toBe(true);
    expect(matchesPattern('*.t?t', 'file.test')).toBe(false);
  });
});

// ── isWithinWorkHours ─────────────────────────────────────────────────────────

describe('isWithinWorkHours — Comprehensive', () => {
  it('current hour within range returns true', () => {
    const now = new Date().getHours();
    const config: ObserverConfig = {
      ...getDefaultObserverConfig(),
      work_hours_start: 0,
      work_hours_end: 24,
    };
    expect(isWithinWorkHours(config)).toBe(true);
  });

  it('returns false when start equals end (empty range)', () => {
    const config: ObserverConfig = {
      ...getDefaultObserverConfig(),
      work_hours_start: 12,
      work_hours_end: 12,
    };
    expect(isWithinWorkHours(config)).toBe(false);
  });

  it('returns false when range is 0-0', () => {
    const config: ObserverConfig = {
      ...getDefaultObserverConfig(),
      work_hours_start: 0,
      work_hours_end: 0,
    };
    expect(isWithinWorkHours(config)).toBe(false);
  });
});
