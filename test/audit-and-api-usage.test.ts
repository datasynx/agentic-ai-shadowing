import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-audit-test-${Date.now()}.db`);

let db: ShadowingDB;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('Audit Log', () => {
  it('logs an audit entry', () => {
    db.logAudit({
      entity_type: 'sop',
      entity_id: 'test-id',
      action: 'create',
      source: 'cli',
    });

    const logs = db.getAuditLog('sop', 'test-id');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('create');
    expect(logs[0]!.source).toBe('cli');
    expect(logs[0]!.entity_type).toBe('sop');
  });

  it('logs audit with old and new values', () => {
    db.logAudit({
      entity_type: 'sop',
      entity_id: 'sop1',
      action: 'status_change',
      old_value: 'draft',
      new_value: 'reviewed',
      source: 'api',
    });

    const logs = db.getAuditLog('sop', 'sop1');
    expect(logs[0]!.old_value).toBe('draft');
    expect(logs[0]!.new_value).toBe('reviewed');
  });

  it('filters audit log by entity type', () => {
    db.logAudit({ entity_type: 'sop', entity_id: 'a', action: 'create' });
    db.logAudit({ entity_type: 'task', entity_id: 'b', action: 'create' });

    const sopLogs = db.getAuditLog('sop');
    expect(sopLogs).toHaveLength(1);
    expect(sopLogs[0]!.entity_type).toBe('sop');
  });

  it('returns empty array when no audit entries exist', () => {
    const logs = db.getAuditLog('sop', 'nonexistent');
    expect(logs).toHaveLength(0);
  });

  it('returns all audit entries when no filter provided', () => {
    db.logAudit({ entity_type: 'sop', entity_id: 'a', action: 'create' });
    db.logAudit({ entity_type: 'task', entity_id: 'b', action: 'start' });
    db.logAudit({ entity_type: 'sop', entity_id: 'c', action: 'delete' });

    const allLogs = db.getAuditLog();
    expect(allLogs).toHaveLength(3);
  });

  it('defaults source to cli', () => {
    db.logAudit({ entity_type: 'sop', entity_id: 'x', action: 'create' });
    const logs = db.getAuditLog('sop', 'x');
    expect(logs[0]!.source).toBe('cli');
  });
});

describe('API Usage', () => {
  it('logs API usage', () => {
    db.logApiUsage({
      model: 'claude-sonnet-4-20250514',
      input_tokens: 1000,
      output_tokens: 500,
      duration_ms: 2500,
    });

    const summary = db.getApiUsageSummary();
    expect(summary.total_calls).toBe(1);
    expect(summary.total_input_tokens).toBe(1000);
    expect(summary.total_output_tokens).toBe(500);
  });

  it('logs API usage with sop_id', () => {
    const task = db.createTask('Test');
    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });

    db.logApiUsage({
      sop_id: sop.id,
      model: 'claude-sonnet-4-20250514',
      input_tokens: 200,
      output_tokens: 100,
    });

    const summary = db.getApiUsageSummary();
    expect(summary.total_calls).toBe(1);
  });

  it('aggregates multiple API usage entries', () => {
    db.logApiUsage({ model: 'test', input_tokens: 100, output_tokens: 50, duration_ms: 1000 });
    db.logApiUsage({ model: 'test', input_tokens: 200, output_tokens: 100, duration_ms: 2000 });
    db.logApiUsage({ model: 'test', input_tokens: 300, output_tokens: 150, duration_ms: 3000 });

    const summary = db.getApiUsageSummary();
    expect(summary.total_calls).toBe(3);
    expect(summary.total_input_tokens).toBe(600);
    expect(summary.total_output_tokens).toBe(300);
    expect(summary.avg_input_tokens).toBe(200);
    expect(summary.avg_duration_ms).toBe(2000);
  });

  it('returns zeros when no API usage exists', () => {
    const summary = db.getApiUsageSummary();
    expect(summary.total_calls).toBe(0);
    expect(summary.total_input_tokens).toBe(0);
    expect(summary.total_output_tokens).toBe(0);
  });
});
