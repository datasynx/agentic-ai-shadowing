import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { TaskManager, formatDuration } from '../src/task-manager.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-tm-test-${Date.now()}.db`);
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

describe('TaskManager — startTask', () => {
  it('starts a new task', () => {
    const task = tm.startTask('Test Task', 'Description');
    expect(task.title).toBe('Test Task');
    expect(task.status).toBe('active');
  });

  it('throws when starting a second task while one is active', () => {
    tm.startTask('First Task');
    expect(() => tm.startTask('Second Task')).toThrow(/Es läuft bereits ein Task/);
  });

  it('allows starting after previous task is completed', () => {
    tm.startTask('First');
    tm.completeTask();
    const second = tm.startTask('Second');
    expect(second.title).toBe('Second');
    expect(second.status).toBe('active');
  });

  it('allows starting after previous task is cancelled', () => {
    tm.startTask('First');
    tm.cancelTask();
    const second = tm.startTask('Second');
    expect(second.status).toBe('active');
  });
});

describe('TaskManager — pauseTask / resumeTask', () => {
  it('pauses the active task', () => {
    tm.startTask('Pausable');
    const paused = tm.pauseTask();
    expect(paused.status).toBe('paused');
  });

  it('throws when pausing with no active task', () => {
    expect(() => tm.pauseTask()).toThrow(/Kein aktiver Task zum Pausieren/);
  });

  it('resumes the most recent paused task', () => {
    tm.startTask('Resumable');
    tm.pauseTask();
    const resumed = tm.resumeTask();
    expect(resumed.status).toBe('active');
  });

  it('resumes a specific paused task by ID', () => {
    const task = tm.startTask('Specific');
    tm.pauseTask();
    const resumed = tm.resumeTask(task.id);
    expect(resumed.status).toBe('active');
    expect(resumed.id).toBe(task.id);
  });

  it('throws when resuming a non-paused task by ID', () => {
    const task = tm.startTask('Active');
    expect(() => tm.resumeTask(task.id)).toThrow(/ist nicht pausiert/);
  });

  it('throws when resuming with no paused tasks', () => {
    expect(() => tm.resumeTask()).toThrow(/Kein pausierter Task zum Fortsetzen/);
  });

  it('throws when resuming unknown task ID', () => {
    expect(() => tm.resumeTask('nonexistent')).toThrow(/nicht gefunden/);
  });
});

describe('TaskManager — completeTask', () => {
  it('completes the active task and returns duration string', () => {
    tm.startTask('Complete Me');
    const { task, duration } = tm.completeTask();
    expect(task.status).toBe('completed');
    expect(task.completed_at).not.toBeNull();
    expect(typeof duration).toBe('string');
  });

  it('throws when completing with no active task', () => {
    expect(() => tm.completeTask()).toThrow(/Kein aktiver Task zum Abschließen/);
  });

  it('accepts optional complexity rating', () => {
    tm.startTask('Rated Task');
    // Create a SOP linked to this task to test execution logging
    const active = tm.getActiveTask()!;
    db.createSOP(active.id, { title: 'Test SOP', content_md: '# Test' });
    const { task } = tm.completeTask(4);
    expect(task.status).toBe('completed');
  });
});

describe('TaskManager — cancelTask', () => {
  it('cancels the active task', () => {
    tm.startTask('Cancel Me');
    const cancelled = tm.cancelTask();
    expect(cancelled.status).toBe('cancelled');
  });

  it('throws when cancelling with no active task', () => {
    expect(() => tm.cancelTask()).toThrow(/Kein aktiver Task zum Abbrechen/);
  });
});

describe('TaskManager — addNote', () => {
  it('adds a note to the active task description', () => {
    tm.startTask('Noted');
    const updated = tm.addNote('First note');
    expect(updated.description).toBe('- First note');
  });

  it('appends notes to existing description', () => {
    tm.startTask('Noted', 'Initial description');
    const updated = tm.addNote('Additional note');
    expect(updated.description).toBe('Initial description\n- Additional note');
  });

  it('adds multiple notes sequentially', () => {
    tm.startTask('Multi Notes');
    tm.addNote('Step 1');
    const updated = tm.addNote('Step 2');
    expect(updated.description).toContain('- Step 1');
    expect(updated.description).toContain('- Step 2');
  });

  it('throws when adding note with no active task', () => {
    expect(() => tm.addNote('Orphan note')).toThrow(/Kein aktiver Task für Notizen/);
  });
});

describe('TaskManager — getActiveTask', () => {
  it('returns null when no task is active', () => {
    expect(tm.getActiveTask()).toBeNull();
  });

  it('returns the active task', () => {
    tm.startTask('Active');
    const active = tm.getActiveTask();
    expect(active).not.toBeNull();
    expect(active!.title).toBe('Active');
  });

  it('returns null after task is paused', () => {
    tm.startTask('Paused');
    tm.pauseTask();
    expect(tm.getActiveTask()).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2min 5s');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDuration(5025)).toBe('1h 23min 45s');
  });

  it('formats hours only', () => {
    expect(formatDuration(7200)).toBe('2h');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('includes seconds when hours present', () => {
    expect(formatDuration(3661)).toBe('1h 1min 1s');
  });

  it('formats exactly one minute', () => {
    expect(formatDuration(60)).toBe('1min');
  });
});
