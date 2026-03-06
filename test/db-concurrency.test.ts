import { describe, it, expect, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-concurrency-${Date.now()}.db`);

// Keep track of all DB instances to close them
const instances: ShadowingDB[] = [];

function createDB(): ShadowingDB {
  const db = new ShadowingDB(DB_PATH);
  db.initialize();
  instances.push(db);
  return db;
}

afterEach(() => {
  for (const db of instances) {
    try { db.close(); } catch { /* ok */ }
  }
  instances.length = 0;
  try { if (existsSync(DB_PATH)) unlinkSync(DB_PATH); } catch { /* ok */ }
  try { if (existsSync(DB_PATH + '-wal')) unlinkSync(DB_PATH + '-wal'); } catch { /* ok */ }
  try { if (existsSync(DB_PATH + '-shm')) unlinkSync(DB_PATH + '-shm'); } catch { /* ok */ }
});

describe('DB Concurrency — WAL Mode', () => {
  it('two instances can read simultaneously', () => {
    const db1 = createDB();
    const db2 = createDB();

    db1.createTask('Task 1');

    // Both should be able to read
    const tasks1 = db1.listTasks();
    const tasks2 = db2.listTasks();

    expect(tasks1).toHaveLength(1);
    expect(tasks2).toHaveLength(1);
  });

  it('read and write simultaneously', () => {
    const db1 = createDB();
    const db2 = createDB();

    const task1 = db1.createTask('Initial Task');
    db1.completeTask(task1.id);

    // db1 writes a new task, db2 reads concurrently
    const task2 = db1.createTask('Second Task');
    db1.pauseTask(task2.id);

    const tasks = db2.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it('two writes from different instances', () => {
    const db1 = createDB();
    const db2 = createDB();

    const task1 = db1.createTask('From DB1');
    db1.completeTask(task1.id);

    const task2 = db2.createTask('From DB2');
    db2.completeTask(task2.id);

    // Both should exist
    const allTasks = db1.listTasks();
    expect(allTasks).toHaveLength(2);
  });

  it('prevents duplicate active task across instances', () => {
    const db1 = createDB();
    const db2 = createDB();

    db1.createTask('Active from DB1');

    // Second instance tries to create active task — should fail due to unique constraint
    expect(() => db2.createTask('Active from DB2')).toThrow();
  });

  it('concurrent status updates on same SOP', () => {
    const db1 = createDB();
    const db2 = createDB();

    const task = db1.createTask('Task');
    const sop = db1.createSOP(task.id, { title: 'SOP', content_md: '# Test' });

    // Both try to update status
    db1.updateSOPStatus(sop.id, 'reviewed');
    const updated = db2.updateSOPStatus(sop.id, 'approved');

    expect(updated.status).toBe('approved');
  });

  it('tag operations from different instances', () => {
    const db1 = createDB();
    const db2 = createDB();

    const task = db1.createTask('Task');
    const sop = db1.createSOP(task.id, { title: 'SOP', content_md: '# Test' });

    db1.addTagToSOP(sop.id, 'tag-from-db1');
    db2.addTagToSOP(sop.id, 'tag-from-db2');

    const tags = db1.getTagsForSOP(sop.id);
    expect(tags).toHaveLength(2);
    expect(tags.map(t => t.name).sort()).toEqual(['tag-from-db1', 'tag-from-db2']);
  });

  it('parallel reads during write do not fail', async () => {
    const db1 = createDB();
    const db2 = createDB();

    db1.createTask('Base Task');
    db1.completeTask(db1.getActiveTask()!.id);

    // Simulate parallel operations
    const results = await Promise.all([
      Promise.resolve(db1.listTasks()),
      Promise.resolve(db2.listTasks()),
      Promise.resolve(db1.getGlobalStats()),
      Promise.resolve(db2.getGlobalStats()),
    ]);

    expect(results[0]).toHaveLength(1);
    expect(results[1]).toHaveLength(1);
    expect(results[2]!.total_tasks).toBe(1);
    expect(results[3]!.total_tasks).toBe(1);
  });

  it('audit log works across instances', () => {
    const db1 = createDB();
    const db2 = createDB();

    db1.logAudit({ entity_type: 'sop', entity_id: 'x', action: 'create', source: 'cli' });
    db2.logAudit({ entity_type: 'sop', entity_id: 'x', action: 'update', source: 'api' });

    const logs = db1.getAuditLog('sop', 'x');
    expect(logs).toHaveLength(2);
  });
});
