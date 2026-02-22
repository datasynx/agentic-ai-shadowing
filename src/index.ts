// ── Public API ──────────────────────────────────────────────────────────────

// Types
export type {
  Task, TaskStatus,
  SOP, SOPStatus, SOPVersion,
  Tag, SOPTag,
  TaskExecution,
  ExportRecord,
  ShadowingConfig, AnonymizationConfig, SOPGenerationConfig, MetricsWeights,
  SOPMetrics, GlobalStats,
  ExportManifest, ExportManifestSOP, ExportResult,
} from './types.js';

export { TASK_STATUSES, SOP_STATUSES } from './types.js';

// Database
export { ShadowingDB } from './db.js';

// Config
export { loadConfig, saveConfig, getDefaultConfig, getConfigDir, getDbPath, ensureConfigDir } from './config.js';

// Task Management
export { TaskManager, formatDuration } from './task-manager.js';

// SOP Generation
export { SOPGenerator, buildSOPPreview, countSteps } from './sop-generator.js';

// Metrics
export {
  calculateSOPMetrics,
  calculateConsistencyScore,
  calculateMaturityScore,
  calculateFreshnessScore,
  calculateOverallQualityScore,
} from './metrics.js';

// Anonymization
export { Anonymizer } from './anonymizer.js';

// Diff
export { diffTexts, formatDiff } from './diff.js';
export type { DiffLine, DiffResult } from './diff.js';

// Cartography
export { loadCartographyGraph, buildGraphContext, buildFocusedContext, findRelevantNodes } from './cartography.js';
export type { CartographyGraph, CartographyNode, CartographyEdge } from './cartography.js';

// UI Server
export { createUIServer } from './ui-server.js';

// Export
export { Exporter } from './exporter.js';
