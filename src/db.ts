import Database from 'better-sqlite3';
import type {
  Task, TaskStatus, SOP, SOPStatus, Tag, TaskExecution,
  ExportRecord, GlobalStats, SOPVersion,
  ObservedAction, ActionSource, ObservationSession,
  ConsentRecord, ExclusionRule,
} from './types.js';

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

CREATE INDEX IF NOT EXISTS idx_sops_task_id ON sops(task_id);
CREATE INDEX IF NOT EXISTS idx_sops_status ON sops(status);
CREATE INDEX IF NOT EXISTS idx_task_executions_sop_id ON task_executions(sop_id);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_sop_versions_sop_id ON sop_versions(sop_id);
CREATE INDEX IF NOT EXISTS idx_observed_actions_session ON observed_actions(session_id);
CREATE INDEX IF NOT EXISTS idx_observed_actions_source ON observed_actions(source);
CREATE INDEX IF NOT EXISTS idx_observation_sessions_status ON observation_sessions(status);

-- Enforce at most one active task at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_task
  ON tasks(status) WHERE status = 'active';

-- Enforce at most one active observation session at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_observation
  ON observation_sessions(status) WHERE status = 'active';
`;

// ── ShadowingDB ──────────────────────────────────────────────────────────────

export class ShadowingDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
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
      this.db.exec(`ALTER TABLE tasks ADD COLUMN paused_at TEXT`);
    }
    if (!colNames.has('paused_total_seconds')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN paused_total_seconds INTEGER NOT NULL DEFAULT 0`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(title: string, description?: string): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (title, description)
      VALUES (?, ?)
      RETURNING *
    `);
    return this.mapTask(stmt.get(title, description ?? null) as RawTask);
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
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    fields.push("updated_at = datetime('now')");

    values.push(id);
    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ? RETURNING *`);
    const row = stmt.get(...values) as RawTask | undefined;
    if (!row) throw new Error(`Task ${id} not found`);
    return this.mapTask(row);
  }

  completeTask(id: string): Task {
    // Duration = wall-clock time - total paused time (including current pause if paused)
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'completed',
          completed_at = datetime('now'),
          duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER)
            - paused_total_seconds
            - CASE WHEN paused_at IS NOT NULL
                THEN CAST((julianday('now') - julianday(paused_at)) * 86400 AS INTEGER)
                ELSE 0
              END,
          paused_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `);
    const row = stmt.get(id) as RawTask | undefined;
    if (!row) throw new Error(`Task ${id} not found`);
    return this.mapTask(row);
  }

  pauseTask(id: string): Task {
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'paused',
          paused_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `);
    const row = stmt.get(id) as RawTask | undefined;
    if (!row) throw new Error(`Task ${id} not found`);
    return this.mapTask(row);
  }

  resumeTask(id: string): Task {
    // Add the pause gap to paused_total_seconds, then clear paused_at
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'active',
          paused_total_seconds = paused_total_seconds +
            CASE WHEN paused_at IS NOT NULL
              THEN CAST((julianday('now') - julianday(paused_at)) * 86400 AS INTEGER)
              ELSE 0
            END,
          paused_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `);
    const row = stmt.get(id) as RawTask | undefined;
    if (!row) throw new Error(`Task ${id} not found`);
    return this.mapTask(row);
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
    const stmt = this.db.prepare(`
      INSERT INTO sops (task_id, title, description, content_md, ai_generated)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `);
    const row = stmt.get(
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

  updateSOP(id: string, updates: Partial<Pick<SOP, 'title' | 'description' | 'content_md'>>, changeSummary?: string): SOP {
    // Snapshot current version before updating content
    if (updates.content_md !== undefined) {
      const current = this.getSOP(id);
      if (current) {
        this.db.prepare(`
          INSERT INTO sop_versions (sop_id, version, title, content_md, change_summary)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, current.version, current.title, current.content_md, changeSummary ?? null);
      }
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
    const stmt = this.db.prepare(`UPDATE sops SET ${fields.join(', ')} WHERE id = ? RETURNING *`);
    const row = stmt.get(...values) as RawSOP | undefined;
    if (!row) throw new Error(`SOP ${id} not found`);
    return this.mapSOP(row);
  }

  updateSOPStatus(id: string, status: SOPStatus): SOP {
    const extra = status === 'reviewed' ? ", reviewed_at = datetime('now')" :
                  status === 'exported' ? ", exported_at = datetime('now')" : '';
    const stmt = this.db.prepare(
      `UPDATE sops SET status = ?, updated_at = datetime('now')${extra} WHERE id = ? RETURNING *`
    );
    const row = stmt.get(status, id) as RawSOP | undefined;
    if (!row) throw new Error(`SOP ${id} not found`);
    return this.mapSOP(row);
  }

  deleteSOP(id: string): void {
    this.db.prepare('DELETE FROM sops WHERE id = ?').run(id);
  }

  // ── Tags ─────────────────────────────────────────────────────────────────

  getOrCreateTag(name: string): Tag {
    const existing = this.db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(name) as Tag | undefined;
    if (existing) return existing;

    const stmt = this.db.prepare('INSERT INTO tags (name) VALUES (?) RETURNING *');
    return stmt.get(name) as Tag;
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
    if (!row) throw new Error(`Session ${id} not found`);
    return row;
  }

  pauseObservationSession(id: string): ObservationSession {
    const stmt = this.db.prepare(`
      UPDATE observation_sessions SET status = 'paused' WHERE id = ? RETURNING *
    `);
    const row = stmt.get(id) as ObservationSession | undefined;
    if (!row) throw new Error(`Session ${id} not found`);
    return row;
  }

  resumeObservationSession(id: string): ObservationSession {
    const stmt = this.db.prepare(`
      UPDATE observation_sessions SET status = 'active' WHERE id = ? RETURNING *
    `);
    const row = stmt.get(id) as ObservationSession | undefined;
    if (!row) throw new Error(`Session ${id} not found`);
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
      data.window_title ?? null,
      data.command ?? null,
      data.file_path ?? null,
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

    // Check if the last action matches and is within pulsetime
    if (
      last.source !== data.source ||
      last.app_name !== (data.app_name ?? null) ||
      last.window_title !== (data.window_title ?? null)
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
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_tasks,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks
      FROM tasks
    `).get() as { total_tasks: number; active_tasks: number; completed_tasks: number };

    const sops = this.db.prepare(`
      SELECT
        COUNT(*) as total_sops,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_sops,
        SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) as reviewed_sops,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_sops,
        SUM(CASE WHEN status = 'exported' THEN 1 ELSE 0 END) as exported_sops
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
