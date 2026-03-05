import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';

describe('DB Edge Cases', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-db-edge-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Task Edge Cases ──────────────────────────────────────────────────────

  describe('Task Constraints', () => {
    it('should enforce single active task constraint', () => {
      db.createTask('Task 1');
      expect(() => db.createTask('Task 2')).toThrow();
    });

    it('should allow creating task after completing the active one', () => {
      const t1 = db.createTask('Task 1');
      db.completeTask(t1.id);
      const t2 = db.createTask('Task 2');
      expect(t2.status).toBe('active');
    });

    it('should allow creating task after cancelling the active one', () => {
      const t1 = db.createTask('Task 1');
      db.cancelTask(t1.id);
      const t2 = db.createTask('Task 2');
      expect(t2.status).toBe('active');
    });

    it('should return null for getTask with non-existent ID', () => {
      expect(db.getTask('nonexistent')).toBeNull();
    });

    it('should return null for getActiveTask when no active task', () => {
      expect(db.getActiveTask()).toBeNull();
    });

    it('should throw on completeTask for already completed task', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      expect(() => db.completeTask(t.id)).toThrow('already completed');
    });

    it('should throw on completeTask for cancelled task', () => {
      const t = db.createTask('Test');
      db.cancelTask(t.id);
      expect(() => db.completeTask(t.id)).toThrow('cancelled');
    });

    it('should throw on completeTask for non-existent task', () => {
      expect(() => db.completeTask('nonexistent')).toThrow('not found');
    });

    it('should throw on pauseTask for non-active task', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      expect(() => db.pauseTask(t.id)).toThrow('not active');
    });

    it('should throw on resumeTask for non-paused task', () => {
      const t = db.createTask('Test');
      expect(() => db.resumeTask(t.id)).toThrow('not paused');
    });

    it('should throw on updateTask for non-existent task', () => {
      expect(() => db.updateTask('nonexistent', { title: 'x' })).toThrow('not found');
    });
  });

  describe('Task deleteTask and cascading', () => {
    it('should delete a task', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      db.deleteTask(t.id);
      expect(db.getTask(t.id)).toBeNull();
    });

    it('should cascade delete SOPs when task is deleted', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      db.deleteTask(t.id);
      expect(db.getSOP(sop.id)).toBeNull();
    });

    it('should cascade delete tags/executions when SOP is deleted via task', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP', tags: ['test'] });
      db.logExecution(sop.id, { duration_seconds: 100 });
      db.deleteTask(t.id);
      expect(db.getExecutions(sop.id)).toEqual([]);
      expect(db.getTagsForSOP(sop.id)).toEqual([]);
    });
  });

  describe('listTasks', () => {
    it('should return empty array when no tasks exist', () => {
      expect(db.listTasks()).toEqual([]);
    });

    it('should filter by status correctly', () => {
      const t1 = db.createTask('T1');
      db.completeTask(t1.id);
      const t2 = db.createTask('T2');
      db.cancelTask(t2.id);

      expect(db.listTasks({ status: 'completed' })).toHaveLength(1);
      expect(db.listTasks({ status: 'cancelled' })).toHaveLength(1);
      expect(db.listTasks({ status: 'active' })).toHaveLength(0);
    });
  });

  // ── SOP Edge Cases ───────────────────────────────────────────────────────

  describe('SOP Edge Cases', () => {
    it('should return null for getSOP with non-existent ID', () => {
      expect(db.getSOP('nonexistent')).toBeNull();
    });

    it('should throw on updateSOP for non-existent SOP', () => {
      expect(() => db.updateSOP('nonexistent', { title: 'x' })).toThrow('not found');
    });

    it('should throw on updateSOPStatus for non-existent SOP', () => {
      expect(() => db.updateSOPStatus('nonexistent', 'approved')).toThrow('not found');
    });

    it('should create SOP with empty tags array', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP', tags: [] });
      expect(db.getTagsForSOP(sop.id)).toEqual([]);
    });

    it('should create SOP with ai_generated=false', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP', ai_generated: false });
      expect(sop.ai_generated).toBe(false);
    });

    it('should increment version on content update', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# V1' });
      expect(sop.version).toBe(1);

      const updated = db.updateSOP(sop.id, { content_md: '# V2' });
      expect(updated.version).toBe(2);
    });

    it('should create version history on content update', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# V1' });
      db.updateSOP(sop.id, { content_md: '# V2' }, 'Changed content');
      const versions = db.getSOPVersions(sop.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.version).toBe(1);
      expect(versions[0]!.content_md).toBe('# V1');
      expect(versions[0]!.change_summary).toBe('Changed content');
    });

    it('should not increment version when only title changes', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# V1' });
      const updated = db.updateSOP(sop.id, { title: 'New Title' });
      expect(updated.version).toBe(1);
    });

    it('should set reviewed_at when status changes to reviewed', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      expect(sop.reviewed_at).toBeNull();
      const reviewed = db.updateSOPStatus(sop.id, 'reviewed');
      expect(reviewed.reviewed_at).not.toBeNull();
    });

    it('should set exported_at when status changes to exported', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      const exported = db.updateSOPStatus(sop.id, 'exported');
      expect(exported.exported_at).not.toBeNull();
    });

    it('should handle deleteSOP gracefully for non-existent ID', () => {
      // Should not throw
      db.deleteSOP('nonexistent');
    });
  });

  describe('SOP listSOPs Filters', () => {
    it('should return empty array when no SOPs exist', () => {
      expect(db.listSOPs()).toEqual([]);
    });

    it('should filter by status', () => {
      const t = db.createTask('Test');
      db.createSOP(t.id, { title: 'SOP1', content_md: '# 1' });
      const sop2 = db.createSOP(t.id, { title: 'SOP2', content_md: '# 2' });
      db.updateSOPStatus(sop2.id, 'approved');

      expect(db.listSOPs({ status: 'draft' })).toHaveLength(1);
      expect(db.listSOPs({ status: 'approved' })).toHaveLength(1);
    });

    it('should filter by tag', () => {
      const t = db.createTask('Test');
      const sop1 = db.createSOP(t.id, { title: 'SOP1', content_md: '# 1', tags: ['alpha'] });
      db.createSOP(t.id, { title: 'SOP2', content_md: '# 2', tags: ['beta'] });

      const result = db.listSOPs({ tag: 'alpha' });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(sop1.id);
    });

    it('should filter by search', () => {
      const t = db.createTask('Test');
      db.createSOP(t.id, { title: 'Deploy SOP', content_md: '# Deploy', description: 'Deploy process' });
      db.createSOP(t.id, { title: 'Review SOP', content_md: '# Review' });

      const result = db.listSOPs({ search: 'Deploy' });
      expect(result).toHaveLength(1);
    });

    it('should combine filters', () => {
      const t = db.createTask('Test');
      const sop1 = db.createSOP(t.id, { title: 'Deploy SOP', content_md: '# Deploy', tags: ['ops'] });
      db.updateSOPStatus(sop1.id, 'approved');
      db.createSOP(t.id, { title: 'Deploy Draft', content_md: '# Deploy Draft', tags: ['ops'] });

      const result = db.listSOPs({ status: 'approved', search: 'Deploy' });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(sop1.id);
    });
  });

  // ── Tag Edge Cases ───────────────────────────────────────────────────────

  describe('Tags', () => {
    it('should handle case-insensitive tag names', () => {
      const tag1 = db.getOrCreateTag('Deploy');
      const tag2 = db.getOrCreateTag('deploy');
      expect(tag1.id).toBe(tag2.id);
    });

    it('should handle adding duplicate tag to SOP (idempotent)', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      db.addTagToSOP(sop.id, 'test');
      db.addTagToSOP(sop.id, 'test'); // should not throw
      expect(db.getTagsForSOP(sop.id)).toHaveLength(1);
    });

    it('should return empty tags for SOP with no tags', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      expect(db.getTagsForSOP(sop.id)).toEqual([]);
    });

    it('should remove tag from SOP', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP', tags: ['alpha', 'beta'] });
      const tags = db.getTagsForSOP(sop.id);
      const alphaTag = tags.find(t => t.name === 'alpha');
      db.removeTagFromSOP(sop.id, alphaTag!.id);
      expect(db.getTagsForSOP(sop.id)).toHaveLength(1);
    });

    it('should handle removing non-existent tag from SOP', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      db.removeTagFromSOP(sop.id, 'nonexistent'); // should not throw
    });

    it('should list all tags', () => {
      db.getOrCreateTag('alpha');
      db.getOrCreateTag('beta');
      db.getOrCreateTag('gamma');
      expect(db.listTags()).toHaveLength(3);
    });
  });

  // ── Execution Edge Cases ─────────────────────────────────────────────────

  describe('Executions', () => {
    it('should log execution with null complexity', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      const exec = db.logExecution(sop.id, { duration_seconds: 60 });
      expect(exec.complexity_rating).toBeNull();
    });

    it('should log execution with zero duration', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      const exec = db.logExecution(sop.id, { duration_seconds: 0 });
      expect(exec.duration_seconds).toBe(0);
    });

    it('should return empty executions for SOP with no executions', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      expect(db.getExecutions(sop.id)).toEqual([]);
    });

    it('should reject complexity outside 1-5 range', () => {
      const t = db.createTask('Test');
      db.completeTask(t.id);
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      expect(() => db.logExecution(sop.id, { duration_seconds: 60, complexity_rating: 0 })).toThrow();
      expect(() => db.logExecution(sop.id, { duration_seconds: 60, complexity_rating: 6 })).toThrow();
    });
  });

  // ── Export Edge Cases ────────────────────────────────────────────────────

  describe('Exports', () => {
    it('should return empty array when no exports exist', () => {
      expect(db.getExports()).toEqual([]);
    });

    it('should log export with empty sop_ids', () => {
      const exp = db.logExport({ sop_count: 0, export_path: '/tmp/test', sop_ids: [] });
      expect(exp.sop_count).toBe(0);
    });
  });

  // ── Version Edge Cases ───────────────────────────────────────────────────

  describe('Versions', () => {
    it('should return null for non-existent version', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      expect(db.getSOPVersion(sop.id, 999)).toBeNull();
    });

    it('should return empty versions for SOP with no updates', () => {
      const t = db.createTask('Test');
      const sop = db.createSOP(t.id, { title: 'SOP', content_md: '# SOP' });
      expect(db.getSOPVersions(sop.id)).toEqual([]);
    });
  });

  // ── Observation Session Edge Cases ───────────────────────────────────────

  describe('Observation Sessions', () => {
    it('should enforce single active session constraint', () => {
      db.startObservationSession('Session 1');
      expect(() => db.startObservationSession('Session 2')).toThrow();
    });

    it('should return null for non-existent session', () => {
      expect(db.getObservationSession('nonexistent')).toBeNull();
    });

    it('should return null when no active session', () => {
      expect(db.getActiveObservationSession()).toBeNull();
    });

    it('should throw on completing non-existent session', () => {
      expect(() => db.completeObservationSession('nonexistent')).toThrow();
    });

    it('should count actions when completing session', () => {
      const session = db.startObservationSession('Test');
      db.logObservedAction(session.id, { source: 'manual', window_title: 'Action 1' });
      db.logObservedAction(session.id, { source: 'manual', window_title: 'Action 2' });
      const completed = db.completeObservationSession(session.id);
      expect(completed.total_actions).toBe(2);
    });

    it('should list sessions by status', () => {
      const s = db.startObservationSession('Test');
      db.completeObservationSession(s.id);
      expect(db.listObservationSessions({ status: 'completed' })).toHaveLength(1);
      expect(db.listObservationSessions({ status: 'active' })).toHaveLength(0);
    });

    it('should allow creating new session after completing one', () => {
      const s1 = db.startObservationSession('S1');
      db.completeObservationSession(s1.id);
      const s2 = db.startObservationSession('S2');
      expect(s2.status).toBe('active');
    });
  });

  // ── Observed Actions Edge Cases ──────────────────────────────────────────

  describe('Observed Actions', () => {
    it('should log action with minimal fields', () => {
      const session = db.startObservationSession('Test');
      const action = db.logObservedAction(session.id, { source: 'manual' });
      expect(action.source).toBe('manual');
      expect(action.app_name).toBeNull();
      expect(action.window_title).toBeNull();
    });

    it('should log action with all fields', () => {
      const session = db.startObservationSession('Test');
      const action = db.logObservedAction(session.id, {
        source: 'shell',
        app_name: 'Terminal',
        window_title: 'bash',
        command: 'ls -la',
        file_path: '/tmp',
        metadata: { key: 'value' },
        started_at: '2024-01-01T00:00:00',
        ended_at: '2024-01-01T00:01:00',
        duration_seconds: 60,
      });
      expect(action.command).toBe('ls -la');
      expect(action.duration_seconds).toBe(60);
    });

    it('should filter actions by source', () => {
      const session = db.startObservationSession('Test');
      db.logObservedAction(session.id, { source: 'shell', command: 'ls' });
      db.logObservedAction(session.id, { source: 'window', app_name: 'Chrome' });
      db.logObservedAction(session.id, { source: 'shell', command: 'cd' });

      const shellActions = db.getObservedActions(session.id, { source: 'shell' });
      expect(shellActions).toHaveLength(2);
    });

    it('should respect limit and offset', () => {
      const session = db.startObservationSession('Test');
      for (let i = 0; i < 10; i++) {
        db.logObservedAction(session.id, { source: 'manual', window_title: `Action ${i}` });
      }
      const limited = db.getObservedActions(session.id, { limit: 3 });
      expect(limited).toHaveLength(3);

      const offset = db.getObservedActions(session.id, { limit: 3, offset: 5 });
      expect(offset).toHaveLength(3);
    });

    it('should get action timeline with time filters', () => {
      const session = db.startObservationSession('Test');
      db.logObservedAction(session.id, { source: 'manual', started_at: '2024-01-01T10:00:00', ended_at: '2024-01-01T10:05:00' });
      db.logObservedAction(session.id, { source: 'manual', started_at: '2024-01-01T12:00:00', ended_at: '2024-01-01T12:05:00' });

      const filtered = db.getActionTimeline(session.id, '2024-01-01T11:00:00');
      expect(filtered).toHaveLength(1);
    });

    it('should get action summary grouped by source', () => {
      const session = db.startObservationSession('Test');
      db.logObservedAction(session.id, { source: 'shell', duration_seconds: 10 });
      db.logObservedAction(session.id, { source: 'shell', duration_seconds: 20 });
      db.logObservedAction(session.id, { source: 'window', duration_seconds: 30 });

      const summary = db.getActionSummary(session.id);
      expect(summary).toHaveLength(2);
      const shellSummary = summary.find(s => s.source === 'shell');
      expect(shellSummary!.count).toBe(2);
      expect(shellSummary!.total_seconds).toBe(30);
    });
  });

  // ── Consent Edge Cases ───────────────────────────────────────────────────

  describe('Consent', () => {
    it('should return false for hasConsent when no consent logged', () => {
      expect(db.hasConsent('window')).toBe(false);
    });

    it('should return true after granting consent', () => {
      db.logConsent('granted', 'window');
      expect(db.hasConsent('window')).toBe(true);
    });

    it('should return false after revoking consent', () => {
      db.logConsent('granted', 'window');
      db.logConsent('revoked', 'window');
      expect(db.hasConsent('window')).toBe(false);
    });

    it('should track consent log history', () => {
      db.logConsent('granted', 'window');
      db.logConsent('revoked', 'window');
      const log = db.getConsentLog();
      expect(log).toHaveLength(2);
    });
  });

  // ── Exclusion Rules Edge Cases ───────────────────────────────────────────

  describe('Exclusion Rules', () => {
    it('should add and list rules', () => {
      db.addExclusionRule('app', '1Password');
      db.addExclusionRule('title_pattern', '*banking*');
      expect(db.listExclusionRules()).toHaveLength(2);
    });

    it('should filter rules by type', () => {
      db.addExclusionRule('app', '1Password');
      db.addExclusionRule('title_pattern', '*banking*');
      expect(db.listExclusionRules('app')).toHaveLength(1);
    });

    it('should remove rule', () => {
      const rule = db.addExclusionRule('app', '1Password');
      db.removeExclusionRule(rule.id);
      expect(db.listExclusionRules()).toHaveLength(0);
    });
  });

  // ── Data Degradation Edge Cases ──────────────────────────────────────────

  describe('Data Degradation', () => {
    it('should return 0 when no old actions to purge', () => {
      expect(db.purgeOldActions(90)).toBe(0);
    });

    it('should return 0 when no old actions to degrade', () => {
      expect(db.degradeOldActions(7)).toBe(0);
    });
  });

  // ── GlobalStats Edge Cases ───────────────────────────────────────────────

  describe('GlobalStats', () => {
    it('should return all zeros for empty database', () => {
      const stats = db.getGlobalStats();
      expect(stats.total_tasks).toBe(0);
      expect(stats.active_tasks).toBe(0);
      expect(stats.completed_tasks).toBe(0);
      expect(stats.total_sops).toBe(0);
      expect(stats.total_executions).toBe(0);
      expect(stats.total_tags).toBe(0);
      expect(stats.total_exports).toBe(0);
      expect(stats.avg_quality_score).toBe(0);
    });

    it('should count correctly after multiple operations', () => {
      const t1 = db.createTask('T1');
      db.completeTask(t1.id);
      const t2 = db.createTask('T2');
      const sop = db.createSOP(t1.id, { title: 'SOP', content_md: '#', tags: ['test'] });
      db.logExecution(sop.id, { duration_seconds: 100 });

      const stats = db.getGlobalStats();
      expect(stats.total_tasks).toBe(2);
      expect(stats.active_tasks).toBe(1);
      expect(stats.completed_tasks).toBe(1);
      expect(stats.total_sops).toBe(1);
      expect(stats.total_executions).toBe(1);
      expect(stats.total_tags).toBe(1);
    });
  });

  // ── Migration Edge Cases ─────────────────────────────────────────────────

  describe('Migration', () => {
    it('should be idempotent (calling initialize twice)', () => {
      db.initialize();
      // Should not throw
      const stats = db.getGlobalStats();
      expect(stats.total_tasks).toBe(0);
    });
  });
});
