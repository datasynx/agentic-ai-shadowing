import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Task, TaskStatus, SOP, SOPStatus, Tag, TaskExecution,
  ExportRecord, GlobalStats, SOPVersion,
  ObservedAction, ActionSource, ObservationSession,
  ConsentRecord, ExclusionRule,
} from './types.js';
import { ShadowingError } from './errors.js';
import { getLogger } from './logger.js';

const log = getLogger('db');

// Input limits enforced at the DB layer (TASK-08); the REST API uses the
// same values in its Zod schemas (src/ui-server.ts).
const MAX_TITLE_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_SOP_CONTENT_BYTES = 500_000;

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,
    duration_seconds INTEGER,
    paused_at       TEXT,
    paused_total_seconds INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sops (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    content_md      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'reviewed', 'approved', 'exported', 'archived')),
    ai_generated    INTEGER NOT NULL DEFAULT 1,
    reviewed_at     TEXT,
    exported_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    name            TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS sop_tags (
    sop_id          TEXT NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
    tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    ai_generated    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (sop_id, tag_id)
);

CREATE TABLE IF NOT EXISTS task_executions (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    sop_id          TEXT NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
    duration_seconds INTEGER NOT NULL,
    complexity_rating INTEGER CHECK (complexity_rating BETWEEN 1 AND 5),
    notes           TEXT,
    executed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exports (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    exported_at     TEXT NOT NULL DEFAULT (datetime('now')),
    sop_count       INTEGER NOT NULL,
    export_path     TEXT NOT NULL,
    anonymized      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS export_sops (
    export_id       TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
    sop_id          TEXT NOT NULL REFERENCES sops(id),
    PRIMARY KEY (export_id, sop_id)
);

CREATE TABLE IF NOT EXISTS sop_versions (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    sop_id          TEXT NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    title           TEXT NOT NULL,
    content_md      TEXT NOT NULL,
    changed_at      TEXT NOT NULL DEFAULT (datetime('now')),
    change_summary  TEXT
);

CREATE TABLE IF NOT EXISTS observation_sessions (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    title           TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'completed')),
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    total_actions   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS observed_actions (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    session_id      TEXT NOT NULL REFERENCES observation_sessions(id) ON DELETE CASCADE,
    source          TEXT NOT NULL CHECK (source IN ('window', 'shell', 'git', 'file', 'manual')),
    app_name        TEXT,
    window_title    TEXT,
    command         TEXT,
    file_path       TEXT,
    metadata        TEXT,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT NOT NULL DEFAULT (datetime('now')),
    duration_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consent_log (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    action          TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
    scope           TEXT NOT NULL,
    recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exclusion_rules (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    rule_type       TEXT NOT NULL CHECK (rule_type IN ('app', 'title_pattern', 'url_pattern', 'path_pattern')),
    pattern         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    action          TEXT NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    source          TEXT NOT NULL DEFAULT 'cli',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_usage (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    sop_id          TEXT,
    model           TEXT NOT NULL,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sops_task_id ON sops(task_id);
CREATE INDEX IF NOT EXISTS idx_sops_status ON sops(status);
CREATE INDEX IF NOT EXISTS idx_task_executions_sop_id ON task_executions(sop_id);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_sop_versions_sop_id ON sop_versions(sop_id);
CREATE INDEX IF NOT EXISTS idx_observed_actions_session ON observed_actions(session_id);
CREATE INDEX IF NOT EXISTS idx_observed_actions_source ON observed_actions(source);
CREATE INDEX IF NOT EXISTS idx_observation_sessions_status ON observation_sessions(status);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_sop ON api_usage(sop_id);

-- Enforce at most one active task at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_task
  ON tasks(status) WHERE status = 'active';

-- Enforce at most one active observation session at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_observation
  ON observation_sessions(status) WHERE status = 'active';
`;

// ── ShadowingDB ──────────────────────────────────────────────────────────────

/**
 * Audit provenance a mutating method writes in the SAME transaction as the
 * mutation it records (see #56). The method derives `old_value`/`new_value`
 * from the row state it already reads; the caller supplies only what it knows:
 * the triggering `action` and the `source` channel.
 */
export interface AuditContext {
  action: string;
  source: string;
}

export class ShadowingDB {
  private db: Database.Database;
  private captureRedactor: ((text: string) => string) | null = null;

  constructor(dbPath: string) {
    // better-sqlite3 will not create missing parent dirs — ensure the
    // config/data dir exists so first-run paths (notably `shadowing mcp`,
    // which has no prior `init`) don't crash with "directory does not exist".
    // Idempotent; harmless for ':memory:' (dirname === '.').
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  /**
   * Install a redact-on-capture function (see createCaptureRedactor in
   * anonymizer.ts). When set, window titles, commands, file paths and task
   * titles/descriptions are redacted BEFORE they are persisted, so
   * PII/secrets never reach disk.
   */
  setCaptureRedactor(redactor: ((text: string) => string) | null): void {
    this.captureRedactor = redactor;
  }

  private redactCapture(value: string | null): string | null;
  private redactCapture(value: string | undefined): string | undefined;
  private redactCapture(value: string | null | undefined): string | null | undefined {
    if (value === undefined || value === null || this.captureRedactor === null) return value;
    return this.captureRedactor(value);
  }

  initialize(): void {
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Apply incremental migrations for existing databases. */
  private migrate(): void {
    // Migration 1: Add pause tracking columns to tasks
    const cols = this.db.pragma('table_info(tasks)') as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('paused_at')) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN paused_at TEXT`); } catch { /* column may already exist */ }
    }
    if (!colNames.has('paused_total_seconds')) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN paused_total_seconds INTEGER NOT NULL DEFAULT 0`); } catch { /* column may already exist */ }
    }

    // Migration 2: Add audit_log table
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
          entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
          action TEXT NOT NULL, old_value TEXT, new_value TEXT,
          source TEXT NOT NULL DEFAULT 'cli',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
      `);
    } catch { /* already exists */ }

    // Migration 3: Add api_usage table
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS api_usage (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
          sop_id TEXT, model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_api_usage_sop ON api_usage(sop_id);
      `);
    } catch { /* already exists */ }
  }

  close(): void {
    this.db.close();
  }

  // ── Input limits (TASK-08) ───────────────────────────────────────────────
  // Central enforcement at the DB layer so every entry path (CLI, REST API,
  // MCP tools, hook handler) is covered, mirroring the redact-on-capture
  // design. The REST API additionally validates via Zod for better 4xx
  // messages; these guards are the backstop.

  private validateTitle(title: string): void {
    if (title.trim().length === 0) {
      throw new ShadowingError('title must not be empty', 'validation_error');
    }
    if (title.length > MAX_TITLE_CHARS) {
      throw new ShadowingError(
        `title exceeds ${MAX_TITLE_CHARS} characters`,
        'validation_error',
        { length: title.length, max: MAX_TITLE_CHARS },
      );
    }
  }

  private validateDescription(description: string | null | undefined): void {
    if (description != null && description.length > MAX_DESCRIPTION_CHARS) {
      throw new ShadowingError(
        `description exceeds ${MAX_DESCRIPTION_CHARS} characters`,
        'validation_error',
        { length: description.length, max: MAX_DESCRIPTION_CHARS },
      );
    }
  }

  private validateSOPContent(contentMd: string): void {
    const bytes = Buffer.byteLength(contentMd, 'utf-8');
    if (bytes > MAX_SOP_CONTENT_BYTES) {
      throw new ShadowingError(
        `content_md exceeds ${MAX_SOP_CONTENT_BYTES} bytes`,
        'sop_content_too_large',
        { bytes, max: MAX_SOP_CONTENT_BYTES },
      );
    }
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(title: string, description?: string): Task {
    this.validateTitle(title);
    this.validateDescription(description);
    const stmt = this.db.prepare(`
      INSERT INTO tasks (title, description)
      VALUES (?, ?)
      RETURNING *
    `);
    return this.mapTask(stmt.get(
      this.redactCapture(title),
      this.redactCapture(description) ?? null,
    ) as RawTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RawTask | undefined;
    return row ? this.mapTask(row) : null;
  }

  getActiveTask(): Task | null {
    const row = this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).get() as RawTask | undefined;
    return row ? this.mapTask(row) : null;
  }

  listTasks(filter?: { status?: TaskStatus }): Task[] {
    let sql = 'SELECT * FROM tasks';
    const params: string[] = [];
    if (filter?.status) {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(sql).all(...params) as RawTask[];
    return rows.map(r => this.mapTask(r));
  }

  updateTask(id: string, updates: Partial<Pick<Task, 'title' | 'description' | 'status'>>): Task {
    if (updates.title !== undefined) this.validateTitle(updates.title);
    if (updates.description !== undefined) this.validateDescription(updates.description);
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(this.redactCapture(updates.title)); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(this.redactCapture(updates.description)); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    fields.push("updated_at = datetime('now')");

    values.push(id);
    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ? RETURNING *`);
    const row = stmt.get(...values) as RawTask | undefined;
    if (!row) throw new ShadowingError(`Task ${id} not found`, 'task_not_found', { taskId: id });
    return this.mapTask(row);
  }

  completeTask(id: string, notes?: string): Task {
    // Atomic guard + write: the status read and the UPDATE run in one
    // immediate transaction so concurrent CLI/MCP/UI processes can't interleave
    // between them (#56).
    const run = this.db.transaction(() => {
      const current = this.getTask(id);
      if (!current) throw new ShadowingError(`Task ${id} not found`, 'task_not_found', { taskId: id });
      if (current.status === 'completed') throw new ShadowingError(`Task ${id} is already completed`, 'task_already_completed', { taskId: id });
      if (current.status === 'cancelled') throw new ShadowingError(`Task ${id} is cancelled`, 'task_cancelled', { taskId: id });

      // Optional completion notes are appended to the description in the SAME
      // write (no second updateTask round-trip); redacted on capture like all
      // free text.
      let description = current.description;
      if (notes) {
        const safe = this.redactCapture(notes);
        description = description ? `${description}\n${safe}` : safe;
      }

      // Duration = wall-clock time - total paused time (including current pause
      // if paused), clamped to 0 so sub-second rounding can't go negative (#56).
      const row = this.db.prepare(`
        UPDATE tasks
        SET status = 'completed',
            completed_at = datetime('now'),
            duration_seconds = MAX(0,
              ROUND((julianday('now') - julianday(started_at)) * 86400)
              - paused_total_seconds
              - CASE WHEN paused_at IS NOT NULL
                  THEN ROUND((julianday('now') - julianday(paused_at)) * 86400)
                  ELSE 0
                END),
            ${notes ? 'description = ?,' : ''}
            paused_at = NULL,
            updated_at = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(...(notes ? [description, id] : [id])) as RawTask | undefined;
      if (!row) throw new ShadowingError(`Task ${id} not found`, 'task_not_found', { taskId: id });
      return this.mapTask(row);
    });
    return run.immediate();
  }

  pauseTask(id: string): Task {
    const run = this.db.transaction(() => {
      const current = this.getTask(id);
      if (!current) throw new ShadowingError(`Task ${id} not found`, 'task_not_found', { taskId: id });
      if (current.status !== 'active') throw new ShadowingError(`Task ${id} is not active (status: ${current.status})`, 'task_not_active', { taskId: id, status: current.status });

      const row = this.db.prepare(`
        UPDATE tasks
        SET status = 'paused',
            paused_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(id) as RawTask | undefined;
      if (!row) throw new ShadowingError(`Task ${id} not found`, 'task_not_found', { taskId: id });
      return this.mapTask(row);
    });
    return run.immediate();
  }

  resumeTask(id: string): Task {
    const run = this.db.transaction(() => {
      const current = this.getTask(id);
      if (!current) throw new ShadowingError(`Task ${id} not found`, 'task_not_found', { taskId: id });
      if (current.status !== 'paused') throw new ShadowingError(`Task ${id} is not paused (status: ${current.status})`, 'task_not_paused', { taskId: id, status: current.status });

      // Add the pause gap to paused_total_seconds, then clear paused_at
      const row = this.db.prepare(`
        UPDATE tasks
        SET status = 'active',
            paused_total_seconds = paused_total_seconds +
              CASE WHEN paused_at IS NOT NULL
                THEN ROUND((julianday('now') - julianday(paused_at)) * 86400)
                ELSE 0
              END,
            paused_at = NULL,
            updated_at = datetime('now')
        WHERE id = ?
        RETURNING *
      `).get(id) as RawTask | undefined;
      if (!row) throw new ShadowingError(`Task ${id} not found`, 'task_not_found', { taskId: id });
      return this.mapTask(row);
    });
    return run.immediate();
  }

  cancelTask(id: string): Task {
    return this.updateTask(id, { status: 'cancelled' });
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  // ── SOPs ─────────────────────────────────────────────────────────────────

  createSOP(taskId: string, data: {
    title: string;
    description?: string;
    content_md: string;
    ai_generated?: boolean;
    tags?: string[];
  }): SOP {
    this.validateTitle(data.title);
    this.validateDescription(data.description);
    this.validateSOPContent(data.content_md);
    // Atomic: the SOP row and its tags commit together — a mid-loop failure
    // must not leave a SOP with a partial tag set (#56).
    const create = this.db.transaction(() => {
      const row = this.db.prepare(`
        INSERT INTO sops (task_id, title, description, content_md, ai_generated)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
      `).get(
        taskId,
        data.title,
        data.description ?? null,
        data.content_md,
        data.ai_generated !== false ? 1 : 0,
      ) as RawSOP;

      const sop = this.mapSOP(row);

      if (data.tags) {
        for (const tag of data.tags) {
          this.addTagToSOP(sop.id, tag, data.ai_generated !== false);
        }
      }

      return sop;
    });
    return create();
  }

  getSOP(id: string): SOP | null {
    const row = this.db.prepare('SELECT * FROM sops WHERE id = ?').get(id) as RawSOP | undefined;
    return row ? this.mapSOP(row) : null;
  }

  listSOPs(filter?: { status?: SOPStatus; tag?: string; search?: string }): SOP[] {
    let sql = 'SELECT DISTINCT s.* FROM sops s';
    const conditions: string[] = [];
    const params: string[] = [];

    if (filter?.tag) {
      sql += ' JOIN sop_tags st ON s.id = st.sop_id JOIN tags t ON st.tag_id = t.id';
      conditions.push('t.name = ?');
      params.push(filter.tag);
    }
    if (filter?.status) {
      conditions.push('s.status = ?');
      params.push(filter.status);
    }
    if (filter?.search) {
      conditions.push('(s.title LIKE ? OR s.description LIKE ? OR s.content_md LIKE ?)');
      const pattern = `%${filter.search}%`;
      params.push(pattern, pattern, pattern);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY s.created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as RawSOP[];
    return rows.map(r => this.mapSOP(r));
  }

  updateSOP(id: string, updates: Partial<Pick<SOP, 'title' | 'description' | 'content_md'>>, changeSummary?: string, audit?: AuditContext): SOP {
    if (updates.title !== undefined) this.validateTitle(updates.title);
    if (updates.description !== undefined) this.validateDescription(updates.description);
    if (updates.content_md !== undefined) this.validateSOPContent(updates.content_md);
    // Atomic: the version snapshot, the version-bump UPDATE, and the optional
    // audit row all commit together — a crash between them must not desync
    // version history or drop the audit trail (#56).
    const apply = this.db.transaction(() => {
      const current = this.getSOP(id);
      // Snapshot current version before updating content
      if (updates.content_md !== undefined && current) {
        this.db.prepare(`
          INSERT INTO sop_versions (sop_id, version, title, content_md, change_summary)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, current.version, current.title, current.content_md, changeSummary ?? null);
      }

      const fields: string[] = [];
      const values: unknown[] = [];

      if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
      if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
      if (updates.content_md !== undefined) {
        fields.push('content_md = ?');
        values.push(updates.content_md);
        fields.push('version = version + 1');
      }
      fields.push("updated_at = datetime('now')");

      values.push(id);
      const row = this.db.prepare(`UPDATE sops SET ${fields.join(', ')} WHERE id = ? RETURNING *`)
        .get(...values) as RawSOP | undefined;
      if (!row) throw new ShadowingError(`SOP ${id} not found`, 'sop_not_found', { sopId: id });
      const sop = this.mapSOP(row);

      if (audit && current) {
        this.insertAuditRow({
          entity_type: 'sop', entity_id: id, action: audit.action,
          old_value: JSON.stringify({ title: current.title, version: current.version }),
          new_value: JSON.stringify({ title: sop.title, version: sop.version }),
          source: audit.source,
        });
      }
      return sop;
    });
    return apply();
  }

  updateSOPStatus(id: string, status: SOPStatus, audit?: AuditContext): SOP {
    const extra = status === 'reviewed' ? ", reviewed_at = datetime('now')" :
                  status === 'exported' ? ", exported_at = datetime('now')" : '';
    // Atomic: the status UPDATE and the optional audit row commit together (#56).
    const apply = this.db.transaction(() => {
      const current = this.getSOP(id);
      const row = this.db.prepare(
        `UPDATE sops SET status = ?, updated_at = datetime('now')${extra} WHERE id = ? RETURNING *`
      ).get(status, id) as RawSOP | undefined;
      if (!row) throw new ShadowingError(`SOP ${id} not found`, 'sop_not_found', { sopId: id });

      if (audit && current) {
        this.insertAuditRow({
          entity_type: 'sop', entity_id: id, action: audit.action,
          old_value: current.status, new_value: status, source: audit.source,
        });
      }
      return this.mapSOP(row);
    });
    return apply();
  }

  deleteSOP(id: string): void {
    this.db.prepare('DELETE FROM sops WHERE id = ?').run(id);
  }

  // ── Tags ─────────────────────────────────────────────────────────────────

  getOrCreateTag(name: string): Tag {
    const existing = this.db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(name) as Tag | undefined;
    if (existing) return existing;

    // Use INSERT OR IGNORE to handle concurrent inserts safely
    this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    return this.db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(name) as Tag;
  }

  addTagToSOP(sopId: string, tagName: string, aiGenerated = true): void {
    const tag = this.getOrCreateTag(tagName);
    this.db.prepare(
      'INSERT OR IGNORE INTO sop_tags (sop_id, tag_id, ai_generated) VALUES (?, ?, ?)'
    ).run(sopId, tag.id, aiGenerated ? 1 : 0);
  }

  removeTagFromSOP(sopId: string, tagId: string): void {
    this.db.prepare('DELETE FROM sop_tags WHERE sop_id = ? AND tag_id = ?').run(sopId, tagId);
  }

  listTags(): Tag[] {
    return this.db.prepare('SELECT * FROM tags ORDER BY name').all() as Tag[];
  }

  getTagsForSOP(sopId: string): (Tag & { ai_generated: boolean })[] {
    const rows = this.db.prepare(`
      SELECT t.id, t.name, st.ai_generated
      FROM tags t
      JOIN sop_tags st ON t.id = st.tag_id
      WHERE st.sop_id = ?
      ORDER BY t.name
    `).all(sopId) as (Tag & { ai_generated: number })[];
    return rows.map(r => ({ ...r, ai_generated: r.ai_generated === 1 }));
  }

  // ── Executions ───────────────────────────────────────────────────────────

  logExecution(sopId: string, data: {
    duration_seconds: number;
    complexity_rating?: number;
    notes?: string;
  }): TaskExecution {
    const stmt = this.db.prepare(`
      INSERT INTO task_executions (sop_id, duration_seconds, complexity_rating, notes)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `);
    return stmt.get(
      sopId,
      data.duration_seconds,
      data.complexity_rating ?? null,
      data.notes ?? null,
    ) as TaskExecution;
  }

  getExecutions(sopId: string): TaskExecution[] {
    return this.db.prepare(
      'SELECT * FROM task_executions WHERE sop_id = ? ORDER BY executed_at DESC'
    ).all(sopId) as TaskExecution[];
  }

  // ── Exports ──────────────────────────────────────────────────────────────

  logExport(data: { sop_count: number; export_path: string; sop_ids: string[] }): ExportRecord {
    const txn = this.db.transaction(() => {
      const exportRow = this.db.prepare(`
        INSERT INTO exports (sop_count, export_path)
        VALUES (?, ?)
        RETURNING *
      `).get(data.sop_count, data.export_path) as ExportRecord;

      const insertLink = this.db.prepare(
        'INSERT INTO export_sops (export_id, sop_id) VALUES (?, ?)'
      );
      for (const sopId of data.sop_ids) {
        insertLink.run(exportRow.id, sopId);
      }

      return exportRow;
    });
    return txn();
  }

  getExports(): ExportRecord[] {
    return this.db.prepare('SELECT * FROM exports ORDER BY exported_at DESC').all() as ExportRecord[];
  }

  // ── Versions ──────────────────────────────────────────────────────────────

  getSOPVersions(sopId: string): SOPVersion[] {
    return this.db.prepare(
      'SELECT * FROM sop_versions WHERE sop_id = ? ORDER BY version DESC'
    ).all(sopId) as SOPVersion[];
  }

  getSOPVersion(sopId: string, version: number): SOPVersion | null {
    return (this.db.prepare(
      'SELECT * FROM sop_versions WHERE sop_id = ? AND version = ?'
    ).get(sopId, version) as SOPVersion | undefined) ?? null;
  }

  // ── Observation Sessions ─────────────────────────────────────────────────

  startObservationSession(title?: string): ObservationSession {
    const stmt = this.db.prepare(`
      INSERT INTO observation_sessions (title)
      VALUES (?)
      RETURNING *
    `);
    return stmt.get(title ?? null) as ObservationSession;
  }

  getObservationSession(id: string): ObservationSession | null {
    return (this.db.prepare(
      'SELECT * FROM observation_sessions WHERE id = ?'
    ).get(id) as ObservationSession | undefined) ?? null;
  }

  getActiveObservationSession(): ObservationSession | null {
    return (this.db.prepare(
      "SELECT * FROM observation_sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).get() as ObservationSession | undefined) ?? null;
  }

  listObservationSessions(filter?: { status?: string }): ObservationSession[] {
    let sql = 'SELECT * FROM observation_sessions';
    const params: string[] = [];
    if (filter?.status) {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY started_at DESC';
    return this.db.prepare(sql).all(...params) as ObservationSession[];
  }

  completeObservationSession(id: string): ObservationSession {
    const stmt = this.db.prepare(`
      UPDATE observation_sessions
      SET status = 'completed',
          ended_at = datetime('now'),
          total_actions = (SELECT COUNT(*) FROM observed_actions WHERE session_id = ?)
      WHERE id = ?
      RETURNING *
    `);
    const row = stmt.get(id, id) as ObservationSession | undefined;
    if (!row) throw new ShadowingError(`Session ${id} not found`, 'session_not_found', { sessionId: id });
    return row;
  }

  pauseObservationSession(id: string): ObservationSession {
    const stmt = this.db.prepare(`
      UPDATE observation_sessions SET status = 'paused' WHERE id = ? RETURNING *
    `);
    const row = stmt.get(id) as ObservationSession | undefined;
    if (!row) throw new ShadowingError(`Session ${id} not found`, 'session_not_found', { sessionId: id });
    return row;
  }

  resumeObservationSession(id: string): ObservationSession {
    const stmt = this.db.prepare(`
      UPDATE observation_sessions SET status = 'active' WHERE id = ? RETURNING *
    `);
    const row = stmt.get(id) as ObservationSession | undefined;
    if (!row) throw new ShadowingError(`Session ${id} not found`, 'session_not_found', { sessionId: id });
    return row;
  }

  // ── Observed Actions ────────────────────────────────────────────────────

  logObservedAction(sessionId: string, data: {
    source: ActionSource;
    app_name?: string;
    window_title?: string;
    command?: string;
    file_path?: string;
    metadata?: Record<string, unknown>;
    started_at?: string;
    ended_at?: string;
    duration_seconds?: number;
  }): ObservedAction {
    const stmt = this.db.prepare(`
      INSERT INTO observed_actions (session_id, source, app_name, window_title, command, file_path, metadata, started_at, ended_at, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?)
      RETURNING *
    `);
    return stmt.get(
      sessionId,
      data.source,
      data.app_name ?? null,
      this.redactCapture(data.window_title) ?? null,
      this.redactCapture(data.command) ?? null,
      this.redactCapture(data.file_path) ?? null,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.started_at ?? null,
      data.ended_at ?? null,
      data.duration_seconds ?? 0,
    ) as ObservedAction;
  }

  /**
   * Heartbeat update: extend the ended_at and duration of the last action
   * if it matches the same source + app_name + window_title.
   * Returns the updated action if merged, or null if a new action is needed.
   */
  heartbeatAction(sessionId: string, data: {
    source: ActionSource;
    app_name?: string;
    window_title?: string;
    pulsetime_seconds: number;
  }): ObservedAction | null {
    const last = this.db.prepare(`
      SELECT * FROM observed_actions
      WHERE session_id = ?
      ORDER BY ended_at DESC
      LIMIT 1
    `).get(sessionId) as ObservedAction | undefined;

    if (!last) return null;

    // Check if the last action matches and is within pulsetime.
    // The stored title is redacted, so the incoming one must be redacted
    // the same way or heartbeat merging would never match.
    if (
      last.source !== data.source ||
      last.app_name !== (data.app_name ?? null) ||
      last.window_title !== (this.redactCapture(data.window_title) ?? null)
    ) {
      return null;
    }

    const lastEnd = new Date(last.ended_at + 'Z').getTime();
    const now = Date.now();
    const gapSeconds = (now - lastEnd) / 1000;

    if (gapSeconds > data.pulsetime_seconds) {
      return null; // Gap too large, need new action
    }

    // Merge: extend the existing action
    const stmt = this.db.prepare(`
      UPDATE observed_actions
      SET ended_at = datetime('now'),
          duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER)
      WHERE id = ?
      RETURNING *
    `);
    return stmt.get(last.id) as ObservedAction;
  }

  getObservedActions(sessionId: string, opts?: {
    source?: ActionSource;
    limit?: number;
    offset?: number;
  }): ObservedAction[] {
    let sql = 'SELECT * FROM observed_actions WHERE session_id = ?';
    const params: (string | number)[] = [sessionId];

    if (opts?.source) {
      sql += ' AND source = ?';
      params.push(opts.source);
    }

    sql += ' ORDER BY started_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
      if (opts.offset) {
        sql += ' OFFSET ?';
        params.push(opts.offset);
      }
    }

    return this.db.prepare(sql).all(...params) as ObservedAction[];
  }

  /**
   * Re-apply redaction to all stored observed actions (one-time cleanup for
   * databases written before redact-on-capture, see `shadowing scrub`).
   * Idempotent: the redaction pipeline is a no-op on already-redacted text.
   * Returns the number of rows that changed.
   */
  scrubObservedActions(redactor: (text: string) => string): number {
    const rows = this.db.prepare(
      'SELECT id, window_title, command, file_path FROM observed_actions',
    ).all() as Array<{ id: string; window_title: string | null; command: string | null; file_path: string | null }>;

    const update = this.db.prepare(
      'UPDATE observed_actions SET window_title = ?, command = ?, file_path = ? WHERE id = ?',
    );

    let changed = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const windowTitle = row.window_title === null ? null : redactor(row.window_title);
        const command = row.command === null ? null : redactor(row.command);
        const filePath = row.file_path === null ? null : redactor(row.file_path);
        if (windowTitle !== row.window_title || command !== row.command || filePath !== row.file_path) {
          update.run(windowTitle, command, filePath, row.id);
          changed++;
        }
      }
    });
    tx();
    return changed;
  }

  /**
   * Re-apply redaction to task titles and descriptions (notes).
   * Returns the number of rows that changed.
   */
  scrubTasks(redactor: (text: string) => string): number {
    const rows = this.db.prepare(
      'SELECT id, title, description FROM tasks',
    ).all() as Array<{ id: string; title: string; description: string | null }>;

    const update = this.db.prepare(
      "UPDATE tasks SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?",
    );

    let changed = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const title = redactor(row.title);
        const description = row.description === null ? null : redactor(row.description);
        if (title !== row.title || description !== row.description) {
          update.run(title, description, row.id);
          changed++;
        }
      }
    });
    tx();
    return changed;
  }

  getActionTimeline(sessionId: string, startTime?: string, endTime?: string): ObservedAction[] {
    let sql = 'SELECT * FROM observed_actions WHERE session_id = ?';
    const params: string[] = [sessionId];

    if (startTime) {
      sql += ' AND started_at >= ?';
      params.push(startTime);
    }
    if (endTime) {
      sql += ' AND ended_at <= ?';
      params.push(endTime);
    }

    sql += ' ORDER BY started_at ASC';
    return this.db.prepare(sql).all(...params) as ObservedAction[];
  }

  getActionSummary(sessionId: string): { source: string; count: number; total_seconds: number }[] {
    return this.db.prepare(`
      SELECT source, COUNT(*) as count, SUM(duration_seconds) as total_seconds
      FROM observed_actions
      WHERE session_id = ?
      GROUP BY source
      ORDER BY total_seconds DESC
    `).all(sessionId) as { source: string; count: number; total_seconds: number }[];
  }

  // ── Consent ─────────────────────────────────────────────────────────────

  logConsent(action: 'granted' | 'revoked', scope: string): ConsentRecord {
    const stmt = this.db.prepare(`
      INSERT INTO consent_log (action, scope)
      VALUES (?, ?)
      RETURNING *
    `);
    return stmt.get(action, scope) as ConsentRecord;
  }

  getConsentLog(): ConsentRecord[] {
    return this.db.prepare(
      'SELECT * FROM consent_log ORDER BY recorded_at DESC, rowid DESC'
    ).all() as ConsentRecord[];
  }

  /**
   * Returns the effective consent state for a scope.
   * Looks at the most recent consent entry for the scope.
   */
  hasConsent(scope: string): boolean {
    const row = this.db.prepare(`
      SELECT action FROM consent_log
      WHERE scope = ?
      ORDER BY recorded_at DESC, rowid DESC
      LIMIT 1
    `).get(scope) as { action: string } | undefined;

    return row?.action === 'granted';
  }

  // ── Exclusion Rules ─────────────────────────────────────────────────────

  addExclusionRule(ruleType: ExclusionRule['rule_type'], pattern: string): ExclusionRule {
    const stmt = this.db.prepare(`
      INSERT INTO exclusion_rules (rule_type, pattern)
      VALUES (?, ?)
      RETURNING *
    `);
    return stmt.get(ruleType, pattern) as ExclusionRule;
  }

  removeExclusionRule(id: string): void {
    this.db.prepare('DELETE FROM exclusion_rules WHERE id = ?').run(id);
  }

  listExclusionRules(ruleType?: ExclusionRule['rule_type']): ExclusionRule[] {
    if (ruleType) {
      return this.db.prepare(
        'SELECT * FROM exclusion_rules WHERE rule_type = ? ORDER BY created_at DESC'
      ).all(ruleType) as ExclusionRule[];
    }
    return this.db.prepare(
      'SELECT * FROM exclusion_rules ORDER BY rule_type, created_at DESC'
    ).all() as ExclusionRule[];
  }

  // ── Data Degradation ────────────────────────────────────────────────────

  /**
   * Delete observed actions older than the given number of days.
   * Returns the number of deleted rows.
   */
  purgeOldActions(olderThanDays: number): number {
    const result = this.db.prepare(`
      DELETE FROM observed_actions
      WHERE started_at <= datetime('now', ? || ' days')
    `).run(`-${olderThanDays}`);
    return result.changes;
  }

  /**
   * Remove detailed metadata (window_title, command) from actions older than N days,
   * keeping only aggregate data (source, app_name, duration).
   */
  degradeOldActions(olderThanDays: number): number {
    const result = this.db.prepare(`
      UPDATE observed_actions
      SET window_title = NULL,
          command = NULL,
          file_path = NULL,
          metadata = NULL
      WHERE started_at <= datetime('now', ? || ' days')
        AND (window_title IS NOT NULL OR command IS NOT NULL OR file_path IS NOT NULL OR metadata IS NOT NULL)
    `).run(`-${olderThanDays}`);
    return result.changes;
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  getGlobalStats(): GlobalStats {
    const tasks = this.db.prepare(`
      SELECT
        COUNT(*) as total_tasks,
        COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active_tasks,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed_tasks
      FROM tasks
    `).get() as { total_tasks: number; active_tasks: number; completed_tasks: number };

    const sops = this.db.prepare(`
      SELECT
        COUNT(*) as total_sops,
        COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) as draft_sops,
        COALESCE(SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END), 0) as reviewed_sops,
        COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) as approved_sops,
        COALESCE(SUM(CASE WHEN status = 'exported' THEN 1 ELSE 0 END), 0) as exported_sops
      FROM sops
    `).get() as { total_sops: number; draft_sops: number; reviewed_sops: number; approved_sops: number; exported_sops: number };

    const execCount = (this.db.prepare('SELECT COUNT(*) as c FROM task_executions').get() as { c: number }).c;
    const tagCount = (this.db.prepare('SELECT COUNT(*) as c FROM tags').get() as { c: number }).c;
    const exportCount = (this.db.prepare('SELECT COUNT(*) as c FROM exports').get() as { c: number }).c;

    return {
      ...tasks,
      ...sops,
      total_executions: execCount,
      total_tags: tagCount,
      total_exports: exportCount,
      avg_quality_score: 0, // calculated externally via metrics module
    };
  }

  // ── Audit Log ──────────────────────────────────────────────────────────

  /**
   * Insert one audit row. Statement-only (no logging) so it can run inside
   * another method's transaction, keeping the audit entry atomic with the
   * mutation it records (#56). Use `logAudit` for standalone audit writes.
   */
  private insertAuditRow(data: {
    entity_type: string;
    entity_id: string;
    action: string;
    old_value?: string | null;
    new_value?: string | null;
    source?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO audit_log (entity_type, entity_id, action, old_value, new_value, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.entity_type,
      data.entity_id,
      data.action,
      data.old_value ?? null,
      data.new_value ?? null,
      data.source ?? 'cli',
    );
  }

  logAudit(data: {
    entity_type: string;
    entity_id: string;
    action: string;
    old_value?: string;
    new_value?: string;
    source?: string;
  }): void {
    this.insertAuditRow(data);
    log.info('Audit entry recorded', {
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      action: data.action,
      source: data.source ?? 'cli',
    });
  }

  getAuditLog(entityType?: string, entityId?: string): Array<{
    id: string;
    entity_type: string;
    entity_id: string;
    action: string;
    old_value: string | null;
    new_value: string | null;
    source: string;
    created_at: string;
  }> {
    let sql = 'SELECT * FROM audit_log';
    const conditions: string[] = [];
    const params: string[] = [];
    if (entityType) { conditions.push('entity_type = ?'); params.push(entityType); }
    if (entityId) { conditions.push('entity_id = ?'); params.push(entityId); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...params) as Array<{
      id: string; entity_type: string; entity_id: string;
      action: string; old_value: string | null; new_value: string | null;
      source: string; created_at: string;
    }>;
  }

  // ── API Usage ─────────────────────────────────────────────────────────

  logApiUsage(data: {
    sop_id?: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    duration_ms?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO api_usage (sop_id, model, input_tokens, output_tokens, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.sop_id ?? null,
      data.model,
      data.input_tokens,
      data.output_tokens,
      data.duration_ms ?? null,
    );
  }

  getApiUsageSummary(): {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    avg_input_tokens: number;
    avg_output_tokens: number;
    avg_duration_ms: number;
  } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_calls,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(AVG(input_tokens), 0) as avg_input_tokens,
        COALESCE(AVG(output_tokens), 0) as avg_output_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms
      FROM api_usage
    `).get() as {
      total_calls: number;
      total_input_tokens: number;
      total_output_tokens: number;
      avg_input_tokens: number;
      avg_output_tokens: number;
      avg_duration_ms: number;
    };
    return row;
  }

  // ── Mapping helpers ──────────────────────────────────────────────────────

  private mapTask(row: RawTask): Task {
    return {
      ...row,
      status: row.status as TaskStatus,
    };
  }

  private mapSOP(row: RawSOP): SOP {
    return {
      ...row,
      status: row.status as SOPStatus,
      ai_generated: row.ai_generated === 1,
    };
  }
}

// ── Raw row types (SQLite returns integers for booleans) ─────────────────────

interface RawTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  paused_at: string | null;
  paused_total_seconds: number;
  created_at: string;
  updated_at: string;
}

interface RawSOP {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  content_md: string;
  version: number;
  status: string;
  ai_generated: number;
  reviewed_at: string | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
}
