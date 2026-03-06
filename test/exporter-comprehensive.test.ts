import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import { Anonymizer } from '../src/anonymizer.js';
import { Exporter } from '../src/exporter.js';
import { getDefaultConfig } from '../src/config.js';
import type { ExportManifest } from '../src/types.js';

describe('Exporter — Comprehensive Tests', () => {
  let db: ShadowingDB;
  let tmpDir: string;
  let exportDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-export-'));
    exportDir = join(tmpDir, 'exports');
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createExporter(overrides: Record<string, unknown> = {}) {
    const config = getDefaultConfig();
    const anonymizer = new Anonymizer(config.anonymization);
    return new Exporter(db, anonymizer, config, exportDir);
  }

  function createTestSOP(title = 'Test SOP', content = '# Test\n## Objective\nTest objective.') {
    // Complete any existing active task first (single-active constraint)
    const active = db.getActiveTask();
    if (active) db.completeTask(active.id);
    const task = db.createTask('Test Task');
    db.completeTask(task.id);
    return db.createSOP(task.id, { title, content_md: content });
  }

  // ── exportSOPs ──────────────────────────────────────────────────────────────

  describe('exportSOPs', () => {
    it('throws on empty SOP IDs array', () => {
      const exporter = createExporter();
      expect(() => exporter.exportSOPs([])).toThrow('No SOPs selected');
    });

    it('exports a single SOP', () => {
      const sop = createTestSOP();
      const exporter = createExporter();
      const result = exporter.exportSOPs([sop.id]);

      expect(result.sop_count).toBe(1);
      expect(existsSync(result.export_path)).toBe(true);
      expect(existsSync(join(result.export_path, 'manifest.json'))).toBe(true);
      expect(existsSync(join(result.export_path, 'sops', 'sop_001.md'))).toBe(true);
    });

    it('exports multiple SOPs', () => {
      const sop1 = createTestSOP('SOP 1', '# SOP 1');
      const sop2 = createTestSOP('SOP 2', '# SOP 2');
      const exporter = createExporter();
      const result = exporter.exportSOPs([sop1.id, sop2.id]);

      expect(result.sop_count).toBe(2);
      expect(existsSync(join(result.export_path, 'sops', 'sop_001.md'))).toBe(true);
      expect(existsSync(join(result.export_path, 'sops', 'sop_002.md'))).toBe(true);
    });

    it('skips non-existent SOP IDs gracefully', () => {
      const sop = createTestSOP();
      const exporter = createExporter();
      const result = exporter.exportSOPs([sop.id, 'nonexistent-id']);

      expect(result.sop_count).toBe(1);
    });

    it('creates valid manifest.json', () => {
      const sop = createTestSOP('Deploy SOP', '# Deploy\n## Objective\nDeploy to prod.');
      db.addTagToSOP(sop.id, 'deploy');
      db.addTagToSOP(sop.id, 'production');
      const exporter = createExporter();
      const result = exporter.exportSOPs([sop.id]);

      const manifest = JSON.parse(
        readFileSync(join(result.export_path, 'manifest.json'), 'utf8'),
      ) as ExportManifest;

      expect(manifest.version).toBe('1.0.0');
      expect(manifest.source).toBe('agentic-ai-shadowing');
      expect(manifest.sop_count).toBe(1);
      expect(manifest.anonymized).toBe(true);
      expect(manifest.tags_summary).toContain('deploy');
      expect(manifest.tags_summary).toContain('production');
      expect(manifest.sops).toHaveLength(1);
      expect(manifest.sops[0]!.file).toBe('sop_001.md');
      expect(typeof manifest.exported_at).toBe('string');
    });

    it('anonymizes content in exported files', () => {
      const content = '# SOP\nContact: john@company.com at 192.168.1.1';
      const sop = createTestSOP('Test', content);
      const exporter = createExporter();
      const result = exporter.exportSOPs([sop.id]);

      const exported = readFileSync(join(result.export_path, 'sops', 'sop_001.md'), 'utf8');
      expect(exported).not.toContain('john@company.com');
      expect(exported).toContain('[email@example.com]');
      expect(exported).not.toContain('192.168.1.1');
      expect(exported).toContain('[internal-ip]');
    });

    it('anonymizes title in manifest', () => {
      const sop = createTestSOP('Contact john@company.com for details');
      const exporter = createExporter();
      const result = exporter.exportSOPs([sop.id]);

      expect(result.manifest.sops[0]!.title).toContain('[email@example.com]');
      expect(result.manifest.sops[0]!.title).not.toContain('john@company.com');
    });

    it('marks SOP as exported after export', () => {
      const sop = createTestSOP();
      const exporter = createExporter();
      exporter.exportSOPs([sop.id]);

      const updated = db.getSOP(sop.id);
      expect(updated!.status).toBe('exported');
    });

    it('logs export in database', () => {
      const sop = createTestSOP();
      const exporter = createExporter();
      exporter.exportSOPs([sop.id]);

      const exports = db.getExports();
      expect(exports).toHaveLength(1);
      expect(exports[0]!.sop_count).toBe(1);
    });

    it('handles collision-safe directory naming', () => {
      const sop1 = createTestSOP('SOP 1', '# SOP 1');
      const sop2 = createTestSOP('SOP 2', '# SOP 2');
      const exporter = createExporter();

      // Export twice quickly — may produce same timestamp
      const result1 = exporter.exportSOPs([sop1.id]);
      const result2 = exporter.exportSOPs([sop2.id]);

      expect(result1.export_path).not.toBe(result2.export_path);
      expect(existsSync(result1.export_path)).toBe(true);
      expect(existsSync(result2.export_path)).toBe(true);
    });

    it('calculates metrics summary correctly', () => {
      const sop = createTestSOP();
      db.logExecution(sop.id, { duration_seconds: 100, complexity_rating: 3 });
      db.logExecution(sop.id, { duration_seconds: 200, complexity_rating: 4 });

      const exporter = createExporter();
      const result = exporter.exportSOPs([sop.id]);

      expect(result.manifest.metrics_summary.total_executions).toBe(2);
      expect(result.manifest.metrics_summary.avg_completion_time_seconds).toBeGreaterThan(0);
    });

    it('handles SOP with no executions', () => {
      const sop = createTestSOP();
      const exporter = createExporter();
      const result = exporter.exportSOPs([sop.id]);

      expect(result.manifest.metrics_summary.total_executions).toBe(0);
      expect(result.manifest.metrics_summary.avg_completion_time_seconds).toBe(0);
    });

    it('numbers SOP files with zero-padded indices', () => {
      // Create 12 SOPs
      const sopIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        sopIds.push(createTestSOP(`SOP ${i}`, `# SOP ${i}`).id);
      }
      const exporter = createExporter();
      const result = exporter.exportSOPs(sopIds);

      const sopsDir = join(result.export_path, 'sops');
      const files = readdirSync(sopsDir).sort();
      expect(files[0]).toBe('sop_001.md');
      expect(files[11]).toBe('sop_012.md');
    });
  });

  // ── exportAll ───────────────────────────────────────────────────────────────

  describe('exportAll', () => {
    it('throws when no approved SOPs exist', () => {
      const exporter = createExporter();
      expect(() => exporter.exportAll()).toThrow('No approved SOPs');
    });

    it('exports only approved SOPs', () => {
      const sop1 = createTestSOP('Approved SOP', '# Approved');
      const sop2 = createTestSOP('Draft SOP', '# Draft');
      db.updateSOPStatus(sop1.id, 'approved');
      // sop2 remains draft

      const exporter = createExporter();
      const result = exporter.exportAll();

      expect(result.sop_count).toBe(1);
    });

    it('ignores draft, reviewed, exported, and archived SOPs', () => {
      const approved = createTestSOP('Approved', '# A');
      const reviewed = createTestSOP('Reviewed', '# R');
      const archived = createTestSOP('Archived', '# Ar');

      db.updateSOPStatus(approved.id, 'approved');
      db.updateSOPStatus(reviewed.id, 'reviewed');
      db.updateSOPStatus(archived.id, 'archived');

      const exporter = createExporter();
      const result = exporter.exportAll();
      expect(result.sop_count).toBe(1);
    });
  });
});
