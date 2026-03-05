import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import {
  calculateSOPMetrics,
  calculateConsistencyScore,
  calculateMaturityScore,
  calculateFreshnessScore,
  calculateOverallQualityScore,
} from '../src/metrics.js';
import type { SOP, MetricsWeights } from '../src/types.js';

const defaultWeights: MetricsWeights = {
  consistency: 0.35,
  maturity: 0.35,
  freshness: 0.30,
};

describe('Metrics Edge Cases', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-metrics-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('calculateSOPMetrics', () => {
    it('should throw for non-existent SOP', () => {
      expect(() => calculateSOPMetrics(db, 'nonexistent', defaultWeights)).toThrow('not found');
    });

    it('should return empty metrics for SOP with no executions', () => {
      const task = db.createTask('Test');
      const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });
      const metrics = calculateSOPMetrics(db, sop.id, defaultWeights);
      expect(metrics.execution_count).toBe(0);
      expect(metrics.avg_duration_seconds).toBe(0);
      expect(metrics.consistency_score).toBe(0);
    });

    it('should calculate metrics with single execution', () => {
      const task = db.createTask('Test');
      const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });
      db.logExecution(sop.id, { duration_seconds: 300, complexity_rating: 3 });

      const metrics = calculateSOPMetrics(db, sop.id, defaultWeights);
      expect(metrics.execution_count).toBe(1);
      expect(metrics.avg_duration_seconds).toBe(300);
      expect(metrics.median_duration_seconds).toBe(300);
      expect(metrics.min_duration_seconds).toBe(300);
      expect(metrics.max_duration_seconds).toBe(300);
      expect(metrics.std_deviation_seconds).toBe(0); // Single value → 0 stddev
      expect(metrics.avg_complexity).toBe(3);
    });

    it('should calculate correct statistics with multiple executions', () => {
      const task = db.createTask('Test');
      const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });
      db.logExecution(sop.id, { duration_seconds: 100 });
      db.logExecution(sop.id, { duration_seconds: 200 });
      db.logExecution(sop.id, { duration_seconds: 300 });

      const metrics = calculateSOPMetrics(db, sop.id, defaultWeights);
      expect(metrics.execution_count).toBe(3);
      expect(metrics.avg_duration_seconds).toBe(200);
      expect(metrics.median_duration_seconds).toBe(200);
      expect(metrics.min_duration_seconds).toBe(100);
      expect(metrics.max_duration_seconds).toBe(300);
    });

    it('should handle executions with no complexity ratings', () => {
      const task = db.createTask('Test');
      const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });
      db.logExecution(sop.id, { duration_seconds: 100 });
      db.logExecution(sop.id, { duration_seconds: 200 });

      const metrics = calculateSOPMetrics(db, sop.id, defaultWeights);
      expect(metrics.avg_complexity).toBe(0);
    });

    it('should calculate median for even number of executions', () => {
      const task = db.createTask('Test');
      const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP' });
      db.logExecution(sop.id, { duration_seconds: 100 });
      db.logExecution(sop.id, { duration_seconds: 200 });
      db.logExecution(sop.id, { duration_seconds: 300 });
      db.logExecution(sop.id, { duration_seconds: 400 });

      const metrics = calculateSOPMetrics(db, sop.id, defaultWeights);
      expect(metrics.median_duration_seconds).toBe(250); // (200+300)/2
    });

    it('should boost maturity for reviewed SOPs', () => {
      const task = db.createTask('Test');
      const sop = db.createSOP(task.id, { title: 'SOP', content_md: '# SOP', tags: ['test'] });
      db.logExecution(sop.id, { duration_seconds: 100 });
      db.updateSOPStatus(sop.id, 'reviewed');

      const metrics = calculateSOPMetrics(db, sop.id, defaultWeights);
      expect(metrics.maturity_score).toBeGreaterThan(30); // Has review (30%) + some executions
    });
  });

  describe('calculateConsistencyScore', () => {
    it('should return 100 for CV of 0', () => {
      expect(calculateConsistencyScore(0)).toBe(100);
    });

    it('should return 0 for CV >= 50', () => {
      expect(calculateConsistencyScore(50)).toBe(0);
    });

    it('should return 0 for CV > 50', () => {
      expect(calculateConsistencyScore(100)).toBe(0);
    });

    it('should return 80 for CV of 10', () => {
      expect(calculateConsistencyScore(10)).toBe(80);
    });

    it('should never exceed 100', () => {
      expect(calculateConsistencyScore(-10)).toBe(100); // Negative CV doesn't make sense but shouldn't crash
    });
  });

  describe('calculateMaturityScore', () => {
    const baseSOP = {
      id: 'test', task_id: 'task', title: 'SOP', description: 'desc',
      content_md: '#', version: 1, status: 'draft' as const,
      ai_generated: true, reviewed_at: null, exported_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    it('should return 0 for minimal SOP', () => {
      const score = calculateMaturityScore(baseSOP, 0, false, 0, false, false);
      expect(score).toBe(0);
    });

    it('should return 100 for fully mature SOP', () => {
      const score = calculateMaturityScore(baseSOP, 10, true, 3, true, true);
      expect(score).toBe(100);
    });

    it('should cap execution contribution at 30%', () => {
      const score5 = calculateMaturityScore(baseSOP, 5, false, 0, false, false);
      const score10 = calculateMaturityScore(baseSOP, 10, false, 0, false, false);
      expect(score5).toBe(score10); // Both should be 30
      expect(score5).toBe(30);
    });

    it('should give partial credit for <5 executions', () => {
      const score = calculateMaturityScore(baseSOP, 2, false, 0, false, false);
      expect(score).toBe(12); // (2/5) * 30 = 12
    });

    it('should cap at 100', () => {
      // All factors maxed out
      const score = calculateMaturityScore(baseSOP, 100, true, 10, true, true);
      expect(score).toBe(100);
    });
  });

  describe('calculateFreshnessScore', () => {
    it('should return high score for recently updated SOP', () => {
      const sop: SOP = {
        id: 'test', task_id: 'task', title: 'SOP', description: 'desc',
        content_md: '#', version: 1, status: 'draft', ai_generated: true,
        reviewed_at: null, exported_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const score = calculateFreshnessScore(sop, 0);
      expect(score).toBeGreaterThan(90);
    });

    it('should return high score for recently reviewed SOP', () => {
      const sop: SOP = {
        id: 'test', task_id: 'task', title: 'SOP', description: 'desc',
        content_md: '#', version: 1, status: 'reviewed', ai_generated: true,
        reviewed_at: new Date().toISOString(), exported_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const score = calculateFreshnessScore(sop, 5);
      expect(score).toBeGreaterThan(90);
    });

    it('should return low score for old unreviewed SOP', () => {
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const sop: SOP = {
        id: 'test', task_id: 'task', title: 'SOP', description: 'desc',
        content_md: '#', version: 1, status: 'draft', ai_generated: true,
        reviewed_at: null, exported_at: null,
        created_at: oldDate, updated_at: oldDate,
      };
      const score = calculateFreshnessScore(sop, 0);
      expect(score).toBe(0); // 60 days * 2 > 100
    });

    it('should decay faster for frequently executed SOPs', () => {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const sop: SOP = {
        id: 'test', task_id: 'task', title: 'SOP', description: 'desc',
        content_md: '#', version: 1, status: 'reviewed', ai_generated: true,
        reviewed_at: weekAgo, exported_at: null,
        created_at: weekAgo, updated_at: weekAgo,
      };
      const lowFreq = calculateFreshnessScore(sop, 2);
      const highFreq = calculateFreshnessScore(sop, 15);
      expect(lowFreq).toBeGreaterThan(highFreq);
    });
  });

  describe('calculateOverallQualityScore', () => {
    it('should weight scores correctly', () => {
      const score = calculateOverallQualityScore(100, 100, 100, defaultWeights);
      expect(score).toBe(100);
    });

    it('should return 0 when all components are 0', () => {
      const score = calculateOverallQualityScore(0, 0, 0, defaultWeights);
      expect(score).toBe(0);
    });

    it('should respect custom weights', () => {
      const weights: MetricsWeights = { consistency: 1, maturity: 0, freshness: 0 };
      const score = calculateOverallQualityScore(80, 50, 30, weights);
      expect(score).toBe(80);
    });
  });
});
