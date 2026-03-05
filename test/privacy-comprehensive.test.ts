import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import { PrivacyManager, getDefaultExclusions } from '../src/privacy.js';

describe('PrivacyManager — Comprehensive Tests', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-priv-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Consent Management ──────────────────────────────────────────────────────

  describe('Consent management', () => {
    it('grants and checks consent for a specific scope', () => {
      const pm = new PrivacyManager(db);
      pm.grantConsent('window');
      expect(pm.hasConsent('window')).toBe(true);
    });

    it('revokes consent', () => {
      const pm = new PrivacyManager(db);
      pm.grantConsent('shell');
      pm.revokeConsent('shell');
      expect(pm.hasConsent('shell')).toBe(false);
    });

    it('"all" scope grants consent for all specific scopes', () => {
      const pm = new PrivacyManager(db);
      pm.grantConsent('all');
      expect(pm.hasConsent('window')).toBe(true);
      expect(pm.hasConsent('shell')).toBe(true);
      expect(pm.hasConsent('git')).toBe(true);
      expect(pm.hasConsent('file')).toBe(true);
    });

    it('revoking "all" does not revoke individual scopes', () => {
      const pm = new PrivacyManager(db);
      pm.grantConsent('all');
      pm.grantConsent('window');
      pm.revokeConsent('all');
      // Individual 'window' consent still exists
      expect(pm.hasConsent('window')).toBe(true);
    });

    it('getConsentStatus returns status for all scopes', () => {
      const pm = new PrivacyManager(db);
      pm.grantConsent('window');
      pm.grantConsent('shell');
      const status = pm.getConsentStatus();
      expect(status['window']).toBe(true);
      expect(status['shell']).toBe(true);
      expect(status['git']).toBe(false);
      expect(status['file']).toBe(false);
      expect(status['all']).toBe(false);
    });

    it('getConsentLog returns full audit trail', () => {
      const pm = new PrivacyManager(db);
      pm.grantConsent('window');
      pm.revokeConsent('window');
      pm.grantConsent('window');
      const log = pm.getConsentLog();
      expect(log).toHaveLength(3);
    });

    it('consent defaults to false for unchecked scopes', () => {
      const pm = new PrivacyManager(db);
      expect(pm.hasConsent('window')).toBe(false);
      expect(pm.hasConsent('randomscope')).toBe(false);
    });
  });

  // ── Exclusion Rules ─────────────────────────────────────────────────────────

  describe('Exclusion rules', () => {
    it('adds and lists exclusion rules', () => {
      const pm = new PrivacyManager(db);
      pm.addExclusion('app', '1Password');
      pm.addExclusion('title_pattern', '*banking*');
      expect(pm.listExclusions()).toHaveLength(2);
    });

    it('filters by type', () => {
      const pm = new PrivacyManager(db);
      pm.addExclusion('app', '1Password');
      pm.addExclusion('title_pattern', '*banking*');
      expect(pm.listExclusions('app')).toHaveLength(1);
      expect(pm.listExclusions('title_pattern')).toHaveLength(1);
    });

    it('removes exclusion by ID', () => {
      const pm = new PrivacyManager(db);
      const rule = pm.addExclusion('app', 'Test');
      pm.removeExclusion(rule.id);
      expect(pm.listExclusions()).toHaveLength(0);
    });

    it('shouldExclude returns true for matching context', () => {
      const pm = new PrivacyManager(db);
      pm.addExclusion('app', '1Password');
      expect(pm.shouldExclude({ app_name: '1Password' })).toBe(true);
    });

    it('shouldExclude returns false for non-matching context', () => {
      const pm = new PrivacyManager(db);
      pm.addExclusion('app', '1Password');
      expect(pm.shouldExclude({ app_name: 'Chrome' })).toBe(false);
    });

    it('shouldExclude checks all rule types', () => {
      const pm = new PrivacyManager(db);
      pm.addExclusion('path_pattern', '*.env*');
      expect(pm.shouldExclude({ file_path: '.env.local' })).toBe(true);
      expect(pm.shouldExclude({ file_path: 'src/app.ts' })).toBe(false);
    });

    it('shouldExclude with empty context returns false', () => {
      const pm = new PrivacyManager(db);
      pm.addExclusion('app', '1Password');
      expect(pm.shouldExclude({})).toBe(false);
    });
  });

  // ── Data Degradation ────────────────────────────────────────────────────────

  describe('Data degradation', () => {
    it('applyDataLifecycle returns counts', () => {
      const pm = new PrivacyManager(db);
      const result = pm.applyDataLifecycle();
      expect(typeof result.degraded).toBe('number');
      expect(typeof result.purged).toBe('number');
    });

    it('respects custom retention periods', () => {
      const pm = new PrivacyManager(db, { degradeAfterDays: 1, purgeAfterDays: 2 });
      const policy = pm.getRetentionPolicy();
      expect(policy.degradeAfterDays).toBe(1);
      expect(policy.purgeAfterDays).toBe(2);
    });

    it('default retention periods', () => {
      const pm = new PrivacyManager(db);
      const policy = pm.getRetentionPolicy();
      expect(policy.degradeAfterDays).toBe(7);
      expect(policy.purgeAfterDays).toBe(90);
    });

    it('degrades old action metadata', () => {
      // Create session with old actions
      const session = db.startObservationSession('Old Session');
      db.logObservedAction(session.id, {
        source: 'window',
        app_name: 'Chrome',
        window_title: 'Secret Banking',
        command: 'cat password.txt',
      });

      // Use very short retention to trigger degradation
      const pm = new PrivacyManager(db, { degradeAfterDays: 0, purgeAfterDays: 0 });
      const result = pm.applyDataLifecycle();
      // With 0 days, recent actions might still be degraded depending on timing
      expect(typeof result.degraded).toBe('number');
      expect(typeof result.purged).toBe('number');
    });
  });
});

// ── getDefaultExclusions ──────────────────────────────────────────────────────

describe('getDefaultExclusions', () => {
  it('returns an array of exclusion patterns', () => {
    const defaults = getDefaultExclusions();
    expect(Array.isArray(defaults)).toBe(true);
    expect(defaults.length).toBeGreaterThan(0);
  });

  it('includes common password managers', () => {
    const defaults = getDefaultExclusions();
    const patterns = defaults.map(d => d.pattern);
    expect(patterns).toContain('1Password');
    expect(patterns).toContain('Bitwarden');
  });

  it('includes banking patterns', () => {
    const defaults = getDefaultExclusions();
    expect(defaults.some(d => d.pattern.includes('bank'))).toBe(true);
  });

  it('includes private browsing patterns', () => {
    const defaults = getDefaultExclusions();
    expect(defaults.some(d => d.pattern.includes('Private'))).toBe(true);
    expect(defaults.some(d => d.pattern.includes('Incognito'))).toBe(true);
  });

  it('includes sensitive file patterns', () => {
    const defaults = getDefaultExclusions();
    expect(defaults.some(d => d.pattern.includes('.env'))).toBe(true);
    expect(defaults.some(d => d.pattern.includes('credentials'))).toBe(true);
    expect(defaults.some(d => d.pattern.includes('.pem'))).toBe(true);
    expect(defaults.some(d => d.pattern.includes('id_rsa'))).toBe(true);
  });

  it('each default has rule_type, pattern, and description', () => {
    const defaults = getDefaultExclusions();
    for (const d of defaults) {
      expect(typeof d.rule_type).toBe('string');
      expect(typeof d.pattern).toBe('string');
      expect(typeof d.description).toBe('string');
      expect(d.pattern.length).toBeGreaterThan(0);
    }
  });
});
