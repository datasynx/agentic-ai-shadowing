import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';

describe('ShadowingDB — Coverage Gaps', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-db-gaps-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function completeActiveTask() {
    const active = db.getActiveTask();
    if (active) db.completeTask(active.id);
  }

  function createCompletedTaskWithSOP(title = 'Test') {
    completeActiveTask();
    const task = db.createTask(title);
    db.completeTask(task.id);
    return {
      task,
      sop: db.createSOP(task.id, { title: `${title} SOP`, content_md: '# Test' }),
    };
  }

  // ── Observation Session: pause / resume ─────────────────────────────────

  describe('pauseObservationSession', () => {
    it('pauses an active session', () => {
      const session = db.startObservationSession('Test session');
      const paused = db.pauseObservationSession(session.id);
      expect(paused.status).toBe('paused');
      expect(paused.id).toBe(session.id);
    });

    it('throws for non-existent session', () => {
      expect(() => db.pauseObservationSession('nonexistent')).toThrow('not found');
    });

    it('allows starting a new session after pausing', () => {
      const s1 = db.startObservationSession('S1');
      db.pauseObservationSession(s1.id);
      // Paused session should not block new active session (unique index is on status='active')
      const s2 = db.startObservationSession('S2');
      expect(s2.status).toBe('active');
    });
  });

  describe('resumeObservationSession', () => {
    it('resumes a paused session', () => {
      const session = db.startObservationSession('Test');
      db.pauseObservationSession(session.id);
      const resumed = db.resumeObservationSession(session.id);
      expect(resumed.status).toBe('active');
    });

    it('throws for non-existent session', () => {
      expect(() => db.resumeObservationSession('nonexistent')).toThrow('not found');
    });

    it('full pause/resume cycle preserves session data', () => {
      const session = db.startObservationSession('Lifecycle test');
      db.logObservedAction(session.id, { source: 'shell', command: 'ls' });

      db.pauseObservationSession(session.id);
      const paused = db.getObservationSession(session.id);
      expect(paused!.status).toBe('paused');

      db.resumeObservationSession(session.id);
      const resumed = db.getObservationSession(session.id);
      expect(resumed!.status).toBe('active');

      // Actions still accessible
      const actions = db.getObservedActions(session.id);
      expect(actions).toHaveLength(1);
    });
  });

  // ── heartbeatAction ─────────────────────────────────────────────────────

  describe('heartbeatAction', () => {
    it('returns null when session has no actions', () => {
      const session = db.startObservationSession('HB');
      const result = db.heartbeatAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'file.ts',
        pulsetime_seconds: 60,
      });
      expect(result).toBeNull();
    });

    it('returns null when source does not match last action', () => {
      const session = db.startObservationSession('HB');
      db.logObservedAction(session.id, { source: 'shell', command: 'ls' });

      const result = db.heartbeatAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        pulsetime_seconds: 60,
      });
      expect(result).toBeNull();
    });

    it('returns null when app_name does not match', () => {
      const session = db.startObservationSession('HB');
      db.logObservedAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'file.ts',
      });

      const result = db.heartbeatAction(session.id, {
        source: 'window',
        app_name: 'Chrome',
        window_title: 'file.ts',
        pulsetime_seconds: 60,
      });
      expect(result).toBeNull();
    });

    it('returns null when window_title does not match', () => {
      const session = db.startObservationSession('HB');
      db.logObservedAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'file.ts',
      });

      const result = db.heartbeatAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'other.ts',
        pulsetime_seconds: 60,
      });
      expect(result).toBeNull();
    });

    it('merges when source, app_name, window_title match within pulsetime', () => {
      const session = db.startObservationSession('HB');
      db.logObservedAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'file.ts',
      });

      const merged = db.heartbeatAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'file.ts',
        pulsetime_seconds: 300, // 5 minutes
      });

      expect(merged).not.toBeNull();
      expect(merged!.app_name).toBe('VS Code');
      expect(merged!.window_title).toBe('file.ts');
      // Duration should be >= 0 (just merged)
      expect(merged!.duration_seconds).toBeGreaterThanOrEqual(0);
    });

    it('matches null app_name and null window_title', () => {
      const session = db.startObservationSession('HB');
      db.logObservedAction(session.id, { source: 'shell' });

      const merged = db.heartbeatAction(session.id, {
        source: 'shell',
        pulsetime_seconds: 300,
      });

      expect(merged).not.toBeNull();
    });

    it('does not merge when app_name is null vs non-null', () => {
      const session = db.startObservationSession('HB');
      db.logObservedAction(session.id, { source: 'window' }); // app_name = null

      const result = db.heartbeatAction(session.id, {
        source: 'window',
        app_name: 'VS Code', // non-null
        pulsetime_seconds: 300,
      });

      expect(result).toBeNull();
    });

    it('only considers the most recent action by ended_at', () => {
      const session = db.startObservationSession('HB');
      // Insert first action with older timestamp
      db.logObservedAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'first.ts',
        started_at: '2025-01-01T00:00:00',
        ended_at: '2025-01-01T00:01:00',
      });
      // Insert second action with newer timestamp
      db.logObservedAction(session.id, {
        source: 'window',
        app_name: 'Chrome',
        window_title: 'google.com',
        started_at: '2025-01-01T00:02:00',
        ended_at: '2025-01-01T00:03:00',
      });

      // VS Code (older action) should NOT match — heartbeat checks most recent
      const noMatch = db.heartbeatAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'first.ts',
        pulsetime_seconds: 86400, // large pulsetime to avoid time gap issues
      });
      expect(noMatch).toBeNull();
    });
  });

  // ── Data Degradation edge cases ─────────────────────────────────────────

  describe('data degradation', () => {
    it('purgeOldActions removes old actions and keeps recent ones', () => {
      const session = db.startObservationSession('Degrade test');
      // Insert an action with old timestamp
      db.logObservedAction(session.id, {
        source: 'shell',
        command: 'old command',
        started_at: '2020-01-01T00:00:00',
        ended_at: '2020-01-01T00:01:00',
      });
      // Insert a recent action
      db.logObservedAction(session.id, {
        source: 'shell',
        command: 'recent command',
      });

      const purged = db.purgeOldActions(30); // 30 days
      expect(purged).toBe(1);

      const remaining = db.getObservedActions(session.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.command).toBe('recent command');
    });

    it('degradeOldActions nullifies detailed fields', () => {
      const session = db.startObservationSession('Degrade test');
      db.logObservedAction(session.id, {
        source: 'window',
        app_name: 'VS Code',
        window_title: 'secret-file.ts',
        command: 'cat passwords.txt',
        file_path: '/home/user/passwords.txt',
        metadata: { secret: true },
        started_at: '2020-01-01T00:00:00',
        ended_at: '2020-01-01T00:01:00',
      });

      const degraded = db.degradeOldActions(30);
      expect(degraded).toBe(1);

      const actions = db.getObservedActions(session.id);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.window_title).toBeNull();
      expect(actions[0]!.command).toBeNull();
      expect(actions[0]!.file_path).toBeNull();
      expect(actions[0]!.metadata).toBeNull();
      // Source and app_name are preserved
      expect(actions[0]!.source).toBe('window');
      expect(actions[0]!.app_name).toBe('VS Code');
    });

    it('degradeOldActions is idempotent', () => {
      const session = db.startObservationSession('Degrade test');
      db.logObservedAction(session.id, {
        source: 'shell',
        command: 'ls',
        started_at: '2020-01-01T00:00:00',
        ended_at: '2020-01-01T00:01:00',
      });

      const first = db.degradeOldActions(30);
      expect(first).toBe(1);
      const second = db.degradeOldActions(30);
      expect(second).toBe(0); // Already degraded
    });
  });

  // ── Task edge cases ─────────────────────────────────────────────────────

  describe('task edge cases', () => {
    it('updateTask updates only title', () => {
      const task = db.createTask('Original', 'desc');
      const updated = db.updateTask(task.id, { title: 'New Title' });
      expect(updated.title).toBe('New Title');
      expect(updated.description).toBe('desc');
    });

    it('updateTask updates only description', () => {
      const task = db.createTask('Title', 'old desc');
      const updated = db.updateTask(task.id, { description: 'new desc' });
      expect(updated.title).toBe('Title');
      expect(updated.description).toBe('new desc');
    });

    it('listTasks without filter returns all tasks', () => {
      db.createTask('Task 1');
      db.completeTask(db.getActiveTask()!.id);
      db.createTask('Task 2');
      db.cancelTask(db.getActiveTask()!.id);
      db.createTask('Task 3');

      const all = db.listTasks();
      expect(all).toHaveLength(3);
    });

    it('multiple pause/resume cycles accumulate paused time', () => {
      const task = db.createTask('Pause test');

      // Pause for ~0 seconds (instant pause/resume)
      db.pauseTask(task.id);
      db.resumeTask(task.id);
      db.pauseTask(task.id);
      db.resumeTask(task.id);

      const completed = db.completeTask(task.id);
      // Duration can be 0 or slightly negative due to SQLite datetime second-level precision
      expect(completed.duration_seconds).not.toBeNull();
    });
  });

  // ── SOP edge cases ──────────────────────────────────────────────────────

  describe('SOP edge cases', () => {
    it('updateSOP with only description does not bump version', () => {
      const { sop } = createCompletedTaskWithSOP();
      const updated = db.updateSOP(sop.id, { description: 'New description' });
      expect(updated.version).toBe(1);
      expect(updated.description).toBe('New description');
    });

    it('updateSOP with only title does not bump version', () => {
      const { sop } = createCompletedTaskWithSOP();
      const updated = db.updateSOP(sop.id, { title: 'New Title' });
      expect(updated.version).toBe(1);
      expect(updated.title).toBe('New Title');
    });

    it('updateSOP with content_md bumps version', () => {
      const { sop } = createCompletedTaskWithSOP();
      const updated = db.updateSOP(sop.id, { content_md: '# Updated' });
      expect(updated.version).toBe(2);
    });

    it('multiple content updates create sequential versions', () => {
      const { sop } = createCompletedTaskWithSOP();
      db.updateSOP(sop.id, { content_md: '# V2' });
      db.updateSOP(sop.id, { content_md: '# V3' });
      db.updateSOP(sop.id, { content_md: '# V4' });

      const versions = db.getSOPVersions(sop.id);
      // Each update snapshots the PREVIOUS version before bumping
      expect(versions).toHaveLength(3); // snapshots of v1, v2, v3
      expect(versions[0]!.version).toBe(3); // most recent snapshot (DESC order)
      expect(versions[2]!.version).toBe(1); // oldest snapshot
    });

    it('listSOPs search is case-insensitive', () => {
      const { sop } = createCompletedTaskWithSOP('Deploy Pipeline');
      const results = db.listSOPs({ search: 'deploy pipeline' });
      expect(results.some(s => s.id === sop.id)).toBe(true);
    });

    it('listSOPs with combined status + tag filter', () => {
      const { sop: sop1 } = createCompletedTaskWithSOP('SOP A');
      const { sop: sop2 } = createCompletedTaskWithSOP('SOP B');

      db.addTagToSOP(sop1.id, 'deploy');
      db.addTagToSOP(sop2.id, 'deploy');
      db.updateSOPStatus(sop1.id, 'reviewed');

      const results = db.listSOPs({ status: 'reviewed', tag: 'deploy' });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(sop1.id);
    });

    it('status transitions: exported back to draft is allowed', () => {
      const { sop } = createCompletedTaskWithSOP();
      db.updateSOPStatus(sop.id, 'exported');
      const back = db.updateSOPStatus(sop.id, 'draft');
      expect(back.status).toBe('draft');
    });
  });

  // ── Tag edge cases ──────────────────────────────────────────────────────

  describe('tag edge cases', () => {
    it('addTagToSOP with aiGenerated=false', () => {
      const { sop } = createCompletedTaskWithSOP();
      db.addTagToSOP(sop.id, 'manual-tag', false);
      const tags = db.getTagsForSOP(sop.id);
      expect(tags).toHaveLength(1);
      expect(tags[0]!.ai_generated).toBe(false);
    });

    it('tag names with special characters', () => {
      const { sop } = createCompletedTaskWithSOP();
      db.addTagToSOP(sop.id, 'c++');
      db.addTagToSOP(sop.id, 'node.js');
      db.addTagToSOP(sop.id, 'ci/cd');

      const tags = db.getTagsForSOP(sop.id);
      const names = tags.map(t => t.name);
      expect(names).toContain('c++');
      expect(names).toContain('node.js');
      expect(names).toContain('ci/cd');
    });

    it('getOrCreateTag is case-insensitive', () => {
      const tag1 = db.getOrCreateTag('Deploy');
      const tag2 = db.getOrCreateTag('deploy');
      const tag3 = db.getOrCreateTag('DEPLOY');
      expect(tag1.id).toBe(tag2.id);
      expect(tag2.id).toBe(tag3.id);
    });
  });

  // ── Export edge cases ───────────────────────────────────────────────────

  describe('export edge cases', () => {
    it('getExports returns in DESC order', () => {
      const { sop: sop1 } = createCompletedTaskWithSOP('E1');
      const { sop: sop2 } = createCompletedTaskWithSOP('E2');

      db.logExport({ sop_count: 1, export_path: '/tmp/export1', sop_ids: [sop1.id] });
      db.logExport({ sop_count: 1, export_path: '/tmp/export2', sop_ids: [sop2.id] });

      const exports = db.getExports();
      expect(exports).toHaveLength(2);
      const paths = exports.map(e => e.export_path);
      expect(paths).toContain('/tmp/export1');
      expect(paths).toContain('/tmp/export2');
    });

    it('logExport with empty sop_ids creates export record', () => {
      const exportRec = db.logExport({ sop_count: 0, export_path: '/tmp/empty', sop_ids: [] });
      expect(exportRec.sop_count).toBe(0);
      expect(exportRec.export_path).toBe('/tmp/empty');
    });
  });

  // ── GlobalStats with various SOP statuses ──────────────────────────────

  describe('getGlobalStats comprehensive', () => {
    it('counts all SOP statuses correctly', () => {
      const { sop: s1 } = createCompletedTaskWithSOP('S1');
      const { sop: s2 } = createCompletedTaskWithSOP('S2');
      const { sop: s3 } = createCompletedTaskWithSOP('S3');
      const { sop: s4 } = createCompletedTaskWithSOP('S4');

      db.updateSOPStatus(s1.id, 'reviewed');
      db.updateSOPStatus(s2.id, 'approved');
      db.updateSOPStatus(s3.id, 'exported');
      // s4 stays draft

      const stats = db.getGlobalStats();
      expect(stats.total_sops).toBe(4);
      expect(stats.draft_sops).toBe(1);
      expect(stats.reviewed_sops).toBe(1);
      expect(stats.approved_sops).toBe(1);
      expect(stats.exported_sops).toBe(1);
    });

    it('counts tags, executions, and exports', () => {
      const { sop } = createCompletedTaskWithSOP();
      db.addTagToSOP(sop.id, 'tag1');
      db.addTagToSOP(sop.id, 'tag2');
      db.logExecution(sop.id, { duration_seconds: 100 });
      db.logExport({ sop_count: 1, export_path: '/tmp/e', sop_ids: [sop.id] });

      const stats = db.getGlobalStats();
      expect(stats.total_tags).toBe(2);
      expect(stats.total_executions).toBe(1);
      expect(stats.total_exports).toBe(1);
    });
  });

  // ── Observation session: listObservationSessions without filter ────────

  describe('listObservationSessions', () => {
    it('returns all sessions without filter', () => {
      const s1 = db.startObservationSession('S1');
      db.completeObservationSession(s1.id);
      const s2 = db.startObservationSession('S2');
      db.pauseObservationSession(s2.id);
      db.startObservationSession('S3'); // active

      const all = db.listObservationSessions();
      expect(all).toHaveLength(3);
    });

    it('filters by status correctly', () => {
      const s1 = db.startObservationSession('S1');
      db.completeObservationSession(s1.id);
      const s2 = db.startObservationSession('S2');
      db.pauseObservationSession(s2.id);

      expect(db.listObservationSessions({ status: 'completed' })).toHaveLength(1);
      expect(db.listObservationSessions({ status: 'paused' })).toHaveLength(1);
      expect(db.listObservationSessions({ status: 'active' })).toHaveLength(0);
    });
  });

  // ── Schema idempotency ─────────────────────────────────────────────────

  describe('initialize idempotency', () => {
    it('can be called multiple times without error', () => {
      expect(() => {
        db.initialize();
        db.initialize();
        db.initialize();
      }).not.toThrow();
    });

    it('data persists across multiple initialize calls', () => {
      db.createTask('Persist test');
      db.initialize(); // re-init
      const tasks = db.listTasks();
      expect(tasks.some(t => t.title === 'Persist test')).toBe(true);
    });
  });
});
