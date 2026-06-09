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

// Errors
export { ShadowingError, SOPGenerationError } from './errors.js';
export type { ShadowingErrorCode } from './errors.js';

// Logger
export { createLogger, noopLogger, getLogger, setDefaultLogger, setLogLevel, getLogLevel } from './logger.js';
export type { Logger, LogLevel, LoggerOptions } from './logger.js';

// Database
export { ShadowingDB } from './db.js';

// Config
export { loadConfig, saveConfig, getDefaultConfig, getConfigDir, getDbPath, ensureConfigDir, ConfigSchema } from './config.js';

// Task Management
export { TaskManager, formatDuration } from './task-manager.js';

// SOP Generation
export { SOPGenerator, buildSOPPreview, countSteps } from './sop-generator.js';
export type { AnthropicLikeClient } from './sop-generator.js';
export { createAnthropicClient } from './anthropic-client.js';

// SOP Response Parser
export { parseSOPResponse } from './sop-parser.js';
export type { ParsedSOPResponse } from './sop-parser.js';

// Retry Logic
export { withRetry } from './retry.js';
export type { RetryOptions } from './retry.js';

// Metrics
export {
  calculateSOPMetrics,
  calculateConsistencyScore,
  calculateMaturityScore,
  calculateFreshnessScore,
  calculateOverallQualityScore,
} from './metrics.js';

// Anonymization
export { Anonymizer, createCaptureRedactor } from './anonymizer.js';
export type { RedactionSummary } from './anonymizer.js';

// Dashboard client helpers (XSS-escaping layer, also unit-testable)
export { esc, escJs, renderMD, getDashboardClientHelpers } from './dashboard-client.js';

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
export { detectShell, getHistoryFilePath, parseZshHistory, parseBashHistory, parseFishHistory, parsePowerShellHistory, createShellHistoryReader } from './shell-history.js';
export type { ShellType } from './shell-history.js';

// Infrastructure Context
export { buildInfraGraph, formatInfraGraph, listProjectFiles } from './infra-context.js';

// Privacy
export { PrivacyManager, getDefaultExclusions } from './privacy.js';

// UI Server
export { createUIServer, getServerAuthToken } from './ui-server.js';
export type { UIServerOptions } from './ui-server.js';

// Export
export { Exporter } from './exporter.js';

// MCP Server (Claude Code Integration)
export { MCPServer, startMCPServer, buildMcpServer, getRegisteredToolNames } from './mcp-server.js';

// Claude Code Setup (hooks + .mcp.json, idempotent install/uninstall)
export { applyClaudeSetup, settingsPathForScope } from './claude-setup.js';
export type { SetupScope, SetupOptions, SetupResult, SetupFileChange } from './claude-setup.js';

// Multi-framework harness adapters (Codex, OpenClaw, Hermes, AGENTS.md)
export { applyHarness, planHarness, detectHarnesses, agentsMdSection, HARNESS_TARGETS } from './harness.js';
export type { HarnessTarget, HarnessPlan, HarnessApplyResult, HarnessEnv, ExecFn, ExecResult } from './harness.js';

// Hook Handler (Claude Code Hooks)
export { processHookEvent, classifyToolAction, buildActionDescription, isGitCommand, runHookHandler } from './hook-handler.js';
export type { HookEvent } from './hook-handler.js';

// Window Detector
export { createWindowDetector, detectActiveWindow, detectPlatform, parseWindowsPSOutput } from './window-detector.js';
export type { DetectorPlatform } from './window-detector.js';

// Session Analyzer (Agentic Core)
export { SessionAnalyzer, clusterBySilence, summarizeActionGroup } from './session-analyzer.js';
export type { ActionCluster, AnalysisResult } from './session-analyzer.js';
