import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { TaskManager } from '../src/task-manager.js';
import { ShadowingError } from '../src/errors.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-errors-${Date.now()}.db`);
let db: ShadowingDB;
let tm: TaskManager;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  tm = new TaskManager(db);
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('Error Codes — TaskManager', () => {
  it('throws task_already_active when starting second task', () => {
    tm.startTask('First');
    try {
      tm.startTask('Second');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('task_already_active');
    }
  });

  it('throws no_active_task when pausing with none active', () => {
    try {
      tm.pauseTask();
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('no_active_task');
    }
  });

  it('throws no_active_task when completing with none active', () => {
    try {
      tm.completeTask();
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('no_active_task');
    }
  });

  it('throws no_active_task when cancelling with none active', () => {
    try {
      tm.cancelTask();
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('no_active_task');
    }
  });

  it('throws no_paused_task when no paused tasks exist', () => {
    try {
      tm.resumeTask();
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('no_paused_task');
    }
  });

  it('throws task_not_found when resuming nonexistent ID', () => {
    try {
      tm.resumeTask('nonexistent1234');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('task_not_found');
    }
  });
});

describe('Error Codes — DB Layer', () => {
  it('throws task_not_found for nonexistent task update', () => {
    try {
      db.updateTask('nonexistent', { title: 'New' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('task_not_found');
    }
  });

  it('throws task_not_found for nonexistent completeTask', () => {
    try {
      db.completeTask('nonexistent');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('task_not_found');
    }
  });

  it('throws task_already_completed for completed task', () => {
    const task = db.createTask('Test');
    db.completeTask(task.id);
    try {
      db.completeTask(task.id);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('task_already_completed');
    }
  });

  it('throws task_not_active for pausing non-active task', () => {
    const task = db.createTask('Test');
    db.completeTask(task.id);
    try {
      db.pauseTask(task.id);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('task_not_active');
    }
  });

  it('throws task_not_paused for resuming non-paused task', () => {
    const task = db.createTask('Test');
    try {
      db.resumeTask(task.id);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('task_not_paused');
    }
  });

  it('throws sop_not_found for nonexistent SOP update', () => {
    try {
      db.updateSOP('nonexistent', { title: 'New' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('sop_not_found');
    }
  });

  it('throws sop_not_found for nonexistent SOP status update', () => {
    try {
      db.updateSOPStatus('nonexistent', 'reviewed');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('sop_not_found');
    }
  });

  it('throws session_not_found for nonexistent session complete', () => {
    try {
      db.completeObservationSession('nonexistent');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ShadowingError);
      expect((err as ShadowingError).code).toBe('session_not_found');
    }
  });
});
