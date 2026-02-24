import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { ShadowingConfig } from './types.js';

// ── Config Schema (Zod) ─────────────────────────────────────────────────────

const AnonymizationSchema = z.object({
  custom_replacements: z.record(z.string()).default({}),
  redact_emails: z.boolean().default(true),
  redact_ips: z.boolean().default(true),
  redact_urls: z.boolean().default(true),
  redact_phone_numbers: z.boolean().default(true),
  redact_file_paths: z.boolean().default(true),
}).default({});

const SOPGenerationSchema = z.object({
  model: z.string().min(1).default('claude-sonnet-4-20250514'),
  max_tokens: z.number().int().positive().max(16384).default(4096),
  temperature: z.number().min(0).max(1).default(0.3),
  include_cartography_context: z.boolean().default(true),
  auto_generate_tags: z.boolean().default(true),
  sop_language: z.enum(['de', 'en']).default('de'),
}).default({});

const MetricsWeightsSchema = z.object({
  consistency: z.number().min(0).max(1).default(0.35),
  maturity: z.number().min(0).max(1).default(0.35),
  freshness: z.number().min(0).max(1).default(0.30),
}).default({});

export const ConfigSchema = z.object({
  version: z.string().default('1.0.0'),
  language: z.enum(['de', 'en']).default('de'),
  polling_interval_minutes: z.number().int().positive().default(15),
  editor: z.string().min(1).default(process.env['EDITOR'] ?? 'code'),
  ui_port: z.number().int().min(1024).max(65535).default(3847),
  cartography_graph_path: z.string().nullable().default(null),
  anonymization: AnonymizationSchema,
  sop_generation: SOPGenerationSchema,
  metrics: z.object({
    quality_score_weights: MetricsWeightsSchema,
  }).default({}),
});

export type ValidatedConfig = z.infer<typeof ConfigSchema>;

export function getConfigDir(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? tmpdir();
  return join(home, '.datasynx', 'shadowing');
}

export function getDbPath(): string {
  return join(getConfigDir(), 'shadowing.db');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export function getExportsDir(): string {
  return join(getConfigDir(), 'exports');
}

export function getDefaultConfig(): ShadowingConfig {
  return {
    version: '1.0.0',
    language: 'de',
    polling_interval_minutes: 15,
    editor: process.env['EDITOR'] ?? 'code',
    ui_port: 3847,
    cartography_graph_path: null,
    anonymization: {
      custom_replacements: {},
      redact_emails: true,
      redact_ips: true,
      redact_urls: true,
      redact_phone_numbers: true,
      redact_file_paths: true,
    },
    sop_generation: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0.3,
      include_cartography_context: true,
      auto_generate_tags: true,
      sop_language: 'de',
    },
    metrics: {
      quality_score_weights: {
        consistency: 0.35,
        maturity: 0.35,
        freshness: 0.30,
      },
    },
  };
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const exportsDir = getExportsDir();
  if (!existsSync(exportsDir)) {
    mkdirSync(exportsDir, { recursive: true });
  }
}

export function loadConfig(): ShadowingConfig {
  const configPath = getConfigPath();
  const defaults = getDefaultConfig();

  if (!existsSync(configPath)) {
    return defaults;
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    const result = ConfigSchema.safeParse(data);
    if (result.success) {
      return result.data as ShadowingConfig;
    }
    // Validation failed — log warning and fall back to merge with defaults
    process.stderr.write(
      `  Warnung: Config-Validierung fehlgeschlagen: ${result.error.issues.map(i => i.message).join(', ')}\n` +
      `  Verwende Defaults für ungültige Felder.\n`,
    );
    const loaded = data as Partial<ShadowingConfig>;
    return {
      ...defaults,
      ...loaded,
      anonymization: { ...defaults.anonymization, ...loaded.anonymization },
      sop_generation: { ...defaults.sop_generation, ...loaded.sop_generation },
      metrics: {
        quality_score_weights: {
          ...defaults.metrics.quality_score_weights,
          ...loaded.metrics?.quality_score_weights,
        },
      },
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(config: ShadowingConfig): void {
  ensureConfigDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
