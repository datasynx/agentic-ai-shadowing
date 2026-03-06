import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDefaultConfig, ConfigSchema, getConfigDir, getDbPath } from '../src/config.js';

/**
 * Config tests: pure function tests + schema validation.
 * We don't test loadConfig/saveConfig with mocked paths because the module
 * uses internal function references. Those are tested in e2e-full.test.ts.
 */

describe('Config — Path Functions', () => {
  it('getConfigDir returns a path containing .datasynx/shadowing', () => {
    const dir = getConfigDir();
    expect(dir).toContain('.datasynx');
    expect(dir).toContain('shadowing');
  });

  it('getDbPath ends with shadowing.db', () => {
    expect(getDbPath()).toContain('shadowing.db');
  });
});

describe('Config — getDefaultConfig', () => {
  it('returns a complete config object', () => {
    const config = getDefaultConfig();
    expect(config.version).toBe('1.0.0');
    expect(config.language).toBe('en');
    expect(config.polling_interval_minutes).toBe(15);
    expect(config.ui_port).toBe(3847);
    expect(config.cartography_graph_path).toBeNull();
  });

  it('default config passes schema validation', () => {
    const result = ConfigSchema.safeParse(getDefaultConfig());
    expect(result.success).toBe(true);
  });

  it('editor defaults to EDITOR env var or "code"', () => {
    const config = getDefaultConfig();
    const expected = process.env['EDITOR'] ?? 'code';
    expect(config.editor).toBe(expected);
  });

  it('sop_generation has correct defaults', () => {
    const config = getDefaultConfig();
    expect(config.sop_generation.model).toContain('claude');
    expect(config.sop_generation.max_tokens).toBe(4096);
    expect(config.sop_generation.temperature).toBe(0.3);
    expect(config.sop_generation.include_cartography_context).toBe(true);
    expect(config.sop_generation.auto_generate_tags).toBe(true);
    expect(config.sop_generation.sop_language).toBe('en');
  });

  it('anonymization has all fields enabled by default', () => {
    const config = getDefaultConfig();
    expect(config.anonymization.redact_emails).toBe(true);
    expect(config.anonymization.redact_ips).toBe(true);
    expect(config.anonymization.redact_urls).toBe(true);
    expect(config.anonymization.redact_phone_numbers).toBe(true);
    expect(config.anonymization.redact_file_paths).toBe(true);
    expect(config.anonymization.custom_replacements).toEqual({});
  });

  it('metrics weights sum to approximately 1.0', () => {
    const w = getDefaultConfig().metrics.quality_score_weights;
    expect(w.consistency + w.maturity + w.freshness).toBeCloseTo(1.0);
  });
});

describe('Config — Schema Validation (Comprehensive)', () => {
  it('accepts minimal empty object and fills defaults', () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.anonymization.redact_emails).toBe(true);
      expect(result.data.sop_generation.model).toContain('claude');
    }
  });

  it('accepts full valid config', () => {
    const result = ConfigSchema.safeParse(getDefaultConfig());
    expect(result.success).toBe(true);
  });

  it('rejects negative polling_interval_minutes', () => {
    expect(ConfigSchema.safeParse({ polling_interval_minutes: -1 }).success).toBe(false);
  });

  it('rejects zero polling_interval_minutes', () => {
    expect(ConfigSchema.safeParse({ polling_interval_minutes: 0 }).success).toBe(false);
  });

  it('rejects ui_port below 1024', () => {
    expect(ConfigSchema.safeParse({ ui_port: 80 }).success).toBe(false);
  });

  it('rejects ui_port above 65535', () => {
    expect(ConfigSchema.safeParse({ ui_port: 70000 }).success).toBe(false);
  });

  it('accepts ui_port at boundaries', () => {
    expect(ConfigSchema.safeParse({ ui_port: 1024 }).success).toBe(true);
    expect(ConfigSchema.safeParse({ ui_port: 65535 }).success).toBe(true);
  });

  it('rejects invalid language "fr"', () => {
    expect(ConfigSchema.safeParse({ language: 'fr' }).success).toBe(false);
  });

  it('accepts language "de"', () => {
    expect(ConfigSchema.safeParse({ language: 'de' }).success).toBe(true);
  });

  it('accepts language "en"', () => {
    expect(ConfigSchema.safeParse({ language: 'en' }).success).toBe(true);
  });

  it('rejects empty model string', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { model: '' } }).success).toBe(false);
  });

  it('rejects temperature above 1', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { temperature: 1.5 } }).success).toBe(false);
  });

  it('rejects negative temperature', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { temperature: -0.1 } }).success).toBe(false);
  });

  it('accepts temperature at boundaries', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { temperature: 0 } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ sop_generation: { temperature: 1 } }).success).toBe(true);
  });

  it('rejects max_tokens above 16384', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { max_tokens: 20000 } }).success).toBe(false);
  });

  it('rejects non-integer max_tokens', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { max_tokens: 4096.5 } }).success).toBe(false);
  });

  it('rejects zero max_tokens', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { max_tokens: 0 } }).success).toBe(false);
  });

  it('accepts sop_language "de"', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { sop_language: 'de' } }).success).toBe(true);
  });

  it('rejects invalid sop_language "es"', () => {
    expect(ConfigSchema.safeParse({ sop_generation: { sop_language: 'es' } }).success).toBe(false);
  });

  it('rejects negative metrics weights', () => {
    expect(ConfigSchema.safeParse({
      metrics: { quality_score_weights: { consistency: -0.1 } },
    }).success).toBe(false);
  });

  it('rejects metrics weights above 1', () => {
    expect(ConfigSchema.safeParse({
      metrics: { quality_score_weights: { consistency: 1.1 } },
    }).success).toBe(false);
  });

  it('accepts metrics weights at boundaries', () => {
    expect(ConfigSchema.safeParse({
      metrics: { quality_score_weights: { consistency: 0, maturity: 0, freshness: 0 } },
    }).success).toBe(true);
    expect(ConfigSchema.safeParse({
      metrics: { quality_score_weights: { consistency: 1, maturity: 1, freshness: 1 } },
    }).success).toBe(true);
  });

  it('accepts cartography_graph_path as string', () => {
    const result = ConfigSchema.safeParse({ cartography_graph_path: '/path/to/graph.json' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cartography_graph_path).toBe('/path/to/graph.json');
    }
  });

  it('accepts cartography_graph_path as null', () => {
    const result = ConfigSchema.safeParse({ cartography_graph_path: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cartography_graph_path).toBeNull();
    }
  });

  it('accepts custom_replacements map', () => {
    const result = ConfigSchema.safeParse({
      anonymization: { custom_replacements: { 'ACME Corp': '[company]' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.anonymization.custom_replacements).toEqual({ 'ACME Corp': '[company]' });
    }
  });

  it('strips unknown fields', () => {
    const result = ConfigSchema.safeParse({ unknown_field: true, extra: 42 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['unknown_field']).toBeUndefined();
    }
  });
});
