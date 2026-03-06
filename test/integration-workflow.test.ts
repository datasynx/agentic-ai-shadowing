/**
 * Integration Tests — Full Workflow
 *
 * Tests the complete pipeline:
 * Task creation → SOP creation → Metrics → Export → Anonymization
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import { TaskManager, formatDuration } from '../src/task-manager.js';
import { Anonymizer } from '../src/anonymizer.js';
import { Exporter } from '../src/exporter.js';
import { calculateSOPMetrics, calculateConsistencyScore, calculateMaturityScore, calculateFreshnessScore, calculateOverallQualityScore } from '../src/metrics.js';
import { diffTexts, formatDiff } from '../src/diff.js';
import { getDefaultConfig } from '../src/config.js';
import { PrivacyManager, getDefaultExclusions } from '../src/privacy.js';
import { Observer, matchesExclusionRules, matchesPattern } from '../src/observer.js';
import { clusterBySilence, summarizeActionGroup } from '../src/session-analyzer.js';
import type { ExportManifest } from '../src/types.js';

describe('Integration: Complete Task → SOP → Metrics → Export Workflow', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-integration-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full lifecycle: create task → create SOP → add tags → log executions → calculate metrics → export', () => {
    const config = getDefaultConfig();
    const tm = new TaskManager(db);

    // 1. Create and complete a task
    const task = tm.startTask('Monthly SAP Closing', 'Close all SAP FI modules');
    expect(task.status).toBe('active');
    const { task: completedTask, duration } = tm.completeTask(3);
    expect(completedTask.status).toBe('completed');
    expect(typeof duration).toBe('string');

    // 2. Create SOP for the task
    const sop = db.createSOP(completedTask.id, {
      title: 'Monthly SAP Closing SOP',
      description: 'Standard procedure for monthly closing',
      content_md: `# Monthly SAP Closing SOP
## Objective
Complete the monthly closing process in SAP FI.

## Prerequisites
- SAP access with FI authorization
- All daily postings completed

## Steps
### Step 1: Run Balance Carryforward
Execute transaction FAGLGVTR.

### Step 2: Execute Foreign Currency Valuation
Run FAGL_FC_VAL for all company codes.

### Step 3: Post Accruals
Create accrual entries via FBS1.

## Expected Result
All FI modules closed for the period.

## Notes
Contact finance@company.com if issues arise.
Server: 192.168.1.100`,
      tags: ['accounting', 'sap', 'monthly', 'finance'],
    });

    expect(sop.version).toBe(1);
    expect(sop.status).toBe('draft');

    // 3. Log multiple executions
    db.logExecution(sop.id, { duration_seconds: 5000, complexity_rating: 3 });
    db.logExecution(sop.id, { duration_seconds: 4800, complexity_rating: 3 });
    db.logExecution(sop.id, { duration_seconds: 5200, complexity_rating: 4 });
    db.logExecution(sop.id, { duration_seconds: 4900, complexity_rating: 3 });
    db.logExecution(sop.id, { duration_seconds: 5100, complexity_rating: 3 });

    // 4. Calculate metrics
    const metrics = calculateSOPMetrics(db, sop.id, config.metrics.quality_score_weights);
    expect(metrics.execution_count).toBe(5);
    expect(metrics.avg_duration_seconds).toBeGreaterThan(0);
    expect(metrics.consistency_score).toBeGreaterThan(0);
    expect(metrics.maturity_score).toBeGreaterThan(0);

    // 5. Review the SOP
    db.updateSOPStatus(sop.id, 'reviewed');
    const reviewed = db.getSOP(sop.id)!;
    expect(reviewed.reviewed_at).not.toBeNull();

    // 6. Update content (creates version)
    db.updateSOP(sop.id, { content_md: reviewed.content_md + '\n\n## Revision\nAdded step for tax report.' }, 'Added tax report step');
    const updatedSop = db.getSOP(sop.id)!;
    expect(updatedSop.version).toBe(2);

    // Check version history
    const versions = db.getSOPVersions(sop.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);

    // 7. Diff between versions
    const diff = diffTexts(versions[0]!.content_md, updatedSop.content_md);
    expect(diff.addedCount).toBeGreaterThan(0);
    const formatted = formatDiff(diff);
    expect(formatted).toContain('+');

    // 8. Approve for export
    db.updateSOPStatus(sop.id, 'approved');

    // 9. Recalculate metrics after review + revision
    const metricsAfter = calculateSOPMetrics(db, sop.id, config.metrics.quality_score_weights);
    // Maturity should be higher now (review + revision + tags + description + 5 executions)
    expect(metricsAfter.maturity_score).toBeGreaterThanOrEqual(metrics.maturity_score);

    // 10. Export with anonymization
    const anonymizer = new Anonymizer(config.anonymization);
    const exporter = new Exporter(db, anonymizer, config, join(tmpDir, 'exports'));
    const exportResult = exporter.exportAll();

    expect(exportResult.sop_count).toBe(1);
    expect(existsSync(exportResult.export_path)).toBe(true);

    // Verify anonymization in exported file
    const exportedContent = readFileSync(
      join(exportResult.export_path, 'sops', 'sop_001.md'), 'utf8',
    );
    expect(exportedContent).not.toContain('finance@company.com');
    expect(exportedContent).toContain('[email@example.com]');
    expect(exportedContent).not.toContain('192.168.1.100');
    expect(exportedContent).toContain('[internal-ip]');

    // Verify manifest
    const manifest = JSON.parse(
      readFileSync(join(exportResult.export_path, 'manifest.json'), 'utf8'),
    ) as ExportManifest;
    expect(manifest.sop_count).toBe(1);
    expect(manifest.tags_summary).toContain('accounting');
    expect(manifest.metrics_summary.total_executions).toBe(5);

    // 11. Verify global stats
    const stats = db.getGlobalStats();
    expect(stats.total_tasks).toBe(1);
    expect(stats.completed_tasks).toBe(1);
    expect(stats.total_sops).toBe(1);
    expect(stats.total_executions).toBe(5);
    expect(stats.total_tags).toBe(4);
    expect(stats.total_exports).toBe(1);
  });

  it('task pause/resume preserves context', () => {
    const tm = new TaskManager(db);

    const task = tm.startTask('Long running task');
    tm.addNote('Started investigation');
    tm.pauseTask();

    // Try starting another task while paused — should work since no active task
    const task2 = tm.startTask('Quick task');
    tm.completeTask();

    // Resume original task
    tm.resumeTask(task.id);
    tm.addNote('Continued after break');
    const { task: completed } = tm.completeTask();

    expect(completed.description).toContain('Started investigation');
    expect(completed.description).toContain('Continued after break');
  });

  it('SOP workflow: draft → reviewed → approved → exported', () => {
    const task = db.createTask('Test');
    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });

    expect(sop.status).toBe('draft');
    expect(sop.reviewed_at).toBeNull();
    expect(sop.exported_at).toBeNull();

    db.updateSOPStatus(sop.id, 'reviewed');
    const reviewed = db.getSOP(sop.id)!;
    expect(reviewed.status).toBe('reviewed');
    expect(reviewed.reviewed_at).not.toBeNull();

    db.updateSOPStatus(sop.id, 'approved');
    expect(db.getSOP(sop.id)!.status).toBe('approved');

    db.updateSOPStatus(sop.id, 'exported');
    const exported = db.getSOP(sop.id)!;
    expect(exported.status).toBe('exported');
    expect(exported.exported_at).not.toBeNull();
  });

  it('observation → clustering → analysis pipeline', () => {
    // Create observation session with actions
    const session = db.startObservationSession('Dev session');

    // Simulate a coding workflow
    db.logObservedAction(session.id, {
      source: 'window', app_name: 'VS Code', window_title: 'src/app.ts',
      started_at: '2024-01-01 10:00:00', ended_at: '2024-01-01 10:15:00', duration_seconds: 900,
    });
    db.logObservedAction(session.id, {
      source: 'shell', command: 'npm test',
      started_at: '2024-01-01 10:15:30', ended_at: '2024-01-01 10:16:00', duration_seconds: 30,
    });
    db.logObservedAction(session.id, {
      source: 'git', command: 'git commit -m "fix: resolve bug"',
      started_at: '2024-01-01 10:16:30', ended_at: '2024-01-01 10:16:35', duration_seconds: 5,
    });

    // 5 minute gap, then different task
    db.logObservedAction(session.id, {
      source: 'window', app_name: 'Chrome', window_title: 'Jira Board',
      started_at: '2024-01-01 10:25:00', ended_at: '2024-01-01 10:30:00', duration_seconds: 300,
    });

    db.completeObservationSession(session.id);

    // Cluster the actions
    const actions = db.getActionTimeline(session.id);
    expect(actions).toHaveLength(4);

    const clusters = clusterBySilence(actions, 300);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toHaveLength(3); // Coding + test + commit
    expect(clusters[1]).toHaveLength(1); // Jira browsing

    // Summarize each cluster
    const summary1 = summarizeActionGroup(clusters[0]!);
    expect(summary1).toContain('VS Code');
    expect(summary1).toContain('npm test');
    expect(summary1).toContain('git commit');

    const summary2 = summarizeActionGroup(clusters[1]!);
    expect(summary2).toContain('Chrome');
    expect(summary2).toContain('Jira');
  });

  it('privacy: consent + exclusion + data lifecycle', () => {
    const pm = new PrivacyManager(db, { degradeAfterDays: 0, purgeAfterDays: 0 });

    // Set up consent
    pm.grantConsent('all');
    expect(pm.hasConsent('window')).toBe(true);

    // Set up exclusion rules
    for (const excl of getDefaultExclusions()) {
      pm.addExclusion(excl.rule_type, excl.pattern);
    }

    // Test exclusion matching
    expect(pm.shouldExclude({ app_name: '1Password' })).toBe(true);
    expect(pm.shouldExclude({ window_title: 'Private Browsing — Safari' })).toBe(true);
    expect(pm.shouldExclude({ app_name: 'VS Code' })).toBe(false);
    expect(pm.shouldExclude({ file_path: '.env.local' })).toBe(true);

    // Create some actions and apply lifecycle
    const session = db.startObservationSession('Test');
    db.logObservedAction(session.id, { source: 'window', window_title: 'Test' });
    db.completeObservationSession(session.id);

    const result = pm.applyDataLifecycle();
    expect(typeof result.degraded).toBe('number');
    expect(typeof result.purged).toBe('number');

    // Verify consent log
    const log = pm.getConsentLog();
    expect(log.length).toBeGreaterThan(0);
  });

  it('multiple SOPs with shared tags aggregate correctly', () => {
    const t1 = db.createTask('Task 1');
    db.completeTask(t1.id);
    const sop1 = db.createSOP(t1.id, { title: 'SOP 1', content_md: '#', tags: ['deploy', 'aws'] });

    const t2 = db.createTask('Task 2');
    db.completeTask(t2.id);
    const sop2 = db.createSOP(t2.id, { title: 'SOP 2', content_md: '#', tags: ['deploy', 'gcp'] });

    // 'deploy' tag should be shared
    const tags = db.listTags();
    expect(tags.find(t => t.name === 'deploy')).toBeDefined();

    const sop1Tags = db.getTagsForSOP(sop1.id).map(t => t.name);
    expect(sop1Tags).toContain('deploy');
    expect(sop1Tags).toContain('aws');

    const sop2Tags = db.getTagsForSOP(sop2.id).map(t => t.name);
    expect(sop2Tags).toContain('deploy');
    expect(sop2Tags).toContain('gcp');

    // Filter SOPs by shared tag
    const deploySOPs = db.listSOPs({ tag: 'deploy' });
    expect(deploySOPs).toHaveLength(2);
  });

  it('cascading delete: deleting task removes SOPs, tags, executions, versions', () => {
    const task = db.createTask('Task');
    db.completeTask(task.id);

    const sop = db.createSOP(task.id, { title: 'SOP', content_md: '#', tags: ['test'] });
    db.logExecution(sop.id, { duration_seconds: 100, complexity_rating: 3 });
    db.updateSOP(sop.id, { content_md: '# Updated' }, 'Update');

    // Verify everything exists
    expect(db.getSOP(sop.id)).not.toBeNull();
    expect(db.getTagsForSOP(sop.id)).toHaveLength(1);
    expect(db.getExecutions(sop.id)).toHaveLength(1);
    expect(db.getSOPVersions(sop.id)).toHaveLength(1);

    // Delete task — should cascade
    db.deleteTask(task.id);

    expect(db.getTask(task.id)).toBeNull();
    expect(db.getSOP(sop.id)).toBeNull();
    expect(db.getTagsForSOP(sop.id)).toEqual([]);
    expect(db.getExecutions(sop.id)).toEqual([]);
    expect(db.getSOPVersions(sop.id)).toEqual([]);
  });

  it('formatDuration handles edge cases', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
    expect(formatDuration(60)).toBe('1min');
    expect(formatDuration(61)).toBe('1min 1s');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3661)).toBe('1h 1min 1s');
    expect(formatDuration(86400)).toBe('24h');
  });

  it('metrics scoring functions work in isolation', () => {
    // Consistency
    expect(calculateConsistencyScore(0)).toBe(100);
    expect(calculateConsistencyScore(50)).toBe(0);
    expect(calculateConsistencyScore(25)).toBe(50);
    expect(calculateConsistencyScore(-10)).toBe(100); // Clamped
    expect(calculateConsistencyScore(200)).toBe(0); // Clamped

    // Maturity (max possible: 30+30+20+10+10 = 100)
    const dummySOP = {
      id: 'x', task_id: 'x', title: 'x', description: 'y', content_md: '#',
      version: 2, status: 'reviewed' as const, ai_generated: true,
      reviewed_at: '2024-01-01', exported_at: null,
      created_at: '2024-01-01', updated_at: '2024-01-01',
    };
    const maturity = calculateMaturityScore(dummySOP, 10, true, 1, true, true);
    expect(maturity).toBe(100);

    // Zero everything
    const maturityZero = calculateMaturityScore(
      { ...dummySOP, description: null, reviewed_at: null },
      0, false, 0, false, false,
    );
    expect(maturityZero).toBe(0);

    // Overall quality
    const overall = calculateOverallQualityScore(100, 100, 100, { consistency: 0.35, maturity: 0.35, freshness: 0.30 });
    expect(overall).toBeCloseTo(100);

    const overallZero = calculateOverallQualityScore(0, 0, 0, { consistency: 0.35, maturity: 0.35, freshness: 0.30 });
    expect(overallZero).toBe(0);
  });
});
