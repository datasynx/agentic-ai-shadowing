import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { TaskManager } from '../src/task-manager.js';
import { Anonymizer, createCaptureRedactor } from '../src/anonymizer.js';
import { getDefaultConfig } from '../src/config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-redact-capture-${Date.now()}.db`);

let db: ShadowingDB;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

function defaultRedactor(): (text: string) => string {
  const redactor = createCaptureRedactor(getDefaultConfig());
  if (!redactor) throw new Error('redactor expected with default config');
  return redactor;
}

describe('redact-on-capture — observed actions', () => {
  it('redacts commands before they are persisted', () => {
    db.setCaptureRedactor(defaultRedactor());
    const session = db.startObservationSession('test');

    const action = db.logObservedAction(session.id, {
      source: 'shell',
      command: 'export ANTHROPIC_API_KEY=sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    });

    expect(action.command).not.toContain('sk-ant-api03');
    // Verify at the DB level, not just the returned object
    const stored = db.getObservedActions(session.id);
    expect(stored[0]!.command).not.toContain('sk-ant-api03');
    expect(stored[0]!.command).toContain('[anthropic-api-key]');
  });

  it('redacts window titles and file paths', () => {
    db.setCaptureRedactor(defaultRedactor());
    const session = db.startObservationSession('test');

    const action = db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'Mail',
      window_title: 'Re: invoice from jane.doe@example.org',
      file_path: '/home/jane/secrets/notes.txt',
    });

    expect(action.window_title).not.toContain('jane.doe@example.org');
    expect(action.file_path).not.toContain('/home/jane');
    expect(action.file_path).toContain('[user]');
  });

  it('persists raw data when no redactor is set (opt-out path)', () => {
    const session = db.startObservationSession('test');
    const action = db.logObservedAction(session.id, {
      source: 'shell',
      command: 'mail jane.doe@example.org',
    });
    expect(action.command).toContain('jane.doe@example.org');
  });

  it('heartbeat merging still works with a redactor installed', () => {
    db.setCaptureRedactor(defaultRedactor());
    const session = db.startObservationSession('test');

    const title = 'Editing report for jane.doe@example.org';
    db.logObservedAction(session.id, { source: 'window', app_name: 'Editor', window_title: title });
    // Same (raw) title again within pulsetime — must merge, not create a second row
    const merged = db.heartbeatAction(session.id, {
      source: 'window', app_name: 'Editor', window_title: title, pulsetime_seconds: 60,
    });

    expect(merged).not.toBeNull();
    expect(db.getObservedActions(session.id)).toHaveLength(1);
  });
});

describe('redact-on-capture — task notes', () => {
  it('redacts notes added via TaskManager', () => {
    const tm = new TaskManager(db, defaultRedactor() ?? undefined);
    tm.startTask('Deploy service');
    tm.addNote('used token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 for auth');

    const task = db.getActiveTask();
    expect(task!.description).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    expect(task!.description).toContain('[github-token]');
  });
});

describe('redact-on-capture — task title and description', () => {
  // Tasks are created via CLI, MCP (shadowing_start_task) and the hook
  // handler — all of them go through db.createTask, so the redaction must
  // live at the DB layer, not only in TaskManager.addNote.
  it('redacts secrets and PII in createTask', () => {
    db.setCaptureRedactor(defaultRedactor());

    const task = db.createTask(
      'Mail an chef@firma.example senden',
      'Token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 nutzen, Server 192.168.1.50',
    );

    expect(task.title).not.toContain('chef@firma.example');
    expect(task.title).toContain('[email@example.com]');
    expect(task.description).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    expect(task.description).toContain('[github-token]');
    expect(task.description).not.toContain('192.168.1.50');

    // Verify at the DB level, not just the returned object
    const stored = db.getTask(task.id);
    expect(stored!.description).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
  });

  it('redacts secrets in updateTask (MCP complete_task notes path)', () => {
    db.setCaptureRedactor(defaultRedactor());
    const task = db.createTask('Deploy service');

    const updated = db.updateTask(task.id, {
      description: 'auth via Bearer sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    });

    expect(updated.description).not.toContain('sk-ant-api03');
  });

  it('persists raw task data when no redactor is set (opt-out path)', () => {
    const task = db.createTask('Mail jane.doe@example.org', 'server 10.0.0.5');
    expect(task.title).toContain('jane.doe@example.org');
    expect(task.description).toContain('10.0.0.5');
  });
});

describe('redact-on-capture — SOP title, description and content', () => {
  // SOPs are created/edited via CLI ($EDITOR), MCP (shadowing_update_sop) and
  // the web dashboard PUT route — all go through db.createSOP/updateSOP, so the
  // redaction must live at the DB layer (PRODUCT_SPEC §6.4, issue #53).
  it('redacts secrets and PII in createSOP', () => {
    db.setCaptureRedactor(defaultRedactor());
    const task = db.createTask('Deploy service');

    const sop = db.createSOP(task.id, {
      title: 'Onboarding for chef@firma.example',
      description: 'Server 192.168.1.50',
      content_md: '# Steps\nUse token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    });

    expect(sop.title).not.toContain('chef@firma.example');
    expect(sop.title).toContain('[email@example.com]');
    expect(sop.description).not.toContain('192.168.1.50');
    expect(sop.content_md).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    expect(sop.content_md).toContain('[github-token]');

    // Verify at the DB level, not just the returned object
    const stored = db.getSOP(sop.id);
    expect(stored!.content_md).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
  });

  it('redacts secrets in updateSOP (editor / dashboard edit path)', () => {
    db.setCaptureRedactor(defaultRedactor());
    const task = db.createTask('Deploy service');
    const sop = db.createSOP(task.id, { title: 'Clean SOP', content_md: '# Steps' });

    const updated = db.updateSOP(sop.id, {
      content_md: '# Steps\nauth via Bearer sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    });

    expect(updated.content_md).not.toContain('sk-ant-api03');
    const stored = db.getSOP(sop.id);
    expect(stored!.content_md).not.toContain('sk-ant-api03');
  });

  it('persists raw SOP data when no redactor is set (opt-out path)', () => {
    const task = db.createTask('Deploy service');
    const sop = db.createSOP(task.id, {
      title: 'Mail jane.doe@example.org',
      content_md: 'server 10.0.0.5',
    });
    expect(sop.title).toContain('jane.doe@example.org');
    expect(sop.content_md).toContain('10.0.0.5');
  });
});

describe('shadowing scrub — retroactive redaction', () => {
  it('scrubs previously raw observed actions and is idempotent', () => {
    // Write RAW data first (pre-redact-on-capture database)
    const session = db.startObservationSession('legacy');
    db.logObservedAction(session.id, {
      source: 'shell',
      command: 'curl -H "Authorization: Bearer abc123DEF456ghi789JKL012" https://api.internal.corp/v1',
    });
    db.logObservedAction(session.id, { source: 'manual', window_title: 'clean entry' });

    const anonymizer = new Anonymizer(getDefaultConfig().anonymization);
    const redactor = (text: string): string => anonymizer.anonymize(text);

    const changed = db.scrubObservedActions(redactor);
    expect(changed).toBe(1); // only the dirty row

    const stored = db.getObservedActions(session.id);
    const commands = stored.map(a => a.command).filter(Boolean);
    expect(commands.join(' ')).not.toContain('abc123DEF456ghi789JKL012');

    // Second run changes nothing (idempotent)
    expect(db.scrubObservedActions(redactor)).toBe(0);
  });

  it('scrubs task titles and descriptions', () => {
    db.createTask('Fix mail for jane.doe@example.org', 'server 10.0.0.5 is affected');

    const anonymizer = new Anonymizer(getDefaultConfig().anonymization);
    const redactor = (text: string): string => anonymizer.anonymize(text);

    expect(db.scrubTasks(redactor)).toBe(1);
    const task = db.getActiveTask();
    expect(task!.title).not.toContain('jane.doe@example.org');
    expect(task!.description).not.toContain('10.0.0.5');

    expect(db.scrubTasks(redactor)).toBe(0);
  });

  it('scrubs SOP rows and historical version snapshots, idempotently', () => {
    // Write RAW data (no redactor) — a pre-redact-on-capture database. The
    // update creates a sop_versions snapshot holding the raw v1 content.
    const task = db.createTask('Deploy service');
    const sop = db.createSOP(task.id, {
      title: 'SOP for jane.doe@example.org',
      content_md: '# v1\nuse token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    });
    db.updateSOP(sop.id, { content_md: '# v2\nserver 10.0.0.5 affected' });

    const anonymizer = new Anonymizer(getDefaultConfig().anonymization);
    const redactor = (text: string): string => anonymizer.anonymize(text);

    // 1 sops row (title + current content) + 1 sop_versions row (v1 snapshot)
    expect(db.scrubSOPs(redactor)).toBe(2);

    const stored = db.getSOP(sop.id);
    expect(stored!.title).not.toContain('jane.doe@example.org');
    expect(stored!.content_md).not.toContain('10.0.0.5');

    const versions = db.getSOPVersions(sop.id);
    expect(versions.map(v => v.content_md).join(' '))
      .not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');

    // Second run changes nothing (idempotent)
    expect(db.scrubSOPs(redactor)).toBe(0);
  });
});
