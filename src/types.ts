// ── Task ─────────────────────────────────────────────────────────────────────

export const TASK_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  started_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
}

// ── SOP ──────────────────────────────────────────────────────────────────────

export const SOP_STATUSES = ['draft', 'reviewed', 'approved', 'exported', 'archived'] as const;
export type SOPStatus = (typeof SOP_STATUSES)[number];

export interface SOP {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  content_md: string;
  version: number;
  status: SOPStatus;
  ai_generated: boolean;
  reviewed_at: string | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Tag ──────────────────────────────────────────────────────────────────────

export interface Tag {
  id: string;
  name: string;
}

export interface SOPTag {
  sop_id: string;
  tag_id: string;
  ai_generated: boolean;
}

// ── TaskExecution ────────────────────────────────────────────────────────────

export interface TaskExecution {
  id: string;
  sop_id: string;
  duration_seconds: number;
  complexity_rating: number | null;
  notes: string | null;
  executed_at: string;
}

// ── SOPVersion ───────────────────────────────────────────────────────────────

export interface SOPVersion {
  id: string;
  sop_id: string;
  version: number;
  title: string;
  content_md: string;
  changed_at: string;
  change_summary: string | null;
}

// ── Export ────────────────────────────────────────────────────────────────────

export interface ExportRecord {
  id: string;
  exported_at: string;
  sop_count: number;
  export_path: string;
  anonymized: boolean;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface AnonymizationConfig {
  custom_replacements: Record<string, string>;
  redact_emails: boolean;
  redact_ips: boolean;
  redact_urls: boolean;
  redact_phone_numbers: boolean;
  redact_file_paths: boolean;
  /** Entropy fallback for unknown secret formats (known token formats are always redacted). */
  redact_high_entropy: boolean;
  /** Redact PII/secrets before observation data is written to SQLite (data-at-rest protection). */
  redact_on_capture: boolean;
}

export interface SOPGenerationConfig {
  model: string;
  max_tokens: number;
  temperature: number;
  include_cartography_context: boolean;
  auto_generate_tags: boolean;
  sop_language: string;
  /** API endpoint override for enterprise gateways / local models (null = SDK default, honors ANTHROPIC_BASE_URL). */
  base_url: string | null;
  /** Env var holding the API credential (default: ANTHROPIC_API_KEY). */
  api_key_env: string;
  /** Request SOPs via tool-use structured output (default true); disable for gateways without tool support. */
  use_structured_output: boolean;
}

export interface MetricsWeights {
  consistency: number;
  maturity: number;
  freshness: number;
}

export interface ShadowingConfig {
  version: string;
  language: string;
  polling_interval_minutes: number;
  editor: string;
  ui_port: number;
  ui_host: string;
  ui_auth_token?: string;
  ui_rate_limit_per_minute?: number;
  /** Cross-origin origins allowed to call the UI API. Same-origin is always allowed; default: none. */
  ui_allowed_origins?: string[];
  log_level?: string;
  cartography_graph_path: string | null;
  anonymization: AnonymizationConfig;
  sop_generation: SOPGenerationConfig;
  metrics: {
    quality_score_weights: MetricsWeights;
  };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface SOPMetrics {
  execution_count: number;
  avg_duration_seconds: number;
  median_duration_seconds: number;
  min_duration_seconds: number;
  max_duration_seconds: number;
  std_deviation_seconds: number;
  coefficient_of_variation: number;
  avg_complexity: number;
  consistency_score: number;
  maturity_score: number;
  freshness_score: number;
  overall_quality_score: number;
}

// ── GlobalStats ──────────────────────────────────────────────────────────────

export interface GlobalStats {
  total_tasks: number;
  active_tasks: number;
  completed_tasks: number;
  total_sops: number;
  draft_sops: number;
  reviewed_sops: number;
  approved_sops: number;
  exported_sops: number;
  total_executions: number;
  total_tags: number;
  total_exports: number;
  avg_quality_score: number;
}

// ── Export Result ─────────────────────────────────────────────────────────────

export interface ExportManifest {
  version: string;
  exported_at: string;
  source: string;
  sop_count: number;
  anonymized: boolean;
  tags_summary: string[];
  redaction_summary?: {
    email_count: number;
    ip_count: number;
    url_count: number;
    phone_count: number;
    filepath_count: number;
    iban_count: number;
    credit_card_count: number;
    custom_count: number;
    secret_count: number;
    high_entropy_count: number;
  };
  metrics_summary: {
    avg_completion_time_seconds: number;
    avg_quality_score: number;
    total_executions: number;
  };
  sops: ExportManifestSOP[];
}

export interface ExportManifestSOP {
  file: string;
  title: string;
  tags: string[];
  executions: number;
  avg_duration_seconds: number;
  quality_score: number;
}

export interface ExportResult {
  export_path: string;
  sop_count: number;
  manifest: ExportManifest;
}

// ── Observation ──────────────────────────────────────────────────────────────

export const ACTION_SOURCES = ['window', 'shell', 'git', 'file', 'manual'] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

export interface ObservedAction {
  id: string;
  session_id: string;
  source: ActionSource;
  app_name: string | null;
  window_title: string | null;
  command: string | null;
  file_path: string | null;
  metadata: string | null; // JSON string
  started_at: string;
  ended_at: string;
  duration_seconds: number;
}

export interface ObservationSession {
  id: string;
  title: string | null;
  status: 'active' | 'paused' | 'completed';
  started_at: string;
  ended_at: string | null;
  total_actions: number;
  created_at: string;
}

// ── Privacy ──────────────────────────────────────────────────────────────────

export interface ConsentRecord {
  id: string;
  action: 'granted' | 'revoked';
  scope: string;
  recorded_at: string;
}

export interface ExclusionRule {
  id: string;
  rule_type: 'app' | 'title_pattern' | 'url_pattern' | 'path_pattern';
  pattern: string;
  created_at: string;
}

// ── Infrastructure Context ───────────────────────────────────────────────────

export interface InfraNode {
  name: string;
  type: 'service' | 'database' | 'cache' | 'queue' | 'api' | 'frontend' | 'tool' | 'unknown';
  source: string; // e.g. "docker-compose.yml", "package.json"
  metadata: Record<string, unknown>;
}

export interface InfraEdge {
  source: string;
  target: string;
  relation: string;
}

export interface InfraGraph {
  nodes: InfraNode[];
  edges: InfraEdge[];
}

// ── Observer Config ──────────────────────────────────────────────────────────

export interface ObserverConfig {
  poll_interval_ms: number;
  watch_git: boolean;
  watch_files: boolean;
  capture_shell_history: boolean;
  work_hours_only: boolean;
  work_hours_start: number; // 0-23
  work_hours_end: number;   // 0-23
}
