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
  ObservedAction, ActionSource, ObservationSession,
  ConsentRecord, ExclusionRule,
  InfraNode, InfraEdge, InfraGraph,
  ObserverConfig,
} from './types.js';

export { TASK_STATUSES, SOP_STATUSES, ACTION_SOURCES } from './types.js';

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
export { loadCartographyGraph, loadJGFFile, buildGraphContext, buildFocusedContext, findRelevantNodes } from './cartography.js';
export type { CartographyGraph, CartographyNode, CartographyEdge } from './cartography.js';

// Cartography Check
export { checkCartographyInstalled, locateJGFFile, ensureCartography } from './cartography-check.js';
export type { CartographyCheckResult } from './cartography-check.js';

// Observer
export { Observer, matchesExclusionRules, matchesPattern, isWithinWorkHours, getDefaultObserverConfig } from './observer.js';
export type { WindowInfo, ShellCommand } from './observer.js';

// Shell History
export { detectShell, getHistoryFilePath, parseZshHistory, parseBashHistory, parseFishHistory, createShellHistoryReader } from './shell-history.js';
export type { ShellType } from './shell-history.js';

// Infrastructure Context
export { buildInfraGraph, formatInfraGraph, listProjectFiles } from './infra-context.js';

// Privacy
export { PrivacyManager, getDefaultExclusions } from './privacy.js';

// UI Server
export { createUIServer } from './ui-server.js';

// Export
export { Exporter } from './exporter.js';
