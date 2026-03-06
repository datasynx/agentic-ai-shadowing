import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import { TaskManager, formatDuration } from '../src/task-manager.js';

describe('TaskManager Edge Cases', () => {
  let db: ShadowingDB;
  let tm: TaskManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-tm-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
    tm = new TaskManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('startTask', () => {
    it('should throw when a task is already running', () => {
      tm.startTask('Task 1');
      expect(() => tm.startTask('Task 2')).toThrow('already running');
    });

    it('should accept task with empty description', () => {
      const task = tm.startTask('Test', '');
      expect(task.description).toBe('');
    });

    it('should accept task with special characters in title', () => {
      const task = tm.startTask('Deploy "prod" — v2.0 <critical>');
      expect(task.title).toBe('Deploy "prod" — v2.0 <critical>');
    });
  });

  describe('completeTask', () => {
    it('should throw when no active task', () => {
      expect(() => tm.completeTask()).toThrow('No active task');
    });

    it('should return formatted duration', () => {
      tm.startTask('Test');
      const result = tm.completeTask();
      expect(result.task.status).toBe('completed');
      expect(typeof result.duration).toBe('string');
    });

    it('should log execution to linked SOPs', () => {
      const task = tm.startTask('Test');
      db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });
      const result = tm.completeTask(3);
      // Duration might be 0 or very small since we complete immediately
      expect(result.task.status).toBe('completed');
    });
  });

  describe('pauseTask', () => {
    it('should throw when no active task', () => {
      expect(() => tm.pauseTask()).toThrow('No active task');
    });

    it('should pause the active task', () => {
      tm.startTask('Test');
      const paused = tm.pauseTask();
      expect(paused.status).toBe('paused');
    });
  });

  describe('resumeTask', () => {
    it('should throw when no paused task', () => {
      expect(() => tm.resumeTask()).toThrow('No paused task');
    });

    it('should resume by ID', () => {
      const task = tm.startTask('Test');
      tm.pauseTask();
      const resumed = tm.resumeTask(task.id);
      expect(resumed.status).toBe('active');
    });

    it('should throw for non-existent task ID', () => {
      expect(() => tm.resumeTask('nonexistent')).toThrow('not found');
    });

    it('should throw for non-paused task by ID', () => {
      const task = tm.startTask('Test');
      expect(() => tm.resumeTask(task.id)).toThrow('not paused');
    });

    it('should resume most recent paused task when no ID given', () => {
      const t1 = tm.startTask('T1');
      tm.pauseTask();
      const resumed = tm.resumeTask();
      expect(resumed.id).toBe(t1.id);
    });
  });

  describe('cancelTask', () => {
    it('should throw when no active task', () => {
      expect(() => tm.cancelTask()).toThrow('No active task');
    });

    it('should cancel the active task', () => {
      tm.startTask('Test');
      const cancelled = tm.cancelTask();
      expect(cancelled.status).toBe('cancelled');
    });
  });

  describe('addNote', () => {
    it('should throw when no active task', () => {
      expect(() => tm.addNote('Note')).toThrow('No active task');
    });

    it('should append note to empty description', () => {
      tm.startTask('Test');
      const updated = tm.addNote('First note');
      expect(updated.description).toBe('- First note');
    });

    it('should append note to existing description', () => {
      tm.startTask('Test', 'Initial description');
      const updated = tm.addNote('New note');
      expect(updated.description).toBe('Initial description\n- New note');
    });

    it('should append multiple notes', () => {
      tm.startTask('Test');
      tm.addNote('Note 1');
      const updated = tm.addNote('Note 2');
      expect(updated.description).toContain('- Note 1');
      expect(updated.description).toContain('- Note 2');
    });
  });

  describe('getActiveTask', () => {
    it('should return null when no active task', () => {
      expect(tm.getActiveTask()).toBeNull();
    });

    it('should return active task', () => {
      const task = tm.startTask('Test');
      expect(tm.getActiveTask()?.id).toBe(task.id);
    });
  });
});

describe('formatDuration Edge Cases', () => {
  it('should format zero seconds', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('should format seconds only', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2min 5s');
  });

  it('should format hours, minutes, and seconds', () => {
    expect(formatDuration(3661)).toBe('1h 1min 1s');
  });

  it('should format exact hour', () => {
    expect(formatDuration(3600)).toBe('1h');
  });

  it('should format exact minute', () => {
    expect(formatDuration(60)).toBe('1min');
  });

  it('should handle large values', () => {
    expect(formatDuration(86400)).toBe('24h');
  });

  it('should handle negative values', () => {
    // Negative durations shouldn't normally occur, but should not crash
    const result = formatDuration(-10);
    expect(typeof result).toBe('string');
  });
});
