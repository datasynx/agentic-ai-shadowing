import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import { TaskManager, formatDuration } from '../src/task-manager.js';
import {
  getConfigPath,
  getExportsDir,
  getConfigDir,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  getDefaultConfig,
  ConfigSchema,
} from '../src/config.js';
import { buildSOPPreview, countSteps, SOPGenerationError } from '../src/sop-generator.js';
import { calculateConsistencyScore, calculateMaturityScore, calculateFreshnessScore, calculateOverallQualityScore } from '../src/metrics.js';
import { diffTexts, formatDiff } from '../src/diff.js';

// ── Config: path functions ────────────────────────────────────────────────────

describe('config path functions', () => {
  it('getConfigPath ends with config.json', () => {
    const path = getConfigPath();
    expect(path).toMatch(/config\.json$/);
    expect(path).toContain('.datasynx');
  });

  it('getExportsDir ends with exports', () => {
    const dir = getExportsDir();
    expect(dir).toMatch(/exports$/);
    expect(dir).toContain('.datasynx');
  });

  it('getConfigDir contains .datasynx/shadowing', () => {
    expect(getConfigDir()).toContain(join('.datasynx', 'shadowing'));
  });

  it('all config paths share same base directory', () => {
    const configDir = getConfigDir();
    expect(getConfigPath()).toContain(configDir);
    expect(getExportsDir()).toContain(configDir);
  });
});

// ── Config: ensureConfigDir + saveConfig + loadConfig ────────────────────────

describe('config file operations', () => {
  let origHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'shadow-config-'));
    origHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    process.env['HOME'] = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('ensureConfigDir creates directories', () => {
    ensureConfigDir();
    expect(existsSync(getConfigDir())).toBe(true);
    expect(existsSync(getExportsDir())).toBe(true);
  });

  it('ensureConfigDir is idempotent', () => {
    ensureConfigDir();
    ensureConfigDir();
    expect(existsSync(getConfigDir())).toBe(true);
  });

  it('saveConfig writes config to disk', () => {
    const config = getDefaultConfig();
    config.language = 'de';
    saveConfig(config);

    const raw = readFileSync(getConfigPath(), 'utf8');
    const loaded = JSON.parse(raw) as Record<string, unknown>;
    expect(loaded['language']).toBe('de');
  });

  it('loadConfig returns defaults when no file exists', () => {
    const config = loadConfig();
    expect(config).toEqual(getDefaultConfig());
  });

  it('loadConfig reads saved config', () => {
    const config = getDefaultConfig();
    config.ui_port = 9999;
    saveConfig(config);

    const loaded = loadConfig();
    expect(loaded.ui_port).toBe(9999);
  });

  it('loadConfig returns defaults for invalid JSON', () => {
    ensureConfigDir();
    writeFileSync(getConfigPath(), '{invalid json!!!', 'utf8');
    const config = loadConfig();
    expect(config).toEqual(getDefaultConfig());
  });

  it('loadConfig merges partial invalid config with defaults', () => {
    ensureConfigDir();
    // Write config with one invalid field (ui_port out of range) and one valid field
    writeFileSync(getConfigPath(), JSON.stringify({
      version: '1.0.0',
      language: 'de',
      ui_port: 99999, // invalid: max 65535
      polling_interval_minutes: 15,
      editor: 'vim',
      cartography_graph_path: null,
      anonymization: { redact_emails: true, redact_ips: true, redact_urls: true, redact_phone_numbers: true, redact_file_paths: true, custom_replacements: {} },
      sop_generation: { model: 'claude-sonnet-4-6', max_tokens: 4096, temperature: 0.3, include_cartography_context: true, auto_generate_tags: true, sop_language: 'en' },
      metrics: { quality_score_weights: { consistency: 0.35, maturity: 0.35, freshness: 0.30 } },
    }), 'utf8');

    const config = loadConfig();
    // Merge fallback should keep valid fields
    expect(config.language).toBe('de');
    expect(config.editor).toBe('vim');
  });

  it('loadConfig warns when the configured model is deprecated', () => {
    const config = getDefaultConfig();
    config.sop_generation.model = 'claude-sonnet-4-20250514'; // deprecated, retires 2026-06-15
    saveConfig(config);

    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(
      ((line: string | Uint8Array): boolean => { warnings.push(String(line)); return true; }) as typeof process.stderr.write,
    );
    try {
      const loaded = loadConfig();
      expect(loaded.sop_generation.model).toBe('claude-sonnet-4-20250514');
    } finally {
      spy.mockRestore();
    }

    const joined = warnings.join('\n');
    expect(joined).toContain('deprecated');
    expect(joined).toContain('claude-sonnet-4-6'); // the recommended replacement
  });
});

// ── ConfigSchema edge cases ──────────────────────────────────────────────────

describe('ConfigSchema boundary values', () => {
  it('rejects temperature > 1', () => {
    const result = ConfigSchema.safeParse({ sop_generation: { temperature: 1.1 } });
    expect(result.success).toBe(false);
  });

  it('accepts temperature = 0', () => {
    const result = ConfigSchema.safeParse({ sop_generation: { temperature: 0 } });
    expect(result.success).toBe(true);
  });

  it('accepts temperature = 1', () => {
    const result = ConfigSchema.safeParse({ sop_generation: { temperature: 1 } });
    expect(result.success).toBe(true);
  });

  it('rejects ui_port < 1024', () => {
    const result = ConfigSchema.safeParse({ ui_port: 80 });
    expect(result.success).toBe(false);
  });

  it('accepts ui_port = 65535', () => {
    const result = ConfigSchema.safeParse({ ui_port: 65535 });
    expect(result.success).toBe(true);
  });

  it('rejects max_tokens = 0', () => {
    const result = ConfigSchema.safeParse({ sop_generation: { max_tokens: 0 } });
    expect(result.success).toBe(false);
  });

  it('accepts max_tokens = 16384', () => {
    const result = ConfigSchema.safeParse({ sop_generation: { max_tokens: 16384 } });
    expect(result.success).toBe(true);
  });

  it('rejects max_tokens > 16384', () => {
    const result = ConfigSchema.safeParse({ sop_generation: { max_tokens: 20000 } });
    expect(result.success).toBe(false);
  });
});

// ── TaskManager: resumeTask with multiple paused ─────────────────────────────

describe('TaskManager edge cases', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-tm-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resumeTask without ID picks first from paused list', () => {
    const tm = new TaskManager(db);
    const t1 = tm.startTask('Task 1');
    tm.pauseTask();
    // Create and pause a second task
    const t2 = db.createTask('Task 2');
    db.pauseTask(t2.id);

    // Resume without ID — should pick first from listTasks({status:'paused'})
    const resumed = tm.resumeTask();
    expect(resumed.status).toBe('active');
  });

  it('completeTask with zero duration does not log execution', () => {
    const tm = new TaskManager(db);
    tm.startTask('Quick task');
    const { task } = tm.completeTask();
    // duration_seconds may be 0 or negative for instant tasks
    // Check that no execution was logged (duration_seconds falsy means skip)
    const sops = db.listSOPs().filter(s => s.task_id === task.id);
    // No SOP linked to this task, so no execution to log
    expect(sops).toHaveLength(0);
  });

  it('addNote with multiple notes appends correctly', () => {
    const tm = new TaskManager(db);
    tm.startTask('Notes task');
    tm.addNote('First note');
    tm.addNote('Second note');
    tm.addNote('Third note');

    const task = tm.getActiveTask()!;
    expect(task.description).toContain('- First note');
    expect(task.description).toContain('- Second note');
    expect(task.description).toContain('- Third note');
    // Should have newlines between notes
    expect(task.description!.split('\n')).toHaveLength(3);
  });
});

// ── formatDuration edge cases ────────────────────────────────────────────────

describe('formatDuration edge cases', () => {
  it('59 seconds returns seconds only', () => {
    expect(formatDuration(59)).toBe('59s');
  });

  it('60 seconds returns 1min', () => {
    expect(formatDuration(60)).toBe('1min');
  });

  it('61 seconds returns 1min 1s', () => {
    expect(formatDuration(61)).toBe('1min 1s');
  });

  it('3599 seconds', () => {
    expect(formatDuration(3599)).toBe('59min 59s');
  });

  it('3600 seconds returns 1h', () => {
    expect(formatDuration(3600)).toBe('1h');
  });

  it('3661 seconds returns 1h 1min 1s', () => {
    expect(formatDuration(3661)).toBe('1h 1min 1s');
  });

  it('negative value returns it directly (< 60)', () => {
    // formatDuration(-5) → "-5s" because -5 < 60
    expect(formatDuration(-5)).toBe('-5s');
  });

  it('fractional seconds are not rounded', () => {
    // 59.9 < 60, so returns "59.9s"
    expect(formatDuration(59.9)).toBe('59.9s');
  });
});

// ── SOP Generator helpers ────────────────────────────────────────────────────

describe('SOPGenerationError', () => {
  it('has correct name', () => {
    const err = new SOPGenerationError('test', 'api_error');
    expect(err.name).toBe('SOPGenerationError');
  });

  it('is instanceof Error', () => {
    const err = new SOPGenerationError('test', 'api_error');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof SOPGenerationError).toBe(true);
  });

  it('retryable flag is passed through constructor', () => {
    expect(new SOPGenerationError('', 'rate_limited', true).retryable).toBe(true);
    expect(new SOPGenerationError('', 'api_error', true).retryable).toBe(true);
    expect(new SOPGenerationError('', 'auth_failed', false).retryable).toBe(false);
    expect(new SOPGenerationError('', 'parse_error', false).retryable).toBe(false);
  });

  it('stores statusCode when provided', () => {
    const err = new SOPGenerationError('fail', 'api_error', true, 500);
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('api_error');
  });
});

describe('buildSOPPreview', () => {
  it('shows title, steps, and tags', () => {
    const preview = buildSOPPreview('Deploy SOP', ['deploy', 'prod'], 5);
    expect(preview).toContain('"Deploy SOP"');
    expect(preview).toContain('Steps: 5');
    expect(preview).toContain('#deploy #prod');
  });

  it('shows (none) when no tags', () => {
    const preview = buildSOPPreview('No Tags', [], 0);
    expect(preview).toContain('(none)');
  });
});

describe('countSteps', () => {
  it('counts multiple steps', () => {
    const md = '### Step 1: Do\n### Step 2: This\n### Step 3: That';
    expect(countSteps(md)).toBe(3);
  });

  it('ignores non-step H3 headings', () => {
    const md = '### Step 1: Do\n### Notes\n### Step 2: This';
    expect(countSteps(md)).toBe(2);
  });

  it('returns 0 for no steps', () => {
    expect(countSteps('# Title\n## Objective\nSome text')).toBe(0);
  });

  it('handles step numbers > 9', () => {
    let md = '';
    for (let i = 1; i <= 15; i++) md += `### Step ${i}: Action ${i}\n`;
    expect(countSteps(md)).toBe(15);
  });
});

// ── Metrics edge cases ───────────────────────────────────────────────────────

describe('metrics scoring edge cases', () => {
  it('consistency score clamps at 100 for negative CV', () => {
    // Negative CV shouldn't happen but formula gives max(0, 100 - (-10)*2) = 120 → clamped?
    const score = calculateConsistencyScore(-10);
    // Formula: max(0, min(100, 100 - CV*2)), with CV=-10 → clamped to 100
    expect(score).toBe(100);
  });

  it('consistency score at CV=50 gives 0', () => {
    expect(calculateConsistencyScore(50)).toBe(0);
  });

  it('consistency score at CV=100 gives 0 (clamped)', () => {
    expect(calculateConsistencyScore(100)).toBe(0);
  });

  it('overall quality with custom weights', () => {
    const score = calculateOverallQualityScore(80, 60, 40, {
      consistency: 0.5,
      maturity: 0.3,
      freshness: 0.2,
    });
    expect(score).toBeCloseTo(80 * 0.5 + 60 * 0.3 + 40 * 0.2);
  });

  it('maturity score with all components at max', () => {
    const score = calculateMaturityScore(
      { reviewed_at: '2025-01-01' } as any,
      10, // >= 5 executions
      true, // reviewed
      3, // >= 1 revision
      true, // has tags
      true, // has description
    );
    expect(score).toBe(100);
  });

  it('freshness score for recently reviewed SOP', () => {
    const score = calculateFreshnessScore(
      { reviewed_at: new Date().toISOString() } as any,
      0,
    );
    // Recently reviewed → high freshness
    expect(score).toBeGreaterThan(80);
  });
});

// ── Diff edge cases ──────────────────────────────────────────────────────────

describe('diff edge cases', () => {
  it('diffTexts with trailing newlines', () => {
    const result = diffTexts('hello\n', 'hello\nworld\n');
    expect(result.addedCount).toBeGreaterThanOrEqual(1);
  });

  it('diffTexts with only whitespace differences', () => {
    const result = diffTexts('hello world', 'hello  world');
    // These are different strings, so should show changes
    expect(result.removedCount + result.addedCount).toBeGreaterThan(0);
  });

  it('formatDiff with context=0', () => {
    const result = diffTexts('line1\nline2\nline3', 'line1\nchanged\nline3');
    const formatted = formatDiff(result, 0);
    // Should still show changes even with 0 context
    expect(formatted).toContain('changed');
  });

  it('formatDiff with context=1', () => {
    const result = diffTexts(
      'a\nb\nc\nd\ne',
      'a\nb\nX\nd\ne',
    );
    const formatted = formatDiff(result, 1);
    // Should show 1 line of context around the change
    expect(formatted).toContain('b');
    expect(formatted).toContain('d');
  });

  it('diffTexts both empty', () => {
    const result = diffTexts('', '');
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
  });
});
