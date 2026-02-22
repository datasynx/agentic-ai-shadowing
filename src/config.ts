import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShadowingConfig } from './types.js';

export function getConfigDir(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
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
    const loaded = JSON.parse(raw) as Partial<ShadowingConfig>;
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
