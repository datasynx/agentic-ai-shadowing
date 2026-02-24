import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDefaultConfig, loadConfig, saveConfig, getConfigDir, getDbPath, ensureConfigDir, ConfigSchema } from '../src/config.js';

// Use a temp dir so tests don't touch real config
const TEST_DIR = join(tmpdir(), `shadowing-config-test-${Date.now()}`);

describe('Config — Defaults', () => {
  it('returns a valid default config', () => {
    const config = getDefaultConfig();
    expect(config.version).toBe('1.0.0');
    expect(config.language).toBe('de');
    expect(config.ui_port).toBe(3847);
    expect(config.polling_interval_minutes).toBe(15);
    expect(config.cartography_graph_path).toBeNull();
  });

  it('default config has all anonymization fields', () => {
    const config = getDefaultConfig();
    expect(config.anonymization.redact_emails).toBe(true);
    expect(config.anonymization.redact_ips).toBe(true);
    expect(config.anonymization.redact_urls).toBe(true);
    expect(config.anonymization.redact_phone_numbers).toBe(true);
    expect(config.anonymization.redact_file_paths).toBe(true);
    expect(config.anonymization.custom_replacements).toEqual({});
  });

  it('default config has SOP generation settings', () => {
    const config = getDefaultConfig();
    expect(config.sop_generation.model).toContain('claude');
    expect(config.sop_generation.max_tokens).toBe(4096);
    expect(config.sop_generation.temperature).toBe(0.3);
    expect(config.sop_generation.sop_language).toBe('de');
  });

  it('default config has metrics weights summing to ~1.0', () => {
    const config = getDefaultConfig();
    const w = config.metrics.quality_score_weights;
    expect(w.consistency + w.maturity + w.freshness).toBeCloseTo(1.0);
  });
});

describe('Config — Schema Validation', () => {
  it('validates a valid config', () => {
    const result = ConfigSchema.safeParse(getDefaultConfig());
    expect(result.success).toBe(true);
  });

  it('rejects invalid ui_port', () => {
    const result = ConfigSchema.safeParse({ ...getDefaultConfig(), ui_port: 80 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid language', () => {
    const result = ConfigSchema.safeParse({ ...getDefaultConfig(), language: 'fr' });
    expect(result.success).toBe(false);
  });

  it('fills defaults for missing fields', () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.language).toBe('de');
    }
  });

  it('accepts valid sop_language values', () => {
    const de = ConfigSchema.safeParse({ ...getDefaultConfig(), sop_generation: { ...getDefaultConfig().sop_generation, sop_language: 'de' } });
    expect(de.success).toBe(true);
    const en = ConfigSchema.safeParse({ ...getDefaultConfig(), sop_generation: { ...getDefaultConfig().sop_generation, sop_language: 'en' } });
    expect(en.success).toBe(true);
  });
});

describe('Config — Paths', () => {
  it('getConfigDir returns a path with .datasynx/shadowing', () => {
    const dir = getConfigDir();
    expect(dir).toContain('.datasynx');
    expect(dir).toContain('shadowing');
  });

  it('getDbPath returns a .db file path', () => {
    const dbPath = getDbPath();
    expect(dbPath).toContain('shadowing.db');
  });
});
