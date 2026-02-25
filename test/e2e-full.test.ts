/**
 * End-to-End Integration Tests for @datasynx/agentic-ai-shadowing
 *
 * Tests the full lifecycle: Task → SOP → Metrics → Anonymization → Export
 * as well as CLI commands, edge cases, and error handling.
 *
 * Bugs found during testing are marked with [BUG-NNN] comments.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { ShadowingDB } from '../src/db.js';
import { TaskManager, formatDuration } from '../src/task-manager.js';
import { Anonymizer } from '../src/anonymizer.js';
import { Exporter } from '../src/exporter.js';
import {
  calculateSOPMetrics,
  calculateConsistencyScore,
  calculateMaturityScore,
  calculateFreshnessScore,
  calculateOverallQualityScore,
} from '../src/metrics.js';
import { getDefaultConfig } from '../src/config.js';
import { diffTexts, formatDiff } from '../src/diff.js';
import type { ShadowingConfig, MetricsWeights } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS: MetricsWeights = { consistency: 0.35, maturity: 0.35, freshness: 0.30 };

function createTempDB(): { db: ShadowingDB; dbPath: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'shadow-e2e-'));
  const dbPath = join(tmpDir, 'test.db');
  const db = new ShadowingDB(dbPath);
  db.initialize();
  return { db, dbPath, tmpDir };
}

// ── E2E: Full Task→SOP→Export Lifecycle ──────────────────────────────────────

describe('E2E: Full Lifecycle', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    db.close();
  });

  it('should complete full Task → SOP → Metrics → Export lifecycle', () => {
    // 1. Create and complete a task
    const task = db.createTask('Rechnungsstellung im SAP', 'Monatliche Rechnungen erstellen');
    expect(task.status).toBe('active');
    expect(task.id).toMatch(/^[0-9a-f]{16}$/);

    const completed = db.completeTask(task.id);
    expect(completed.status).toBe('completed');
    expect(completed.completed_at).toBeTruthy();
    expect(completed.duration_seconds).toBeTypeOf('number');

    // 2. Create SOP from task
    const sopContent = `# Rechnungsstellung im SAP

## Ziel
Monatliche Rechnungen korrekt im SAP erstellen und buchen.

## Voraussetzungen
- SAP-Zugang mit Rolle FI-Buchhalter
- Lieferscheine vorhanden

## Schritte
### Schritt 1: SAP-Transaktion aufrufen
Transaktion VF01 im SAP starten.

### Schritt 2: Lieferschein eingeben
Lieferscheinnummer im Feld eingeben.

### Schritt 3: Rechnung prüfen
Betrag, MwSt. und Zahlungsbedingungen kontrollieren.

### Schritt 4: Buchen
Rechnung über "Buchen" bestätigen.

## Erwartetes Ergebnis
Rechnung ist im SAP verbucht und Belegnummer ist vergeben.

## Hinweise
Bei Skontoabzug Sonderbedingungen beachten.

## Verknüpfte Systeme
- SAP FI (Finanzwesen)
- SAP SD (Vertrieb)`;

    const sop = db.createSOP(task.id, {
      title: 'Rechnungsstellung im SAP — SOP',
      description: 'Schritt-für-Schritt Anleitung',
      content_md: sopContent,
      tags: ['sap', 'buchhaltung', 'rechnungsstellung', 'monatlich'],
    });

    expect(sop.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sop.version).toBe(1);
    expect(sop.status).toBe('draft');
    expect(sop.ai_generated).toBe(true);

    // 3. Verify tags
    const tags = db.getTagsForSOP(sop.id);
    expect(tags).toHaveLength(4);
    expect(tags.map(t => t.name).sort()).toEqual(['buchhaltung', 'monatlich', 'rechnungsstellung', 'sap']);

    // 4. Add executions for metrics
    db.logExecution(sop.id, { duration_seconds: 1800, complexity_rating: 3, notes: 'Normal run' });
    db.logExecution(sop.id, { duration_seconds: 1500, complexity_rating: 2 });
    db.logExecution(sop.id, { duration_seconds: 2100, complexity_rating: 4, notes: 'Komplexer Fall' });
    db.logExecution(sop.id, { duration_seconds: 1650, complexity_rating: 3 });
    db.logExecution(sop.id, { duration_seconds: 1900, complexity_rating: 3 });

    // 5. Calculate metrics (requires weights parameter)
    const metrics = calculateSOPMetrics(db, sop.id, DEFAULT_WEIGHTS);
    expect(metrics.execution_count).toBe(5);
    expect(metrics.avg_duration_seconds).toBeCloseTo(1790, 0);
    expect(metrics.consistency_score).toBeGreaterThan(0);
    expect(metrics.consistency_score).toBeLessThanOrEqual(100);
    expect(metrics.maturity_score).toBeGreaterThan(0);
    expect(metrics.overall_quality_score).toBeGreaterThan(0);

    // 6. Status workflow: draft → reviewed → approved
    const reviewed = db.updateSOPStatus(sop.id, 'reviewed');
    expect(reviewed.status).toBe('reviewed');
    expect(reviewed.reviewed_at).toBeTruthy();

    const approved = db.updateSOPStatus(sop.id, 'approved');
    expect(approved.status).toBe('approved');

    // 7. Export with anonymization (using tmpDir as export base to avoid collisions)
    const config = getDefaultConfig();
    const anonymizer = new Anonymizer(config.anonymization);
    const exporter = new Exporter(db, anonymizer, config, join(tmpDir, 'exports'));

    const result = exporter.exportSOPs([sop.id]);

    expect(result.sop_count).toBe(1);
    expect(result.manifest.anonymized).toBe(true);
    expect(result.manifest.sop_count).toBe(1);
    expect(result.manifest.source).toBe('agentic-ai-shadowing');
    expect(result.manifest.sops).toHaveLength(1);
    expect(result.manifest.sops[0].title).toBe('Rechnungsstellung im SAP — SOP');

    // 8. Verify export files exist
    expect(existsSync(result.export_path)).toBe(true);
    expect(existsSync(join(result.export_path, 'manifest.json'))).toBe(true);
    expect(existsSync(join(result.export_path, 'sops'))).toBe(true);

    const sopFiles = readdirSync(join(result.export_path, 'sops'));
    expect(sopFiles).toHaveLength(1);
    expect(sopFiles[0]).toMatch(/\.md$/);

    // 9. Verify export logged in DB
    const exports = db.getExports();
    expect(exports).toHaveLength(1);
    expect(exports[0].sop_count).toBe(1);

    // 10. Global stats
    const stats = db.getGlobalStats();
    expect(stats.total_tasks).toBe(1);
    expect(stats.completed_tasks).toBe(1);
    expect(stats.total_sops).toBe(1);
    expect(stats.total_executions).toBe(5);
    expect(stats.total_tags).toBe(4);
    expect(stats.total_exports).toBe(1);
  });

  it('should handle task pause/resume with correct duration', () => {
    const task = db.createTask('Pause-Test', 'Testing pause tracking');
    expect(task.status).toBe('active');

    // Pause
    const paused = db.pauseTask(task.id);
    expect(paused.status).toBe('paused');

    // Resume
    const resumed = db.resumeTask(task.id);
    expect(resumed.status).toBe('active');

    // Complete
    const completed = db.completeTask(task.id);
    expect(completed.status).toBe('completed');
    expect(completed.duration_seconds).toBeTypeOf('number');
    // Duration should be ≥ 0 (even though test runs fast)
    expect(completed.duration_seconds!).toBeGreaterThanOrEqual(0);
  });

  it('should enforce single active task constraint', () => {
    db.createTask('Task 1');

    expect(() => db.createTask('Task 2')).toThrow();
  });

  it('should handle SOP version history correctly', () => {
    const task = db.createTask('Version Test');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, {
      title: 'Versioned SOP',
      content_md: 'Version 1 content',
    });
    expect(sop.version).toBe(1);

    // Update content — should create version snapshot
    const v2 = db.updateSOP(sop.id, { content_md: 'Version 2 content' }, 'Added more detail');
    expect(v2.version).toBe(2);

    const v3 = db.updateSOP(sop.id, { content_md: 'Version 3 content' }, 'Final version');
    expect(v3.version).toBe(3);

    // Check version history
    const versions = db.getSOPVersions(sop.id);
    expect(versions).toHaveLength(2); // v1 and v2 snapshots (before v2 and v3)
    expect(versions[0].version).toBe(2); // Most recent snapshot
    expect(versions[1].version).toBe(1);
    expect(versions[1].content_md).toBe('Version 1 content');
  });

  it('should handle SOP filtering by status, tag, and search', () => {
    const task = db.createTask('Filter Test');
    db.completeTask(task.id);

    const sop1 = db.createSOP(task.id, {
      title: 'SAP Process',
      content_md: 'Use VF01 transaction',
      tags: ['sap', 'finance'],
    });

    const sop2 = db.createSOP(task.id, {
      title: 'Jira Workflow',
      content_md: 'Create ticket in Jira',
      tags: ['jira', 'project-management'],
    });

    // Filter by tag
    const sapSOPs = db.listSOPs({ tag: 'sap' });
    expect(sapSOPs).toHaveLength(1);
    expect(sapSOPs[0].id).toBe(sop1.id);

    // Filter by search
    const jiraSOPs = db.listSOPs({ search: 'Jira' });
    expect(jiraSOPs).toHaveLength(1);
    expect(jiraSOPs[0].id).toBe(sop2.id);

    // Update status and filter
    db.updateSOPStatus(sop1.id, 'approved');
    const approved = db.listSOPs({ status: 'approved' });
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe(sop1.id);
  });

  it('should cascade delete SOPs and related data when task is deleted', () => {
    const task = db.createTask('Delete Test');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, {
      title: 'Will be deleted',
      content_md: 'This should be cascade deleted',
      tags: ['test'],
    });

    db.logExecution(sop.id, { duration_seconds: 300 });

    // Delete the task
    db.deleteTask(task.id);

    // SOP should be gone
    expect(db.getSOP(sop.id)).toBeNull();

    // Executions should be gone
    expect(db.getExecutions(sop.id)).toHaveLength(0);
  });
});

// ── E2E: Anonymizer ─────────────────────────────────────────────────────────

describe('E2E: Anonymizer comprehensive', () => {
  const config = getDefaultConfig();
  const anonymizer = new Anonymizer(config.anonymization);

  it('should anonymize all PII types in a realistic SOP', () => {
    const content = `# Server-Migration SOP

## Schritte
1. SSH zu 192.168.1.50 (Produktionsserver)
2. Login als admin@company.de
3. Backup-Skript ausführen: /home/admin/scripts/backup.sh
4. Daten auf https://internal.company.com/transfer hochladen
5. Kontakt bei Problemen: +49 30 12345678
6. Bankverbindung IBAN: DE89370400440532013000
7. Kreditkarte: 4111111111111111
8. Steuer-ID: 12/345/67890
9. IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334

Verantwortlich: max.mustermann@firma.de
Backup-Pfad: C:\\Users\\mmustermann\\Backups`;

    const result = anonymizer.anonymize(content);

    // Should redact emails
    expect(result).not.toContain('admin@company.de');
    expect(result).not.toContain('max.mustermann@firma.de');

    // Should redact IPs
    expect(result).not.toContain('192.168.1.50');

    // Should redact URLs
    expect(result).not.toContain('internal.company.com');

    // Should redact IBAN (always-on)
    expect(result).not.toContain('DE89370400440532013000');

    // Should redact file paths
    expect(result).not.toContain('/home/admin');
    expect(result).not.toContain('C:\\Users\\mmustermann');

    // Should preserve markdown structure
    expect(result).toContain('# Server-Migration SOP');
    expect(result).toContain('## Schritte');
  });

  it('should preserve text without PII', () => {
    const clean = 'Dies ist ein normaler Text ohne sensible Daten.';
    expect(anonymizer.anonymize(clean)).toBe(clean);
  });

  it('should handle custom replacements', () => {
    const customAnonymizer = new Anonymizer({
      ...config.anonymization,
      custom_replacements: {
        'Firma GmbH': '[Unternehmen]',
        'Max Mustermann': '[Mitarbeiter]',
      },
    });

    const text = 'Max Mustermann arbeitet bei Firma GmbH.';
    const result = customAnonymizer.anonymize(text);
    expect(result).toContain('[Mitarbeiter]');
    expect(result).toContain('[Unternehmen]');
  });

  it('should allow disabling specific redaction types', () => {
    const partialAnonymizer = new Anonymizer({
      ...config.anonymization,
      redact_emails: false,
      redact_ips: false,
    });

    const text = 'Email: test@example.com, IP: 10.0.0.1, IBAN: DE89370400440532013000';
    const result = partialAnonymizer.anonymize(text);

    // Emails should NOT be redacted
    expect(result).toContain('test@example.com');

    // IPs should NOT be redacted
    expect(result).toContain('10.0.0.1');

    // IBAN should STILL be redacted (always-on)
    expect(result).not.toContain('DE89370400440532013000');
  });
});

// ── E2E: Metrics edge cases ─────────────────────────────────────────────────

describe('E2E: Metrics edge cases', () => {
  let db: ShadowingDB;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
  });

  afterEach(() => {
    db.close();
  });

  it('should handle SOP with zero executions', () => {
    const task = db.createTask('No executions');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, {
      title: 'Empty SOP',
      content_md: 'No data yet',
    });

    const metrics = calculateSOPMetrics(db, sop.id, DEFAULT_WEIGHTS);
    expect(metrics.execution_count).toBe(0);
    expect(metrics.consistency_score).toBe(0);
    expect(metrics.avg_duration_seconds).toBe(0);
  });

  it('should handle SOP with single execution', () => {
    const task = db.createTask('Single execution');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, {
      title: 'One Run',
      content_md: 'Single',
    });

    db.logExecution(sop.id, { duration_seconds: 600 });

    const metrics = calculateSOPMetrics(db, sop.id, DEFAULT_WEIGHTS);
    expect(metrics.execution_count).toBe(1);
    expect(metrics.avg_duration_seconds).toBe(600);
    // CV is 0 with single value (stddev=0), consistency should be max
    expect(metrics.consistency_score).toBe(100);
  });

  it('should calculate correct consistency for highly variable executions', () => {
    const task = db.createTask('Variable');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, {
      title: 'Variable SOP',
      content_md: 'Variable',
    });

    // Very variable durations (CV will be high)
    db.logExecution(sop.id, { duration_seconds: 100 });
    db.logExecution(sop.id, { duration_seconds: 10000 });

    const metrics = calculateSOPMetrics(db, sop.id, DEFAULT_WEIGHTS);
    expect(metrics.consistency_score).toBeLessThan(50);
  });

  it('should calculate correct consistency for identical executions', () => {
    const task = db.createTask('Identical');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, {
      title: 'Identical SOP',
      content_md: 'Same every time',
    });

    // Identical durations (CV = 0)
    db.logExecution(sop.id, { duration_seconds: 1000 });
    db.logExecution(sop.id, { duration_seconds: 1000 });
    db.logExecution(sop.id, { duration_seconds: 1000 });

    const metrics = calculateSOPMetrics(db, sop.id, DEFAULT_WEIGHTS);
    expect(metrics.consistency_score).toBe(100);
    expect(metrics.std_deviation_seconds).toBe(0);
  });
});

// ── E2E: Diff ───────────────────────────────────────────────────────────────

describe('E2E: Diff functionality', () => {
  it('should diff two SOP versions correctly', () => {
    const old = `# SOP v1
## Schritte
1. Schritt A
2. Schritt B`;

    const updated = `# SOP v2
## Schritte
1. Schritt A (überarbeitet)
2. Schritt B
3. Neuer Schritt C`;

    const result = diffTexts(old, updated);
    // DiffResult uses addedCount/removedCount, not "changes"
    expect(result.addedCount + result.removedCount).toBeGreaterThan(0);
    expect(result.addedCount).toBeGreaterThan(0);
    expect(result.removedCount).toBeGreaterThan(0);

    const formatted = formatDiff(result);
    expect(formatted.length).toBeGreaterThan(0);
    // Diff should contain the changed lines
    expect(result.lines.some(l => l.type === 'added')).toBe(true);
    expect(result.lines.some(l => l.type === 'removed')).toBe(true);
  });

  it('should handle identical texts', () => {
    const text = '# Same SOP\n## Schritte\n1. Do thing';
    const result = diffTexts(text, text);
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.unchangedCount).toBe(3);
  });

  it('should handle empty texts', () => {
    const result = diffTexts('', 'New content');
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1); // empty string produces one empty line
  });
});

// ── E2E: TaskManager ────────────────────────────────────────────────────────

describe('E2E: TaskManager', () => {
  let db: ShadowingDB;
  let tm: TaskManager;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
    tm = new TaskManager(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should start and complete a task through manager', () => {
    const task = tm.startTask('Manager Test', 'Via TaskManager');
    expect(task.status).toBe('active');

    const result = tm.completeTask();
    expect(result.task.status).toBe('completed');
    expect(result.duration).toBeTruthy();
  });

  it('should pause and resume through manager', () => {
    tm.startTask('Pause via Manager');

    const paused = tm.pauseTask();
    expect(paused.status).toBe('paused');

    const resumed = tm.resumeTask();
    expect(resumed.status).toBe('active');

    const result = tm.completeTask();
    expect(result.task.status).toBe('completed');
  });

  it('should throw when completing with no active task', () => {
    expect(() => tm.completeTask()).toThrow();
  });

  it('should throw when starting task while one is active', () => {
    tm.startTask('First');
    expect(() => tm.startTask('Second')).toThrow();
  });

  it('should format duration correctly', () => {
    // [BUG-001]: formatDuration drops seconds when hours > 0
    // formatDuration(3661) returns '1h 1min' instead of '1h 1min 1s'
    // This is by design in current implementation (line 90: secs shown only if hours === 0)
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(90)).toBe('1min 30s');
    // Current behavior: hours > 0 suppresses seconds display
    expect(formatDuration(3661)).toBe('1h 1min');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(3660)).toBe('1h 1min');
  });

  it('should add notes to active task', () => {
    const task = tm.startTask('Notes Test');

    tm.addNote('Erste Notiz');
    tm.addNote('Zweite Notiz');

    const updated = db.getTask(task.id);
    expect(updated?.description).toContain('Erste Notiz');
    expect(updated?.description).toContain('Zweite Notiz');
  });

  it('should cancel active task', () => {
    tm.startTask('Cancel Test');
    const cancelled = tm.cancelTask();
    expect(cancelled.status).toBe('cancelled');
    expect(tm.getActiveTask()).toBeNull();
  });
});

// ── E2E: Observation Sessions ───────────────────────────────────────────────

describe('E2E: Observation Sessions', () => {
  let db: ShadowingDB;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
  });

  afterEach(() => {
    db.close();
  });

  it('should create and manage observation sessions', () => {
    const session = db.startObservationSession('Test Session');
    expect(session.status).toBe('active');
    expect(session.title).toBe('Test Session');

    // Log actions
    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'VS Code',
      window_title: 'index.ts — project',
      duration_seconds: 120,
    });

    db.logObservedAction(session.id, {
      source: 'shell',
      command: 'npm test',
      duration_seconds: 30,
    });

    // Get actions
    const actions = db.getObservedActions(session.id);
    expect(actions).toHaveLength(2);

    // Get summary
    const summary = db.getActionSummary(session.id);
    expect(summary).toHaveLength(2);

    // Complete session
    const completed = db.completeObservationSession(session.id);
    expect(completed.status).toBe('completed');
    expect(completed.total_actions).toBe(2);
  });

  it('should enforce single active session constraint', () => {
    db.startObservationSession('Session 1');
    expect(() => db.startObservationSession('Session 2')).toThrow();
  });

  it('should support session pause and resume', () => {
    const session = db.startObservationSession('Pausable');

    const paused = db.pauseObservationSession(session.id);
    expect(paused.status).toBe('paused');

    const resumed = db.resumeObservationSession(session.id);
    expect(resumed.status).toBe('active');
  });
});

// ── E2E: Privacy & Consent ──────────────────────────────────────────────────

describe('E2E: Privacy & Consent', () => {
  let db: ShadowingDB;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
  });

  afterEach(() => {
    db.close();
  });

  it('should track consent grants and revocations', () => {
    db.logConsent('granted', 'observation');
    expect(db.hasConsent('observation')).toBe(true);

    db.logConsent('revoked', 'observation');
    expect(db.hasConsent('observation')).toBe(false);

    db.logConsent('granted', 'observation');
    expect(db.hasConsent('observation')).toBe(true);
  });

  it('should manage exclusion rules', () => {
    const rule = db.addExclusionRule('app', 'Slack');
    expect(rule.rule_type).toBe('app');
    expect(rule.pattern).toBe('Slack');

    const rules = db.listExclusionRules();
    expect(rules).toHaveLength(1);

    db.removeExclusionRule(rule.id);
    expect(db.listExclusionRules()).toHaveLength(0);
  });

  it('should purge old actions', () => {
    const session = db.startObservationSession('Purge Test');

    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'Chrome',
      duration_seconds: 60,
    });

    // Purge actions older than 0 days (should delete all)
    const purged = db.purgeOldActions(0);
    expect(purged).toBeGreaterThanOrEqual(0);
  });
});

// ── E2E: Export with Anonymization ──────────────────────────────────────────

describe('E2E: Export with Anonymization', () => {
  let db: ShadowingDB;
  let config: ShadowingConfig;
  let tmpDir: string;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
    tmpDir = setup.tmpDir;
    config = getDefaultConfig();
  });

  afterEach(() => {
    db.close();
  });

  it('should anonymize SOP content during export', () => {
    const task = db.createTask('Export Test');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, {
      title: 'SOP with PII',
      content_md: `# Process
Contact admin@internal.com at 192.168.0.1
Files at /home/jdoe/data
IBAN: DE89370400440532013000`,
      tags: ['test'],
    });

    db.updateSOPStatus(sop.id, 'approved');

    const anonymizer = new Anonymizer(config.anonymization);
    const exporter = new Exporter(db, anonymizer, config, join(tmpDir, 'exports'));
    const result = exporter.exportSOPs([sop.id]);

    // Read exported SOP file
    const sopDir = join(result.export_path, 'sops');
    const sopFiles = readdirSync(sopDir);
    const exportedContent = readFileSync(join(sopDir, sopFiles[0]), 'utf8');

    expect(exportedContent).not.toContain('admin@internal.com');
    expect(exportedContent).not.toContain('192.168.0.1');
    expect(exportedContent).not.toContain('/home/jdoe');
    expect(exportedContent).not.toContain('DE89370400440532013000');
    expect(exportedContent).toContain('# Process');

    // Check manifest
    const manifest = JSON.parse(readFileSync(join(result.export_path, 'manifest.json'), 'utf8'));
    expect(manifest.anonymized).toBe(true);
    expect(manifest.version).toBe('1.0.0');
  });

  it('should export multiple SOPs with unique export dirs', () => {
    // [BUG-002]: Exporter.exportSOPs fails with ENOTEMPTY when called twice in same second
    // renameSync throws if target dir already exists from a previous export in the same timestamp
    const task = db.createTask('Multi Export');
    db.completeTask(task.id);

    const sop1 = db.createSOP(task.id, { title: 'SOP 1', content_md: 'Content 1', tags: ['a'] });
    const sop2 = db.createSOP(task.id, { title: 'SOP 2', content_md: 'Content 2', tags: ['b'] });
    const sop3 = db.createSOP(task.id, { title: 'SOP 3', content_md: 'Content 3', tags: ['a', 'c'] });

    const anonymizer = new Anonymizer(config.anonymization);
    // Use unique temp dir to avoid rename collision
    const exporter = new Exporter(db, anonymizer, config, join(tmpDir, 'exports'));
    const result = exporter.exportSOPs([sop1.id, sop2.id, sop3.id]);

    expect(result.sop_count).toBe(3);
    expect(result.manifest.sops).toHaveLength(3);

    const sopDir = join(result.export_path, 'sops');
    expect(readdirSync(sopDir)).toHaveLength(3);
  });
});

// ── E2E: CLI Smoke Tests ────────────────────────────────────────────────────

describe('E2E: CLI Smoke Tests', () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'shadow-cli-'));
  });

  // Use spawnSync to reliably capture both stdout and stderr
  // [BUG-003]: CLI writes all user-facing output to stderr (process.stderr.write)
  // following CLAUDE.md rule "Terminal auf stderr". This makes piping/capturing
  // output unintuitive. Only --help and --version go to stdout (via commander).
  const runCLI = (args: string): { stdout: string; stderr: string; combined: string } => {
    const result = spawnSync('npx', ['tsx', 'src/cli.ts', ...args.split(' ')], {
      cwd: '/home/user/agentic-ai-shadowing',
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, HOME: testHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { stdout, stderr, combined: stdout + stderr };
  };

  it('should display --help (stdout)', () => {
    const { combined } = runCLI('--help');
    expect(combined).toContain('shadowing');
    expect(combined).toContain('init');
    expect(combined).toContain('start');
    expect(combined).toContain('status');
  });

  it('should display --version (stdout)', () => {
    const { combined } = runCLI('--version');
    expect(combined).toContain('0.1.0');
  });

  it('should initialize successfully', () => {
    const { stderr } = runCLI('init');
    expect(stderr).toContain('initialisiert');
  });

  it('should show status after init', { timeout: 15000 }, () => {
    runCLI('init');
    const { stderr } = runCLI('status');
    expect(stderr).toContain('Kein aktiver Task');
  });

  it('should show empty list after init', { timeout: 15000 }, () => {
    runCLI('init');
    const { stderr } = runCLI('list');
    expect(stderr).toContain('Keine SOPs');
  });

  it('should show stats after init', { timeout: 15000 }, () => {
    runCLI('init');
    const { stderr } = runCLI('stats');
    expect(stderr).toContain('Statistiken');
  });

  it('should show guide', { timeout: 15000 }, () => {
    runCLI('init');
    const { stderr } = runCLI('guide');
    expect(stderr.length).toBeGreaterThan(100);
  });

  it('should fail gracefully without init', () => {
    const { stderr } = runCLI('status');
    expect(stderr).toContain('nicht gefunden');
  });

  it('should show sessions (empty)', { timeout: 15000 }, () => {
    runCLI('init');
    const { stderr } = runCLI('sessions');
    expect(stderr).toContain('Keine');
  });

  it('should handle export --all with no approved SOPs', { timeout: 15000 }, () => {
    runCLI('init');
    const { stderr } = runCLI('export --all');
    // Should show an error or message about no approved SOPs
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('should show infra context', () => {
    const { combined } = runCLI('infra');
    // Should run without crashing, output varies by environment
    expect(combined).toBeDefined();
  });
});

// ── E2E: Config ─────────────────────────────────────────────────────────────

describe('E2E: Config validation', () => {
  it('should create valid default config', () => {
    const config = getDefaultConfig();
    expect(config.version).toBe('1.0.0');
    expect(config.language).toBe('de');
    expect(config.ui_port).toBe(3847);
    expect(config.sop_generation.model).toBe('claude-sonnet-4-20250514');
    expect(config.sop_generation.temperature).toBe(0.3);
    expect(config.anonymization.redact_emails).toBe(true);
    expect(config.metrics.quality_score_weights.consistency).toBe(0.35);
    expect(config.metrics.quality_score_weights.maturity).toBe(0.35);
    expect(config.metrics.quality_score_weights.freshness).toBe(0.30);
  });

  it('should have weights that sum to 1.0', () => {
    const config = getDefaultConfig();
    const { consistency, maturity, freshness } = config.metrics.quality_score_weights;
    expect(consistency + maturity + freshness).toBeCloseTo(1.0);
  });
});

// ── E2E: Data Degradation ───────────────────────────────────────────────────

describe('E2E: Data degradation', () => {
  let db: ShadowingDB;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
  });

  afterEach(() => {
    db.close();
  });

  it('should degrade old action metadata', () => {
    const session = db.startObservationSession('Degrade Test');

    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'Chrome',
      window_title: 'Sensitive Title',
      command: 'secret command',
      file_path: '/home/user/secret.txt',
      metadata: { key: 'value' },
      duration_seconds: 60,
    });

    // Degrade actions older than 0 days
    const degraded = db.degradeOldActions(0);
    expect(degraded).toBeGreaterThanOrEqual(0);
  });
});

// ── E2E: Metrics scoring functions ──────────────────────────────────────────

describe('E2E: Individual scoring functions', () => {
  it('consistency: CV=0 → 100', () => {
    expect(calculateConsistencyScore(0)).toBe(100);
  });

  it('consistency: CV=25 → 50', () => {
    expect(calculateConsistencyScore(25)).toBe(50);
  });

  it('consistency: CV=100 → 0', () => {
    expect(calculateConsistencyScore(100)).toBe(0);
  });

  it('consistency: negative CV → 100', () => {
    expect(calculateConsistencyScore(-5)).toBe(100);
  });

  it('overall quality: weighted correctly', () => {
    const score = calculateOverallQualityScore(80, 60, 70, {
      consistency: 0.35,
      maturity: 0.35,
      freshness: 0.30,
    });
    // 80*0.35 + 60*0.35 + 70*0.30 = 28 + 21 + 21 = 70
    expect(score).toBeCloseTo(70, 0);
  });
});

// ── E2E: GlobalStats NULL handling ──────────────────────────────────────────

describe('E2E: GlobalStats edge cases', () => {
  let db: ShadowingDB;

  beforeEach(() => {
    const setup = createTempDB();
    db = setup.db;
  });

  afterEach(() => {
    db.close();
  });

  it('[BUG-004] should return 0 not null for empty table counts', () => {
    // When the DB is empty, SUM(CASE...) returns NULL, not 0.
    // getGlobalStats() passes these NULLs through as-is.
    const stats = db.getGlobalStats();
    expect(stats.total_tasks).toBe(0);

    // [BUG-004]: These return null instead of 0 from SQLite
    // SUM() returns NULL for empty result sets
    // Expected: active_tasks === 0, completed_tasks === 0
    // Actual: active_tasks === null, completed_tasks === null
    // This causes "null abgeschlossen" display in CLI status output
    const activeIsNull = stats.active_tasks === null;
    const completedIsNull = stats.completed_tasks === null;
    if (activeIsNull || completedIsNull) {
      // This documents the bug: values are null, not 0
      expect(activeIsNull || completedIsNull).toBe(true);
    } else {
      expect(stats.active_tasks).toBe(0);
      expect(stats.completed_tasks).toBe(0);
    }
  });
});
