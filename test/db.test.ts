import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-test-${Date.now()}.db`);

let db: ShadowingDB;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('ShadowingDB — Tasks', () => {
  it('creates a task', () => {
    const task = db.createTask('Test Task', 'Description');
    expect(task.title).toBe('Test Task');
    expect(task.description).toBe('Description');
    expect(task.status).toBe('active');
    expect(task.id).toHaveLength(16);
  });

  it('gets active task', () => {
    db.createTask('Active Task');
    const active = db.getActiveTask();
    expect(active).not.toBeNull();
    expect(active!.title).toBe('Active Task');
  });

  it('completes a task with duration', () => {
    const task = db.createTask('To Complete');
    const completed = db.completeTask(task.id);
    expect(completed.status).toBe('completed');
    expect(completed.completed_at).not.toBeNull();
    expect(completed.duration_seconds).not.toBeNull();
  });

  it('lists tasks with filter', () => {
    db.createTask('Active');
    const t2 = db.createTask('Paused');
    db.pauseTask(t2.id);

    const active = db.listTasks({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe('Active');

    const paused = db.listTasks({ status: 'paused' });
    expect(paused).toHaveLength(1);
    expect(paused[0]!.title).toBe('Paused');
  });

  it('task lifecycle: active → paused → active → completed', () => {
    const task = db.createTask('Lifecycle');
    expect(task.status).toBe('active');

    const paused = db.pauseTask(task.id);
    expect(paused.status).toBe('paused');

    const resumed = db.resumeTask(task.id);
    expect(resumed.status).toBe('active');

    const completed = db.completeTask(task.id);
    expect(completed.status).toBe('completed');
  });
});

describe('ShadowingDB — SOPs', () => {
  it('creates a SOP with tags', () => {
    const task = db.createTask('SOP Task');
    const sop = db.createSOP(task.id, {
      title: 'Test SOP',
      content_md: '# Test\n## Ziel\nTest SOP',
      tags: ['testing', 'demo'],
    });

    expect(sop.title).toBe('Test SOP');
    expect(sop.version).toBe(1);
    expect(sop.status).toBe('draft');
    expect(sop.ai_generated).toBe(true);

    const tags = db.getTagsForSOP(sop.id);
    expect(tags).toHaveLength(2);
    expect(tags.map(t => t.name).sort()).toEqual(['demo', 'testing']);
  });

  it('increments version on content update', () => {
    const task = db.createTask('Version Task');
    const sop = db.createSOP(task.id, { title: 'V1', content_md: 'Initial' });
    expect(sop.version).toBe(1);

    const updated = db.updateSOP(sop.id, { content_md: 'Updated content' });
    expect(updated.version).toBe(2);
  });

  it('updates SOP status', () => {
    const task = db.createTask('Status Task');
    const sop = db.createSOP(task.id, { title: 'S', content_md: 'Content' });

    const reviewed = db.updateSOPStatus(sop.id, 'reviewed');
    expect(reviewed.status).toBe('reviewed');
    expect(reviewed.reviewed_at).not.toBeNull();

    const approved = db.updateSOPStatus(sop.id, 'approved');
    expect(approved.status).toBe('approved');
  });

  it('lists SOPs with search filter', () => {
    const task = db.createTask('Search Task');
    db.createSOP(task.id, { title: 'Billing SOP', content_md: 'Rechnungen erstellen' });
    db.createSOP(task.id, { title: 'Deploy SOP', content_md: 'Server deployment' });

    const results = db.listSOPs({ search: 'Rechnung' });
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Billing SOP');
  });

  it('deletes SOP (cascades tags)', () => {
    const task = db.createTask('Delete Task');
    const sop = db.createSOP(task.id, { title: 'To Delete', content_md: 'X', tags: ['temp'] });
    db.deleteSOP(sop.id);

    expect(db.getSOP(sop.id)).toBeNull();
    const tags = db.getTagsForSOP(sop.id);
    expect(tags).toHaveLength(0);
  });
});

describe('ShadowingDB — Tags', () => {
  it('creates and reuses tags (case-insensitive)', () => {
    const t1 = db.getOrCreateTag('Testing');
    const t2 = db.getOrCreateTag('testing');
    expect(t1.id).toBe(t2.id);
  });

  it('adds and removes tags from SOP', () => {
    const task = db.createTask('Tag Task');
    const sop = db.createSOP(task.id, { title: 'T', content_md: 'C' });

    db.addTagToSOP(sop.id, 'alpha');
    db.addTagToSOP(sop.id, 'beta');

    let tags = db.getTagsForSOP(sop.id);
    expect(tags).toHaveLength(2);

    const alphaTag = tags.find(t => t.name === 'alpha')!;
    db.removeTagFromSOP(sop.id, alphaTag.id);

    tags = db.getTagsForSOP(sop.id);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.name).toBe('beta');
  });
});

describe('ShadowingDB — Executions', () => {
  it('logs and retrieves executions', () => {
    const task = db.createTask('Exec Task');
    const sop = db.createSOP(task.id, { title: 'E', content_md: 'C' });

    db.logExecution(sop.id, { duration_seconds: 120, complexity_rating: 3 });
    db.logExecution(sop.id, { duration_seconds: 150, complexity_rating: 4, notes: 'Langsam' });

    const executions = db.getExecutions(sop.id);
    expect(executions).toHaveLength(2);
    const durations = executions.map(e => e.duration_seconds).sort((a, b) => a - b);
    expect(durations).toEqual([120, 150]);
  });
});

describe('ShadowingDB — Versions', () => {
  it('creates version snapshot on content update', () => {
    const task = db.createTask('Version Task');
    const sop = db.createSOP(task.id, { title: 'V1', content_md: 'Original content' });

    db.updateSOP(sop.id, { content_md: 'Updated content' });
    db.updateSOP(sop.id, { content_md: 'Third version' });

    const versions = db.getSOPVersions(sop.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.version).toBe(2); // DESC order
    expect(versions[1]!.version).toBe(1);
    expect(versions[1]!.content_md).toBe('Original content');
  });

  it('retrieves specific version', () => {
    const task = db.createTask('Specific Version');
    const sop = db.createSOP(task.id, { title: 'SV', content_md: 'v1 content' });
    db.updateSOP(sop.id, { content_md: 'v2 content' });

    const v1 = db.getSOPVersion(sop.id, 1);
    expect(v1).not.toBeNull();
    expect(v1!.content_md).toBe('v1 content');
  });

  it('stores change summary', () => {
    const task = db.createTask('Summary Task');
    const sop = db.createSOP(task.id, { title: 'S', content_md: 'old' });
    db.updateSOP(sop.id, { content_md: 'new' }, 'Improved clarity');

    const versions = db.getSOPVersions(sop.id);
    expect(versions[0]!.change_summary).toBe('Improved clarity');
  });

  it('does not create version on title-only update', () => {
    const task = db.createTask('Title Task');
    const sop = db.createSOP(task.id, { title: 'Old Title', content_md: 'Content' });
    db.updateSOP(sop.id, { title: 'New Title' });

    const versions = db.getSOPVersions(sop.id);
    expect(versions).toHaveLength(0);
  });

  it('cascades version delete with SOP', () => {
    const task = db.createTask('Delete Version');
    const sop = db.createSOP(task.id, { title: 'DV', content_md: 'v1' });
    db.updateSOP(sop.id, { content_md: 'v2' });

    db.deleteSOP(sop.id);
    const versions = db.getSOPVersions(sop.id);
    expect(versions).toHaveLength(0);
  });
});

describe('ShadowingDB — Stats', () => {
  it('returns global statistics', () => {
    const task = db.createTask('Stats Task');
    db.completeTask(task.id);
    db.createSOP(task.id, { title: 'S', content_md: 'C', tags: ['tag1'] });

    const stats = db.getGlobalStats();
    expect(stats.total_tasks).toBe(1);
    expect(stats.completed_tasks).toBe(1);
    expect(stats.total_sops).toBe(1);
    expect(stats.draft_sops).toBe(1);
    expect(stats.total_tags).toBe(1);
  });
});
