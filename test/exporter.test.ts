import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { Anonymizer } from '../src/anonymizer.js';
import { Exporter } from '../src/exporter.js';
import { getDefaultConfig } from '../src/config.js';
import type { ShadowingConfig } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-export-test-${Date.now()}.db`);
const TEST_EXPORTS_DIR = join(tmpdir(), `shadowing-exports-test-${Date.now()}`);

let db: ShadowingDB;
let exporter: Exporter;
let config: ShadowingConfig;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  config = getDefaultConfig();
  const anonymizer = new Anonymizer(config.anonymization);
  exporter = new Exporter(db, anonymizer, config, TEST_EXPORTS_DIR);
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
  try { rmSync(TEST_EXPORTS_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

function createTestSOP(status: 'approved' | 'draft' | 'reviewed' = 'approved') {
  const task = db.createTask('Export Test Task');
  db.completeTask(task.id);
  const sop = db.createSOP(task.id, {
    title: 'Test SOP',
    description: 'A test SOP for export',
    content_md: `# Test SOP
## Ziel
Test der Exportfunktion.

## Schritte
### Schritt 1: Aktion
Führe die Aktion aus.

## Erwartetes Ergebnis
Export erfolgreich.`,
    tags: ['testing', 'export'],
  });
  if (status !== 'draft') {
    db.updateSOPStatus(sop.id, 'reviewed');
    if (status === 'approved') {
      db.updateSOPStatus(sop.id, 'approved');
    }
  }
  return sop;
}

describe('Exporter — exportSOPs', () => {
  it('exports selected SOPs to directory', () => {
    const sop = createTestSOP('approved');
    const result = exporter.exportSOPs([sop.id]);

    expect(result.sop_count).toBe(1);
    expect(result.export_path).toContain('export_');
    expect(existsSync(result.export_path)).toBe(true);
  });

  it('creates manifest.json with correct structure', () => {
    const sop = createTestSOP('approved');
    const result = exporter.exportSOPs([sop.id]);

    const manifestPath = join(result.export_path, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.source).toBe('agentic-ai-shadowing');
    expect(manifest.sop_count).toBe(1);
    expect(manifest.anonymized).toBe(true);
    expect(manifest.sops).toHaveLength(1);
    expect(manifest.sops[0].file).toBe('sop_001.md');
    expect(manifest.sops[0].title).toBe('Test SOP');
    expect(manifest.tags_summary).toEqual(expect.arrayContaining(['testing', 'export']));
  });

  it('creates SOP markdown files in sops/ subdirectory', () => {
    const sop = createTestSOP('approved');
    const result = exporter.exportSOPs([sop.id]);

    const sopFile = join(result.export_path, 'sops', 'sop_001.md');
    expect(existsSync(sopFile)).toBe(true);

    const content = readFileSync(sopFile, 'utf8');
    expect(content).toContain('# Test SOP');
    expect(content).toContain('Schritt 1');
  });

  it('anonymizes content in exported files', () => {
    const task = db.createTask('PII Task');
    db.completeTask(task.id);
    const sop = db.createSOP(task.id, {
      title: 'PII SOP',
      content_md: 'Contact admin@secret.com at /Users/john/docs/file.pdf',
    });
    db.updateSOPStatus(sop.id, 'approved');

    const result = exporter.exportSOPs([sop.id]);
    const sopFile = join(result.export_path, 'sops', 'sop_001.md');
    const content = readFileSync(sopFile, 'utf8');

    expect(content).not.toContain('admin@secret.com');
    expect(content).toContain('[email@example.com]');
    expect(content).not.toContain('/Users/john/');
    expect(content).toContain('/Users/[user]/');
  });

  it('exports multiple SOPs with correct numbering', () => {
    const sop1 = createTestSOP('approved');
    const sop2 = createTestSOP('approved');
    const sop3 = createTestSOP('approved');

    const result = exporter.exportSOPs([sop1.id, sop2.id, sop3.id]);
    expect(result.sop_count).toBe(3);

    expect(existsSync(join(result.export_path, 'sops', 'sop_001.md'))).toBe(true);
    expect(existsSync(join(result.export_path, 'sops', 'sop_002.md'))).toBe(true);
    expect(existsSync(join(result.export_path, 'sops', 'sop_003.md'))).toBe(true);
  });

  it('marks exported SOPs as "exported" in DB', () => {
    const sop = createTestSOP('approved');
    exporter.exportSOPs([sop.id]);

    const updated = db.getSOP(sop.id)!;
    expect(updated.status).toBe('exported');
  });

  it('logs export in DB', () => {
    const sop = createTestSOP('approved');
    exporter.exportSOPs([sop.id]);

    const exports = db.getExports();
    expect(exports).toHaveLength(1);
    expect(exports[0]!.sop_count).toBe(1);
  });

  it('throws when no SOP IDs provided', () => {
    expect(() => exporter.exportSOPs([])).toThrow(/No SOPs selected for export/);
  });

  it('skips invalid SOP IDs gracefully', () => {
    const sop = createTestSOP('approved');
    const result = exporter.exportSOPs([sop.id, 'nonexistent']);
    expect(result.sop_count).toBe(1);
  });
});

describe('Exporter — exportAll', () => {
  it('exports all approved SOPs', () => {
    createTestSOP('approved');
    createTestSOP('approved');
    createTestSOP('draft'); // should NOT be exported

    const result = exporter.exportAll();
    expect(result.sop_count).toBe(2);
  });

  it('throws when no approved SOPs exist', () => {
    createTestSOP('draft');
    expect(() => exporter.exportAll()).toThrow(/No approved SOPs/);
  });
});

describe('Exporter — manifest metrics', () => {
  it('includes aggregated metrics in manifest', () => {
    const task = db.createTask('Metric Task');
    db.completeTask(task.id);
    const sop = db.createSOP(task.id, { title: 'Metric SOP', content_md: '# M' });
    db.updateSOPStatus(sop.id, 'approved');

    db.logExecution(sop.id, { duration_seconds: 100, complexity_rating: 3 });
    db.logExecution(sop.id, { duration_seconds: 200, complexity_rating: 4 });

    const result = exporter.exportSOPs([sop.id]);

    expect(result.manifest.metrics_summary.total_executions).toBe(2);
    expect(result.manifest.metrics_summary.avg_completion_time_seconds).toBeGreaterThan(0);
    expect(result.manifest.sops[0]!.executions).toBe(2);
  });
});
