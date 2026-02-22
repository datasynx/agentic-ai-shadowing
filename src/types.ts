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
}

export interface SOPGenerationConfig {
  model: string;
  max_tokens: number;
  temperature: number;
  include_cartography_context: boolean;
  auto_generate_tags: boolean;
  sop_language: string;
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
