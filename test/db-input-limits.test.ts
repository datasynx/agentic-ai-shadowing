import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { ShadowingError } from '../src/errors.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

/**
 * DB-layer input limits (TASK-08): title ≤ 500 chars, description ≤ 10 000
 * chars, SOP content ≤ 500 000 bytes. Enforced centrally in ShadowingDB so
 * every entry path (CLI, REST API, MCP, hook handler) is covered — the REST
 * API's Zod schemas are only the first line of defense.
 */

const DB_PATH = join(tmpdir(), `shadowing-limits-test-${Date.now()}.db`);

let db: ShadowingDB;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

function expectValidationError(fn: () => unknown, code = 'validation_error'): void {
  try {
    fn();
    expect.unreachable('expected ShadowingError');
  } catch (err) {
    expect(err).toBeInstanceOf(ShadowingError);
    expect((err as ShadowingError).code).toBe(code);
  }
}

describe('task input limits', () => {
  it('rejects an empty title', () => {
    expectValidationError(() => db.createTask('   '));
  });

  it('accepts a title of exactly 500 characters', () => {
    const task = db.createTask('a'.repeat(500));
    expect(task.title).toHaveLength(500);
  });

  it('rejects a title of 501 characters', () => {
    expectValidationError(() => db.createTask('a'.repeat(501)));
  });

  it('accepts a description of exactly 10 000 characters', () => {
    const task = db.createTask('Task', 'd'.repeat(10_000));
    expect(task.description).toHaveLength(10_000);
  });

  it('rejects a description of 10 001 characters', () => {
    expectValidationError(() => db.createTask('Task', 'd'.repeat(10_001)));
  });

  it('rejects an over-long title on update', () => {
    const task = db.createTask('Task');
    expectValidationError(() => db.updateTask(task.id, { title: 'a'.repeat(501) }));
  });

  it('rejects an over-long description on update', () => {
    const task = db.createTask('Task');
    expectValidationError(() => db.updateTask(task.id, { description: 'd'.repeat(10_001) }));
  });
});

describe('SOP input limits', () => {
  function makeTask() {
    return db.createTask('SOP host task');
  }

  it('accepts content of exactly 500 000 bytes', () => {
    const sop = db.createSOP(makeTask().id, { title: 'SOP', content_md: 'x'.repeat(500_000) });
    expect(sop.content_md).toHaveLength(500_000);
  });

  it('rejects content over 500 000 bytes with sop_content_too_large', () => {
    expectValidationError(
      () => db.createSOP(makeTask().id, { title: 'SOP', content_md: 'x'.repeat(500_001) }),
      'sop_content_too_large',
    );
  });

  it('measures bytes, not characters (multi-byte UTF-8)', () => {
    // 250 001 × '€' (3 bytes each) = 750 003 bytes but only 250 001 chars
    expectValidationError(
      () => db.createSOP(makeTask().id, { title: 'SOP', content_md: '€'.repeat(250_001) }),
      'sop_content_too_large',
    );
  });

  it('rejects an empty SOP title', () => {
    expectValidationError(() => db.createSOP(makeTask().id, { title: '', content_md: '# ok' }));
  });

  it('rejects over-long content on update', () => {
    const sop = db.createSOP(makeTask().id, { title: 'SOP', content_md: '# v1' });
    expectValidationError(
      () => db.updateSOP(sop.id, { content_md: 'x'.repeat(500_001) }),
      'sop_content_too_large',
    );
  });

  it('rejects an over-long SOP description', () => {
    expectValidationError(() =>
      db.createSOP(makeTask().id, { title: 'SOP', description: 'd'.repeat(10_001), content_md: '# ok' }),
    );
  });
});
