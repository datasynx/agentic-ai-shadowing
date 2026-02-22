import { describe, it, expect } from 'vitest';
import {
  calculateConsistencyScore,
  calculateMaturityScore,
  calculateOverallQualityScore,
} from '../src/metrics.js';
import type { SOP } from '../src/types.js';

describe('calculateConsistencyScore', () => {
  it('returns 100 for CV = 0 (perfect consistency)', () => {
    expect(calculateConsistencyScore(0)).toBe(100);
  });

  it('returns 80 for CV = 10', () => {
    expect(calculateConsistencyScore(10)).toBe(80);
  });

  it('returns 0 for CV >= 50', () => {
    expect(calculateConsistencyScore(50)).toBe(0);
    expect(calculateConsistencyScore(75)).toBe(0);
  });

  it('returns 50 for CV = 25', () => {
    expect(calculateConsistencyScore(25)).toBe(50);
  });
});

describe('calculateMaturityScore', () => {
  const baseSOP: SOP = {
    id: 'test', task_id: 'task', title: 'Test',
    description: null, content_md: '', version: 1,
    status: 'draft', ai_generated: true,
    reviewed_at: null, exported_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it('returns 0 for brand new SOP', () => {
    const score = calculateMaturityScore(baseSOP, 0, false, 0, false, false);
    expect(score).toBe(0);
  });

  it('returns 100 for fully mature SOP', () => {
    const score = calculateMaturityScore(baseSOP, 10, true, 2, true, true);
    expect(score).toBe(100);
  });

  it('weights execution count up to 5', () => {
    const s1 = calculateMaturityScore(baseSOP, 1, false, 0, false, false);
    const s3 = calculateMaturityScore(baseSOP, 3, false, 0, false, false);
    const s5 = calculateMaturityScore(baseSOP, 5, false, 0, false, false);
    const s10 = calculateMaturityScore(baseSOP, 10, false, 0, false, false);

    expect(s1).toBe(6);    // 1/5 * 30
    expect(s3).toBe(18);   // 3/5 * 30
    expect(s5).toBe(30);   // 5/5 * 30
    expect(s10).toBe(30);  // capped at 30
  });

  it('adds 30 for review', () => {
    const noReview = calculateMaturityScore(baseSOP, 0, false, 0, false, false);
    const withReview = calculateMaturityScore(baseSOP, 0, true, 0, false, false);
    expect(withReview - noReview).toBe(30);
  });
});

describe('calculateOverallQualityScore', () => {
  it('calculates weighted average', () => {
    const weights = { consistency: 0.35, maturity: 0.35, freshness: 0.30 };
    const score = calculateOverallQualityScore(80, 60, 100, weights);
    // 80*0.35 + 60*0.35 + 100*0.30 = 28 + 21 + 30 = 79
    expect(score).toBe(79);
  });

  it('returns 0 for all zeros', () => {
    const weights = { consistency: 0.35, maturity: 0.35, freshness: 0.30 };
    expect(calculateOverallQualityScore(0, 0, 0, weights)).toBe(0);
  });

  it('returns 100 for all 100s', () => {
    const weights = { consistency: 0.35, maturity: 0.35, freshness: 0.30 };
    expect(calculateOverallQualityScore(100, 100, 100, weights)).toBe(100);
  });
});
