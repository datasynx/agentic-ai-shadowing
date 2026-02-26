import type { ShadowingDB } from './db.js';
import type { SOP, SOPMetrics, MetricsWeights } from './types.js';

export function calculateSOPMetrics(
  db: ShadowingDB,
  sopId: string,
  weights: MetricsWeights,
): SOPMetrics {
  const sop = db.getSOP(sopId);
  if (!sop) throw new Error(`SOP ${sopId} not found.`);

  const executions = db.getExecutions(sopId);
  const durations = executions.map(e => e.duration_seconds);
  const complexities = executions
    .filter(e => e.complexity_rating !== null)
    .map(e => e.complexity_rating!);

  if (durations.length === 0) {
    return emptyMetrics();
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const avg = mean(durations);
  const med = median(sorted);
  const stdDev = standardDeviation(durations, avg);
  const cv = avg > 0 ? (stdDev / avg) * 100 : 0;

  const tags = db.getTagsForSOP(sopId);

  const consistency = calculateConsistencyScore(cv);
  const maturity = calculateMaturityScore(
    sop,
    executions.length,
    sop.reviewed_at !== null,
    sop.version - 1, // revisions = version - 1
    tags.length > 0,
    sop.description !== null && sop.description.length > 0,
  );
  const freshness = calculateFreshnessScore(sop, durations.length);
  const overall = calculateOverallQualityScore(consistency, maturity, freshness, weights);

  return {
    execution_count: durations.length,
    avg_duration_seconds: Math.round(avg),
    median_duration_seconds: Math.round(med),
    min_duration_seconds: sorted[0]!,
    max_duration_seconds: sorted[sorted.length - 1]!,
    std_deviation_seconds: Math.round(stdDev),
    coefficient_of_variation: Math.round(cv * 10) / 10,
    avg_complexity: complexities.length > 0 ? Math.round(mean(complexities) * 10) / 10 : 0,
    consistency_score: Math.round(consistency),
    maturity_score: Math.round(maturity),
    freshness_score: Math.round(freshness),
    overall_quality_score: Math.round(overall),
  };
}

// Low CV = high consistency. CV of 10% → 80%, CV of 50% → 0%.
export function calculateConsistencyScore(cv: number): number {
  return Math.max(0, Math.min(100, 100 - cv * 2));
}

// Weighted score from multiple factors.
export function calculateMaturityScore(
  sop: SOP,
  executionCount: number,
  hasReview: boolean,
  revisionCount: number,
  hasTags: boolean,
  hasDescription: boolean,
): number {
  let score = 0;
  // >=5 executions → 30%
  score += Math.min(executionCount / 5, 1) * 30;
  // Review completed → 30%
  if (hasReview) score += 30;
  // >=1 revision → 20%
  if (revisionCount >= 1) score += 20;
  // Tags present → 10%
  if (hasTags) score += 10;
  // Description present → 10%
  if (hasDescription) score += 10;
  return Math.min(100, score);
}

// Freshness based on last review timestamp.
export function calculateFreshnessScore(sop: SOP, executionCount: number): number {
  if (!sop.reviewed_at) {
    // Never reviewed → score based on age only
    const ageMs = Date.now() - new Date(sop.updated_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.min(100, 100 - ageDays * 2));
  }

  const reviewAgeMs = Date.now() - new Date(sop.reviewed_at).getTime();
  const reviewAgeDays = reviewAgeMs / (1000 * 60 * 60 * 24);

  // Scale by frequency: frequently executed SOPs become outdated faster
  const frequencyFactor = executionCount > 10 ? 1.5 : executionCount > 5 ? 1.0 : 0.5;
  const decayRate = frequencyFactor * 0.5; // points per day

  return Math.max(0, Math.min(100, 100 - reviewAgeDays * decayRate));
}

export function calculateOverallQualityScore(
  consistency: number,
  maturity: number,
  freshness: number,
  weights: MetricsWeights,
): number {
  return consistency * weights.consistency +
         maturity * weights.maturity +
         freshness * weights.freshness;
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function standardDeviation(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function emptyMetrics(): SOPMetrics {
  return {
    execution_count: 0,
    avg_duration_seconds: 0,
    median_duration_seconds: 0,
    min_duration_seconds: 0,
    max_duration_seconds: 0,
    std_deviation_seconds: 0,
    coefficient_of_variation: 0,
    avg_complexity: 0,
    consistency_score: 0,
    maturity_score: 0,
    freshness_score: 0,
    overall_quality_score: 0,
  };
}
